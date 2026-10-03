-- ═══════════════════════════════════════════════════════════════════════════
-- Safe Ride — B4 1단계 검증 (get_visible_zones / submit_content_report / block_zone_owner)
--
-- 실행: Supabase SQL Editor 에 통째로 붙여넣고 Run.
--   • 단일 DO 블록. 마지막에 RAISE EXCEPTION 'TEST RESULT: ...' 로 끝낸다(전체 롤백 → 잔존 없음).
--     이 에러는 정상(=성공 실행). 각 CASE 가 PASS 인지 확인한다.
--
-- 전제:
--   • 20261001_get_visible_zones.sql 을 먼저 이 프로젝트(스테이징)에 적용해 둘 것.
--   • c_u1 / c_u2 는 auth.users 에 실제 존재하는 서로 다른 유저 UUID (profiles/ FK 때문).
--   • 좌표는 서해 해상(실제 마커와 무간섭). get_visible_zones 는 거리필터가 없어 id 로 조회한다.
-- ═══════════════════════════════════════════════════════════════════════════

DO $$
DECLARE
  c_u1     constant uuid := 'a7ace137-e15c-4e4e-9812-1fa0ba6332cb';  -- 실제 유저1
  c_u2     constant uuid := '4074c9ad-cd20-4121-aa85-53d3b0d3ffd2';  -- 실제 유저2

  v_result text := E'\n';
  v_args   text[];
  v_mine   boolean; v_voted boolean; v_owner boolean;
  v_status text; v_cnt integer; v_reported uuid;

  v_claims_u1 constant text := format('{"sub":"%s","role":"authenticated"}', c_u1);
BEGIN
  -- ── 시드: 해상 좌표 active 마커들 ───────────────────────────────────────────
  INSERT INTO zones (id, lat, lng, title, type, status, confirmation, reporter_ids,
                     safe_voter_ids, report_count, last_activity_at, created_at)
  VALUES
    ('zt-mine',   34.0, 124.0, '내 마커',      'pothole', 'active', 'confirmed',
       ARRAY[c_u1::text], '{}', 1, now(), now()),
    ('zt-other',  34.1, 124.0, '남의 마커',    'pothole', 'active', 'confirmed',
       ARRAY[c_u2::text], '{}', 1, now(), now()),
    ('zt-voted',  34.2, 124.0, '내가 투표함',  'pothole', 'active', 'confirmed',
       ARRAY[c_u2::text], ARRAY[c_u1::text], 2, now(), now()),
    ('zt-noowner',34.3, 124.0, '소유자 없음',  'pothole', 'active', 'unconfirmed',
       '{}', '{}', 1, now(), now()),
    ('zt-block',  34.4, 124.0, '차단 대상',    'pothole', 'active', 'confirmed',
       ARRAY[c_u2::text], '{}', 1, now(), now());

  -- ── CASE COLS: 반환 컬럼에 PII 가 없어야 ───────────────────────────────────
  SELECT proargnames INTO v_args FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.proname='get_visible_zones';
  v_result := v_result || CASE
    WHEN NOT ('reporter_ids' = ANY(v_args))
     AND NOT ('safe_voter_ids' = ANY(v_args))
     AND NOT ('admin_confirmed_prev' = ANY(v_args))
     AND ('is_mine' = ANY(v_args)) AND ('i_voted' = ANY(v_args))
     AND ('has_owner' = ANY(v_args)) AND ('admin_confirmed' = ANY(v_args))
    THEN 'CASE COLS PASS: 반환에 PII 없음 + booleans 존재'
    ELSE 'CASE COLS FAIL: ' || array_to_string(v_args, ',') END || E'\n';

  -- ── CASE ANON: 비로그인 → is_mine/i_voted false ────────────────────────────
  PERFORM set_config('request.jwt.claims', '{"role":"anon"}', true);
  SELECT is_mine, i_voted, has_owner INTO v_mine, v_voted, v_owner
    FROM get_visible_zones() WHERE id = 'zt-voted';
  v_result := v_result || CASE WHEN v_mine = false AND v_voted = false AND v_owner = true
    THEN 'CASE ANON PASS: anon is_mine/i_voted=false, has_owner=true'
    ELSE 'CASE ANON FAIL: mine='||v_mine||' voted='||v_voted||' owner='||v_owner END || E'\n';

  -- ── CASE MINE: U1 기준 내 마커 true / 남의 마커 false ──────────────────────
  PERFORM set_config('request.jwt.claims', v_claims_u1, true);
  SELECT is_mine INTO v_mine  FROM get_visible_zones() WHERE id = 'zt-mine';
  SELECT is_mine INTO v_voted FROM get_visible_zones() WHERE id = 'zt-other';  -- 재사용(남의마커 is_mine)
  v_result := v_result || CASE WHEN v_mine = true AND v_voted = false
    THEN 'CASE MINE PASS: 내 마커 is_mine=true, 남의 마커 false'
    ELSE 'CASE MINE FAIL: mine='||v_mine||' other='||v_voted END || E'\n';

  -- ── CASE VOTED: U1 이 투표한 마커 i_voted=true ─────────────────────────────
  SELECT i_voted INTO v_voted FROM get_visible_zones() WHERE id = 'zt-voted';
  v_result := v_result || CASE WHEN v_voted = true
    THEN 'CASE VOTED PASS: i_voted=true' ELSE 'CASE VOTED FAIL: '||v_voted END || E'\n';

  -- ── CASE NOOWNER: 소유자 없는 마커 has_owner=false ─────────────────────────
  SELECT has_owner INTO v_owner FROM get_visible_zones() WHERE id = 'zt-noowner';
  v_result := v_result || CASE WHEN v_owner = false
    THEN 'CASE NOOWNER PASS: has_owner=false' ELSE 'CASE NOOWNER FAIL: '||v_owner END || E'\n';

  -- ── CASE SELF-REPORT: 본인 마커 신고 거부 ──────────────────────────────────
  BEGIN
    PERFORM public.submit_content_report('zt-mine', '기타', '본인신고');
    v_result := v_result || 'CASE SELF-REPORT FAIL: 예외 없음' || E'\n';
  EXCEPTION WHEN others THEN
    v_result := v_result || CASE WHEN SQLERRM = '본인이 등록한 구역은 신고할 수 없습니다'
      THEN 'CASE SELF-REPORT PASS' ELSE 'CASE SELF-REPORT FAIL: '||SQLERRM END || E'\n';
  END;

  -- ── CASE SELF-BLOCK: 본인 마커 차단 거부 ───────────────────────────────────
  BEGIN
    PERFORM public.block_zone_owner('zt-mine');
    v_result := v_result || 'CASE SELF-BLOCK FAIL: 예외 없음' || E'\n';
  EXCEPTION WHEN others THEN
    v_result := v_result || CASE WHEN SQLERRM = '본인은 차단할 수 없습니다'
      THEN 'CASE SELF-BLOCK PASS' ELSE 'CASE SELF-BLOCK FAIL: '||SQLERRM END || E'\n';
  END;

  -- ── CASE NOOWNER-BLOCK: 소유자 없는 마커 차단 거부 ─────────────────────────
  BEGIN
    PERFORM public.block_zone_owner('zt-noowner');
    v_result := v_result || 'CASE NOOWNER-BLOCK FAIL: 예외 없음' || E'\n';
  EXCEPTION WHEN others THEN
    v_result := v_result || CASE WHEN SQLERRM = '차단할 사용자를 찾을 수 없습니다'
      THEN 'CASE NOOWNER-BLOCK PASS' ELSE 'CASE NOOWNER-BLOCK FAIL: '||SQLERRM END || E'\n';
  END;

  -- ── CASE REPORT: 신고 → status=created, reported_user_id = 서버 해석(U2) ────
  SELECT public.submit_content_report('zt-other', '스팸', NULL) ->> 'status' INTO v_status;
  SELECT reported_user_id INTO v_reported
    FROM content_reports WHERE reporter_id = c_u1 AND hazard_id = 'zt-other';
  v_result := v_result || CASE WHEN v_status = 'created' AND v_reported = c_u2
    THEN 'CASE REPORT PASS: created + reported_user_id=서버해석(U2)'
    ELSE 'CASE REPORT FAIL: status='||coalesce(v_status,'NULL')||' reported='||coalesce(v_reported::text,'NULL') END || E'\n';

  -- ── CASE DUP: 같은 마커 재신고 → duplicate, 행 1개 유지 ────────────────────
  SELECT public.submit_content_report('zt-other', '스팸', NULL) ->> 'status' INTO v_status;
  SELECT count(*) INTO v_cnt FROM content_reports WHERE reporter_id = c_u1 AND hazard_id = 'zt-other';
  v_result := v_result || CASE WHEN v_status = 'duplicate' AND v_cnt = 1
    THEN 'CASE DUP PASS: duplicate, 행 1개'
    ELSE 'CASE DUP FAIL: status='||coalesce(v_status,'NULL')||' cnt='||v_cnt END || E'\n';

  -- ── CASE BLOCK: 차단 → 목록 제외, 해제 → 재등장 ───────────────────────────
  PERFORM public.block_zone_owner('zt-block');   -- U1 이 U2 차단 (U2 소유 전부 제외됨)
  SELECT count(*) INTO v_cnt FROM get_visible_zones() WHERE id = 'zt-block';
  v_result := v_result || CASE WHEN v_cnt = 0
    THEN 'CASE BLOCK PASS: 차단 후 목록 제외' ELSE 'CASE BLOCK FAIL: 여전히 보임('||v_cnt||')' END || E'\n';
  DELETE FROM blocked_users WHERE blocker_id = c_u1 AND blocked_id = c_u2;  -- 해제(테이블 DELETE)
  SELECT count(*) INTO v_cnt FROM get_visible_zones() WHERE id = 'zt-block';
  v_result := v_result || CASE WHEN v_cnt = 1
    THEN 'CASE UNBLOCK PASS: 해제 후 재등장' ELSE 'CASE UNBLOCK FAIL: cnt='||v_cnt END || E'\n';

  -- ── CASE PERM: 권한 (get_visible_zones=anon+auth, 나머지=auth only) ─────────
  v_result := v_result || CASE
    WHEN has_function_privilege('anon',          'public.get_visible_zones()', 'EXECUTE') = true
     AND has_function_privilege('authenticated', 'public.get_visible_zones()', 'EXECUTE') = true
     AND has_function_privilege('anon',          'public.submit_content_report(text,text,text)', 'EXECUTE') = false
     AND has_function_privilege('authenticated', 'public.submit_content_report(text,text,text)', 'EXECUTE') = true
     AND has_function_privilege('anon',          'public.block_zone_owner(text)', 'EXECUTE') = false
     AND has_function_privilege('authenticated', 'public.block_zone_owner(text)', 'EXECUTE') = true
    THEN 'CASE PERM PASS: get_visible_zones anon+auth, 나머지 auth 전용'
    ELSE 'CASE PERM FAIL: 권한 확인 필요' END || E'\n';

  PERFORM set_config('request.jwt.claims', NULL, true);
  RAISE EXCEPTION 'TEST RESULT: %', v_result;
END $$;
