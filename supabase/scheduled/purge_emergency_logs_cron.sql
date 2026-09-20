-- ═══════════════════════════════════════════════════════════════════════════
-- Safe Ride — emergency_logs 90일 삭제 pg_cron 스케줄 (마이그레이션과 분리)
--
-- 전제: pg_cron 확장이 활성화돼 있어야 한다(Supabase: Dashboard → Database → Extensions
--       에서 pg_cron 켜기). 확장이 꺼진 상태로 실행하면 실패하므로, 20260921_purge_emergency_logs.sql
--       (함수 정의)과 분리해 pg_cron 활성화 이후에만 이 파일을 실행한다.
--       함수 purge_stale_emergency_logs() 가 먼저 배포돼 있어야 한다.
--
-- 실행: 스테이징 → 동작 확인 → 운영은 직접. (이 파일은 자동 실행하지 않음)
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 스케줄 등록/갱신 (멱등: 같은 job 이름이면 갱신) ──────────────────────────
-- 03:20 UTC = 한국시간(KST) 12:20 매일.
select cron.schedule('purge-stale-emergency-logs', '20 3 * * *', $$select purge_stale_emergency_logs()$$);

-- ── 해제 ──────────────────────────────────────────────────────────────────────
--   select cron.unschedule('purge-stale-emergency-logs');

-- ── 실행 결과 확인 ────────────────────────────────────────────────────────────
-- 등록된 잡 목록/스케줄/활성 여부:
--   select jobname, schedule, active from cron.job;
-- 최근 실행 이력(성공/실패·반환 메시지·시작시각):
--   select jobid, status, return_message, start_time
--     from cron.job_run_details order by start_time desc limit 5;
