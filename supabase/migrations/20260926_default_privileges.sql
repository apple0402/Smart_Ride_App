-- ═══════════════════════════════════════════════════════════════════════════
-- Safe Ride — DEFAULT PRIVILEGES 회수 (신규 테이블 자동 권한 차단)
--
-- 배경:
--   20260918_restore_api_role_grants.sql 이 아래를 설정해 두었다:
--     ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO anon, authenticated;
--   그 결과 postgres(마이그레이션 실행 롤)가 public 에 만드는 '신규' 테이블은
--   자동으로 anon/authenticated 에게 SELECT 가 부여된다 → RLS 를 깜빡 켜지 않으면
--   신규 테이블이 무방비로 노출될 수 있다(과거 reports/zones 노출과 동일한 함정).
--
-- 조치:
--   앞으로 postgres 가 public 에 만드는 테이블의 DEFAULT PRIVILEGES 에서
--   anon/authenticated 의 모든 권한을 회수한다. 신규 테이블은 CLAUDE.md 규칙대로
--   '필요한 권한만 명시적으로 GRANT' 하도록 강제된다.
--
-- ⚠️ 이 문장은 '앞으로 생성될' 객체의 기본값만 바꾼다.
--    → 이미 존재하는 테이블(zones/reports/rides/profiles/emergency_logs/
--      content_reports/blocked_users/agents* 등)의 현재 권한에는 아무 영향이 없다.
--      기존 권한은 각 테이블에 이미 부여된 GRANT/REVOKE 상태 그대로 유지된다.
--
-- ⚠️ 대상 롤 주의: ALTER DEFAULT PRIVILEGES 는 'FOR ROLE <객체 생성자>' 기준이다.
--    20260918 파일이 FOR ROLE 없이(=현재 롤=postgres) 설정했으므로, 이를 되돌리려면
--    동일하게 postgres 를 대상으로 회수해야 한다. supabase 마이그레이션은 postgres 로
--    실행되므로 'for role postgres' 로 명시한다.
--
-- 멱등: 재실행해도 동일 상태(회수의 회수는 없음). 관련 규칙: CLAUDE.md 참조.
-- 적용: 스테이징 → smoke-test 통과 확인 후 운영은 직접 적용(이 파일은 실행하지 않음).
-- ═══════════════════════════════════════════════════════════════════════════

alter default privileges for role postgres in schema public
  revoke all on tables from anon, authenticated;

-- PostgREST 스키마 캐시 갱신(기본 권한 변경 반영) — 즉시 효과가 필요하진 않으나 관례상 발송
-- NOTIFY pgrst, 'reload schema';

-- ═══════════════════════════════════════════════════════════════════════════
-- 롤백 SQL (기본 SELECT 부여를 되살릴 때 — 권장하지 않음)
--
--   alter default privileges for role postgres in schema public
--     grant select on tables to anon, authenticated;
-- ═══════════════════════════════════════════════════════════════════════════
