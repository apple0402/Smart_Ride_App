-- ═══════════════════════════════════════════════════════════════════════════
-- Safe Ride — 재심사 대응 마이그레이션
--   (a) profiles FK CASCADE 보증
--   (b) RLS를 SELECT 전용으로 축소 (클라이언트 직접 쓰기 차단)
--   (c) 쓰기 작업 전용 RPC (SECURITY DEFINER, 원자적 포인트 증감)
--
-- Supabase SQL 에디터에 그대로 붙여넣어 실행하세요. 여러 번 실행해도 안전(idempotent).
-- 관리자 서버(routes/admin.js)는 service_role 키로 RLS를 우회하므로 영향 없음.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── (a) profiles.id → auth.users(id) ON DELETE CASCADE 보증 ────────────────────
-- 기존 DB에 CASCADE가 빠져 있을 수 있어 재보증한다(이미 CASCADE면 동일 재생성일 뿐 무해).
DO $$ BEGIN
  ALTER TABLE profiles DROP CONSTRAINT IF EXISTS profiles_id_fkey;
  ALTER TABLE profiles
    ADD CONSTRAINT profiles_id_fkey
      FOREIGN KEY (id) REFERENCES auth.users(id) ON DELETE CASCADE;
END $$;

-- ── (b) RLS를 SELECT 전용으로 축소 ─────────────────────────────────────────────
-- 클라이언트(anon/authenticated)의 직접 INSERT/UPDATE 권한을 제거한다.
-- 모든 쓰기는 아래 (c)의 SECURITY DEFINER RPC를 통해서만 수행된다.

-- zones: 지도 표시용 SELECT만 유지, 무제한 삽입/수정 정책 제거
DROP POLICY IF EXISTS "zones_insert" ON zones;
DROP POLICY IF EXISTS "zones_update" ON zones;
-- (zones_select, zones_delete 는 유지)

-- reports: SELECT 유지, 클라 직접 INSERT 제거
DROP POLICY IF EXISTS "reports_insert" ON reports;

-- profiles: 본인 SELECT 유지, 클라 직접 INSERT/UPDATE 제거 (포인트 조작 차단)
DROP POLICY IF EXISTS "profiles_insert" ON profiles;
DROP POLICY IF EXISTS "profiles_update" ON profiles;

-- rides: rides_insert(WITH CHECK auth.uid()=user_id) 는 본인 것만 넣을 수 있어 안전 → 유지.
--        단, 주행거리 포인트 지급은 record_ride RPC 내부에서 처리한다.

-- ── (b-2) 프로필 자동 생성 트리거 ──────────────────────────────────────────────
-- profiles_insert 정책을 제거했으므로 클라이언트는 더 이상 프로필 row 를 만들 수 없다.
-- 회원가입(auth.users insert) 시 서버가 프로필을 자동 생성한다(표준 Supabase 패턴).
CREATE OR REPLACE FUNCTION handle_new_user()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  INSERT INTO profiles (id, name, safety_points, total_reports, total_distance)
  VALUES (NEW.id,
          coalesce(NEW.raw_user_meta_data ->> 'name', split_part(NEW.email, '@', 1)),
          0, 0, 0)
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION handle_new_user();

-- 기존 유저 백필: 프로필이 없는 auth.users 를 채운다(포인트 UPDATE 가 항상 대상 row 를 갖도록).
INSERT INTO profiles (id, name, safety_points, total_reports, total_distance)
SELECT u.id, coalesce(u.raw_user_meta_data ->> 'name', split_part(u.email, '@', 1)), 0, 0, 0
  FROM auth.users u
  LEFT JOIN profiles p ON p.id = u.id
 WHERE p.id IS NULL;

-- ══════════════════════════════════════════════════════════════════════════════
-- (b-3) 신고 검증·신뢰도 시스템 컬럼
-- ══════════════════════════════════════════════════════════════════════════════
-- profiles: 신고자 신뢰도 점수 (0.0 ~ 1.0). 확정/기각 이력 기반으로 재계산.
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS trust_score       double precision DEFAULT 1.0;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS confirmed_reports integer DEFAULT 0;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS rejected_reports  integer DEFAULT 0;

-- 포인트 축 분리 (섹션 5): 기여(신고·투표) vs 활동(주행). safety_points 는 등급 산정용 effective 값으로 유지.
--   effective_points = contribution_points + LEAST(activity_points, 100)  → safety_points 에 저장
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS contribution_points  integer DEFAULT 0;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS activity_points      integer DEFAULT 0;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS distance_points_paid integer DEFAULT 0;

-- 백필: 기존 유저 무손실 이전.
--   기존 safety_points 전액을 contribution 으로 이관(→ effective 동일, 등급 불변),
--   이미 획득한 주행거리 포인트만큼 distance_points_paid 를 시드해 과거 주행 재지급 방지.
UPDATE profiles
   SET contribution_points  = coalesce(contribution_points, 0) + coalesce(safety_points, 0),
       distance_points_paid = floor(coalesce(total_distance, 0) / 10) * 5
 WHERE contribution_points = 0 AND activity_points = 0 AND distance_points_paid = 0;

-- zones: 마커 확인 상태 + 서로 다른 신고자 집합
--   confirmation: 'unconfirmed'(미확인 제보) | 'confirmed'(확인된 위험) | 'review_needed'(검토 필요)
--   reporter_ids: 서로 다른 신고자 user_id (중복 제거) — 승격 기준(서로 다른 유저 수) 판정용
ALTER TABLE zones ADD COLUMN IF NOT EXISTS confirmation VARCHAR(20) DEFAULT 'unconfirmed';
ALTER TABLE zones ADD COLUMN IF NOT EXISTS reporter_ids TEXT[]      DEFAULT '{}';
ALTER TABLE zones ADD COLUMN IF NOT EXISTS pass_count   integer     DEFAULT 0;  -- 피드백 루프(섹션 7): 안전 통과 횟수

-- 마지막 활동 시각(신고/투표 갱신) — 90일 자동 만료(섹션 4-3) 판정용.
-- 기존 행은 created_at 으로 시드(재실행 시 NULL 만 채워 멱등).
ALTER TABLE zones ADD COLUMN IF NOT EXISTS last_activity_at TIMESTAMP WITH TIME ZONE;
UPDATE zones SET last_activity_at = coalesce(created_at, now()) WHERE last_activity_at IS NULL;
ALTER TABLE zones ALTER COLUMN last_activity_at SET DEFAULT now();

-- 기존 마커 백필: 시스템 도입 이전 데이터는 검증된 것으로 간주 → 흐리게 표시되지 않도록 confirmed 로.
UPDATE zones SET confirmation = 'confirmed' WHERE confirmation IS NULL OR confirmation = 'unconfirmed';

-- 신뢰도 재계산: 확정/기각 이력이 없으면 1.0, 있으면 확정 비율.
CREATE OR REPLACE FUNCTION _recompute_trust(p_uid uuid)
RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  UPDATE profiles
     SET trust_score = CASE
       WHEN coalesce(confirmed_reports, 0) + coalesce(rejected_reports, 0) = 0 THEN 1.0
       ELSE round(confirmed_reports::numeric
                  / (confirmed_reports + rejected_reports), 3)::double precision
     END
   WHERE id = p_uid;
$$;

-- 등급 산정용 effective_points 재계산 → safety_points 에 저장(클라이언트 UI/레벨은 safety_points 를 그대로 읽음).
--   effective = contribution + LEAST(activity, 100)  — 활동(주행) 포인트는 100까지만 등급에 반영.
CREATE OR REPLACE FUNCTION _refresh_effective_points(p_uid uuid)
RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  UPDATE profiles
     SET safety_points = coalesce(contribution_points, 0) + LEAST(coalesce(activity_points, 0), 100),
         updated_at    = now()
   WHERE id = p_uid;
$$;

-- ══════════════════════════════════════════════════════════════════════════════
-- (c) 쓰기 전용 RPC
-- ══════════════════════════════════════════════════════════════════════════════

-- ── 헬퍼: 하버사인 거리(m) ─────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION _haversine_m(lat1 double precision, lng1 double precision,
                                        lat2 double precision, lng2 double precision)
RETURNS double precision
LANGUAGE sql IMMUTABLE AS $$
  SELECT 6371000 * 2 * asin(sqrt(
    power(sin(radians(lat2 - lat1) / 2), 2) +
    cos(radians(lat1)) * cos(radians(lat2)) *
    power(sin(radians(lng2 - lng1) / 2), 2)
  ));
$$;

-- ── 1) 위험 신고 제출 ─────────────────────────────────────────────────────────
-- (구 6-인자 버전이 이미 배포된 환경에서 재실행 시 오버로드가 남지 않도록 정리)
DROP FUNCTION IF EXISTS submit_hazard_report(text, double precision, double precision, text, text, text);
CREATE OR REPLACE FUNCTION submit_hazard_report(
  p_type         text,
  p_lat          double precision,
  p_lng          double precision,
  p_desc         text DEFAULT '',
  p_severity     text DEFAULT 'medium',
  p_address      text DEFAULT '',
  p_gps_accuracy double precision DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_uid       uuid := auth.uid();
  v_title     text;
  v_desc      text;
  v_zone      zones%ROWTYPE;
  v_nearby    zones%ROWTYPE;
  v_action    text;
  v_trust     double precision;
  v_confirmed integer;
  v_total     integer;
  v_required  integer;   -- 승격에 필요한 서로 다른 신고자 수
  v_confirm   text;      -- 신규 zone 초기 확인 상태
  v_distinct  integer;   -- 현재 zone 의 서로 다른 신고자 수
  v_was_conf  boolean;   -- 이번 신고 전에 이미 confirmed 였는지
  v_rid       text;
BEGIN
  -- 신고는 로그인 필수 (UI 도 로그인 강제 — app.js Report.submit)
  IF v_uid IS NULL THEN
    RAISE EXCEPTION '신고하려면 로그인이 필요합니다';
  END IF;

  -- (1) GPS 정확도 검사 (오차가 크면 위치 신뢰 불가) — 값이 없으면 통과
  IF p_gps_accuracy IS NOT NULL AND p_gps_accuracy > 50 THEN
    RAISE EXCEPTION '위치 정확도가 부족합니다(오차 %m). 야외에서 다시 시도해 주세요.', round(p_gps_accuracy);
  END IF;

  -- (2) 동일 유저 + 동일 유형 + 근접(15m) + 단시간(5분) 중복 신고 차단
  IF EXISTS (
    SELECT 1 FROM reports
     WHERE user_id = v_uid
       AND type = p_type
       AND created_at > now() - interval '5 minutes'
       AND _haversine_m(lat, lng, p_lat, p_lng) < 15
  ) THEN
    RAISE EXCEPTION '방금 같은 위험을 신고하셨습니다';
  END IF;

  -- (3) 일일 신고 상한 (스팸 방지)
  IF (SELECT count(*) FROM reports
        WHERE user_id = v_uid AND created_at >= CURRENT_DATE) >= 10 THEN
    RAISE EXCEPTION '일일 신고 한도(10건)를 초과했습니다';
  END IF;

  v_title := CASE p_type
    WHEN 'pothole'      THEN '포트홀 / 크랙'
    WHEN 'slippery'     THEN '맨홀 / 미끄러움'
    WHEN 'construction' THEN '도로 / 보도 공사'
    ELSE '기타 위험'
  END;
  v_desc := '유저 제보: [' || v_title || ']' ||
            CASE WHEN coalesce(p_desc, '') <> '' THEN ' ' || p_desc ELSE '' END;

  -- (4) 신고자 신뢰도 조회 (프로필 없으면 생성)
  INSERT INTO profiles (id, name, safety_points, total_reports, total_distance)
  VALUES (v_uid, split_part(coalesce((auth.jwt() ->> 'email'), 'rider'), '@', 1), 0, 0, 0)
  ON CONFLICT (id) DO NOTHING;
  SELECT coalesce(trust_score, 1.0), coalesce(confirmed_reports, 0), coalesce(total_reports, 0)
    INTO v_trust, v_confirmed, v_total
    FROM profiles WHERE id = v_uid;

  -- (5) 카테고리별 승격 기준 (기타위험은 더 엄격하게: 3명)
  v_required := CASE WHEN p_type = 'other' THEN 3 ELSE 2 END;

  -- 신고 원본 기록
  INSERT INTO reports (id, user_id, lat, lng, type, title, description, severity)
  VALUES ('rpt-' || substr(md5(random()::text), 1, 8), v_uid, p_lat, p_lng,
          p_type, v_title, v_desc, coalesce(p_severity, 'medium'));

  -- 100m 내 활성 zone 검색
  SELECT * INTO v_nearby FROM zones
   WHERE status = 'active'
     AND _haversine_m(lat, lng, p_lat, p_lng) < 100
   ORDER BY _haversine_m(lat, lng, p_lat, p_lng) ASC
   LIMIT 1;

  IF FOUND THEN
    v_was_conf := (v_nearby.confirmation = 'confirmed');
    -- report_count 증가 + 서로 다른 신고자 누적(중복 제외) + 활동 시각 갱신
    UPDATE zones
       SET report_count = report_count + 1,
           last_activity_at = now(),
           reporter_ids = CASE WHEN v_uid::text = ANY (reporter_ids)
                               THEN reporter_ids
                               ELSE array_append(reporter_ids, v_uid::text) END
     WHERE id = v_nearby.id
     RETURNING * INTO v_zone;

    v_distinct := coalesce(array_length(v_zone.reporter_ids, 1), 0);

    -- 승격: 서로 다른 신고자 수 도달 OR 실적 있는 고신뢰 유저의 즉시 승격
    IF v_zone.confirmation <> 'confirmed'
       AND (v_distinct >= v_required OR (v_trust >= 0.8 AND v_confirmed >= 3)) THEN
      UPDATE zones SET confirmation = 'confirmed' WHERE id = v_zone.id RETURNING * INTO v_zone;
    END IF;
    v_action := 'updated';
  ELSE
    -- 신규 zone 초기 확인 상태 결정
    v_confirm := CASE
      WHEN v_trust >= 0.8 AND v_confirmed >= 3 THEN 'confirmed'      -- 실적 있는 고신뢰 유저 → 즉시 확인
      WHEN v_trust < 0.5 AND v_total >= 3      THEN 'review_needed'  -- 저신뢰 유저 → 상황실 검토 큐
      ELSE 'unconfirmed'                                            -- 일반/신규 유저 단독 첫 신고
    END;
    INSERT INTO zones (id, lat, lng, title, type, description, address,
                       severity, report_count, safe_votes, safe_voter_ids, status,
                       confirmation, reporter_ids)
    VALUES ('zone-' || substr(md5(random()::text), 1, 8), p_lat, p_lng, v_title, p_type,
            v_desc, coalesce(p_address, ''), coalesce(p_severity, 'medium'),
            1, 0, '{}', 'active', v_confirm, ARRAY[v_uid::text])
    RETURNING * INTO v_zone;
    v_was_conf := false;
    v_action := 'created';
  END IF;

  -- 신고 포인트 단계 지급 (섹션 5): 제출 즉시 기여 +3, 신고 수 +1
  UPDATE profiles
     SET contribution_points = contribution_points + 3,
         total_reports       = total_reports + 1
   WHERE id = v_uid;
  PERFORM _refresh_effective_points(v_uid);

  -- confirmed 로 새로 승격된 순간: 기여 신고자 전원에게 확정 보너스 +7, 확정 실적 +1, 신뢰도 재계산
  IF (NOT v_was_conf) AND v_zone.confirmation = 'confirmed' THEN
    FOREACH v_rid IN ARRAY v_zone.reporter_ids LOOP
      UPDATE profiles
         SET contribution_points = contribution_points + 7,
             confirmed_reports   = confirmed_reports + 1
       WHERE id = v_rid::uuid;
      PERFORM _recompute_trust(v_rid::uuid);
      PERFORM _refresh_effective_points(v_rid::uuid);
    END LOOP;
  END IF;

  RETURN jsonb_build_object('action', v_action, 'zone', to_jsonb(v_zone));
END $$;

-- ── 2) 안전 투표 (3표 자동 해제) ──────────────────────────────────────────────
CREATE OR REPLACE FUNCTION cast_safety_vote(p_zone_id text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_uid   uuid := auth.uid();
  v_zone  zones%ROWTYPE;
  v_votes integer;
  v_status text;
  v_rid   text;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION '로그인이 필요합니다';
  END IF;

  SELECT * INTO v_zone FROM zones WHERE id = p_zone_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION '구역을 찾을 수 없습니다';
  END IF;

  IF v_uid::text = ANY (v_zone.safe_voter_ids) THEN
    RAISE EXCEPTION '이미 투표하셨습니다';
  END IF;

  v_votes  := coalesce(v_zone.safe_votes, 0) + 1;
  v_status := CASE WHEN v_votes >= 3 THEN 'cleared' ELSE 'active' END;

  UPDATE zones
     SET safe_votes       = v_votes,
         safe_voter_ids   = array_append(safe_voter_ids, v_uid::text),
         status           = v_status,
         last_activity_at = now()
   WHERE id = p_zone_id
   RETURNING * INTO v_zone;

  -- 투표 포인트: 기여 +5 (프로필 없으면 생성)
  INSERT INTO profiles (id, name, safety_points, total_reports, total_distance)
  VALUES (v_uid, split_part(coalesce((auth.jwt() ->> 'email'), 'rider'), '@', 1), 0, 0, 0)
  ON CONFLICT (id) DO NOTHING;
  UPDATE profiles SET contribution_points = contribution_points + 5 WHERE id = v_uid;
  PERFORM _refresh_effective_points(v_uid);

  -- 3인 안전투표로 해제된 순간(섹션 3): 원 신고자 전원 오보 실적 +1, 신뢰도 재계산
  IF v_status = 'cleared' THEN
    FOREACH v_rid IN ARRAY coalesce(v_zone.reporter_ids, '{}'::text[]) LOOP
      UPDATE profiles SET rejected_reports = rejected_reports + 1 WHERE id = v_rid::uuid;
      PERFORM _recompute_trust(v_rid::uuid);
    END LOOP;
  END IF;

  RETURN jsonb_build_object('zone', to_jsonb(v_zone), 'cleared', (v_status = 'cleared'));
END $$;

-- ── 3) 라이딩 기록 + 주행거리 포인트(누적 기준) ──────────────────────────────
-- 버그 수정: 라이딩 단위 버림이 아니라 누적 total_distance 의 10km 경계 통과분만큼 지급.
CREATE OR REPLACE FUNCTION record_ride(
  p_distance_km  double precision,
  p_duration     integer DEFAULT 0,
  p_avg_speed    double precision DEFAULT 0,
  p_max_speed    double precision DEFAULT 0,
  p_danger_zones text[] DEFAULT '{}',
  p_route        jsonb DEFAULT '[]'
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_uid        uuid := auth.uid();
  v_ride       rides%ROWTYPE;
  v_new_dist   double precision;
  v_earned     integer;   -- 누적 거리 기준 총 획득 자격 포인트
  v_paid       integer;   -- 이미 지급된 거리 포인트
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION '로그인 후 라이딩을 저장할 수 있습니다';
  END IF;

  INSERT INTO rides (id, user_id, distance, duration, avg_speed, max_speed,
                     danger_zones_passed, route)
  VALUES ('ride-' || substr(md5(random()::text), 1, 8), v_uid,
          coalesce(p_distance_km, 0), coalesce(p_duration, 0),
          coalesce(p_avg_speed, 0), coalesce(p_max_speed, 0),
          coalesce(p_danger_zones, '{}'), coalesce(p_route, '[]'::jsonb))
  RETURNING * INTO v_ride;

  -- 누적 거리 갱신 + 주행거리 포인트를 activity_points 에 지급 (프로필 없으면 생성)
  INSERT INTO profiles (id, name, safety_points, total_reports, total_distance)
  VALUES (v_uid, split_part(coalesce((auth.jwt() ->> 'email'), 'rider'), '@', 1),
          0, 0, 0)
  ON CONFLICT (id) DO NOTHING;

  -- 버그 수정: 라이딩 단위 버림이 아니라 누적 total_distance 기준 차액 지급.
  --   10km 당 +5 → 총 자격 = floor(누적거리/10)*5, 이미 지급분(distance_points_paid) 차감.
  UPDATE profiles
     SET total_distance = coalesce(total_distance, 0) + coalesce(p_distance_km, 0)
   WHERE id = v_uid
   RETURNING total_distance, coalesce(distance_points_paid, 0) INTO v_new_dist, v_paid;

  v_earned := (floor(v_new_dist / 10) * 5)::integer;

  IF v_earned > v_paid THEN
    UPDATE profiles
       SET activity_points      = activity_points + (v_earned - v_paid),
           distance_points_paid = v_earned
     WHERE id = v_uid;
  END IF;
  PERFORM _refresh_effective_points(v_uid);

  RETURN to_jsonb(v_ride);
END $$;

-- ══════════════════════════════════════════════════════════════════════════════
-- (d) 마커 만료(섹션 4-3) · 피드백 루프(섹션 7) · 랭킹/보상(섹션 6)
-- ══════════════════════════════════════════════════════════════════════════════

-- ── 4-3) 90일 무활동 자동 만료 ────────────────────────────────────────────────
-- status='active' 이면서 90일간 신규 신고/투표가 없는 마커를 'expired' 로 전환. 만료 건수 반환.
-- 배치: 아래 pg_cron 스케줄(옵션) 또는 관리자 엔드포인트(POST /admin/api/expire-stale)에서 호출.
CREATE OR REPLACE FUNCTION expire_stale_zones()
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_count integer;
BEGIN
  UPDATE zones
     SET status = 'expired'
   WHERE status = 'active'
     AND coalesce(last_activity_at, created_at) < now() - interval '90 days';
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END $$;

-- pg_cron 이 설치된 프로젝트라면 아래 한 줄로 매일 03:10(UTC) 자동 실행할 수 있다(옵션):
--   SELECT cron.schedule('expire-stale-zones', '10 3 * * *', $$SELECT expire_stale_zones()$$);
-- pg_cron 미사용 시 관리자 상황실의 "오래된 마커 정리" 버튼(POST /admin/api/expire-stale)으로 수동 실행.

-- ── 7) 피드백 루프: 안전 통과 카운트 ──────────────────────────────────────────
-- 라이딩 중 confirmed 마커를 지나칠 때 호출. 신고 당사자 본인의 통과는 세지 않는다.
CREATE OR REPLACE FUNCTION record_zone_pass(p_zone_id text)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_uid uuid := auth.uid();
BEGIN
  IF v_uid IS NULL THEN RETURN; END IF;
  UPDATE zones
     SET pass_count = coalesce(pass_count, 0) + 1
   WHERE id = p_zone_id
     AND status = 'active'
     AND confirmation = 'confirmed'
     AND NOT (v_uid::text = ANY (coalesce(reporter_ids, '{}'::text[])));  -- 본인 신고는 제외
END $$;

-- 내 신고가 만든 안전 통과 총합(프로필 표시용).
CREATE OR REPLACE FUNCTION get_my_impact()
RETURNS jsonb
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  SELECT jsonb_build_object(
    'safePasses',  coalesce(sum(pass_count), 0),
    'markerCount', count(*)
  )
  FROM zones
  WHERE auth.uid() IS NOT NULL
    AND auth.uid()::text = ANY (coalesce(reporter_ids, '{}'::text[]));
$$;

-- ── 6) 리포터 랭킹 (기여 포인트 상위) ─────────────────────────────────────────
-- profiles 는 본인 SELECT 만 허용(RLS)하므로, 랭킹은 SECURITY DEFINER 로 안전 컬럼만 노출한다.
CREATE OR REPLACE FUNCTION get_leaderboard(p_limit integer DEFAULT 20)
RETURNS jsonb
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  SELECT coalesce(jsonb_agg(row_to_json(t)), '[]'::jsonb)
  FROM (
    SELECT name,
           coalesce(contribution_points, 0) AS contribution_points,
           coalesce(confirmed_reports, 0)   AS confirmed_reports,
           coalesce(safety_points, 0)       AS points
      FROM profiles
     ORDER BY coalesce(contribution_points, 0) DESC,
              coalesce(confirmed_reports, 0) DESC
     LIMIT greatest(1, least(coalesce(p_limit, 20), 100))
  ) t;
$$;

-- ── 실행 권한 부여 ────────────────────────────────────────────────────────────
-- Postgres 는 함수 생성 시 EXECUTE 를 PUBLIC 에 기본 부여한다. anon 의 임의 호출을 막기 위해
-- 먼저 PUBLIC 권한을 회수한 뒤, 의도한 롤에만 부여한다.
REVOKE EXECUTE ON FUNCTION submit_hazard_report(text, double precision, double precision, text, text, text, double precision) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION cast_safety_vote(text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION record_ride(double precision, integer, double precision, double precision, text[], jsonb) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION record_zone_pass(text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION get_my_impact() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION get_leaderboard(integer) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION expire_stale_zones() FROM PUBLIC;

GRANT EXECUTE ON FUNCTION submit_hazard_report(text, double precision, double precision, text, text, text, double precision) TO authenticated;
GRANT EXECUTE ON FUNCTION cast_safety_vote(text) TO authenticated;
GRANT EXECUTE ON FUNCTION record_ride(double precision, integer, double precision, double precision, text[], jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION record_zone_pass(text) TO authenticated;
GRANT EXECUTE ON FUNCTION get_my_impact() TO authenticated;
GRANT EXECUTE ON FUNCTION get_leaderboard(integer) TO authenticated;
-- expire_stale_zones() 는 관리자(service_role)/pg_cron 전용.
GRANT EXECUTE ON FUNCTION expire_stale_zones() TO service_role;
