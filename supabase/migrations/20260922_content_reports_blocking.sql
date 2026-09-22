-- ═══════════════════════════════════════════════════════════════════════════
-- Safe Ride — 콘텐츠 신고(content_reports) + 사용자 차단(blocked_users)
--
-- 배경(App Review):
--   Apple App Store 심사(Guideline 2.1)에서 UGC(사용자가 등록한 위험구역 마커)에 대한
--   신고·차단 수단이 없다는 이유로 반려됨. 최소 기능으로 콘텐츠 신고 + 사용자 차단을 추가한다.
--
-- 실제 스키마 반영(요청서 가정과의 차이):
--   • 위험구역 테이블은 zones 이며 id 가 TEXT(uuid 아님) → hazard_id 는 text FK.
--   • 단일 소유자 컬럼이 없고 reporter_ids TEXT[] 배열로 신고자 여러 명을 담는다.
--     "최초 등록자" = reporter_ids[0] (클라이언트가 reported_user_id / blocked_id 로 넘긴다).
--     reporter_ids 가 비었을 수 있어 reported_user_id 는 nullable.
--
-- 방침:
--   • content_reports: 본인(reporter_id=auth.uid())만 insert/select. 운영자 조회는 service_role.
--   • blocked_users:   본인(blocker_id=auth.uid())만 select/insert/delete. 자기 자신 차단 금지(CHECK).
--   • 권한 최소화: DEFAULT PRIVILEGES(20260918_restore_api_role_grants.sql)가 신규 테이블에
--     anon/authenticated 에 SELECT 를 자동 부여하므로, REVOKE ALL 후 필요한 것만 재부여한다.
--     (anon 은 두 테이블 모두 접근 불가 — 로그인 사용자 전용 기능)
--
-- 멱등: CREATE TABLE IF NOT EXISTS / DROP POLICY IF EXISTS → CREATE / GRANT·REVOKE 재실행 무해.
-- 원자성: 전 구간 BEGIN/COMMIT.
-- 적용: 스테이징(okixksradpfzspbticia) → smoke-test 통과 확인 후 운영(jidpwflthppsltdayhoy)에 직접 적용.
--       (이 파일은 자동 실행되지 않는다 — Supabase SQL 에디터에서 수동 실행)
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

-- ── 1) content_reports (콘텐츠 신고) ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.content_reports (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reporter_id      uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,   -- 신고한 사용자
  hazard_id        text REFERENCES public.zones(id) ON DELETE CASCADE,          -- 신고 대상 위험구역(zones.id 는 TEXT)
  reported_user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,           -- 최초 등록자(reporter_ids[0]) — 없을 수 있어 nullable
  reason           text NOT NULL,                                               -- 신고 사유(라디오 라벨)
  detail           text,                                                        -- '기타' 선택 시 자유 입력
  status           text NOT NULL DEFAULT 'pending',                             -- 운영자 상태 변경용(지금은 컬럼만)
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_content_reports_hazard   ON public.content_reports(hazard_id);
CREATE INDEX IF NOT EXISTS idx_content_reports_reporter ON public.content_reports(reporter_id);

ALTER TABLE public.content_reports ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "content_reports_insert" ON public.content_reports;
CREATE POLICY "content_reports_insert" ON public.content_reports
  FOR INSERT WITH CHECK (reporter_id = auth.uid());

DROP POLICY IF EXISTS "content_reports_select" ON public.content_reports;
CREATE POLICY "content_reports_select" ON public.content_reports
  FOR SELECT USING (reporter_id = auth.uid());

-- 권한: REVOKE 후 최소 GRANT (anon 접근 없음, authenticated 는 INSERT/SELECT — 행 접근은 위 정책이 통제)
REVOKE ALL ON public.content_reports FROM anon, authenticated;
GRANT INSERT, SELECT ON public.content_reports TO authenticated;
GRANT ALL ON public.content_reports TO service_role;   -- 운영자 조회/상태변경

-- ── 2) blocked_users (사용자 차단) ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.blocked_users (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  blocker_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,   -- 차단한 사용자
  blocked_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,   -- 차단당한 사용자
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (blocker_id, blocked_id),
  CHECK (blocked_id <> blocker_id)                                        -- 자기 자신 차단 방지
);
CREATE INDEX IF NOT EXISTS idx_blocked_users_blocker ON public.blocked_users(blocker_id);

ALTER TABLE public.blocked_users ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "blocked_users_select" ON public.blocked_users;
CREATE POLICY "blocked_users_select" ON public.blocked_users
  FOR SELECT USING (blocker_id = auth.uid());

DROP POLICY IF EXISTS "blocked_users_insert" ON public.blocked_users;
CREATE POLICY "blocked_users_insert" ON public.blocked_users
  FOR INSERT WITH CHECK (blocker_id = auth.uid());

DROP POLICY IF EXISTS "blocked_users_delete" ON public.blocked_users;
CREATE POLICY "blocked_users_delete" ON public.blocked_users
  FOR DELETE USING (blocker_id = auth.uid());

-- 권한: REVOKE 후 최소 GRANT (본인 목록 조회/차단/해제 — 행 접근은 위 정책이 통제)
REVOKE ALL ON public.blocked_users FROM anon, authenticated;
GRANT SELECT, INSERT, DELETE ON public.blocked_users TO authenticated;
GRANT ALL ON public.blocked_users TO service_role;

COMMIT;

-- PostgREST 스키마 캐시 갱신(테이블/권한/정책 변경 즉시 반영) — 커밋 이후에 발송
NOTIFY pgrst, 'reload schema';

-- ═══════════════════════════════════════════════════════════════════════════
-- 롤백 SQL (두 테이블 및 권한 제거 — 필요 시 아래를 실행)
--
--   BEGIN;
--   DROP TABLE IF EXISTS public.content_reports;   -- 정책·인덱스·GRANT 함께 제거
--   DROP TABLE IF EXISTS public.blocked_users;
--   COMMIT;
--   NOTIFY pgrst, 'reload schema';
-- ═══════════════════════════════════════════════════════════════════════════
