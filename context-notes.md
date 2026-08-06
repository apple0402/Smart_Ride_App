# 6차 피드백 — 결정 사항과 근거

작성: 2026-08-06 / 기준 커밋: `1394f90` (5차 피드백)

> 5차까지의 노트는 커밋 `1394f90` 시점의 이 파일 이력에 남아 있다.

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
