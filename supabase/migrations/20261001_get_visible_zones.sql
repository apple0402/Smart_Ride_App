-- ═══════════════════════════════════════════════════════════════════════════
-- Safe Ride — reporter_ids/safe_voter_ids 비노출 전환 1단계 (release 1.0.1 / B4)
--
-- 목적: 앱이 zones 의 개인 식별 배열(reporter_ids, safe_voter_ids)과 admin_confirmed_prev 를
--       직접 받지 않도록, 필요한 정보만 돌려주는 RPC 로 전환한다. (2단계는 보급 후 별도 파일)
--
-- 구성(신규 RPC 3개, 전부 SECURITY DEFINER):
--   1) get_visible_zones()                         — anon + authenticated (지도는 비로그인 노출)
--        활성 마커 반환. reporter_ids/safe_voter_ids/admin_confirmed_prev 대신 호출자 기준 boolean
--        (is_mine / i_voted / has_owner / admin_confirmed)만 노출. 차단한 소유자의 마커는 서버에서 제외.
--   2) submit_content_report(hazard_id, reason, detail) — authenticated
--        마커 ID만 받아 서버가 소유자(reporter_ids[1])를 해석해 content_reports 에 기록.
--        본인 마커 신고 거부. 같은 사용자+같은 마커 중복은 멱등({status:'duplicate'}).
--   3) block_zone_owner(zone_id)                   — authenticated
--        마커 ID만 받아 서버가 소유자를 해석해 blocked_users 에 기록(멱등). 소유자 없음/본인 거부.
--
-- 설계:
--   • 전부 definer → RLS 를 우회해 reporter_ids 를 내부에서 읽는다. 그래서 2단계에서 anon/authenticated
--     의 컬럼 접근을 회수해도 이 RPC 들은 계속 동작한다.
--   • 이 파일은 zones / content_reports / blocked_users 의 "테이블 권한·RLS 정책을 변경하지 않는다".
--     1.0(4) 앱이 아직 select('*') 와 직접 insert 를 쓰므로 1단계에서는 건드리지 않는다.
--   • 모든 예외 메시지는 한글 — 앱이 error.message 를 그대로 토스트로 노출한다.
--
-- 멱등: CREATE OR REPLACE + REVOKE/GRANT 재실행 무해. 전 구간 BEGIN/COMMIT.
-- 적용: 스테이징(safe-ride-staging, okixksradpfzspbticia) → tests/get_visible_zones_test.sql 통과
--       → 운영(samrt-rider-DB, jidpwflthppsltdayhoy) 직접 적용. 자동 실행 안 됨.
-- 적용 일자: (스테이징: ____  / 운영: ____)
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

-- ── 1) get_visible_zones ──────────────────────────────────────────────────────
DROP FUNCTION IF EXISTS public.get_visible_zones();
CREATE FUNCTION public.get_visible_zones()
RETURNS TABLE (
  id              text,
  lat             double precision,
  lng             double precision,
  title           text,
  type            text,
  description     text,
  address         text,
  severity        text,
  report_count    integer,
  safe_votes      integer,
  status          text,
  confirmation    text,
  created_at      timestamptz,
  admin_confirmed boolean,
  is_mine         boolean,
  i_voted         boolean,
  has_owner       boolean
)
LANGUAGE sql SECURITY DEFINER SET search_path = public STABLE
AS $$
  SELECT z.id, z.lat, z.lng, z.title, z.type,
         z.description, z.address, z.severity, z.report_count, z.safe_votes,
         z.status, z.confirmation, z.created_at,
         (z.admin_confirmed_at IS NOT NULL)                                      AS admin_confirmed,
         (auth.uid() IS NOT NULL AND z.reporter_ids[1] = auth.uid()::text)       AS is_mine,
         (auth.uid() IS NOT NULL AND auth.uid()::text = ANY (z.safe_voter_ids))  AS i_voted,
         (coalesce(array_length(z.reporter_ids, 1), 0) > 0)                      AS has_owner
    FROM zones z
   WHERE z.status = 'active'
     AND NOT EXISTS (                       -- 호출자가 차단한 소유자(reporter_ids[1])의 마커는 제외
       SELECT 1 FROM blocked_users b
        WHERE b.blocker_id = auth.uid()
          AND b.blocked_id::text = z.reporter_ids[1]
     )
   ORDER BY z.created_at DESC;
$$;

-- ── 2) submit_content_report ──────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.submit_content_report(
  p_hazard_id text,
  p_reason    text,
  p_detail    text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_uid    uuid := auth.uid();
  v_owner  uuid;
  v_exists boolean;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION '로그인이 필요합니다'; END IF;
  IF coalesce(p_reason, '') = '' THEN RAISE EXCEPTION '신고 사유를 선택해 주세요'; END IF;

  SELECT nullif(reporter_ids[1], '')::uuid INTO v_owner FROM zones WHERE id = p_hazard_id;
  IF NOT FOUND THEN RAISE EXCEPTION '구역 정보를 찾을 수 없습니다'; END IF;

  IF v_owner IS NOT NULL AND v_owner = v_uid THEN
    RAISE EXCEPTION '본인이 등록한 구역은 신고할 수 없습니다';
  END IF;

  -- 멱등: 같은 사용자가 같은 마커를 이미 신고했으면 중복 생성하지 않는다.
  SELECT EXISTS (
    SELECT 1 FROM content_reports WHERE reporter_id = v_uid AND hazard_id = p_hazard_id
  ) INTO v_exists;
  IF v_exists THEN
    RETURN jsonb_build_object('status', 'duplicate');
  END IF;

  INSERT INTO content_reports (reporter_id, hazard_id, reported_user_id, reason, detail)
  VALUES (v_uid, p_hazard_id, v_owner, p_reason, nullif(p_detail, ''));
  RETURN jsonb_build_object('status', 'created');
END $$;

-- ── 3) block_zone_owner ───────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.block_zone_owner(p_zone_id text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_uid   uuid := auth.uid();
  v_owner uuid;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION '로그인이 필요합니다'; END IF;

  SELECT nullif(reporter_ids[1], '')::uuid INTO v_owner FROM zones WHERE id = p_zone_id;
  IF NOT FOUND   THEN RAISE EXCEPTION '구역 정보를 찾을 수 없습니다'; END IF;
  IF v_owner IS NULL THEN RAISE EXCEPTION '차단할 사용자를 찾을 수 없습니다'; END IF;
  IF v_owner = v_uid THEN RAISE EXCEPTION '본인은 차단할 수 없습니다'; END IF;

  INSERT INTO blocked_users (blocker_id, blocked_id)
  VALUES (v_uid, v_owner)
  ON CONFLICT (blocker_id, blocked_id) DO NOTHING;
  RETURN jsonb_build_object('status', 'blocked');
END $$;

-- ── 실행 권한 ─────────────────────────────────────────────────────────────────
-- Postgres 는 함수 생성 시 EXECUTE 를 PUBLIC 에 기본 부여 → 회수 후 의도한 롤에만 부여.
REVOKE EXECUTE ON FUNCTION public.get_visible_zones()                       FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.submit_content_report(text, text, text)   FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.block_zone_owner(text)                    FROM PUBLIC;

GRANT  EXECUTE ON FUNCTION public.get_visible_zones()                       TO anon, authenticated;  -- 지도는 비로그인 노출
GRANT  EXECUTE ON FUNCTION public.submit_content_report(text, text, text)   TO authenticated;        -- 로그인 전용
GRANT  EXECUTE ON FUNCTION public.block_zone_owner(text)                    TO authenticated;        -- 로그인 전용

COMMIT;

-- PostgREST 스키마 캐시 갱신(신규 RPC 반영)
NOTIFY pgrst, 'reload schema';

-- ═══════════════════════════════════════════════════════════════════════════
-- 롤백 SQL (필요 시)
--   BEGIN;
--     DROP FUNCTION IF EXISTS public.get_visible_zones();
--     DROP FUNCTION IF EXISTS public.submit_content_report(text, text, text);
--     DROP FUNCTION IF EXISTS public.block_zone_owner(text);
--   COMMIT;
--   NOTIFY pgrst, 'reload schema';
-- ═══════════════════════════════════════════════════════════════════════════
