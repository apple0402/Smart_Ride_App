-- ═══════════════════════════════════════════════════════════════════════════
-- Safe Ride — 오래된(90일 비활동) 마커 자동 만료 스케줄 등록 (기록용)
--
-- 적용 이력:
--   • 2026-10-03 운영(samrt-rider-DB, jidpwflthppsltdayhoy)에 SQL Editor 로 직접 적용 완료.
--   • 스테이징(safe-ride-staging) 미적용.
--   • 등록 확인: cron.job 에 jobid=2, active=true 로 등록됨.
--   • 적용 전 만료 대상 0개 확인(운영자 재확인 54개 수행 후 — last_activity_at 연장됨).
--
-- 실행 시각: '40 18 * * *' (UTC) = 한국시간(KST) 매일 03:40.
--
-- 이 파일은 사후 기록용이다. 자동 실행되지 않으며 재실행 금지(cron.schedule 중복 등록 방지).
-- ═══════════════════════════════════════════════════════════════════════════

SELECT cron.schedule('expire-stale-zones', '40 18 * * *', $$SELECT public.expire_stale_zones()$$);
