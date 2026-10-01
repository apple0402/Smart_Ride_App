-- ═══════════════════════════════════════════════════════════════════════════
-- Safe Ride — 상황실 "운영자 확인" 기능 (release 1.0.1 / A2)
--
-- 목적: 운영자가 라이딩으로 직접 확인한 위험 구역을 상황실에서 confirmed 로 올려
--       지도에 진하게 표시한다. 신고자 2명(승격 기준)이 모이지 않아도 운영 신뢰로 확정.
--
-- 구성:
--   1) zones 신규 컬럼 2개
--      - admin_confirmed_at   timestamptz : 운영자 확인 시각(NULL = 미확인/해제 상태)
--      - admin_confirmed_prev varchar(20) : 확인 '직전' confirmation 값(해제 시 복원용)
--   2) admin_confirm_zone(text)   : 운영자 확인(confirmed + 90일 만료 연장). service_role 전용.
--   3) admin_unconfirm_zone(text) : 확인 해제(직전 confirmation 복원). service_role 전용.
--
-- 설계 결정(요청서/합의 반영):
--   • 쓰기는 SECURITY DEFINER RPC 로만. anon/authenticated 에는 EXECUTE 미부여(service_role 전용).
--     → 상황실(routes/admin.js)이 service_role 키로만 호출한다. 테이블 직접 쓰기 권한은 열지 않음.
--   • profiles(포인트/신뢰도)는 절대 건드리지 않는다 — 운영자 확인은 신고자 실적·불이익과 무관.
--   • 확인 시 last_activity_at=now() 로 갱신해 90일 만료를 연장한다. 이미 confirmed 인 마커도
--     "재확인"으로 호출 가능(만료 연장 목적).
--   • 해제 시 last_activity_at 은 복원하지 않는다(합의). 옛 활동시각으로 되돌리면 다음 만료
--     cron 에서 즉시 사라지는 더 위험한 실패가 되므로, confirmation 값만 복원한다.
--   • admin_confirmed_prev 는 '최초 확인'(admin_confirmed_at IS NULL)일 때만 캡처한다.
--     재확인에서는 유지 → 'confirmed' 로 오염되지 않음(해제 시 원래 상태로 정확히 복원).
--   • 확인 대상은 status='active' 마커로 한정한다(expired/cleared 는 확인 불가).
--   • 신규 컬럼은 zones 테이블의 기존 GRANT(SELECT)를 상속한다. anon/authenticated 에 노출되나
--     민감정보가 아니며, 공개 노출 정리는 B4(get_visible_zones)에서 별도로 수행한다.
--   • RLS 정책/기존 GRANT 는 변경하지 않는다 → 운영 정책명(zones_public_read) 드리프트와 무관.
--
-- 멱등: ADD COLUMN IF NOT EXISTS / CREATE OR REPLACE / REVOKE·GRANT 재실행 무해. 전 구간 BEGIN/COMMIT.
-- 적용: 스테이징(safe-ride-staging, okixksradpfzspbticia) → tests/admin_confirm_zones_test.sql 통과
--       → 운영(samrt-rider-DB, jidpwflthppsltdayhoy) 직접 적용. 이 파일은 자동 실행되지 않는다.
-- 적용 일자: (스테이징: ____  / 운영: ____  — 적용 시 기입)
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

-- ── 1) 신규 컬럼 ──────────────────────────────────────────────────────────────
ALTER TABLE public.zones ADD COLUMN IF NOT EXISTS admin_confirmed_at   timestamptz;
ALTER TABLE public.zones ADD COLUMN IF NOT EXISTS admin_confirmed_prev varchar(20);

-- ── 2) 운영자 확인 ────────────────────────────────────────────────────────────
--   confirmed 로 올리고, 만료를 90일 연장(last_activity_at=now()).
--   최초 확인 시에만 직전 confirmation 을 admin_confirmed_prev 에 보존(해제 복원용).
CREATE OR REPLACE FUNCTION public.admin_confirm_zone(p_zone_id text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_zone zones%ROWTYPE;
BEGIN
  SELECT * INTO v_zone FROM zones WHERE id = p_zone_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION '구역을 찾을 수 없습니다';
  END IF;
  IF v_zone.status <> 'active' THEN
    RAISE EXCEPTION '활성 상태(active) 마커만 운영자 확인할 수 있습니다 (현재: %)', v_zone.status;
  END IF;

  UPDATE zones
     SET confirmation         = 'confirmed',
         -- 최초 확인 때만 직전 값 캡처. 재확인(이미 admin 확인됨)에서는 유지(오염 방지).
         admin_confirmed_prev = CASE WHEN admin_confirmed_at IS NULL
                                     THEN confirmation
                                     ELSE admin_confirmed_prev END,
         admin_confirmed_at   = now(),
         last_activity_at     = now()   -- 90일 만료 연장
   WHERE id = p_zone_id
   RETURNING * INTO v_zone;

  RETURN to_jsonb(v_zone);
END $$;

-- ── 3) 확인 해제 ──────────────────────────────────────────────────────────────
--   운영자 확인 상태(admin_confirmed_at IS NOT NULL)에서만 가능.
--   confirmation 을 확인 직전 값으로 복원하고 admin 플래그를 비운다.
--   last_activity_at 은 복원하지 않는다(위 설계 결정 참고).
CREATE OR REPLACE FUNCTION public.admin_unconfirm_zone(p_zone_id text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_zone zones%ROWTYPE;
BEGIN
  SELECT * INTO v_zone FROM zones WHERE id = p_zone_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION '구역을 찾을 수 없습니다';
  END IF;
  IF v_zone.admin_confirmed_at IS NULL THEN
    RAISE EXCEPTION '운영자 확인 상태가 아닙니다';
  END IF;

  UPDATE zones
     SET confirmation         = coalesce(admin_confirmed_prev, 'unconfirmed'),
         admin_confirmed_at   = NULL,
         admin_confirmed_prev = NULL
   WHERE id = p_zone_id
   RETURNING * INTO v_zone;

  RETURN to_jsonb(v_zone);
END $$;

-- ── 4) 실행 권한: service_role 전용 ───────────────────────────────────────────
-- Postgres 는 함수 생성 시 EXECUTE 를 PUBLIC 에 기본 부여한다. 먼저 회수 후 service_role 에만 부여.
REVOKE EXECUTE ON FUNCTION public.admin_confirm_zone(text)   FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.admin_unconfirm_zone(text) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.admin_confirm_zone(text)   TO service_role;
GRANT  EXECUTE ON FUNCTION public.admin_unconfirm_zone(text) TO service_role;

COMMIT;

-- PostgREST 스키마 캐시 갱신(신규 컬럼·RPC 반영)
NOTIFY pgrst, 'reload schema';

-- ═══════════════════════════════════════════════════════════════════════════
-- 롤백 SQL (필요 시 아래 실행)
--
--   BEGIN;
--     DROP FUNCTION IF EXISTS public.admin_confirm_zone(text);
--     DROP FUNCTION IF EXISTS public.admin_unconfirm_zone(text);
--     -- 컬럼은 데이터 보존이 목적이면 남겨도 무해. 완전 제거 시:
--     -- ALTER TABLE public.zones DROP COLUMN IF EXISTS admin_confirmed_at;
--     -- ALTER TABLE public.zones DROP COLUMN IF EXISTS admin_confirmed_prev;
--   COMMIT;
--   NOTIFY pgrst, 'reload schema';
-- ═══════════════════════════════════════════════════════════════════════════
