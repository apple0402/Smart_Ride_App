-- ═══════════════════════════════════════════════════════════════════════════
-- Safe Ride — submit_hazard_report 병합 로직 변경 (같은 유형만 병합)
--
-- 변경 요지:
--   1) reports 에 zone_id / gps_accuracy 컬럼 추가(어느 zone 에 병합됐는지 저장).
--   2) 병합 조건을 "100m 내 아무 유형"에서 "v_merge_radius(30m) 내 '같은 유형'"으로 축소.
--   3) 병합 대상 zone 을 FOR UPDATE + advisory lock 으로 직렬화(동시 신고 중복 zone 방지).
--   4) 같은 유저가 이미 신고한 구역이면 명시적 예외('이미 신고하신 위험 구역입니다').
--   5) reports 원본 INSERT 를 zone 결정 이후로 옮겨 zone_id/gps_accuracy 를 기록.
--   포인트·신뢰도·review_needed·확정 보너스 로직은 그대로 유지(무변경).
--
-- ⚠️ 기준 코드: 저장소 20260917_review_lockdown.sql 의 submit_hazard_report 정의.
--    (요청서가 말한 '운영 DB 실제 함수 정의' 첨부는 이 작업 시점에 전달되지 않아
--     저장소본을 기준으로 작성했다. 운영본이 다르면 재대조 필요.)
--
-- 시그니처(7인자) 동일 → 앱(api.js reportHazard) 무변경.
--   CREATE OR REPLACE 는 기존 EXECUTE 권한(authenticated)을 보존한다.
-- 멱등: ADD COLUMN IF NOT EXISTS / CREATE INDEX IF NOT EXISTS / CREATE OR REPLACE.
-- 적용: 스테이징(supabase/tests/merge_same_type_test.sql) → 통과 후 운영 직접 적용.
--       (이 파일은 자동 실행되지 않는다 — SQL 에디터에서 수동 실행)
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

-- ── 1) 스키마: reports.zone_id / reports.gps_accuracy ────────────────────────
--   zone_id: 이 신고가 병합/생성한 zone. zone 이 지워지면 신고는 남기되 링크만 끊음.
ALTER TABLE public.reports
  ADD COLUMN IF NOT EXISTS zone_id text REFERENCES public.zones(id) ON DELETE SET NULL;
--   gps_accuracy: 신고 당시 위치 오차(m). 값이 없을 수 있어 nullable.
ALTER TABLE public.reports
  ADD COLUMN IF NOT EXISTS gps_accuracy double precision;

CREATE INDEX IF NOT EXISTS idx_reports_zone_id ON public.reports(zone_id);

-- ── 2) 함수: submit_hazard_report (같은 유형만 병합) ─────────────────────────
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
  v_merge_radius constant double precision := 30;  -- 같은 유형 병합 반경(m)
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

  -- (3-b) 유형별 병합 경합 직렬화: 같은 유형끼리 순차 처리해 동시 신고 시 중복 zone 방지.
  PERFORM pg_advisory_xact_lock(hashtext('zone_merge:' || p_type));

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

  -- v_merge_radius 내 '같은 유형' 활성 zone 검색 (병합 직렬화를 위해 FOR UPDATE)
  SELECT * INTO v_nearby FROM zones
   WHERE status = 'active'
     AND type = p_type
     AND _haversine_m(lat, lng, p_lat, p_lng) < v_merge_radius
   ORDER BY _haversine_m(lat, lng, p_lat, p_lng) ASC
   LIMIT 1
   FOR UPDATE;

  -- 검색 직후: 같은 유저가 이미 이 구역 신고자면 거부(5분/15m 창 밖 재신고도 차단)
  IF FOUND AND v_uid::text = ANY (v_nearby.reporter_ids) THEN
    RAISE EXCEPTION '이미 신고하신 위험 구역입니다';
  END IF;

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

    -- (5) 카테고리별 승격 기준 — 병합된 zone 의 유형(v_zone.type) 기준으로 계산.
    v_required := CASE WHEN v_zone.type = 'other' THEN 3 ELSE 2 END;

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

  -- 신고 원본 기록 (zone 결정 이후로 이동 — zone_id / gps_accuracy 기록)
  INSERT INTO reports (id, user_id, lat, lng, type, title, description, severity,
                       zone_id, gps_accuracy)
  VALUES ('rpt-' || substr(md5(random()::text), 1, 8), v_uid, p_lat, p_lng,
          p_type, v_title, v_desc, coalesce(p_severity, 'medium'),
          v_zone.id, p_gps_accuracy);

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

COMMIT;

-- PostgREST 스키마 캐시 갱신(reports 신규 컬럼 반영)
NOTIFY pgrst, 'reload schema';

-- ═══════════════════════════════════════════════════════════════════════════
-- 롤백 SQL (병합 로직을 review_lockdown.sql 버전으로 되돌릴 때)
--   • 함수: 20260917_review_lockdown.sql 의 submit_hazard_report 정의를 재실행.
--   • 컬럼 제거(선택): 데이터 유지가 목적이면 남겨도 무해.
--       BEGIN;
--         DROP INDEX IF EXISTS public.idx_reports_zone_id;
--         ALTER TABLE public.reports DROP COLUMN IF EXISTS zone_id;
--         ALTER TABLE public.reports DROP COLUMN IF EXISTS gps_accuracy;
--       COMMIT;
--       NOTIFY pgrst, 'reload schema';
-- ═══════════════════════════════════════════════════════════════════════════
