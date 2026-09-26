# Safe Ride — 작업 규칙

## 데이터베이스 / Supabase

### 새 테이블 생성 시 (필수)
새 `public` 스키마 테이블을 만들 때는 아래를 **같은 마이그레이션 안에서** 반드시 함께 수행한다.

1. **RLS 활성화**
   ```sql
   ALTER TABLE public.<table> ENABLE ROW LEVEL SECURITY;
   ```
2. **anon/authenticated 권한을 명시적으로 회수한 뒤, 필요한 것만 재부여**
   `20260918_restore_api_role_grants.sql` 의 `GRANT SELECT ON ALL TABLES ... TO anon, authenticated`
   와 `ALTER DEFAULT PRIVILEGES ... GRANT SELECT ... TO anon, authenticated` 때문에,
   **신규 테이블은 기본적으로 anon/authenticated 에게 SELECT 가 자동 부여된다.**
   따라서 아래처럼 회수 후 최소 권한만 재부여할 것.
   ```sql
   REVOKE ALL ON public.<table> FROM anon, authenticated;
   GRANT <필요한 최소 권한> ON public.<table> TO authenticated;  -- 예: SELECT, INSERT
   GRANT ALL ON public.<table> TO service_role;                  -- 운영/Edge Function 용
   ```
3. **행 접근을 통제하는 RLS 정책을 명시적으로 작성** (본인 소유 기준 등)
   ```sql
   CREATE POLICY "<table>_select" ON public.<table>
     FOR SELECT TO authenticated USING (auth.uid() = <owner_col>);
   ```
   (참고 구현: `20260922_content_reports_blocking.sql` 의 content_reports / blocked_users)
4. 권한/정책 변경 후 `NOTIFY pgrst, 'reload schema';` 로 PostgREST 캐시 갱신.

> ⚠️ RLS 를 켜도 GRANT 가 남아 있으면 노출될 수 있고(정책 없는 SELECT 등), GRANT 를
> 막아도 RLS 정책이 `USING (true)` 면 전원 조회가 된다. **둘 다** 최소화할 것.

> **신규 테이블은 필요한 권한만 명시적으로 GRANT.**
> `20260926_default_privileges.sql` 이 public 스키마의 DEFAULT PRIVILEGES 에서
> anon/authenticated 자동 SELECT 를 회수했으므로, 신규 테이블은 GRANT 를 적어주지
> 않으면 anon/authenticated 가 접근할 수 없다(안전한 기본값). 위 2번 GRANT 문을
> 반드시 함께 작성할 것. (service_role 은 DEFAULT PRIVILEGES 로 계속 ALL 을 받는다.)

### 정책 네이밍 규칙
- 정책명은 **저장소 표준 bare 네이밍**을 사용한다: `<table>_select`, `<table>_insert`,
  `<table>_update`, `<table>_delete`.
- `_auth_`, `_own`, `_public_read` 등 변형 접미사를 새로 도입하지 않는다.
  (운영 DB 와 저장소 정책명이 어긋나면 마이그레이션 재생 시 DROP 이 빗나가 정책이
  잔존한다 — 20260926_prod_rls_lockdown.sql 의 드리프트 사례 참고.)

### 마이그레이션 적용 원칙
- 운영 DB 에 대시보드로 직접 적용한 변경도 **반드시 `supabase/migrations/` 에 사후 기록**한다.
- 파일 상단 주석에 적용 일자·대상 프로젝트·검증 여부를 남긴다.
- 이 저장소의 마이그레이션은 자동 실행되지 않는다(수동 적용). 스테이징 → smoke-test →
  운영 순서를 지킨다.
