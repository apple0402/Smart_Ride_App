-- ═══════════════════════════════════════════════════════════════════════════
-- Safe Ride — profiles 포인트/검증 컬럼 DEFAULT 0 보증 + NULL 백필 (Part A′)
--
-- 배경:
--   20260917_review_lockdown.sql 의 `ADD COLUMN IF NOT EXISTS ... DEFAULT 0` 은
--   컬럼이 이미(기본값 없이) 존재하던 프로젝트에서는 no-op 이 되어, 신규 프로필 행이
--   NULL 로 생성되었다. 그 상태에서 `contribution_points + 3` 등 증가 연산이
--   `NULL + N = NULL` 이 되어 포인트가 반영되지 않았다([3]/[7]/[8]).
--
-- 조치:
--   컬럼을 (없으면) 생성하고 DEFAULT 0 을 명시적으로 강제한 뒤, 기존 NULL 을 0(신뢰도는
--   1.0)으로 백필한다. 전부 IF NOT EXISTS / coalesce 기반이라 여러 번 실행해도 안전(멱등).
-- ═══════════════════════════════════════════════════════════════════════════

-- 1) 포인트/검증 컬럼: 없으면 생성(DEFAULT 0), 있으면 유지
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS contribution_points  integer          DEFAULT 0;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS activity_points      integer          DEFAULT 0;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS distance_points_paid integer          DEFAULT 0;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS confirmed_reports    integer          DEFAULT 0;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS rejected_reports     integer          DEFAULT 0;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS trust_score          double precision DEFAULT 1.0;

-- 2) 이미 존재하나 DEFAULT 가 없던 경우까지 보정
ALTER TABLE profiles ALTER COLUMN contribution_points  SET DEFAULT 0;
ALTER TABLE profiles ALTER COLUMN activity_points      SET DEFAULT 0;
ALTER TABLE profiles ALTER COLUMN distance_points_paid SET DEFAULT 0;
ALTER TABLE profiles ALTER COLUMN confirmed_reports    SET DEFAULT 0;
ALTER TABLE profiles ALTER COLUMN rejected_reports     SET DEFAULT 0;

-- 3) 기존 행 NULL → 0(신뢰도는 1.0) 백필
UPDATE profiles SET
  contribution_points  = coalesce(contribution_points,  0),
  activity_points      = coalesce(activity_points,      0),
  distance_points_paid = coalesce(distance_points_paid, 0),
  confirmed_reports    = coalesce(confirmed_reports,    0),
  rejected_reports     = coalesce(rejected_reports,     0),
  trust_score          = coalesce(trust_score,          1.0);
