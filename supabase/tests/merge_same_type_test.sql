-- ═══════════════════════════════════════════════════════════════════════════
-- Safe Ride — submit_hazard_report 같은-유형 병합 검증 (Supabase 대시보드용)
--
-- 실행: Supabase SQL Editor 에 통째로 붙여넣고 Run.
--   • psql 메타명령(\set 등) 없이 단일 DO 블록으로 동작한다.
--   • 마지막에 일부러 RAISE EXCEPTION 'TEST RESULT: ...' 로 끝낸다.
--     → 트랜잭션이 자동 롤백되어 어떤 데이터도 남지 않고, 결과는 그 '에러 메시지'로
--       한 번에 표시된다. **이 에러는 정상(=성공 실행)이며 실패가 아니다.**
--       메시지 안의 각 CASE 가 PASS 인지 확인하면 된다.
--
-- 전제:
--   • 20260926_merge_same_type.sql 을 먼저 이 프로젝트(스테이징)에 적용해 둘 것.
--   • 아래 c_u1 / c_u2 는 이 프로젝트 auth.users 에 '실제 존재'하는 유저 UUID 여야 한다
--     (함수 내부 profiles INSERT 가 profiles.id → auth.users(id) FK 를 타므로).
--     확인:  select id, email from auth.users order by created_at limit 5;
--   • 교체 위치는 아래 상수 선언 '한 곳' 뿐이다.
-- ═══════════════════════════════════════════════════════════════════════════

DO $$
DECLARE
  -- ▼▼▼ 교체 위치 (여기 한 곳만) ▼▼▼ ------------------------------------------
  c_u1     constant uuid := 'a7ace137-e15c-4e4e-9812-1fa0ba6332cb';  -- 실제 유저1 UUID
  c_email1 constant text := 'smoke-preflight+1ninnyhz@example.com';
  c_u2     constant uuid := '4074c9ad-cd20-4121-aa85-53d3b0d3ffd2';  -- 실제 유저2 UUID
  c_email2 constant text := 'smoke-preflight+3rd7jbou@example.com';
  -- ▲▲▲ 교체 위치 끝 ▲▲▲ ------------------------------------------------------

  -- 좌표 설계 (위도만 변화 → 거리 ≈ Δlat × 111,320 m):
  --   A(다른 유형) 37.5000 / B(같은 유형) 37.5100 / C(같은 유형) 37.5200
  --   0.00018°≈20m, 0.00036°≈40m. 클러스터 간 0.01°≈1.1km(상호 간섭 없음).
  --   5분·15m 중복차단, 30m 병합, 일일한도(총 6건)에 걸리지 않게 배치.

  v_result text := E'\n';
  a_cnt    integer;
  b_cnt    integer;
  c_cnt    integer;
  z_rep    integer;
  b_zone   zones%ROWTYPE;
BEGIN
  -- ── 케이스 1: 같은 위치, 다른 유형 → 별도 zone 2개 ──────────────────────────
  PERFORM set_config('request.jwt.claims',
    format('{"sub":"%s","role":"authenticated","email":"%s"}', c_u1, c_email1), true);
  PERFORM submit_hazard_report('pothole',  37.50000, 127.00000, '', 'medium', '', 10);
  PERFORM submit_hazard_report('slippery', 37.50000, 127.00000, '', 'medium', '', 10);

  -- ── 케이스 2: 같은 유형 20m → 병합, 2명 → confirmed ────────────────────────
  PERFORM set_config('request.jwt.claims',
    format('{"sub":"%s","role":"authenticated","email":"%s"}', c_u1, c_email1), true);
  PERFORM submit_hazard_report('construction', 37.51000, 127.00000, '', 'medium', '', 10);

  PERFORM set_config('request.jwt.claims',
    format('{"sub":"%s","role":"authenticated","email":"%s"}', c_u2, c_email2), true);
  PERFORM submit_hazard_report('construction', 37.51018, 127.00000, '', 'medium', '', 10); -- ≈20m

  -- ── 케이스 3: 같은 유형 40m → 별도 zone ────────────────────────────────────
  PERFORM set_config('request.jwt.claims',
    format('{"sub":"%s","role":"authenticated","email":"%s"}', c_u1, c_email1), true);
  PERFORM submit_hazard_report('pothole', 37.52000, 127.00000, '', 'medium', '', 10);

  PERFORM set_config('request.jwt.claims',
    format('{"sub":"%s","role":"authenticated","email":"%s"}', c_u2, c_email2), true);
  PERFORM submit_hazard_report('pothole', 37.52036, 127.00000, '', 'medium', '', 10); -- ≈40m

  -- ── 케이스 4: 같은 유저 재신고 → 예외('이미 신고하신 위험 구역입니다') ───────
  --   B 클러스터 construction zone(중심 37.51000)에 U1 이 20m 지점서 재신고.
  --   20m>15m 라 (2)5분 dedup 통과 → 30m 병합반경 안 + U1 이 이미 reporter → 예외.
  PERFORM set_config('request.jwt.claims',
    format('{"sub":"%s","role":"authenticated","email":"%s"}', c_u1, c_email1), true);
  BEGIN
    PERFORM submit_hazard_report('construction', 37.51018, 127.00000, '', 'medium', '', 10);
    v_result := v_result || 'CASE4 FAIL: 자기재신고 예외가 발생하지 않음' || E'\n';
  EXCEPTION WHEN others THEN
    IF SQLERRM = '이미 신고하신 위험 구역입니다' THEN
      v_result := v_result || 'CASE4 PASS: 자기재신고 차단 (' || SQLERRM || ')' || E'\n';
    ELSE
      v_result := v_result || 'CASE4 FAIL: 다른 예외 (' || SQLERRM || ')' || E'\n';
    END IF;
  END;

  -- ── 검증 조회 (postgres 권한 그대로 — RLS 영향 없음) ───────────────────────
  -- 케이스1: 같은 좌표에 서로 다른 유형 zone 2개
  SELECT count(*) INTO a_cnt FROM zones
   WHERE _haversine_m(lat, lng, 37.50000, 127.00000) < 5;
  v_result := v_result || CASE WHEN a_cnt = 2
    THEN 'CASE1 PASS: 다른 유형 → 별도 zone 2개'
    ELSE 'CASE1 FAIL: A zone 수=' || a_cnt || ' (기대 2)' END || E'\n';

  -- 케이스2: B construction zone 1개(병합) + confirmed + reporters=2 + report_count>=2
  SELECT count(*) INTO b_cnt FROM zones
   WHERE type = 'construction' AND _haversine_m(lat, lng, 37.51000, 127.00000) < 60;
  SELECT * INTO b_zone FROM zones
   WHERE type = 'construction' AND _haversine_m(lat, lng, 37.51000, 127.00000) < 60
   ORDER BY _haversine_m(lat, lng, 37.51000, 127.00000) LIMIT 1;

  v_result := v_result || CASE WHEN b_cnt = 1
    THEN 'CASE2a PASS: 같은 유형 20m → 병합(zone 1개)'
    ELSE 'CASE2a FAIL: B construction zone 수=' || b_cnt || ' (기대 1)' END || E'\n';

  v_result := v_result || CASE WHEN b_zone.confirmation = 'confirmed'
      AND coalesce(array_length(b_zone.reporter_ids, 1), 0) = 2
      AND b_zone.report_count >= 2
    THEN 'CASE2b PASS: 2명 병합 → confirmed (reporters='
         || coalesce(array_length(b_zone.reporter_ids, 1), 0)
         || ', report_count=' || b_zone.report_count || ')'
    ELSE 'CASE2b FAIL: confirmation=' || coalesce(b_zone.confirmation, 'NULL')
         || ' reporters=' || coalesce(array_length(b_zone.reporter_ids, 1), 0)
         || ' report_count=' || coalesce(b_zone.report_count, 0) END || E'\n';

  -- 케이스3: C pothole zone 2개(40m 별도)
  SELECT count(*) INTO c_cnt FROM zones
   WHERE type = 'pothole' AND _haversine_m(lat, lng, 37.52000, 127.00000) < 60;
  v_result := v_result || CASE WHEN c_cnt = 2
    THEN 'CASE3 PASS: 같은 유형 40m → 별도 zone 2개'
    ELSE 'CASE3 FAIL: C pothole zone 수=' || c_cnt || ' (기대 2)' END || E'\n';

  -- reports.zone_id 기록 확인: B zone 에 연결된 reports 2건
  SELECT count(*) INTO z_rep FROM reports WHERE zone_id = b_zone.id;
  v_result := v_result || CASE WHEN z_rep = 2
    THEN 'ZONE_ID PASS: reports.zone_id 기록됨(B zone 연결 ' || z_rep || '건)'
    ELSE 'ZONE_ID FAIL: B zone 연결 reports=' || z_rep || ' (기대 2)' END || E'\n';

  -- 결과를 에러로 던져 전체 롤백 + 한 번에 표시 (이 에러는 정상이다).
  RAISE EXCEPTION 'TEST RESULT: %', v_result;
END $$;
