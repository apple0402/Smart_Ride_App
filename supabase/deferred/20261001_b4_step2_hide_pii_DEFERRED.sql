-- ═══════════════════════════════════════════════════════════════════════════
-- Safe Ride — reporter_ids/safe_voter_ids 비노출 전환 2단계 (B4 / ⚠️ 적용 금지 상태)
--
-- ⚠️⚠️ 지금 적용하지 말 것. 1.0.1 이 충분히 보급된 뒤 적용한다. ⚠️⚠️
--   • 적용 전 반드시 "구버전(1.0 build4) 사용자 비율"을 확인할 것.
--     1.0(4) 앱은 아직 zones 를 select('*') 로 읽고, content_reports/blocked_users 에 직접 INSERT 한다.
--     이 파일을 적용하면 1.0(4) 에서:
--       - zones 응답에 reporter_ids/safe_voter_ids 가 빠져 클라 차단필터(api.js:59)·소유자 판정이
--         무력화된다(크래시는 아님, 기능 저하).
--       - content_reports/blocked_users 직접 INSERT 가 막혀 1.0(4) 의 신고·차단이 실패한다.
--     → 구버전 사용자가 거의 없을 때 적용할 것.
--   • service_role 과 1단계 RPC(get_visible_zones / submit_content_report / block_zone_owner,
--     전부 SECURITY DEFINER)는 이 변경의 영향을 받지 않는다(테이블 소유자 권한으로 접근).
--
-- 포함 범위(보완 3):
--   A) zones: anon/authenticated 의 컬럼 단위 SELECT 를 재부여해 reporter_ids / safe_voter_ids /
--      admin_confirmed_prev 3개 컬럼을 제외한다. (테이블-SELECT 가 있으면 컬럼 회수가 안 먹히므로
--      테이블 SELECT 를 회수한 뒤 '나머지 컬럼만' GRANT 하는 방식)
--   B) submit_hazard_report / cast_safety_vote 의 반환 jsonb 에서 PII 키 제거.
--   C) content_reports / blocked_users 의 anon/authenticated 직접 INSERT 권한 회수(RPC 로만 쓰기).
--
-- ⚠️ 본문 드리프트 주의: 아래 A 의 컬럼 목록과 B 의 함수 본문은 2026-10-01 저장소 기준이다.
--    적용 시점에 운영 실제 스키마/정의와 반드시 대조할 것.
--      - 컬럼 목록:  SELECT column_name FROM information_schema.columns
--                     WHERE table_schema='public' AND table_name='zones' ORDER BY ordinal_position;
--      - 함수 정의:  SELECT pg_get_functiondef('public.submit_hazard_report(...)'::regprocedure);
--                     SELECT pg_get_functiondef('public.cast_safety_vote(text)'::regprocedure);
--    본문이 바뀌었으면 '운영 본문에 RETURN 변경만' 반영해 적용한다(B 의 핵심 변경은 RETURN 한 줄).
--
-- 적용 순서(그때): 스테이징 → smoke-test(앱 1.0.1 로 지도/신고/차단/투표 정상) → 운영.
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

-- ── A) zones 컬럼 단위 SELECT (PII 3개 제외) ──────────────────────────────────
-- 테이블-SELECT 를 회수하고, PII 를 뺀 나머지 컬럼만 재부여한다.
-- (제외: reporter_ids, safe_voter_ids, admin_confirmed_prev)
REVOKE SELECT ON public.zones FROM anon, authenticated;
GRANT SELECT (
  id, lat, lng, title, type, description, address, severity,
  report_count, safe_votes, status, confirmation,
  pass_count, last_activity_at, created_at, admin_confirmed_at
) ON public.zones TO anon, authenticated;
-- service_role 은 테이블 전체 SELECT 를 유지(DEFAULT PRIVILEGES). 확인:
--   SELECT grantee, privilege_type, column_name FROM information_schema.column_privileges
--    WHERE table_schema='public' AND table_name='zones' AND grantee IN ('anon','authenticated');

-- ── B) RPC 반환에서 PII 제거 (RETURN 한 줄만 변경 — 본문은 적용 시 운영본과 대조) ─────
-- to_jsonb(v_zone) 에서 PII 키 3개를 빼고 반환한다: (- 'reporter_ids' - 'safe_voter_ids' - 'admin_confirmed_prev')
--
--   submit_hazard_report: ... RETURN jsonb_build_object(
--       'action', v_action,
--       'zone',   to_jsonb(v_zone) - 'reporter_ids' - 'safe_voter_ids' - 'admin_confirmed_prev'
--     );
--   cast_safety_vote:     ... RETURN jsonb_build_object(
--       'zone',    to_jsonb(v_zone) - 'reporter_ids' - 'safe_voter_ids' - 'admin_confirmed_prev',
--       'cleared', (v_status = 'cleared')
--     );
--
-- ⚠️ 아래는 2026-10-01 저장소 기준 전체 정의(바로 쓰지 말고 운영본과 대조 후 사용).
-- ───────────────────────────────────────────────────────────────────────────
-- (submit_hazard_report — 30m 같은 유형 병합 버전; reference/prod_submit_hazard_report.sql 과 동일 본문)
-- CREATE OR REPLACE FUNCTION public.submit_hazard_report(... 전체 ...)
--   ... (본문 동일) ...
--   RETURN jsonb_build_object('action', v_action,
--     'zone', to_jsonb(v_zone) - 'reporter_ids' - 'safe_voter_ids' - 'admin_confirmed_prev');
-- END $function$;
--
-- (cast_safety_vote — 20260917_review_lockdown.sql 본문)
-- CREATE OR REPLACE FUNCTION public.cast_safety_vote(p_zone_id text) ...
--   ... (본문 동일) ...
--   RETURN jsonb_build_object(
--     'zone', to_jsonb(v_zone) - 'reporter_ids' - 'safe_voter_ids' - 'admin_confirmed_prev',
--     'cleared', (v_status = 'cleared'));
-- END $$;
--
-- 적용 담당자: 위 두 함수의 '운영 pg_get_functiondef 출력'을 가져와 RETURN 줄만 위와 같이 바꾼 뒤
--             이 BEGIN/COMMIT 블록 안에 CREATE OR REPLACE 로 넣어 실행한다.

-- ── C) content_reports / blocked_users 직접 INSERT 회수 (RPC 전용 쓰기) ────────
-- 1.0.1 은 submit_content_report / block_zone_owner RPC 로만 쓴다. 직접 INSERT 는 차단.
-- SELECT/DELETE(본인 목록 조회·차단 해제)는 유지 — 차단 해제는 여전히 테이블 DELETE 를 쓴다.
REVOKE INSERT ON public.content_reports FROM anon, authenticated;
REVOKE INSERT ON public.blocked_users   FROM anon, authenticated;
-- (참고) 현재 권한:
--   content_reports: authenticated 에 INSERT, SELECT  → INSERT 만 회수(SELECT 유지)
--   blocked_users:   authenticated 에 SELECT, INSERT, DELETE → INSERT 만 회수(SELECT/DELETE 유지)
-- service_role 은 ALL 유지.

COMMIT;

NOTIFY pgrst, 'reload schema';

-- ═══════════════════════════════════════════════════════════════════════════
-- 롤백 SQL (2단계 되돌리기)
--   BEGIN;
--     -- A) zones 테이블 SELECT 복구
--     GRANT SELECT ON public.zones TO anon, authenticated;
--     -- C) 직접 INSERT 복구
--     GRANT INSERT ON public.content_reports TO authenticated;
--     GRANT INSERT ON public.blocked_users   TO authenticated;
--     -- B) 함수 RETURN 을 PII 포함 버전으로 되돌리려면 1단계 이전 정의를 CREATE OR REPLACE
--   COMMIT;
--   NOTIFY pgrst, 'reload schema';
-- ═══════════════════════════════════════════════════════════════════════════
