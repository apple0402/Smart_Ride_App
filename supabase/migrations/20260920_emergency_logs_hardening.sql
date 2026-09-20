-- ═══════════════════════════════════════════════════════════════════════════
-- Safe Ride — emergency_logs 보안 보완 (S1 SELECT 축소 + S3 INSERT 강화·권한 최소화)
--
-- 배경(확정된 운영 상태):
--   • RLS 켜짐. emergency_logs_select = USING (auth.uid() IS NOT NULL)
--       → 로그인만 하면 '타인·익명 SOS 행까지 전부' 열람 가능.
--   • emergency_logs_insert = WITH CHECK (true)
--       → 아무 user_id 로나 삽입 가능(타인 사칭 SOS 위조 가능).
--   • anon/authenticated 가 INSERT/SELECT 외 TRUNCATE/TRIGGER/REFERENCES 등 과잉 권한 보유
--       → anon 키만으로 TRUNCATE(전 SOS 기록 삭제) 가능. TRUNCATE 는 RLS 를 우회함.
--
-- 방침(승인됨):
--   S1) SELECT 는 '본인 행'만.          (익명 행은 service_role 만 조회 → 관제 연동은 그 키로)
--   S3) INSERT 는 '본인 id 또는 익명(NULL)'만. 로그인 유저는 자기 id 만, 비로그인은 NULL 만.
--        → 비로그인 SOS(안전 기능)는 유지(S4 판단), 타인 사칭만 차단.
--   S3) 권한은 REVOKE ALL 후 최소 GRANT 재부여(INSERT + authenticated SELECT 만).
--
-- 멱등: DROP POLICY IF EXISTS → CREATE, REVOKE/GRANT 는 재실행 무해.
-- 원자성: 전 구간을 BEGIN/COMMIT 로 감싼다. REVOKE 성공 후 GRANT 실패 등 중간 실패 시
--         전체 롤백되어 '권한이 빈 상태'로 남지 않는다(앱 INSERT 전면 차단 방지).
-- 적용: 스테이징 → smoke-test 통과 확인 후 운영은 직접 적용(이 파일은 실행하지 않음).
-- ⚠️ 적용 '직전'에 아래 스냅샷 쿼리로 현재 권한을 보관할 것(롤백 기준값):
--     SELECT grantee, privilege_type FROM information_schema.role_table_grants
--       WHERE table_schema='public' AND table_name='emergency_logs'
--         AND grantee IN ('anon','authenticated') ORDER BY grantee, privilege_type;
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

-- ── S1) SELECT: 본인 행만 ─────────────────────────────────────────────────────
DROP POLICY IF EXISTS "emergency_logs_select" ON public.emergency_logs;
CREATE POLICY "emergency_logs_select" ON public.emergency_logs
  FOR SELECT USING (auth.uid() = user_id);

-- ── S3-a) INSERT: 본인 id 또는 익명(NULL)만 ──────────────────────────────────
--   로그인(auth.uid()=X): user_id 는 X 여야 통과(다른 id 사칭 거부).
--   비로그인(auth.uid() IS NULL): user_id 는 NULL 이어야 통과(임의 id 삽입 거부).
DROP POLICY IF EXISTS "emergency_logs_insert" ON public.emergency_logs;
CREATE POLICY "emergency_logs_insert" ON public.emergency_logs
  FOR INSERT WITH CHECK (
    user_id = auth.uid()
    OR (auth.uid() IS NULL AND user_id IS NULL)
  );

-- ── S3-b) 권한 최소화: 전부 회수 후 필요한 것만 재부여 ────────────────────────
--   회수 대상(과잉): anon/authenticated 의 SELECT(anon)·UPDATE·DELETE·TRUNCATE·TRIGGER·REFERENCES.
--   재부여: INSERT(anon+authenticated, SOS 저장) · SELECT(authenticated 만, 행 접근은 위 정책이 통제).
--   회수 대상은 anon, authenticated 뿐 — service_role/postgres 는 건드리지 않는다.
--   service_role 은 20260918_restore_api_role_grants.sql 의 GRANT ALL 로 전권 유지(관제·delete-account).
REVOKE ALL ON public.emergency_logs FROM anon, authenticated;
GRANT INSERT ON public.emergency_logs TO anon, authenticated;
GRANT SELECT ON public.emergency_logs TO authenticated;

COMMIT;

-- PostgREST 스키마 캐시 갱신(권한/정책 변경 즉시 반영) — 커밋 이후에 발송
NOTIFY pgrst, 'reload schema';

-- ═══════════════════════════════════════════════════════════════════════════
-- 롤백 SQL (변경 전 상태로 되돌리기 — 필요 시 아래를 실행)
--
--   BEGIN;
--
--   -- 정책 원복(운영 원상태) — 아래 두 식은 확정된 사실이므로 그대로 사용
--   DROP POLICY IF EXISTS "emergency_logs_select" ON public.emergency_logs;
--   CREATE POLICY "emergency_logs_select" ON public.emergency_logs
--     FOR SELECT USING (auth.uid() IS NOT NULL);          -- 원래: 로그인이면 전 행 열람
--
--   DROP POLICY IF EXISTS "emergency_logs_insert" ON public.emergency_logs;
--   CREATE POLICY "emergency_logs_insert" ON public.emergency_logs
--     FOR INSERT WITH CHECK (true);                       -- 원래: 무제한 삽입
--
--   -- 권한 원복: 적용 직전 스냅샷 기준(anon/authenticated 동일). postgres/service_role 은
--   --   애초에 REVOKE 대상이 아니었으므로 롤백에서도 건드리지 않는다.
--   REVOKE ALL ON public.emergency_logs FROM anon, authenticated;
--   GRANT INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE ON public.emergency_logs TO anon, authenticated;
--
--   COMMIT;
--   NOTIFY pgrst, 'reload schema';
-- ═══════════════════════════════════════════════════════════════════════════
