# 6차 실전 라이딩 피드백 — 수정 체크리스트

> 원 피드백 4건. 각 항목의 **실제 원인**은 `context-notes.md` 참조 (사용자 제시 원인과 다른 건이 1개, 제시안을 반려한 건이 1개).
> 5차까지의 체크리스트는 커밋 `1394f90` 시점의 이 파일 이력 참조.

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
