-- ═══════════════════════════════════════════════════════════════════════════
-- Safe Ride — 운영 RLS 락다운 (저장소 기록용)
--
-- 2026-09-26 운영(jidpwflthppsltdayhoy)에 대시보드로 선적용, 앱 기능 테스트 통과.
-- 이 파일은 이미 운영 DB에 반영된 변경을 저장소에 사후 기록하기 위한 것이다.
-- (DB 재실행 금지 — 형상 기록 목적)
--
-- 내용:
--   • zones    : 쓰기 정책·권한 제거 → 쓰기는 SECURITY DEFINER RPC 로만.
--   • profiles : 본인 SELECT 만, 생성은 on_auth_user_created 트리거, 수정은 RPC.
--   • reports  : 본인 SELECT 만(reports_select_own), 삽입은 submit_hazard_report 로만.
--   • rides    : 본인 SELECT 만, 기록은 record_ride 로만.
--
-- ✅ 재생 안전성 보완 완료(2026-09-26): 운영 DB는 정책명이 저장소(schema.sql/
--    review_lockdown.sql)의 bare 네이밍과 달랐다(zones_auth_*, profiles_*_own,
--    reports_public_read, rides_own_insert 등). 초판은 운영 이름만 DROP 해서, 저장소
--    기반으로 새로 구축한 DB에 재생하면 저장소 정책(특히 reports_select(USING true))이
--    잔존해 락다운이 무효화될 수 있었다. 이를 막기 위해 각 블록에 저장소 기준 정책명
--    DROP(zones_insert/zones_update, profiles_insert/profiles_update,
--    reports_select/reports_insert, rides_insert)을 함께 추가했다.
--    → 운영 이름·저장소 이름 어느 쪽에서 재생하든 동일 최종 상태에 수렴한다(멱등).
--    파일 끝의 검증 쿼리로 최종 정책 세트를 확인할 수 있다.
-- ═══════════════════════════════════════════════════════════════════════════

begin;
-- zones: 쓰기는 RPC(SECURITY DEFINER)로만
drop policy if exists zones_auth_delete on public.zones;
drop policy if exists zones_auth_insert on public.zones;
drop policy if exists zones_auth_update on public.zones;
drop policy if exists zones_delete on public.zones;
-- 저장소(schema.sql) 기준 정책명도 함께 제거 (재생 안전성)
drop policy if exists zones_insert on public.zones;
drop policy if exists zones_update on public.zones;
revoke insert, update, delete, truncate, trigger, references on public.zones from anon, authenticated;

-- profiles: 본인 조회만, 생성은 on_auth_user_created 트리거, 수정은 RPC
drop policy if exists profiles_insert_own on public.profiles;
drop policy if exists profiles_update_own on public.profiles;
-- 저장소(schema.sql) 기준 정책명도 함께 제거 (재생 안전성)
drop policy if exists profiles_insert on public.profiles;
drop policy if exists profiles_update on public.profiles;
revoke all on public.profiles from anon, authenticated;
grant select on public.profiles to authenticated;

-- reports: 본인 조회만, 삽입은 submit_hazard_report로만
drop policy if exists reports_auth_insert on public.reports;
drop policy if exists reports_public_read on public.reports;
drop policy if exists reports_select_own on public.reports;
-- 저장소(schema.sql) 기준 정책명도 함께 제거 (재생 안전성)
--   특히 reports_select(USING true)를 지워야 전원 조회가 남지 않는다.
drop policy if exists reports_select on public.reports;
drop policy if exists reports_insert on public.reports;
create policy reports_select_own on public.reports
  for select to authenticated using (auth.uid() = user_id);
revoke all on public.reports from anon, authenticated;
grant select on public.reports to authenticated;

-- rides: 본인 조회만, 기록은 record_ride로만
drop policy if exists rides_own_insert on public.rides;
-- 저장소(schema.sql) 기준 정책명도 함께 제거 (재생 안전성)
--   rides_select(본인 조회)는 유지한다 — INSERT 정책만 제거해 기록은 record_ride RPC로만.
drop policy if exists rides_insert on public.rides;
revoke all on public.rides from anon, authenticated;
grant select on public.rides to authenticated;

-- ── 검증: 최종 정책 세트 확인 (조회 전용) ────────────────────────────────────
-- select tablename, policyname, cmd from pg_policies where schemaname='public' order by 1,2;
-- 기대값: zones는 SELECT 1개, reports는 reports_select_own 1개, profiles/rides는 SELECT 1개씩
commit;
