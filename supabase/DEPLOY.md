# Safe Ride 배포 & 검증 런북 (재심사 대응 · A/B/C)

> **원칙: 프로덕션 마이그레이션을 실행하기 전에 반드시 스테이징에서 1회 검증한다.**
> RLS 축소·RPC 이전·계정 삭제는 되돌리기 어려운 변경이라, 스테이징 스모크 테스트를
> 통과한 뒤에만 프로덕션에 적용한다.

관련 산출물 (마이그레이션은 모두 멱등 — 여러 번 실행 안전)
- 마이그레이션 ①: `supabase/migrations/20260917_review_lockdown.sql` (RLS 잠금 · RPC 이전 · 컬럼/트리거)
- 마이그레이션 ②: `supabase/migrations/20260918_profiles_points_backfill.sql` (Part A′ — profiles 포인트 컬럼 DEFAULT 0 보증 + NULL 백필)
- 마이그레이션 ③: `supabase/migrations/20260918_restore_api_role_grants.sql` (service_role/anon/authenticated 테이블 GRANT 복원 + `NOTIFY pgrst`)
- Edge Function: `supabase/functions/delete-account/index.ts`
- 스모크 테스트 하니스: `supabase/smoke-test.js` (스테이징 자동 검증 — 프로덕션 URL 이면 실행 차단)
- 클라이언트: `public/js/{api,app}.js`, `public/index.html`, `public/admin.html`, `ios/App/SafeRideWidgets/SupabaseVoteService.swift`

> ⚠️ **적용 순서는 반드시 ① → ② → ③ → Edge Function.** ②/③ 은 오늘(스테이징 디버깅 중) 발견한
> 문제의 수정본이다. ③ GRANT 누락은 `service_role` 이 테이블 DML 권한이 없어 Edge Function 의
> PostgREST 직접 접근(rides.delete 등)이 "permission denied" 로 실패하던 원인이었다.

---

## 1단계. 스테이징 검증 (프로덕션 실행 전 필수)

스테이징 환경은 아래 중 하나로 준비한다.
- **(권장) Supabase Branching**: 프로젝트 대시보드 ▸ Branches ▸ Preview 브랜치 생성 → 격리된 DB/Function 환경.
- **별도 스테이징 프로젝트**: 프로덕션과 동일 스키마의 무료 프로젝트를 하나 더 둔다.
- **최소 검증**: 프로덕션에서 트랜잭션 스모크 테스트(`BEGIN; … ROLLBACK;`) — 스키마/정책/만료 함수까지만 확인 가능(auth 의존 RPC는 앱 세션이 없어 이 방식으로는 확인 불가).

### 1-1. 스테이징에 적용 (반드시 이 순서)
1. SQL 에디터에서 `20260917_review_lockdown.sql` 전체 실행 → 에러 0건 확인.
2. `20260918_profiles_points_backfill.sql` 실행 (Part A′).
3. `20260918_restore_api_role_grants.sql` 실행 (GRANT 복원 — 끝에 `NOTIFY pgrst` 포함).
4. `supabase functions deploy delete-account`(스테이징 프로젝트/브랜치 대상).
5. 스테이징 URL/anon key 로 웹앱을 띄우거나 `npx cap run` 으로 접속.

### 1-1b. 스모크 테스트 하니스 (수동 체크리스트 대체·자동)
아래를 실행해 12개 항목이 전부 PASS 인지 확인한다(프로덕션 URL 이면 자동 차단됨).
```bash
STAGING_URL=https://<staging-ref>.supabase.co \
STAGING_ANON_KEY=<sb_publishable_...> \
STAGING_SERVICE_KEY=<sb_secret_...> \
node supabase/smoke-test.js
```
- 시작 시 `preflight` 가 서비스 키의 테이블 접근(=GRANT)·RLS 우회를 선검사한다.
- 매 실행 전 `preclean` 이 테스트 좌표 주변 잔여 데이터를 정리한다.
- 특정 번호만 재실행 가능(의존 스텝 자동 선행): `node supabase/smoke-test.js 11`

### 1-2. 스모크 테스트 체크리스트 (전부 통과해야 프로덕션 진행)

**RLS 잠금 (SQL 에디터 또는 앱 콘솔, anon 컨텍스트)**
- [ ] `insert into zones(...)` 직접 실행 → RLS 로 거부.
- [ ] `update profiles set safety_points=99999 ...` 직접 실행 → 거부.

**신고/검증 (앱 로그인 세션으로)**
- [ ] 정상 신고 → 마커 생성 + 프로필 기여 +3.
- [ ] GPS 오차 50m 초과 신고 → "위치 정확도 부족" 거부.
- [ ] 같은 위치·유형 5분 내 재신고 → "방금 같은 위험 신고" 거부.
- [ ] 하루 11번째 신고 → "일일 한도 초과" 거부.
- [ ] 서로 다른 2계정(기타위험은 3계정) 신고 → `confirmation='confirmed'` 승격 + 각 기여자 +7.

**투표/신뢰도**
- [ ] 서로 다른 3계정 "이젠 안전해요" → zone `cleared`, 투표자 각 +5.
- [ ] 3표 해제 시 원 신고자 `rejected_reports +1` + `trust_score` 재계산.

**포인트 축 / 주행거리 버그**
- [ ] 9km 라이딩 2회(누적 18km) → 10km 경계 통과 시 +5(예전엔 0), `activity_points`·`distance_points_paid` 정상.
- [ ] 등급이 `effective = contribution + LEAST(activity,100)` 로 산정(= `safety_points`).

**계정 삭제 (재심사 핵심)**
- [ ] 프로필 ▸ 회원탈퇴 ▸ 확인 → 로그인 화면 복귀 + 재로그인 불가.
- [ ] `profiles`/`rides` row 삭제, 해당 유저 `reports.user_id` = NULL(마커 유지) 확인.

**상황실 / 만료 / 랭킹 / 피드백**
- [ ] 공사 마커 상세 ▸ "공사 종료 처리" → 지도에서 숨김.
- [ ] "90일 무활동 마커 정리"(`expire_stale_zones`) 실행 → 만료 건수 반환.
- [ ] 프로필 ▸ 리포터 랭킹 표시, Lv.3+ "검증된 리포터" 배지, confirmed 마커 통과 후 임팩트 카운트 증가.

> 통과 실패 시: 스테이징에서 원인 수정 → 재적용 → 재검증. **프로덕션은 전 항목 통과 후에만.**

---

## 2단계. 프로덕션 배포 (스테이징 12/12 통과 후에만)

> 프로덕션에는 스모크 하니스를 돌릴 수 없다(하니스가 프로덕션 URL 을 차단). 아래 SQL 은 모두
> 멱등이므로 순서대로 실행하고, 마지막에 3단계 수동 검증으로 확인한다.

**DB (프로덕션 SQL 에디터에서 이 순서로):**
1. `20260917_review_lockdown.sql` 실행 → 에러 0건.
2. `20260918_profiles_points_backfill.sql` 실행 (Part A′).
3. `20260918_restore_api_role_grants.sql` 실행 (GRANT 복원 + `NOTIFY pgrst`).
4. GRANT 반영 확인 — 아래 쿼리로 4개 테이블 `svc_*` 가 전부 `t` 인지 점검:
   ```sql
   SELECT t.tablename,
          bool_or(g.grantee='service_role' AND g.privilege_type='SELECT') svc_select,
          bool_or(g.grantee='service_role' AND g.privilege_type='INSERT') svc_insert,
          bool_or(g.grantee='service_role' AND g.privilege_type='UPDATE') svc_update,
          bool_or(g.grantee='service_role' AND g.privilege_type='DELETE') svc_delete
   FROM pg_tables t
   LEFT JOIN information_schema.role_table_grants g
          ON g.table_schema=t.schemaname AND g.table_name=t.tablename
   WHERE t.schemaname='public' AND t.tablename IN ('profiles','rides','zones','reports')
   GROUP BY t.tablename ORDER BY t.tablename;
   ```

**Edge Function:**
5. `supabase functions deploy delete-account` (프로덕션 프로젝트 대상).

**클라이언트:**
6. `node generate-config.js && npx cap sync ios && npx cap sync android` → Xcode 재빌드.

**옵션:**
7. pg_cron 사용 시:
   `SELECT cron.schedule('expire-stale-zones', '10 3 * * *', $$SELECT expire_stale_zones()$$);`

**프로덕션 배포 직후 최소 검증(실계정 아님, 버리는 계정으로):**
- [ ] 신규 계정 가입 → 정상 신고 1건 → 마커 생성 + 기여 +3.
- [ ] 그 계정으로 프로필 ▸ 회원탈퇴 → 로그인 화면 복귀 + 재로그인 불가.
- [ ] `select * from profiles where id='<그 uid>'` = 0행, `rides` 0행, 해당 `reports.user_id` = NULL.

---

## 3단계. 재심사 제출 전 수동 작업 (App Store Connect)
- [ ] 데모 계정 가입 + 신고 1~2건(confirmed) + Lv.2~3 포인트 세팅.
      (데모 계정 정보는 저장소에 두지 않음 — App Store Connect Review Notes 참조)
- [ ] App Review Information ▸ Sign-In Info 를 신규 계정으로 교체(기존 계정 삭제).
- [ ] 기존 개인계정(App Store Connect Review Notes 참조) 비밀번호 변경 권장.

---

## 롤백 메모
- RLS 정책은 `schema.sql` 의 원래 정책을 다시 생성하면 복구되지만, **포인트/신뢰도 데이터는
  마이그레이션이 재구성하므로 되돌리기 어렵다.** → 그래서 1단계 스테이징 검증이 필수다.
- Edge Function 은 이전 버전으로 재배포(rollback)하거나 삭제 가능.
