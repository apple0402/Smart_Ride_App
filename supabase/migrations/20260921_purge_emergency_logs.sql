-- ═══════════════════════════════════════════════════════════════════════════
-- Safe Ride — emergency_logs 90일 자동 삭제 함수 (expire_stale_zones 와 동일 패턴)
--
-- created_at 이 90일 이상 지난 SOS 로그를 물리 삭제한다.
--   • 로그인 여부 무관 — user_id 조건을 두지 않으므로 user_id NULL(비로그인) 행도 포함.
--   • SECURITY DEFINER + service_role/pg_cron 전용(REVOKE FROM PUBLIC → GRANT service_role).
--   • 삭제 건수(integer) 반환.
-- 멱등: CREATE OR REPLACE + REVOKE/GRANT 재실행 무해. 전 구간 BEGIN/COMMIT.
-- 적용: 스테이징 → smoke-test 통과 확인 후 운영은 직접 적용(이 파일은 실행하지 않음).
--
-- ⚠️ 스케줄(cron.schedule)은 이 파일에 넣지 않는다.
--    스테이징/운영에서 pg_cron 확장 활성화 시점이 다르고, 확장이 꺼져 있으면
--    이 마이그레이션 전체가 실패한다. 스케줄은 supabase/scheduled/purge_emergency_logs_cron.sql
--    로 분리했으니 pg_cron 활성화 후 별도로 실행할 것.
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

CREATE OR REPLACE FUNCTION purge_stale_emergency_logs()
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_count integer;
BEGIN
  DELETE FROM emergency_logs
   WHERE created_at < now() - interval '90 days';
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END $$;

REVOKE EXECUTE ON FUNCTION purge_stale_emergency_logs() FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION purge_stale_emergency_logs() TO service_role;

COMMIT;

-- ═══════════════════════════════════════════════════════════════════════════
-- 롤백 SQL (필요 시 아래를 실행)
--
--   BEGIN;
--   DROP FUNCTION IF EXISTS purge_stale_emergency_logs();
--   COMMIT;
--
--   -- pg_cron 스케줄을 걸었다면 함께 해제(scheduled 파일 참고):
--   --   SELECT cron.unschedule('purge-stale-emergency-logs');
-- ═══════════════════════════════════════════════════════════════════════════
