# 5차 피드백 — 결정 사항과 근거

작성: 2026-08-05 / 기준 커밋: `b47305d` (4차 피드백)

## 요약: 제시된 원인 중 4건이 코드와 불일치

수정 요청서의 원인 분석 7건 중 4건은 실제 코드에서 성립하지 않았다.
증상은 모두 실재하므로 **증상은 그대로 두고 원인만 재특정**해서 고쳤다.
아래는 왜 그렇게 판단했는지의 기록 — 6차 피드백 때 같은 논쟁을 반복하지 않기 위함.

---

## 1. 잠금화면 투표 버튼 무반응

**제시된 원인:** `Task.detached`가 `SupabaseVoteService`의 블로킹 락에 걸려 `returnToIdle` 미호출.
윈도우/맥북 간 문법 싱크 문제.

**검증 결과 — 성립하지 않음.**
- `SupabaseVoteService`에 세마포어·뮤텍스·`DispatchQueue.sync` 등 블로킹 락이 **하나도 없다.**
  전부 `async/await` + `URLSession`이다.
- `perform()`은 `Task.detached`를 `await`하지 않는다 (unstructured task). 즉 이미 네트워크를
  기다리지 않는 구조였다. 4차 수정에서 `withTaskGroup` → `Task.detached`로 바꾼 것 자체는 옳았다.
- "윈도우/맥북 문법 싱크"는 존재하지 않는 메커니즘. Swift 소스는 플랫폼과 무관하게 동일 컴파일.

**실제 원인:**
`LiveActivityEnder.returnToIdle()`의 `guard let activity = Activity<...>.activities.first
else { return }`. 익스텐션 프로세스에서 `activities` 배열이 아직 비었거나 동기화되지 않은 시점에
호출되면 **조용히 아무 일도 하지 않고 반환**한다. 카드가 그대로 남는다.
부차적으로, 복귀가 detached Task **생성 이후**에 실행되어 불필요한 선행 작업이 있었다.

**적용한 수정:**
1. `returnToIdle()`을 `Task.detached` 생성보다 **먼저** 실행 → 어떤 경우에도 복귀가 최우선.
2. `activities.first` early-return 제거 → 전체 활동을 순회 갱신. 빈 배열이면 루프가 0회 돌 뿐,
   중간에 함수가 죽지 않는다.
3. `zoneId`를 지역 상수로 캡처 후 detached Task에 전달 — `@Parameter` 프로퍼티를 클로저에서
   직접 캡처하지 않도록 분리.

**의도적으로 하지 않은 것 — `try-catch`:**
요청서는 `try-catch`를 걸어달라고 했으나, `Activity.update()`와 `SupabaseVoteService.voteSafe()`는
**둘 다 `throws`가 아니다.** Swift에서 non-throwing 호출을 `do/catch`로 감싸면
`'catch' block is unreachable` 경고가 나고 컴파일 노이즈만 늘어난다.
네트워크 실패는 이미 `SupabaseVoteService` 내부에서 `try?`로 전부 삼키고 있어
(fetchZone/updateZone 모두 `guard let ... try? await` 패턴) **예외가 위로 전파될 경로 자체가 없다.**
"실패해도 무조건 복귀"라는 요구사항은 try-catch가 아니라 **실행 순서**로 보장했다.

**"0.1초 수준 응답":** 복귀가 네트워크보다 먼저 실행되므로 응답 시간은 `activity.update()`
호출 시간 = 실질적으로 즉시. `requestTimeout: 5`는 건드리지 않았다 — 복귀 경로와 무관해졌다.

---

## 2. 경고 발현 지점 전진

**요청:** 진입 판정을 75~80m 이하로.

**적용:** `GPS_DELAY_MARGIN` 15 → 30. 기본 `alertDistance: 50` 기준 **진입 판정 80m**.
Swift `gpsDelayMargin`도 동일하게 30으로 동기화 (두 값이 어긋나면 포그라운드/백그라운드
발현 지점이 달라진다).

**남겨두는 경고:**
이전 값도 65m(50+15)였는데 체감이 10m였다면, 55m의 지연은 GPS 마진으로 설명되지 않는다.
25km/h ≈ 7m/s이므로 55m는 약 8초의 지연이다. 의심 지점은 다음 둘이며 이번엔 건드리지 않았다.
- `BackgroundSafetyPlugin.triggerZoneEntry()`의 `asyncAfter(deadline: .now() + 1.0)` — TTS 1초 지연 (≈7m)
- GPS 갱신 주기 자체 (`distanceFilter = 1`이지만 실제 수신 간격은 기기·환경 의존)

80m로 올려도 여전히 늦게 느껴진다면 마진을 더 올리는 게 아니라 **GPS 수신 로그의 실제
타임스탬프 간격을 먼저 측정**해야 한다. 마진만 계속 키우면 3번(중복 스팸)만 악화된다.

---

## 3. 투표창 4회 중복 스팸 — **가장 중요한 수정**

**제시된 원인:** 이탈 판정 조건문이 GPS 1m 이동마다 True를 연속 반환.

**검증 결과 — 성립하지 않음.**
이탈 확정 분기(`app.js:435`)는 첫 줄에서 `enteredZones.delete(z.id)`를 실행한다.
삭제되면 다음 틱의 `wasEntered`가 false가 되어 **그 분기에 다시 들어갈 수 없다.**

**실제 원인 — 재진입 루프:**
```
이탈 확정 → enteredZones.delete() → 라이더는 아직 진입 반경(80m) 안에 있음
  → 다음 틱: isInside && !wasEntered → 재진입 판정 → minDist 추적 재시작
  → 10m 더 이격 → 이탈 확정 → 투표창 2회차 → 반복
```
마커 통과 후 반경을 완전히 벗어나기까지 이 사이클이 3~4회 돌아 정확히 관측된 4회 스팸과 일치한다.

**2번이 3번을 악화시킨다:** 반경을 65m → 80m로 넓히면 재진입 사이클 횟수가 더 늘어난다.
그래서 이번 락은 선택이 아니라 **2번 수정의 전제 조건**이다.

**적용한 락 (사용자 승인: "9초 + 반경 이탈 둘 다"):**
`voteLockedZones: Map<zoneId, unlockAt>` 도입. 해제하려면 **두 조건을 모두** 충족해야 한다.
1. 투표창이 뜬 뒤 `VOTE_LOCK_MS`(9초) 경과
2. 현재 거리 > `entryDist + ZONE_REARM_MARGIN`(30m) — 즉 실제로 110m 밖

9초 단독으로는 불충분한 이유: 25km/h에서 9초는 약 62m 이동이라 **80m 반경을 못 벗어난다.**
시간 조건만 걸면 9초 뒤 재진입 스팸이 그대로 재현된다. 두 조건의 AND가 필요하다.

락은 진입 분기 자체를 막는다 (팝업만 막는 게 아니라). 그래야 `alertedZones`·`enteredZones`가
재오염되지 않는다. 네이티브 `BackgroundSafetyPlugin.checkProximity()`도 **동일한 재진입 구조**를
갖고 있어 같은 락을 미러링했다. `backgroundZoneExit` 리스너에도 락 검사를 넣어
JS 경로와 네이티브 경로가 같은 마커에 대해 이중 발현하지 않게 했다.

---

## 4. 상단 문구 번쩍임

**제시된 원인:** `VotePopup`이 초기화 전 깡통 변수를 순간 렌더링.

**검증 결과 — 성립하지 않음.**
- `#vote-popup`은 화면 **하단** 요소다 (`bottom:-100%`). 상단 번쩍임과 위치가 맞지 않는다.
- 기본 텍스트도 정상 한글이다 ("방금 지나온 구역 안전해졌나요?"). 깡통 문자열이 아니다.

**실제 원인 — Tailwind CDN FOUC:**
`index.html:16`의 `cdn.tailwindcss.com`은 빌드 산출물이 아니라 **런타임 JIT 스크립트**다.
스크립트가 실행되어 스타일을 주입하기 전까지 `.hidden` 클래스는 **아무 스타일도 없다.**
그 사이 다음 요소들이 완전히 보이는 상태로 렌더된다.
- `#verification-modal` (`index.html:486`) — `fixed inset-0`, 즉 **전체 화면 오버레이**
- `#form-signup` (`index.html:371`) — 회원가입 폼

이게 "상단에서 이상한 문구가 번쩍"의 정체다. 마커/투표 로직과 무관하다.

**적용한 수정:**
head 인라인 `<style>`에 `.hidden { display:none !important; }`를 직접 선언.
인라인 CSS는 파서가 즉시 적용하므로 CDN 스크립트를 기다리지 않는다.
`!important`가 안전한 이유: 앱은 요소를 보일 때 `classList.remove('hidden')`으로 클래스를
**제거**하지 추가하지 않는다 (`VerificationModal.show()`, `Auth.switchTab()`). 충돌 지점이 없다.

`#vote-popup`에는 요청대로 `visibility` 기반 페이드인을 추가했다 — 현 증상의 원인은 아니지만
슬라이드 트랜지션 중 텍스트 갱신이 보이는 미세한 깜빡임은 실제로 막아준다.

---

## 5. 레거시 마커 널 세이프티

**제시된 원인:** `zone.address`가 `undefined`라 JS 전체가 다운.

**검증 결과 — 부분적으로만 성립.**
`mapZone()` (`api.js:12-18`)이 이미 널 병합을 하고 있다.
```js
desc: z.description || '',   address: z.address || '',
safeVotes: z.safe_votes || 0,  safeVoterIds: z.safe_voter_ids || [],
```
따라서 `address` 부재로 인한 크래시는 **이미 발생하지 않는다.** 그리고 `undefined` 프로퍼티
읽기는 JS에서 예외가 아니다 — `undefined`를 반환할 뿐 "전체가 다운"되지 않는다.

**실재하는 결함:**
`ZONE_KOREAN[zone.type] || zone.title`에서 **둘 다 없으면 `undefined`가 그대로 렌더**된다.
`ZONE_KOREAN`은 4종(pothole/slippery/construction/other)만 갖고 있는데
`ZONE_ICONS`에는 `wet_road`, `sharp_turn`, `blind_spot`, `steep`, `debris`, `general`이 더 있다.
레거시 행이 이 타입이고 `title`이 null이면 → "방금 지나온 [undefined] 안전해졌나요?"

**적용한 수정:**
- `zoneLabel(zone)` 헬퍼 — `ZONE_KOREAN` → `title` → `ZONE_ICONS` 보유 타입의 일반 라벨 →
  최종 `'위험 구역'` 순으로 폴백. 절대 `undefined`를 반환하지 않는다.
- `VotePopup.show()` 전체를 try/catch로 감쌌다. **텍스트 렌더가 실패하더라도
  `classList.add('open')`은 finally에서 반드시 실행**되어 투표창 자체는 열린다.
  요청의 핵심("과거 마커든 새 마커든 100% 정상 작동")을 구조적으로 보장하는 지점.
- `Alert.show()`, `ZoneList.render()`, `NativeTTS.getZoneMessage()`도 같은 헬퍼로 통일.

---

## 6. PWA TTS 무음

`AudioUnlock` 모듈은 4차 수정에서 이미 존재했다 (`app.js:220`). 빠진 조각만 채웠다.

| 요청 항목 | 4차 상태 | 5차 조치 |
|---|---|---|
| 무음 HTML5 오디오 강제 재생 | 없음 (AudioContext만) | data URI 무음 WAV `<audio>` 재생 추가 |
| `getVoices()` 호출 | 없음 | 프라이밍 + `voiceschanged` 리스너로 캐싱 |
| 무음 TTS 1회 | 있음 | 유지 |
| 재시도 | `{ once: true }` — **1회 실패 시 영구 실패** | 성공 시에만 확정, 실패 시 다음 터치 재시도 |

**`getVoices()`가 중요한 이유:** iOS Safari는 첫 호출에서 **빈 배열**을 반환한다.
비동기로 채워진 뒤 `voiceschanged`가 발화한다. 기존 코드(`app.js:148`)는 발화 시점에
`getVoices().find(ko)`를 호출했는데, 프라이밍 없이는 여기서 `undefined`가 나와
한국어 보이스 없이 기본 보이스로 읽거나 무음이 된다. 이제 언락 시점에 캐싱해 둔다.

---

## 7. PWA 잠금화면 제약 안내

기술적 제약 자체는 사실이다 — iOS Safari/PWA는 화면 잠금 시 JS 타이머와 `geolocation`
콜백이 정지한다. 우회 방법은 없다. 그래서 **고치는 대신 안내**한다.

`PwaNotice` 모듈: `window.Capacitor?.isNativePlatform?.()`가 false일 때만 노출.
- 우측 상단 배지 (상시)
- 최초 1회 안내 문구, 닫으면 `localStorage`에 기억해 재노출 안 함

---

## 검증 한계 (중요)

- **Swift 변경분은 컴파일 검증되지 않았다.** 현재 개발 환경이 윈도우라 Xcode가 없다.
  `VoteIntents.swift`, `BackgroundSafetyPlugin.swift` 변경은 맥북에서
  `npm run cap:sync` 후 실제 빌드로 확인해야 한다.
- 이 프로젝트에는 테스트 스위트가 없다 (`package.json`에 `test` 스크립트 없음).
  JS는 `node --check` 구문 검증과 서버 기동 확인까지만 수행했다.
- 7건 모두 **실기 주행 검증이 필요하다.** 특히 2번(80m)과 3번(락 해제 조건)은
  실제 주행 속도에 따라 상수 재조정이 필요할 수 있다.
