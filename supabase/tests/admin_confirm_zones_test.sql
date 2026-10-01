-- ═══════════════════════════════════════════════════════════════════════════
-- Safe Ride — 운영자 확인(admin_confirm_zone / admin_unconfirm_zone) 검증 (대시보드용)
--
-- 실행: Supabase SQL Editor 에 통째로 붙여넣고 Run.
--   • 단일 DO 블록. 마지막에 일부러 RAISE EXCEPTION 'TEST RESULT: ...' 로 끝낸다.
--     → 트랜잭션 전체 롤백 → 테스트 데이터가 남지 않고, 결과는 그 '에러 메시지'로 표시된다.
--       **이 에러는 정상(=성공 실행)이다.** 각 CASE 가 PASS 인지 확인하면 된다.
--
-- 전제:
--   • 20261001_admin_confirm_zones.sql 을 먼저 이 프로젝트(스테이징)에 적용해 둘 것.
--   • 아래 c_u1 / c_u2 는 이 프로젝트 auth.users 에 '실제 존재'하는 유저 UUID 여야 한다
--     (submit_hazard_report / cast_safety_vote 내부 profiles INSERT 가 FK 를 타므로).
--     확인:  select id, email from auth.users order by created_at limit 5;
--   • 교체 위치는 아래 상수 선언 '한 곳' 뿐이다.
--   • 테스트 좌표는 서해 해상(위험구역 없음)으로 잡아 실제 마커와 간섭하지 않는다.
-- ═══════════════════════════════════════════════════════════════════════════

DO $$
DECLARE
  -- ▼▼▼ 교체 위치 (여기 한 곳만) ▼▼▼ ------------------------------------------
  c_u1     constant uuid := 'a7ace137-e15c-4e4e-9812-1fa0ba6332cb';  -- 실제 유저1 UUID
  c_email1 constant text := 'smoke-preflight+1ninnyhz@example.com';
  c_u2     constant uuid := '4074c9ad-cd20-4121-aa85-53d3b0d3ffd2';  -- 실제 유저2 UUID (c_u1 과 달라야 함)
  c_email2 constant text := 'smoke-preflight+3rd7jbou@example.com';
  -- ▲▲▲ 교체 위치 끝 ▲▲▲ ------------------------------------------------------

  v_result   text := E'\n';
  v_zone     zones%ROWTYPE;
  v_pts_start bigint;
  v_pts_mid   bigint;
BEGIN
  -- profiles 포인트 총합 스냅샷(운영자 확인/해제가 profiles 를 건드리지 않는지 검증용).
  SELECT coalesce(sum(contribution_points), 0) INTO v_pts_start FROM profiles;

  -- ── 시드: 테스트 zone 들을 직접 INSERT (해상 좌표, 90일 지난 활동시각) ────────
  INSERT INTO zones (id, lat, lng, title, type, status, confirmation, reporter_ids,
                     safe_votes, safe_voter_ids, report_count, last_activity_at, created_at)
  VALUES
    ('ztest-a', 33.0000, 124.5000, 'A 미확인', 'pothole', 'active', 'unconfirmed', '{}',
       0, '{}', 1, now() - interval '100 days', now() - interval '100 days'),
    ('ztest-b', 33.0100, 124.5000, 'B 확정', 'pothole', 'active', 'confirmed', '{}',
       0, '{}', 2, now() - interval '100 days', now() - interval '100 days'),
    ('ztest-e', 33.0200, 124.5000, 'E 미확인(해제대상아님)', 'pothole', 'active', 'unconfirmed', '{}',
       0, '{}', 1, now(), now()),
    ('ztest-f', 33.0300, 124.5000, 'F 검토필요', 'pothole', 'active', 'review_needed', '{}',
       0, '{}', 1, now(), now()),
    ('ztest-g', 33.0400, 124.5000, 'G 만료됨', 'pothole', 'expired', 'unconfirmed', '{}',
       0, '{}', 1, now(), now()),
    ('ztest-h', 33.1000, 124.6000, 'H 운영확인(병합대상)', 'other', 'active', 'unconfirmed',
       ARRAY[c_u1::text], 0, '{}', 1, now(), now()),
    ('ztest-i', 33.2000, 124.7000, 'I 안전투표', 'pothole', 'active', 'confirmed', '{}',
       2, ARRAY['00000000-0000-0000-0000-000000000011',
               '00000000-0000-0000-0000-000000000012'],
       1, now(), now());
  UPDATE zones SET admin_confirmed_at = now() WHERE id = 'ztest-i';  -- 안전투표가 admin 확인 마커도 cleared 하는지

  -- ── CASE A: 미확인 → 운영자 확인 ───────────────────────────────────────────
  PERFORM admin_confirm_zone('ztest-a');
  SELECT * INTO v_zone FROM zones WHERE id = 'ztest-a';
  v_result := v_result || CASE WHEN v_zone.confirmation = 'confirmed'
      AND v_zone.admin_confirmed_at IS NOT NULL
      AND v_zone.admin_confirmed_prev = 'unconfirmed'
      AND v_zone.last_activity_at > now() - interval '1 minute'
    THEN 'CASE A PASS: 미확인→확인 (prev=unconfirmed, 90일 연장)'
    ELSE 'CASE A FAIL: conf=' || coalesce(v_zone.confirmation,'NULL')
         || ' prev=' || coalesce(v_zone.admin_confirmed_prev,'NULL')
         || ' at=' || coalesce(v_zone.admin_confirmed_at::text,'NULL') END || E'\n';

  -- ── CASE B: 이미 확정된 마커 확인 → prev='confirmed', 만료 연장 ─────────────
  PERFORM admin_confirm_zone('ztest-b');
  SELECT * INTO v_zone FROM zones WHERE id = 'ztest-b';
  v_result := v_result || CASE WHEN v_zone.confirmation = 'confirmed'
      AND v_zone.admin_confirmed_prev = 'confirmed'
      AND v_zone.last_activity_at > now() - interval '1 minute'
    THEN 'CASE B PASS: 확정 마커 재확인 (prev=confirmed, 90일 연장)'
    ELSE 'CASE B FAIL: prev=' || coalesce(v_zone.admin_confirmed_prev,'NULL')
         || ' last_activity=' || coalesce(v_zone.last_activity_at::text,'NULL') END || E'\n';

  -- ── CASE C: 재확인 시 prev 가 오염되지 않음 (ztest-a 를 다시 확인) ──────────
  PERFORM admin_confirm_zone('ztest-a');
  SELECT * INTO v_zone FROM zones WHERE id = 'ztest-a';
  v_result := v_result || CASE WHEN v_zone.admin_confirmed_prev = 'unconfirmed'
    THEN 'CASE C PASS: 재확인해도 prev 유지(=unconfirmed)'
    ELSE 'CASE C FAIL: prev=' || coalesce(v_zone.admin_confirmed_prev,'NULL') || ' (기대 unconfirmed)' END || E'\n';

  -- ── CASE D: 해제 → 직전 값(unconfirmed) 복원, 플래그 초기화 ─────────────────
  PERFORM admin_unconfirm_zone('ztest-a');
  SELECT * INTO v_zone FROM zones WHERE id = 'ztest-a';
  v_result := v_result || CASE WHEN v_zone.confirmation = 'unconfirmed'
      AND v_zone.admin_confirmed_at IS NULL
      AND v_zone.admin_confirmed_prev IS NULL
    THEN 'CASE D PASS: 해제→unconfirmed 복원, 플래그 초기화'
    ELSE 'CASE D FAIL: conf=' || coalesce(v_zone.confirmation,'NULL')
         || ' at=' || coalesce(v_zone.admin_confirmed_at::text,'NULL')
         || ' prev=' || coalesce(v_zone.admin_confirmed_prev,'NULL') END || E'\n';

  -- ── CASE E: 운영자 확인 아닌 마커 해제 → 예외 ──────────────────────────────
  BEGIN
    PERFORM admin_unconfirm_zone('ztest-e');
    v_result := v_result || 'CASE E FAIL: 예외가 발생하지 않음' || E'\n';
  EXCEPTION WHEN others THEN
    v_result := v_result || CASE WHEN SQLERRM = '운영자 확인 상태가 아닙니다'
      THEN 'CASE E PASS: 미확인 마커 해제 거부 (' || SQLERRM || ')'
      ELSE 'CASE E FAIL: 다른 예외 (' || SQLERRM || ')' END || E'\n';
  END;

  -- ── CASE F: 검토필요 → 확인 → 해제 시 review_needed 복원 ───────────────────
  PERFORM admin_confirm_zone('ztest-f');
  SELECT * INTO v_zone FROM zones WHERE id = 'ztest-f';
  v_result := v_result || CASE WHEN v_zone.confirmation = 'confirmed'
      AND v_zone.admin_confirmed_prev = 'review_needed'
    THEN 'CASE F-1 PASS: 검토필요→확인 (prev=review_needed)'
    ELSE 'CASE F-1 FAIL: conf=' || coalesce(v_zone.confirmation,'NULL')
         || ' prev=' || coalesce(v_zone.admin_confirmed_prev,'NULL') END || E'\n';
  PERFORM admin_unconfirm_zone('ztest-f');
  SELECT * INTO v_zone FROM zones WHERE id = 'ztest-f';
  v_result := v_result || CASE WHEN v_zone.confirmation = 'review_needed'
    THEN 'CASE F-2 PASS: 해제→review_needed 복원'
    ELSE 'CASE F-2 FAIL: conf=' || coalesce(v_zone.confirmation,'NULL') || ' (기대 review_needed)' END || E'\n';

  -- ── CASE G: 비활성(expired) 마커 확인 → 예외 ───────────────────────────────
  BEGIN
    PERFORM admin_confirm_zone('ztest-g');
    v_result := v_result || 'CASE G FAIL: 예외가 발생하지 않음' || E'\n';
  EXCEPTION WHEN others THEN
    v_result := v_result || CASE WHEN SQLERRM LIKE '활성 상태(active) 마커만%'
      THEN 'CASE G PASS: expired 마커 확인 거부'
      ELSE 'CASE G FAIL: 다른 예외 (' || SQLERRM || ')' END || E'\n';
  END;

  -- ── CASE PROFILES: 여기까지(확인/해제 전용) profiles 포인트 불변 ───────────
  SELECT coalesce(sum(contribution_points), 0) INTO v_pts_mid FROM profiles;
  v_result := v_result || CASE WHEN v_pts_mid = v_pts_start
    THEN 'CASE PROFILES PASS: 운영자 확인/해제가 profiles 를 건드리지 않음'
    ELSE 'CASE PROFILES FAIL: 합계 ' || v_pts_start || ' → ' || v_pts_mid END || E'\n';

  -- ── CASE PERM: EXECUTE 권한이 service_role 전용인지 ────────────────────────
  v_result := v_result || CASE
      WHEN has_function_privilege('authenticated', 'public.admin_confirm_zone(text)',   'EXECUTE') = false
       AND has_function_privilege('anon',          'public.admin_confirm_zone(text)',   'EXECUTE') = false
       AND has_function_privilege('authenticated', 'public.admin_unconfirm_zone(text)', 'EXECUTE') = false
       AND has_function_privilege('anon',          'public.admin_unconfirm_zone(text)', 'EXECUTE') = false
       AND has_function_privilege('service_role',  'public.admin_confirm_zone(text)',   'EXECUTE') = true
       AND has_function_privilege('service_role',  'public.admin_unconfirm_zone(text)', 'EXECUTE') = true
    THEN 'CASE PERM PASS: anon/authenticated 거부, service_role 허용'
    ELSE 'CASE PERM FAIL: 권한 설정 확인 필요' END || E'\n';

  -- ── CASE MERGE: 운영자 확인 마커에 일반 신고 병합 → confirmed 유지 ─────────
  -- ztest-h(type=other, 신고자 c_u1 1명)를 운영자 확인한 뒤, c_u2 가 20m 지점에 같은 유형 신고.
  -- other 승격 기준은 3명 → 신고자 2명으로는 일반 승격 불가. '운영자 확인' 덕분에 confirmed 유지.
  PERFORM admin_confirm_zone('ztest-h');
  PERFORM set_config('request.jwt.claims',
    format('{"sub":"%s","role":"authenticated","email":"%s"}', c_u2, c_email2), true);
  PERFORM submit_hazard_report('other', 33.10018, 124.6000, '', 'medium', '', 10);  -- ≈20m, 병합
  PERFORM set_config('request.jwt.claims', NULL, true);
  SELECT * INTO v_zone FROM zones WHERE id = 'ztest-h';
  v_result := v_result || CASE WHEN v_zone.confirmation = 'confirmed'
      AND v_zone.admin_confirmed_at IS NOT NULL
      AND coalesce(array_length(v_zone.reporter_ids, 1), 0) = 2
      AND v_zone.report_count >= 2
    THEN 'CASE MERGE PASS: 일반 신고 병합 후에도 confirmed 유지(신고자 2명/3명 기준)'
    ELSE 'CASE MERGE FAIL: conf=' || coalesce(v_zone.confirmation,'NULL')
         || ' admin_at=' || coalesce(v_zone.admin_confirmed_at::text,'NULL')
         || ' reporters=' || coalesce(array_length(v_zone.reporter_ids,1),0)
         || ' report_count=' || coalesce(v_zone.report_count,0) END || E'\n';

  -- ── CASE VOTE: 운영자 확인 마커도 안전투표 3표면 cleared ────────────────────
  -- ztest-i: safe_votes=2(가짜 voter 2) + admin 확인됨. c_u1 이 3번째 표 → cleared.
  PERFORM set_config('request.jwt.claims',
    format('{"sub":"%s","role":"authenticated","email":"%s"}', c_u1, c_email1), true);
  PERFORM cast_safety_vote('ztest-i');
  PERFORM set_config('request.jwt.claims', NULL, true);
  SELECT * INTO v_zone FROM zones WHERE id = 'ztest-i';
  v_result := v_result || CASE WHEN v_zone.status = 'cleared'
      AND v_zone.confirmation = 'confirmed'           -- 투표는 confirmation 을 건드리지 않음
      AND v_zone.admin_confirmed_at IS NOT NULL
    THEN 'CASE VOTE PASS: 안전투표 3표 → cleared (confirmation/admin 플래그 불변)'
    ELSE 'CASE VOTE FAIL: status=' || coalesce(v_zone.status,'NULL')
         || ' conf=' || coalesce(v_zone.confirmation,'NULL')
         || ' admin_at=' || coalesce(v_zone.admin_confirmed_at::text,'NULL') END || E'\n';

  -- 결과를 에러로 던져 전체 롤백 + 한 번에 표시 (이 에러는 정상이다).
  RAISE EXCEPTION 'TEST RESULT: %', v_result;
END $$;
