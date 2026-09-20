-- ═══════════════════════════════════════════════════════════════════════════
-- Safe Ride — 리포터 랭킹 익명화 (get_leaderboard 에서 name 반환 제거)
--
-- 배경: 랭킹이 profiles.name(가입 시 표시명)을 반환해 모든 로그인 사용자에게 공개됐다.
--       타 사용자에게 보이는 UGC(표시명)를 없애기 위해 name 을 반환에서 제거한다.
--       클라이언트는 순번 기반 "라이더 N" 라벨을 자체 생성한다.
--
-- ⚠️ name 제거 외에는 아무것도 바뀌지 않는다:
--    • 반환 필드 순서: contribution_points → confirmed_reports → points (기존과 동일, name 만 빠짐)
--    • 정렬 기준: contribution_points DESC, confirmed_reports DESC (동일)
--    • LIMIT 클램프: greatest(1, least(p_limit, 100)) (동일)
--    • 반환 타입 jsonb / LANGUAGE sql / SECURITY DEFINER / search_path (동일)
--    • CREATE OR REPLACE 는 기존 EXECUTE 권한(REVOKE PUBLIC / GRANT authenticated)을 보존한다.
--
-- 멱등: CREATE OR REPLACE. 전 구간 BEGIN/COMMIT.
-- 적용: 스테이징 → smoke-test 통과 확인 후 운영은 직접 적용(이 파일은 실행하지 않음).
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

CREATE OR REPLACE FUNCTION get_leaderboard(p_limit integer DEFAULT 20)
RETURNS jsonb
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  SELECT coalesce(jsonb_agg(row_to_json(t)), '[]'::jsonb)
  FROM (
    SELECT coalesce(contribution_points, 0) AS contribution_points,
           coalesce(confirmed_reports, 0)   AS confirmed_reports,
           coalesce(safety_points, 0)       AS points
      FROM profiles
     ORDER BY coalesce(contribution_points, 0) DESC,
              coalesce(confirmed_reports, 0) DESC
     LIMIT greatest(1, least(coalesce(p_limit, 20), 100))
  ) t;
$$;

COMMIT;

-- ═══════════════════════════════════════════════════════════════════════════
-- 롤백 SQL (name 반환 복원 — 필요 시 아래를 실행)
--
--   BEGIN;
--   CREATE OR REPLACE FUNCTION get_leaderboard(p_limit integer DEFAULT 20)
--   RETURNS jsonb
--   LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
--     SELECT coalesce(jsonb_agg(row_to_json(t)), '[]'::jsonb)
--     FROM (
--       SELECT name,
--              coalesce(contribution_points, 0) AS contribution_points,
--              coalesce(confirmed_reports, 0)   AS confirmed_reports,
--              coalesce(safety_points, 0)       AS points
--         FROM profiles
--        ORDER BY coalesce(contribution_points, 0) DESC,
--                 coalesce(confirmed_reports, 0) DESC
--        LIMIT greatest(1, least(coalesce(p_limit, 20), 100))
--     ) t;
--   $$;
--   COMMIT;
-- ═══════════════════════════════════════════════════════════════════════════
