-- ⚠️ 재실행 금지 — 20260926_prod_rls_lockdown의 권한 회수를 되돌림
--    (line 32의 GRANT SELECT ON ALL TABLES ... TO anon, authenticated 등이
--     reports/rides/profiles에 대한 anon SELECT를 재개방한다.)
-- ═══════════════════════════════════════════════════════════════════════════
-- Safe Ride — API 롤(service_role / authenticated / anon) 테이블 권한 복원
--
-- 문제(확정):
--   public 스키마 테이블의 DML GRANT(SELECT/INSERT/UPDATE/DELETE)가 소유자(postgres)
--   에게만 있고 service_role 에는 누락되어 있었다(service_role 은 TRUNCATE/REFERENCES/
--   TRIGGER 만 보유). 그 결과:
--     • Edge Function(delete-account)의 rides.delete / reports.update 등 PostgREST
--       직접 접근이 "permission denied for table ..." 로 실패.
--     • 관리(service) 조회(profiles 등)가 permission denied → 앱/테스트에서 null.
--   ※ SECURITY DEFINER RPC 는 소유자(postgres)로 실행되므로 정상 동작 → 문제가 가려짐.
--   ※ RLS 가 아니라 GRANT 문제다. service_role 은 BYPASSRLS 라 GRANT 만 있으면 RLS 를
--     우회하므로, 아래 GRANT 로 [7][8][9][11] 이 함께 해결된다.
--
-- 방침:
--   • service_role: 전체 테이블/시퀀스 권한(관리·Edge Function 용).
--   • authenticated/anon: Supabase 표준 최소 권한(행 접근은 RLS 정책이 통제).
--   • DEFAULT PRIVILEGES 로 향후 생성 객체에도 자동 적용 → 재발 방지.
--   모든 문장은 GRANT 라 재실행해도 무해(멱등).
-- ═══════════════════════════════════════════════════════════════════════════

-- 스키마 사용 권한(누락 대비)
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;

-- ── service_role: 전체 권한 (RLS 는 BYPASSRLS 로 우회) ────────────────────────
GRANT ALL PRIVILEGES ON ALL TABLES    IN SCHEMA public TO service_role;
GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO service_role;
GRANT ALL PRIVILEGES ON ALL ROUTINES  IN SCHEMA public TO service_role;

-- ── authenticated / anon: 표준 권한 (행 접근은 RLS 가 통제) ───────────────────
--   읽기: 지도 마커/신고/본인 프로필 표시. (profiles_select 는 본인 행만 노출)
GRANT SELECT ON ALL TABLES IN SCHEMA public TO anon, authenticated;
--   앱이 직접 INSERT 하는 테이블(각 RLS 정책이 '본인/허용' 만 통과시킴):
--     rides_insert(WITH CHECK auth.uid()=user_id), emergency_logs_insert(WITH CHECK true)
GRANT INSERT ON public.rides          TO authenticated;
GRANT INSERT ON public.emergency_logs TO anon, authenticated;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO authenticated;

-- ── 향후 생성되는 객체에도 자동 적용 (재발 방지) ─────────────────────────────
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL PRIVILEGES ON TABLES    TO service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL PRIVILEGES ON SEQUENCES TO service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL PRIVILEGES ON ROUTINES  TO service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO anon, authenticated;

-- PostgREST 스키마 캐시 갱신(권한 변경 즉시 반영)
NOTIFY pgrst, 'reload schema';
