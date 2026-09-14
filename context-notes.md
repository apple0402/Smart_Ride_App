# 7차 — 정식 출시 빌드/보안 세팅

작성: 2026-09-14 / 기준 커밋: `6f24256` (지도 관리자 상황실 추가)

> 6차까지의 노트는 커밋 `6f24256` 시점의 이 파일 이력에 남아 있다.

## 요약

앱 이름 전면 변경(Smart Rider → Safe Ride), 번들 ID 유지 결정, CARTO/Supabase 키 노출
정리, 프로덕션 빌드 스크립트 신설, Android 플랫폼 신규 추가까지 했다. **실제 서명된
.aab/.apk 파일은 이 세션에서 만들지 못했다** — 이 환경에 JDK/Android SDK가 없고, 정식
서명 키스토어는 사용자가 직접 만들어 보관해야 하는 자산이라 임의로 생성하지 않았다.

## 1. 앱 이름 변경

서빙되는 실제 페이지(`public/index.html`, `public/admin.html`)는 이미 "Safe Ride"였다.
잔여 "Smart Rider" 표기를 전부 정리했다:
`capacitor.config.json`, `ios/App/App/capacitor.config.json`, `ios/App/App/Info.plist`
(`CFBundleDisplayName`), `public/manifest.json`(PWA 홈 화면 이름), 루트 `index.html`(미사용
중복 파일로 보이지만 일관성을 위해 같이 수정), `README.md`, `package.json`의
`description`, iOS 디버그 로그 프리픽스 2곳(`[SmartRider]` → `[SafeRide]`). `npx cap add
android` 로 새로 생성된 Android 리소스(`strings.xml`)는 처음부터 "Safe Ride"로 생성됐다
(capacitor.config.json을 이미 고쳐둔 뒤 추가했기 때문).

`package.json`의 `"name": "smart-rider-app"`(npm 패키지 식별자, 사용자에게 안 보임)은
건드리지 않았다 — 요청한 "표시되는 이름"에 해당하지 않는다.

## 2. 번들 ID — 변경하지 않고 `com.gansam.smartrider` 유지

사용자가 "정식 상용화 배포에 가장 매끄러운 형태로 확정"해 달라고 위임했다. 조사해보니
이미 `capacitor.config.json` / iOS Xcode 프로젝트(App, SafeRideWidgets 타겟) 전부
`com.gansam.smartrider`로 일치되어 있었고 임시 테스트 마크는 없었다.

**바꾸지 않은 이유:** 사용자가 "베타 테스트를 성공적으로 마쳤다"고 했다 — TestFlight
베타가 이미 이 Bundle ID로 App Store Connect에 앱 레코드가 만들어져 있을 가능성이 높다.
**Bundle ID는 App Store Connect에 앱 레코드를 한 번 만들고 나면 그 뒤로 절대 바꿀 수
없다.** 지금 `com.gansam.saferide`로 바꾸면 기존 앱 레코드/베타 이력을 버리고 완전히
새 앱으로 처음부터 등록해야 한다. 반대로 앱 레코드가 아직 없다면 지금 바꿔도 손해는
없지만, 이미 있다면 되돌릴 수 없는 손실이라 **더 안전한 쪽(유지)을 기본값으로 택했다.**
앱 스토어 커넥트에 아직 앱 레코드를 등록한 적이 없는 게 확실하면 알려달라 — 그 경우엔
`com.gansam.saferide`로 바꿔도 된다.

## 3. CARTO API Key 방어 — 실제로 뭘 했고 뭘 못 하는지

**중요한 전제:** `public/js/supabase-client.js`의 Supabase anon key는 건드리지 않았다.
코드 주석에도 이미 있듯 anon key는 RLS(Row Level Security)로 보호되는 **공개 키**라
브라우저 노출이 정상이다 — 취약점이 아니라서 "방어"할 대상이 아니다.

CARTO 키는 다르다. 티어/쿼터가 있는 유료성 자원이라 도용되면 실제로 손해가 난다. 그런데
**클라이언트 JS에 있는 키는 브라우저 개발자도구로 무조건 읽힌다.** 난독화·압축을 아무리
해도 이건 못 막는다 — "최소한의 난독화 레이어"를 문자 그대로 구현하는 건 가짜 보안이라
하지 않았다. 대신 실제로 효과가 있는 세 가지를 했다:

1. **소스에서 키를 뺐다.** `app.js`와 `admin.html`에 각각 하드코딩되어 있던 키(두 곳 다
   같은 키를 썼다 — `context-notes.md` 6차 기록에 "키 교체 시 두 곳 다 고쳐야 한다"고
   이미 경고돼 있었다)를 지우고, 둘 다 빌드 시 생성되는 `public/js/config.js`에서
   `window.__SAFE_RIDE_ENV__.CARTO_API_KEY`를 읽도록 바꿨다. 이제부터 **새 커밋에는
   평문 키가 안 들어간다.**
2. **오리진 검증을 넣었다** (`generate-config.js`가 만드는 `config.js` 안의 IIFE).
   `location.origin`이 `ALLOWED_ORIGINS`(env, 배포 도메인)에 없으면 키를 빈 문자열로
   내려준다. 네이티브 앱(`capacitor:`/`ionic:`/`file:` 프로토콜)은 항상 통과시킨다.
   **한계:** 이건 단순 핫링크·복붙 재사용을 막는 저지선일 뿐이다. `config.js` 파일
   자체의 응답 본문에는 여전히 실제 키 문자열이 그대로 들어있어서, 마음먹고 뷰소스로
   꺼내 가는 사람은 이 검증을 우회한 채(자기 코드에서 직접 호출) 얼마든지 쓸 수 있다.
3. **진짜 방어인 CARTO 대시보드 도메인 제한 — 아래 안내대로 설정 필요.**

### CARTO 대시보드 도메인 제한 설정 (사용자가 직접 해야 함)

1. https://app.carto.com 로그인 → 우측 상단 계정 메뉴 → **Developers** (또는 API Keys
   관리 화면) 이동.
2. 현재 쓰고 있는 API Key(`cb1_2u1x_1_44a47fad383d59b276bc2d2e`) 찾아서 편집.
3. **Allowed URLs / Domain restriction** 항목에 실제 서비스 도메인만 등록:
   - `https://smart-ride-app-nrle.onrender.com/*` (README에 적힌 현재 Render 배포 주소)
   - 커스텀 도메인을 연결했다면 그 도메인도 추가
   - 네이티브 앱(iOS/Android)은 이 화이트리스트의 영향을 받지 않는다(리퍼러가 없거나
     앱 자체 스킴이라) — 별도로 "앱 번들 ID 등록" 옵션이 있으면 같이 등록.
4. **키 재발급(rotate) 강력 권장.** 지금 쓰는 키는 이미 여러 커밋에 평문으로 git
   히스토리에 남아 있다 — 코드에서 지워도 과거 커밋 blob에는 그대로 있다. 새 키를
   발급받아 `.env`의 `CARTO_API_KEY`와 Render 환경변수에 반영하고, 예전 키는
   비활성화할 것.

### 로컬/배포 환경변수

- `.env`: `CARTO_API_KEY`(로컬 개발용, 기존 노출 키 그대로 넣어둠 — 위 4번 재발급 후
  교체할 것), `ALLOWED_ORIGINS`(비워두면 전체 허용, 로컬 개발 기본값).
- **Render 대시보드 → Environment**에 `CARTO_API_KEY`(재발급한 새 키)와
  `ALLOWED_ORIGINS=https://smart-ride-app-nrle.onrender.com` 추가 필요.

## 4. 프로덕션 빌드 스크립트

`npm run build` = `build:config`(env → `public/js/config.js` 생성) → `build:bridge`
(기존 esbuild 번들) → `build-prod.js`(신규: `public/`를 `dist/public/`로 복사 후 모든
`.js`를 esbuild `minify + drop:['console','debugger']`로 압축). **원본 `public/`은
전혀 건드리지 않는다** — 개발 중 `npm run dev`/`cap:sync`는 그대로 `public/`을 쓴다.

`server.js`에 `WEB_DIR` 분기를 추가했다: `dist/public`이 존재하면 그걸, 없으면
`public/`을 서빙한다. **로컬에서 한 번이라도 `npm run build`를 돌리면 그 뒤로 로컬
서버가 `dist/`를 우선 서빙한다** — 개발 중 최신 코드를 보고 싶으면 `dist/` 폴더를
지우면 된다.

**Render 배포 설정 변경 필요:** Render 대시보드 → 서비스 → Settings → Build Command를
`npm install && npm run build`로 바꿔야 실제 배포본에서도 압축·console 제거가 적용된다
(지금은 아마 `npm install`만 돌고 있을 것). Start Command는 `npm start` 그대로.

검증: `npm run build` 실행 후 로컬 서버 기동해서 `/`, `/js/app.js`, `/js/config.js`,
`/api/health` 전부 200 확인. `dist/public/js/app.js`에 `console.` 문자열 0건 확인.
검증 후 테스트용 `dist/` 폴더는 삭제해서 로컬 개발 흐름을 원상 복구했다.

## 5. Android — 플랫폼은 추가했지만 서명된 .aab/.apk는 못 만들었다

`@capacitor/android` 설치 + `npx cap add android`로 네이티브 프로젝트를 새로 생성했다
(이 프로젝트엔 원래 iOS만 있었다). `applicationId`/`app_name`은 이미 고쳐둔
`capacitor.config.json`을 기준으로 자동 생성돼서 `com.gansam.smartrider` / "Safe Ride"로
맞게 나왔다.

`android/app/build.gradle`에 release 서명 설정을 추가했다 — `android/keystore.properties`
(커밋 안 함, `.gitignore`에 등록)에서 서명 정보를 읽고, 없으면 서명 없이 빌드된다(디버그
서명도 아닌 unsigned — Play Console에 못 올라간다). `android/keystore.properties.example`
을 템플릿으로 남겨뒀다.

**막힌 지점:** 이 환경에 Java/Gradle/Android SDK가 전혀 없다(`java -version` → command
not found). `npx cap add android`까지는 SDK 없이도 됐지만, 실제 `.aab`/`.apk` 빌드는
Gradle이 Android SDK를 필요로 해서 여기서는 실행할 수 없다. 또한 정식 서명 키스토어는
**분실하면 그 앱을 영구히 업데이트할 수 없게 되는 자산**이라 내가 임의로 만들어서 남겨두는
것 자체가 위험하다고 판단해 만들지 않았다.

### 사용자가 로컬(Android Studio/JDK 설치된 환경)에서 해야 할 일

1. **업로드 키스토어 생성** (최초 1회, 반드시 안전한 곳에 백업):
   ```
   cd android
   keytool -genkeypair -v -keystore upload-keystore.jks -alias upload -keyalg RSA -keysize 2048 -validity 9125
   ```
2. `android/keystore.properties.example`을 `android/keystore.properties`로 복사하고
   방금 만든 키스토어 파일 경로/비밀번호로 채운다.
3. 저장소 루트에서 빌드 + 추출:
   ```
   npm run android:bundle    # Play Console 제출용 .aab
   npm run android:apk       # 설치 테스트용 .apk
   ```
4. **추출 경로:**
   - AAB: `android/app/build/outputs/bundle/release/app-release.aab`
   - APK: `android/app/build/outputs/apk/release/app-release.apk`
5. Play Console → 프로덕션(또는 비공개 테스트) → 새 버전 만들기에서 `app-release.aab`
   업로드.

## 검증 한계

- Android 빌드 명령(`android:bundle`/`android:apk`)은 이 환경에 Gradle/SDK가 없어서
  **한 번도 실제로 실행해보지 못했다.** `build.gradle` 문법과 `capacitor.config.prod.json`
  구조만 확인했다 — 사용자 로컬에서 처음 실행할 때 Gradle 버전/SDK 설치 이슈가 나올 수
  있다.
- iOS는 Xcode가 이 환경에 없어서 `cap:sync:prod` 자체도 실행해보지 못했다. `capacitor.config.prod.json`
  파일 구조만 만들어뒀다.
- `npm run build` → 서버 기동 → HTTP 200 확인까지는 실제로 돌려서 검증했다.

## 요약

4건 중 2건은 제시된 원인이 코드와 맞았고(3번·4번), 1번은 원인이 다른 층위에 있었으며,
1번의 제시 수정안 하나는 **적용하면 다른 기능을 파괴**해서 반려하고 대안을 택했다.

---

## 1. 잠금화면 투표 버튼 탭 → 카드가 안 사라짐

**제시된 원인:** `activity.update` 호출만으로는 iOS 17+ 타임라인 갱신이 강제 트리거되지 않음.
**제시된 수정:** `activity.end(activityContent: nil, dismissalPolicy: .immediate)` 호출.

### 실제 원인: 인텐트가 잘못된 프로세스에서 실행되고 있었다

`LiveActivityIntent`는 **앱 프로세스**에서 `perform()`이 실행되도록 설계된 프로토콜이다.
시스템이 그렇게 라우팅하려면 인텐트 타입이 **앱 번들의 AppIntents 메타데이터**에 있어야 하고,
그러려면 소스가 App 타겟에도 컴파일되어 있어야 한다.

`project.pbxproj`를 확인한 결과 (`sed -n '274,300p'`):

```
504EC3001FED79650016851F /* Sources */   ← App 타겟
    AppDelegate / BackgroundSafetyPlugin / MainViewController
    SafeRideActivityAttributes / KeychainHelper / LiveActivityManager
    ※ VoteIntents.swift 없음  ← 여기가 문제

B5F2C3D4E5A6B7C8D9E0F1E1 /* Sources */   ← SafeRideWidgets 익스텐션 타겟
    SafeRideWidgetsBundle / SafeRideLiveActivity
    VoteIntents.swift / SupabaseVoteService / SafeRideActivityAttributes / KeychainHelper
```

`VoteIntents.swift`가 익스텐션 타겟에만 있었다. 그래서 `perform()`이 위젯 익스텐션
프로세스에서 돌았고, **그 프로세스의 `Activity<…>.activities`는 앱이 `request()`한 활동을
담고 있지 않다.** 루프가 0회 돌거나 `update()`가 조용히 버려진 것이다.

이게 5차 수정이 왜 안 먹혔는지도 설명한다. 5차에서 `activities.first` early-return을
제거한 것 자체는 맞는 방향이었지만, 루프 **본문**이 효력이 없었으므로 증상은 그대로였다.
원인이 Swift 코드가 아니라 **빌드 타겟 구성**에 있었기 때문에 코드를 아무리 고쳐도
바뀌지 않았던 것.

### 수정

`project.pbxproj`의 App 타겟 Sources에 두 파일 추가:
- `VoteIntents.swift` (인텐트 본체)
- `SupabaseVoteService.swift` (인텐트가 호출하는 의존성 — 같이 넣지 않으면 링크 실패)

`KeychainHelper.swift`는 이미 양쪽 타겟에 있어 추가 불필요. `SafeRideLiveActivity.swift`와
`SafeRideWidgetsBundle.swift`는 WidgetKit UI라 익스텐션 전용으로 그대로 둔다.
두 타겟 모두 `IPHONEOS_DEPLOYMENT_TARGET = 17.0`이라 `LiveActivityIntent` 가용성 문제 없음.

**UUID 함정:** 처음에 `…F1DA`/`…F1DB`를 새 `PBXBuildFile` ID로 썼는데, 이미
`Info.plist`와 `SafeRideWidgets.entitlements`의 `PBXFileReference`가 선점한 값이었다.
pbxproj는 ID가 전역 유일해야 하므로 프로젝트가 깨진다. `…F1F1`/`…F1F2`로 교체했다.
**앞으로 pbxproj에 수동으로 ID를 추가할 땐 반드시 `grep -c`로 선점 여부를 먼저 확인할 것.**

### `end(dismissalPolicy: .immediate)`를 쓰지 않은 이유 (제시안 반려)

`LiveActivityManager`는 **라이딩 세션당 활동을 딱 1개만** `request()`하고 끝까지 재사용한다.
이건 의도된 설계다 — 파일 상단 주석에 이유가 적혀 있다:

> 구역마다 새로 request()하면 잠금화면(백그라운드) 상태에서 iOS가 새 Live Activity 시작을
> 제한해 카드가 뜨지 않는 문제가 있었음

즉 `endSession()`(라이딩 종료) 외에는 활동을 끝내면 안 된다. 투표 한 번에 `end()`를 걸면:

1. 그 활동이 소멸한다.
2. `LiveActivityManager.activity`는 여전히 죽은 참조를 붙들고 있다 (`nil`이 안 됨).
3. 이후 `showEntry()` / `scheduleExitSequence()`의 `update()`가 전부 무효가 된다.
4. → **남은 주행 내내 경고 카드도 투표 카드도 다시 뜨지 않는다.**

증상 하나 고치려다 기능 전체를 잃는 거래라 택하지 않았다.
제시안의 두 번째 선택지("상태를 `.idle`로 밀어 넣은 뒤 비동기 마무리 보강")를 택했다.

### 비동기 마무리 보강

`perform()`이 반환되는 순간 시스템은 프로세스를 즉시 정지시킬 수 있다.
`await activity.update()`가 ActivityKit에 **접수**된 것과 위젯 타임라인이 실제로 **다시
그려진** 것 사이에 틈이 있어, 250ms 정착 대기를 넣었다.

솔직히 말하면 이건 확정된 메커니즘이라기보다 **안전 마진**이다. 비용이 250ms뿐이고
부작용이 없어서 넣었다. 진짜 수정은 위의 타겟 구성 쪽이다.

---

## 2. 잠금화면 투표창 버튼 잘림

**제시된 원인:** 버튼 크기 확대가 위젯 컨테이너 크기 제한을 초과 → 최초 렌더 레이아웃 연산 꼬임.
→ **맞다.** 실측으로 확인했다.

### 높이 계산

잠금화면 Live Activity의 높이 예산은 약 160pt다. 5차 버전 `VoteCard`:

| 요소 | 높이 |
|---|---|
| `.padding(16)` 상하 | 32 |
| 헤드라인 "🚦 위험 지역 통과" | 21 |
| spacing | 12 |
| 서브헤드라인 (구역명 길면 2줄 래핑) | 40 |
| spacing | 12 |
| 버튼 (`.controlSize(.large)` 내부 패딩 + `.padding(.vertical,10)` **이중 적용**) | ≈58 |
| **합계** | **≈175pt** |

160을 넘긴다. 초과분이 잘려 나갔고, 화면을 터치해 레이아웃이 재계산될 때만 온전히 보였다.
피드백의 "툭 터치하면 그제야 보인다"가 정확히 이 현상이다.

범인은 두 개다:
1. `.controlSize(.large)`와 `.padding(.vertical, 10)`이 **둘 다** 세로 패딩을 넣고 있었다.
2. `.title3` 굵은 한글 라벨이 절반 폭 버튼에서 래핑되면 버튼이 세로로 더 자란다.

### 수정 (특대형 버튼 크기는 유지)

- `.controlSize(.large)` 제거 → 대신 `minHeight: 54`로 **명시 고정**.
  이중 패딩은 사라지고 터치 영역은 오히려 예측 가능해진다.
- 라벨에 `lineLimit(1)` + `minimumScaleFactor(0.65)` → 래핑에 의한 세로 팽창 원천 차단.
  좁은 기기에서는 글자가 살짝 줄어들 뿐 버튼 크기는 그대로다.
- 질문 텍스트도 `lineLimit(1)` + `minimumScaleFactor(0.7)` (긴 구역명 대응).
- 바깥 패딩 16 → 좌우 14 / 상 10 / 하 12, spacing 12 → 6.

수정 후: 10 + 21 + 6 + 20 + 6 + 54 + 12 = **≈129pt**. 예산 내에 여유 있게 들어간다.

`EntryCard`는 ≈77pt로 원래부터 예산 안이라 건드리지 않았다.

---

## 3. 우측 상단 배지가 설정 버튼을 가림

**제시된 원인:** 우측 상단 '앱 모드' 버튼이 설정 버튼을 덮음. → **맞다.**
(다만 실제 라벨은 '앱 모드'가 아니라 **'⚠️ 웹 모드'**, id는 `#pwa-notice-badge`다. 5차에서 추가한 것.)

`#pwa-notice-badge`는 `top:14px; right:14px; z-index:997`.
`#top-bar`는 `z-index:100`이고 그 우측에 프로필(`Auth.openPanel`) / 기록(`Panels.openHistory`) /
설정(`Panels.openSettings`) 버튼 3개가 있다. 정확히 그 위에 배지가 얹혀 터치를 가로챈다.

### 이동 위치를 좌측 하단으로 정한 이유

우측 하단은 이미 임자가 있다 — 신고 FAB(`bottom:260, right:16`), 내 위치 버튼(`bottom:200, right:16`).
피드백은 "화면 중앙 하단"도 제안했지만 거긴 `#bottom-panel`(높이 ≈194)과 `#toast`(bottom:120)가 쓴다.

비어 있는 곳은 **좌측 하단, 하단 패널 위**다. 배지를 `left:14px; bottom:214px`로 옮겼다.

충돌 검사 (배지 ≈78×26):

| 요소 | 영역 | 판정 |
|---|---|---|
| `#top-bar` | 상단 0~90 | 무관 |
| `#gps-debug` | left:8, top:94~184 | 무관 |
| `#loc-btn` | right:16, bottom 200~248 | x축 분리 |
| 신고 FAB | right:16, bottom 260~316 | x축 분리 |
| `#bottom-panel` | bottom 0~≈194 | 20px 여유 |
| `#toast` | bottom 120~160 | 여유 |

안내 카드(`#pwa-notice-card`)는 배지 위에서 펼쳐지도록 `bottom:252px`,
그리고 우측 FAB 열(56+16=72px)을 침범하지 않도록 `right:82px`로 잡았다.
기존의 `margin-left:auto` 우측 정렬은 제거 — 이제 좌측 기준이다.

---

## 4. PWA TTS 무음 — 오디오 잠금 언록

**제시된 원인:** 빈 화면 터치나 텍스트 발화로는 iOS 웹킷 오디오 잠금이 안 풀린다.
명확한 상호작용 버튼을 눌러야 진짜 언록이 일어난다. → **맞다.**

5차의 `AudioUnlock`은 이미 무음 WAV + 보이스 프라이밍 + AudioContext를 다 갖추고 있었다.
문제는 **트리거**였다. 언록이 `document`에 건 전역 `touchstart` 캡처 리스너에만 의존했는데,
첫 터치가 지도 팬/줌이면 제스처가 Leaflet 내부에서 소비되고 iOS WebKit은 그런 경로로는
오디오 세션을 열어주지 않는다.

### AudioGate

앱 진입 시 전체 화면 오버레이를 띄워 **확실한 탭 하나**를 받아낸다.

설계 결정 몇 가지:

- **동기 실행 강제.** 언록은 제스처 핸들러 안에서 동기적으로 끝나야 한다.
  앞에 `await`를 하나라도 두면 트러스트 컨텍스트가 끊겨 언록이 실패한다.
- **정상 볼륨 발화.** `AudioUnlock.unlock()`의 프라이밍 발화는 `volume = 0`이라
  엔진이 깨어났는지 유저가 확인할 방법이 없었다. 게이트에서는 볼륨 1.0으로
  "안전 음성 안내를 시작합니다."를 실제로 들려준다. 언록 성사를 소리로 확정하는 셈.
- **`localStorage` 영구 스킵을 하지 않는다.** 오디오 잠금은 **페이지 로드마다 초기화**되므로
  "다시 안 보기"를 기억하면 다음 방문부터 다시 무음이 된다. `PwaNotice`와 다른 정책인
  이유가 이것이다. 대신 "음성 없이 사용하기" 스킵 링크를 둬서 원치 않는 유저는 넘길 수 있다.
- **네이티브 빌드 미노출.** Capacitor 네이티브는 `AVSpeechSynthesizer` 경로라 언록이 불필요하다.
  `PwaNotice`와 같은 `window.Capacitor?.isNativePlatform?.()` 가드를 쓴다.
- **`_done` 플래그.** 오버레이 전체와 버튼 양쪽에 핸들러를 걸어서(어디를 눌러도 통과),
  버튼 탭이 오버레이로 버블링되면 핸들러가 두 번 돈다. 플래그로 막았다.
  스킵 링크는 `stopPropagation()`으로 별도 차단.

### Tailwind `.hidden` 함정 (실제로 밟은 것)

처음에 `class="hidden"` + 인라인 `display:flex`로 썼는데, **인라인 스타일이 Tailwind의
`.hidden` 클래스보다 우선**이라 오버레이가 숨겨지지 않는다. (`#pwa-notice`는 인라인
`display`가 없어서 우연히 동작하던 것.)
→ 인라인 `display:none`으로 시작하고 JS가 `gate.style.display = 'flex'`로 켠다.

---

## 웹 자산 동기화에 대해

`ios/App/App/public/`은 `npx cap sync ios`가 생성하는 복사본이라 손대지 않았다.
이번 웹 수정(3·4번)은 둘 다 네이티브 빌드에서 early-return하므로
동기화 없이도 네이티브 동작에는 영향이 없다. 맥북에서 빌드할 때
`npm run cap:sync`를 돌리면 자연히 맞춰진다.

---

## 검증 한계 (중요)

- **Swift 변경분과 `project.pbxproj` 변경분은 컴파일 검증되지 않았다.** 윈도우 환경이라 Xcode가 없다.
  구조 검증(App 타겟 Sources 반영 확인, 중복 UUID 없음, 중괄호 균형)까지만 했다.
  **맥북에서 Xcode를 열어 1번의 타겟 멤버십이 실제로 붙었는지 먼저 확인할 것** —
  이번 수정의 핵심이 거기다. Xcode의 File Inspector에서 `VoteIntents.swift`의
  Target Membership에 `App`과 `SafeRideWidgets`가 **둘 다** 체크돼야 한다.
- 이 프로젝트에는 테스트 스위트가 없다 (`package.json`에 `test` 스크립트 없음).
  JS는 `node --check` + 서버 기동 + `AudioGate` 로직 DOM 스텁 실행까지 확인했다.
- **2번의 129pt는 계산값이지 실측값이 아니다.** 한글 폰트 메트릭과 기기 폭에 따라
  달라질 수 있으니 실기에서 잘림이 남으면 `buttonHeight`(54)를 먼저 줄여볼 것.
- 4건 모두 **실기 주행 검증이 필요하다.**

---

# 지도 관리자 상황실 (/admin) — 설계 결정

## 왜 브라우저에서 직접 삭제하지 않았나 (핵심)

`supabase/schema.sql:104` 의 정책이 이렇게 걸려 있다.

```sql
CREATE POLICY "zones_delete" ON zones FOR DELETE USING (auth.uid() IS NOT NULL);
```

관리자 페이지는 Basic Auth만 통과할 뿐 **Supabase 로그인 세션이 없다.** 그래서 브라우저에서
anon 키로 `sb.from('zones').delete()` 를 호출하면 `auth.uid()` 가 null이라 정책에 막히는데,
PostgREST는 이걸 **에러가 아니라 "0건 삭제 성공"으로 돌려준다.** 화면에서는 핀이 사라지고
성공 토스트까지 뜨는데 새로고침하면 그대로 살아 있는, 가장 나쁜 종류의 조용한 실패다.

그래서 쓰기(PATCH/DELETE)는 전부 Express가 `service_role` 키로 대행한다. service_role은
RLS를 우회하므로 정책과 무관하게 동작하고, 키는 서버 프로세스 밖으로 나가지 않는다.

**대안이었던 "RLS 완화"는 기각했다.** `USING (true)` 로 열면 anon 키만 가진 일반 앱 사용자
누구나 남의 제보를 지울 수 있게 된다. 관리자 전용이라는 전제가 무너진다.

## 왜 가드를 express.static 앞에 뒀나

`server.js` 는 미들웨어가 위에서부터 순서대로 도는데, 원래 `express.static(public)` 이
모든 라우트보다 먼저 있었다. `public/admin.html` 을 그 뒤에서 보호하면 **`/admin` 은 막혀도
`/admin.html` 을 직접 치면 static이 먼저 낚아채서 무인증으로 파일이 통째로 나간다.**

그래서 `adminGuard` 를 static 앞에 두고, 경로 3종(`/admin`, `/admin.html`, `/admin/*`)을
직접 매칭한다. `app.use('/admin', ...)` 로는 **`/admin.html` 이 매칭되지 않는다** —
Express의 prefix 매칭은 `/admin` 과 `/admin/...` 만 잡기 때문이다. 이 점이 함정이었다.

## fail-closed

`ADMIN_USER` / `ADMIN_PASSWORD` 가 비어 있으면 통과시키지 않고 503으로 끊는다.
환경변수 누락이 곧 "전국 제보 데이터 무인증 공개"가 되는 사고를 막기 위해서다.

## PATCH 화이트리스트

수정 가능 컬럼은 `title` / `description` / `severity` 3개로 못 박았다. 요청 본문에 뭘 넣든
나머지는 무시된다. `lat`/`lng`/`id`/`report_count` 가 관리 UI에서 바뀌면 앱 쪽 거리 계산과
중복 판정이 흔들린다. `title` 은 NOT NULL 이라 빈 문자열 저장을 400으로 막는다.
`severity` 는 `high|medium|low` 화이트리스트 — 앱의 `SEV_COLORS` / `SEV_RADIUS` 가
이 3개 키로만 조회하므로 다른 값이 들어가면 폴백 색으로 렌더된다.

## 널 세이프티를 `|| ''` 대신 `s()` 헬퍼로 한 이유

`z.address || ''` 는 값이 `0` 이거나 `false` 일 때도 빈 문자열로 만든다. `report_count` 처럼
숫자 컬럼에 같은 패턴을 쓰면 **제보 0건이 빈칸으로 보인다.** `s(v)` 는 null/undefined만
빈 문자열로 바꾸고 나머지는 `String()` 으로 보존한다.

라이브 데이터를 REST로 확인해 보니 실제로 `address:""` 인 행이 다수 있었다 (역지오코딩
프록시 도입 이전에 등록된 마커들). 빈 주소는 그냥 빈칸으로 두지 않고
"(주소 정보 없음 — 과거에 등록된 마커입니다)" 로 안내해서 상황실장이 "로딩 실패"와
"원래 없음"을 구분할 수 있게 했다.

좌표가 깨진 행(`lat`/`lng` 가 숫자가 아님)은 마커 생성을 건너뛴다. `L.marker([NaN, NaN])`
는 Leaflet 내부에서 던져서 **그 이후 마커가 한 개도 안 찍힌다.**

## 타일

앱(`app.js`)은 `dark_all` 을 쓰지만 관리자 화면은 요청대로 `rastertiles/voyager` 다.
키 바인딩 구조(`?key={apiKey}` + `L.tileLayer(..., { apiKey })`)는 `app.js:14-20` 과 동일하게
맞췄다. 키를 교체할 일이 생기면 **두 곳 다** 고쳐야 한다.

## Tailwind를 안 쓴 이유

`public/index.html:28` 주석에 적혀 있듯 `cdn.tailwindcss.com` 은 빌드 산출물이 아니라
런타임 JIT 스크립트다. 관리자 페이지는 화면 하나뿐이라 인라인 CSS가 더 빠르고 의존성이 없다.

## 배포 전 필수 작업 (미완료)

Render 대시보드 → Environment 에 **3개를 추가해야 동작한다.**

| 키 | 값 |
|---|---|
| `ADMIN_USER` | 원하는 관리자 아이디 |
| `ADMIN_PASSWORD` | 충분히 긴 비밀번호 |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase → Settings → API → `service_role` secret |

`SUPABASE_URL` 은 이미 있다고 가정한다. 셋 중 하나라도 없으면 `/admin` 은 503으로 막힌다
(뚫리지 않고 막히는 쪽이라 안전하다).

## 검증 한계 (중요)

- **수정/삭제가 실제로 DB에 반영되는지는 검증하지 못했다.** 로컬에 `service_role` 키가 없어서
  모든 쓰기 경로가 503에서 끊긴다. 배포 후 **삭제해도 되는 테스트 마커 1건으로 반드시
  수정 1회 + 삭제 1회를 실측할 것.** 삭제 후 새로고침해서 되살아나지 않는지까지 봐야 한다.
- 조회 경로는 anon 키로 라이브 REST를 직접 때려 11개 컬럼 전부 존재함을 확인했다.
- 인증 계층은 로컬 서버를 실제로 띄워 401/200 매트릭스 9종을 curl로 실측했다.
- 이 프로젝트에는 테스트 스위트가 없다 (`package.json` 에 `test` 스크립트 없음).

---

# 신규 마커 주소 미저장 버그 (2026-09-14)

## 보고된 원인 vs 실제 원인

보고: "폰 앱에는 한글 주소가 보이는데 /admin 사이드바는 비어 있다. admin.html의 `s()`가 덮어쓰는 것 같다."

실측 결과 admin.html은 무죄였다.
- `s()`/`field()`는 trim 후 한 글자라도 있으면 그대로 출력한다.
- 라이브 DB: 122건 중 **115건이 `address:""`**. 주소가 있는 7건은 전부 8/1~8/4 등록분이고 이후 0건.
  9/13 실전 주행분 15건도 전부 빈 주소. 상황실은 DB를 정확히 보여주고 있었다.
- 폰 앱의 "한글"은 주소가 아니었다. 목록은 `z.desc || z.address` 라 설명문(`유저 제보: [...]`)이,
  투표 팝업은 주소가 없으면 제목이 대신 보인다.
- 진짜 원인: `Report.submit` 의 `fetch('/api/geocode')` 상대 경로. Capacitor 설정에 `server.url` 이 없어
  앱은 번들된 `public/` 을 `capacitor://localhost`(iOS) / `https://localhost`(Android)에서 띄운다.
  요청이 Render에 닿지 않고 실패 → 빈 `catch {}` 가 삼켜 `address: ''` 로 insert.

요청은 `admin.html` 에 `address || description` 폴백을 넣는 것이었지만, 그러면 "한글 주소" 칸에
설명문이 뜰 뿐 저장 버그는 그대로라 저장 경로를 고치는 쪽으로 합의했다.

## 앱 수정

- 네이티브(`Capacitor.isNativePlatform()`)일 때만 Render 절대 주소. 웹은 Render가 직접 서빙하므로
  상대 경로 유지 — 로컬 개발 서버가 운영 서버를 부르지 않게.
- Render 응답에 CORS 헤더가 없었다(`Origin: https://localhost` 로 실측). `cors()` 를 **`/api/geocode` 에만**
  건다. 전역으로 열면 `/admin/api/*` 까지 교차 출처 응답이 붙는데 그럴 이유가 없다.
  `cors` 패키지는 이미 dependencies에 있었다. Nominatim 직접 호출도 CORS는 되지만(`*`),
  WebView는 User-Agent를 못 정해 이용 정책에 어긋나고 주소 형식이 달라져서 택하지 않았다.
- **8초 타임아웃**: 기존에는 로컬에서 즉시 실패해 신고 버튼이 바로 풀렸다. 절대 주소로 바꾸면 잠든
  무료 서버가 깨어나는 수십 초 동안 "제출 중..." 에 묶인다. 주행 중 신고 흐름을 기존과 같게 유지하려고
  끊는다. 끊긴 건은 빈 주소로 저장되고 상황실 복원 버튼으로 채울 수 있다.

## 배포 주의 (중요)

`public/` 은 앱 안에 번들되므로 **Render 배포만으로는 폰 앱이 고쳐지지 않는다.**
Android는 `npm run android:sync` 후 재빌드·재설치, iOS는 Mac에서 `npm run cap:sync:prod` 후 Xcode 빌드.
Render 배포는 서버 쪽 CORS 헤더를 위해 필요하다.

## 과거 마커 주소 복원 (`/admin/api/repair`)

- service_role을 가진 서버가 대행한다. 브라우저는 버튼 클릭과 진행률 조회만 한다.
- **백그라운드 + 진행률 조회**: 1.1초 × 115건이면 2분이 넘는다. 요청 하나로 기다리면 브라우저나
  Render 프록시 타임아웃에 걸릴 수 있어 `POST` 는 202로 즉시 응답하고 `GET` 으로 진행률을 본다.
- 1.1초 간격은 Nominatim 초당 1건 정책에 여유를 둔 값. 실패한 건 뒤에도 쉬어서 연속 실패가
  연속 요청이 되지 않게 했다.
- 상태는 메모리에만 둔다. 재시작·재배포되면 끊기지만 대상을 매번 "빈 주소 행"으로 새로 조회하므로
  다시 누르면 남은 건부터 이어진다. 그래서 작업 테이블을 따로 만들지 않았다.
- 중복 실행은 409. `running=true` 를 DB 조회 **전에** 세워 동시 요청 두 개가 같이 통과하는 틈을 막는다.
- **`Number(null) === 0` 함정**: 처음엔 `Number.isFinite(Number(z.lat))` 로만 걸러서 `lat:null` 행이
  Nominatim까지 호출됐다(가짜 PostgREST 실측에서 발견). null과 빈 문자열을 따로 거른다.
  참고: `admin.html` 의 `renderMarkers` 도 같은 검사를 쓰고 있어 null 좌표 행은 (0, 경도)에 찍힌다. 이번 범위 밖이라 두었다.
- 앱 geocode와 같은 `reverseGeocode()` 를 쓰므로 복원된 주소와 앞으로 저장될 주소의 형식이 같다.
- Render 무료 인스턴스는 15분 무요청 시 잠든다. 2분 작업이라 영향이 없고, 상황실 창의 3초 폴링도 깨워 둔다.

## 검증

- `node --check`: server.js, routes/admin.js, routes/geocode.js, public/js/app.js, admin.html 인라인 JS.
- 가짜 PostgREST를 띄우고 실제 `server.js` 를 기동해 실측(스크래치패드 `repair-e2e.js`):
  geocode 응답 `Access-Control-Allow-Origin: *` / `/admin/api/zones` 에는 CORS 헤더 없음 /
  복원 무인증 401 / 시작 202 / 중복 409 / 조회 쿼리 `or=(address.is.null,address.eq.)` /
  행별 PATCH 본문에 한글 주소 / 좌표 null 행 제외 / 기존 `/` 200.
- 실 DB 쓰기는 로컬에 service_role 키가 없어 검증하지 못했다. 배포 후 버튼으로 실행하고
  anon REST로 빈 주소 건수를 다시 세서 확인한다.
