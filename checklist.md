# 7차 — 정식 출시 빌드/보안 세팅 체크리스트

> 상세 근거는 `context-notes.md`의 "7차 — 정식 출시 빌드/보안 세팅" 참조.
> 6차까지의 체크리스트는 커밋 `6f24256` 시점의 이 파일 이력 참조.

## 1. 앱 이름 변경 (Smart Rider → Safe Ride)
- [x] `capacitor.config.json` / `ios/App/App/capacitor.config.json` — appName
- [x] `ios/App/App/Info.plist` — CFBundleDisplayName
- [x] `public/manifest.json` — name / short_name (PWA 홈 화면 표시)
- [x] 루트 `index.html`(미사용 중복 파일) title + 표시 텍스트
- [x] `README.md`, `package.json` description
- [x] iOS 디버그 로그 프리픽스 `[SmartRider]` → `[SafeRide]` 2곳
- [x] `public/index.html`, `public/admin.html`은 이미 "Safe Ride" — 변경 불필요 확인

## 2. 번들 ID
- [x] 조사 결과 이미 `com.gansam.smartrider`로 전부 일치, 임시 마크 없음
- [x] **변경하지 않기로 결정** — App Store Connect 앱 레코드가 이미 있을 경우 Bundle ID는
      되돌릴 수 없이 바뀌므로 더 안전한 유지를 기본값으로 택함 (근거는 context-notes 참조)
- [ ] 사용자 확인 필요: 앱 스토어 커넥트에 아직 앱 레코드 등록 전이라면 `com.gansam.saferide`로
      바꿔도 안전 — 필요 시 요청

## 3. CARTO API Key 방어
- [x] `app.js`, `admin.html` 하드코딩 키 제거 → `config.js`(빌드 시 생성)에서 읽도록 변경
- [x] `generate-config.js` 신규 — env(`CARTO_API_KEY`, `ALLOWED_ORIGINS`) → `public/js/config.js`
- [x] 오리진 화이트리스트 검증 로직 추가 (한계: 뷰소스로 우회 가능 — 문서화함)
- [x] `public/js/config.js`를 `.gitignore`에 추가, `config.example.js` 템플릿 커밋
- [x] `.env`에 `CARTO_API_KEY` / `ALLOWED_ORIGINS` 추가
- [x] CARTO 대시보드 도메인 제한 설정 안내 작성 (context-notes.md)
- [ ] **사용자가 CARTO 대시보드에서 실제로 도메인 제한 설정할 것**
- [ ] **사용자가 CARTO 키 재발급(rotate)할 것** — 기존 키는 git 히스토리에 이미 노출됨
- [ ] Render 환경변수에 `CARTO_API_KEY`(재발급분), `ALLOWED_ORIGINS` 등록

## 4. 프로덕션 빌드 스크립트
- [x] `generate-config.js`, `build-prod.js` 신규 (esbuild minify + drop console/debugger)
- [x] `package.json` — `build`, `build:config`, `cap:sync:prod`, `android:sync` 스크립트 추가
- [x] `server.js` — `dist/public` 존재 시 우선 서빙하는 `WEB_DIR` 분기 추가
- [x] `capacitor.config.prod.json` 신규 (webDir: dist/public)
- [x] 로컬 검증: `npm run build` 실행 → 서버 기동 → `/`, `/js/app.js`, `/js/config.js`,
      `/api/health` 200 확인, 압축 파일에 `console.` 0건 확인
- [x] 검증 후 테스트용 `dist/` 삭제 (로컬 개발 흐름 원상 복구)
- [ ] **Render 대시보드 Build Command를 `npm install && npm run build`로 변경할 것**
      (안 하면 배포본은 압축 전 원본이 그대로 나감)

## 5. Android 정식 패키지
- [x] `@capacitor/android` 설치 + `npx cap add android` (플랫폼 신규 생성)
- [x] `applicationId`/`app_name` 자동 생성값 확인 (`com.gansam.smartrider` / "Safe Ride")
- [x] `android/app/build.gradle` — `keystore.properties` 기반 release 서명 설정 추가
- [x] `android/keystore.properties.example` 템플릿, `.gitignore`에 키스토어/설정 제외 추가
- [x] `npm run android:bundle` / `npm run android:apk` 스크립트 추가 + 추출 경로 문서화
- [ ] **사용자가 로컬(JDK/Android SDK 있는 환경)에서 업로드 키스토어 생성 필요**
      (`keytool -genkeypair ...`, 이 환경엔 Java가 없어 여기서 생성 불가·안 함)
- [ ] **사용자가 로컬에서 `npm run android:bundle` 실제 실행해서 .aab 뽑아볼 것**
      (이 환경엔 Gradle/Android SDK가 없어 한 번도 실행해보지 못함)
- [ ] Play Console 비공개 테스트 트랙에 업로드 + 실기기 설치 검증

## 1. 잠금화면 투표 버튼 탭 → 카드가 그대로 남음 (최종 해결)
- [x] **근본 원인 특정**: `VoteIntents.swift`가 `SafeRideWidgets` 익스텐션 타겟에만 컴파일되어 있었음
- [x] `project.pbxproj` — App 타겟 Sources에 `VoteIntents.swift` 추가 (신규 UUID `…F1F1`)
- [x] `project.pbxproj` — App 타겟 Sources에 `SupabaseVoteService.swift` 추가 (신규 UUID `…F1F2`)
- [x] `returnToIdle()` — `update()` 접수 후 250ms 정착 대기 추가 (perform() 반환 직후 프로세스 정지 대비)
- [x] `end(dismissalPolicy:)` 도입은 **반려** — 세션당 활동 1개 재사용 구조를 파괴함 (근거는 notes)
- [x] UUID 충돌 검증 (`…F1DA`/`…F1DB`는 Info.plist·entitlements가 선점 중이었음 → 교체)
- 검증: 잠금화면 투표 버튼 탭 → 카드가 즉시 `.idle`("안전 라이딩 중")로 복귀, 이후 구역에서도 경고 카드 정상 발현

## 2. 잠금화면 투표창 버튼 잘림 (최초 렌더 레이아웃 버그)
- [x] **근본 원인 특정**: 카드 고유 높이 ≈175pt > 잠금화면 Live Activity 높이 예산 ≈160pt
- [x] `.controlSize(.large)` 제거 — `.padding(.vertical,10)`과 이중 적용되던 패딩 해소
- [x] 버튼 높이를 `minHeight: 54`로 명시 고정 (특대형 터치 영역 유지)
- [x] 버튼 라벨 `lineLimit(1)` + `minimumScaleFactor(0.65)` — 래핑에 의한 세로 팽창 차단
- [x] 질문 텍스트 `lineLimit(1)` + `minimumScaleFactor(0.7)` (긴 구역명 대응)
- [x] 바깥 패딩 16 → 좌우 14 / 상 10 / 하 12, VStack spacing 12 → 6
- 검증: 재계산 후 ≈129pt. 최초 렌더부터 두 버튼 100% 노출, 터치 전 잘림 없음

## 3. 우측 상단 '웹 모드' 배지가 설정 버튼을 가림
- [x] **위치 확인**: `#pwa-notice-badge`(z-997)가 `#top-bar`(z-100)의 프로필·기록·설정 버튼 위에 정확히 겹침
- [x] 배지 `top:14/right:14` → `left:14/bottom:214` (좌측 하단, 하단 패널 위)
- [x] 안내 카드 `top:52/right:14` → `left:14/right:82/bottom:252` (우측 FAB 열 침범 방지)
- [x] 충돌 검사: top-bar / gps-debug / loc-btn(bottom:200) / 신고 FAB(bottom:260) / bottom-panel(≈194) / toast(bottom:120) 전부 비간섭
- 검증: 프로필·기록·설정 3버튼 모두 터치 가능, 배지도 가려지지 않음

## 4. PWA 음성(TTS) 무음 — 오디오 잠금 언록
- [x] `#audio-gate` 전체 화면 오버레이 추가 (`public/index.html`)
- [x] `AudioGate` 모듈 추가 (`public/js/app.js`) — 네이티브 빌드에서는 미노출
- [x] 탭 핸들러 안에서 **동기적으로** 언록 수행 (무음 WAV + 보이스 프라이밍 + AudioContext)
- [x] 정상 볼륨(1.0) 한국어 첫 발화 성사 — "안전 음성 안내를 시작합니다."
- [x] 중복 탭 방어 (`_done` 플래그), "음성 없이 사용하기" 스킵 경로
- [x] Tailwind `.hidden`이 인라인 `display`에 밀리는 문제 회피 → 인라인 `display:none` 시작 + JS로 `flex`
- [x] `localStorage` 영구 스킵 **안 함** — 오디오 잠금은 페이지 로드마다 초기화되므로 로드당 1회 노출
- 검증: DOM 스텁으로 `AudioGate.init()` → 탭 → 언록/발화/제거/중복방어 전 경로 실행 확인

## 마감
- [x] `node --check public/js/app.js` 구문 검증
- [x] `npm start` 서버 기동 + `GET /` 200 + `/api/health` 정상
- [x] `AudioGate` 로직 DOM 스텁 실행 검증 (실제 코드 eval)
- [x] `project.pbxproj` 구조 검증 (App 타겟 Sources 반영, 중복 UUID 없음)
- [x] Swift 중괄호 균형 검사
- [ ] Swift 컴파일 검증 — **불가(윈도우 환경)**. 맥북에서 Xcode 빌드 필요
- [ ] 실기 주행 검증 — 4건 모두 필요
- [x] 커밋 + main 푸시 (Render 자동 배포 트리거)

---

# 지도 관리자 상황실 (/admin)

## 1. 보안 라우트
- [x] `routes/admin.js` 신규 — Basic Auth (`ADMIN_USER` / `ADMIN_PASSWORD`)
- [x] 자격증명 미설정 시 **fail-closed** (503, 무인증 통과 금지)
- [x] `crypto.timingSafeEqual` 비교
- [x] 가드를 `express.static` **앞에** 장착 — `/admin`, `/admin.html`, `/admin/*` 전부 차단
- 검증: 무인증 `/admin` `/admin.html` `/admin/api/zones` → 401, 오답 비번 → 401, 정답 → 200

## 2. service_role 삭제/수정 대행
- [x] `SUPABASE_SERVICE_ROLE_KEY`로 서버 측 Supabase 클라이언트 (지연 생성, 브라우저 미노출)
- [x] `GET /admin/api/zones` — 전량 조회
- [x] `PATCH /admin/api/zones/:id` — title / description / severity 화이트리스트만
- [x] `DELETE /admin/api/zones/:id` — 실제 행 삭제, 0건이면 404
- [x] 키 미설정 시 503 + 한글 안내 (조용한 실패 방지)
- [x] 미매칭 `/admin/api/*` → 404 JSON (SPA fallback 누수 차단)
- 검증: 키 없는 상태에서 503 + 안내 문구 확인, 미매칭 경로 404 확인

## 3. 관리자 UI (`public/admin.html`)
- [x] Leaflet + CARTO **voyager** 타일 (`CARTO_API_KEY` 반영)
- [x] 전국 뷰 시작 → 마커 있으면 `fitBounds`
- [x] 마커 클릭 → 사이드바에 ID / 한글 주소 / 설명 / 유형 / 좌표 / 제보수 / 등록일시
- [x] 인라인 편집 — 제목·설명·위험도 + [💾 저장] (PATCH)
- [x] [🚨 마커 삭제] + confirm → DELETE → 지도에서 핀 즉시 제거
- [x] 브라우저는 Supabase와 직접 통신하지 않음 (키 노출 0)
- 검증: 인증 통과 시 200, 인라인 JS `node --check` 통과

## 4. 널 세이프티
- [x] `s(v)` 헬퍼 — null/undefined 어떤 입력에도 문자열만 반환
- [x] `address` 빈 값 → "(주소 정보 없음 — 과거에 등록된 마커입니다)" 안내로 대체
- [x] `lat`/`lng` 비수치 행은 마커 생성 건너뜀 (지도 크래시 방지)
- [x] 미지의 `type` / `severity` → 아이콘·색·라벨 전부 폴백
- [x] 사용자 입력은 `textContent`로만 렌더 (innerHTML 미사용)
- 검증: 라이브 데이터에서 `address:""` 행 실재 확인

## 마감
- [x] `node --check server.js` / `routes/admin.js` / admin.html 인라인 JS
- [x] 서버 기동 + 인증 매트릭스 9종 실측
- [x] `ZONE_COLUMNS` 11개 컬럼을 라이브 스키마 대조 (REST 200)
- [x] 기존 앱 라우트 무영향 확인 (`/`, `/api/health` 200)
- [ ] **Render 환경변수 3종 등록 필요** — `ADMIN_USER`, `ADMIN_PASSWORD`, `SUPABASE_SERVICE_ROLE_KEY`
- [ ] 배포 후 실제 수정/삭제 1건 실측 — service_role 키 없이는 검증 불가
- [x] 커밋 + main 푸시 (Render 자동 배포 트리거)

---

# 신규 마커 주소 미저장 버그 수정 (2026-09-14)

## 1. 앱 geocode 통신
- [x] 원인 검증 — admin.html 무죄, DB 115/122건 빈 주소, 상대 경로 + `server.url` 없음
- [x] `Report.submit` 네이티브에서만 Render 절대 주소 + 8초 타임아웃
- [x] `server.js` `/api/geocode` 에만 `cors()`
- [x] 로컬 서버에서 CORS 헤더 실측 — geocode `*`, `/admin/api` 는 헤더 없음
- [x] 배포 후 Render에서 CORS 헤더 실측 — 배포 반영 후 `*` 확인
- [ ] 폰 앱 재빌드·재설치 (사용자) — Android `android:sync`, iOS는 Mac에서 `cap:sync:prod`

## 2. 과거 마커 주소 복원
- [x] `reverseGeocode()` 를 geocode.js에서 분리해 공유
- [x] `POST /admin/api/repair`(백그라운드 시작) / `GET`(진행률), 1.1초 간격, 중복 실행 409
- [x] 상황실 헤더에 [🛠️ 과거 마커 주소 일괄 복원] 버튼 + 진행률
- [x] 가짜 Supabase 서버로 복원 루프 끝까지 실측 — 401/202/409/PATCH 확인, `lat:null` 제외 버그 발견 후 수정
- [ ] 배포 후 버튼 실행 (사용자) → 빈 주소 건수 재확인

## 마감
- [x] `node --check` server.js / routes / app.js / admin.html 인라인 JS
- [x] 커밋 2개 + main 푸시 (`688da0e`, `fea7d33`)
