# 5차 실전 라이딩 피드백 — 수정 체크리스트

> 원 피드백 7건. 각 항목의 **실제 원인**은 `context-notes.md` 참조 (사용자 제시 원인과 다른 건이 4개 있음).

## 1. 잠금화면 투표 버튼 무반응
- [x] `VoteSafeIntent.perform()` — 카드 복귀(`returnToIdle`)를 네트워크 Task 생성보다 **먼저** 실행
- [x] `LiveActivityEnder.returnToIdle()` — `activities.first` early-return 제거, 전체 활동 순회 갱신
- [x] `VoteDangerIntent`도 동일 경로 사용 확인
- 검증: 잠금화면에서 버튼 탭 → 네트워크 오프라인 상태에서도 카드가 즉시 idle로 복귀

## 2. 경고/음성 발현 지점 전진 (→ 진입 판정 80m)
- [x] `app.js` `GPS_DELAY_MARGIN` 15 → 30 (기본 alertDist 50 기준 진입 80m)
- [x] `BackgroundSafetyPlugin.swift` `gpsDelayMargin` 15 → 30 (JS와 동기화)
- 검증: 25km/h 주행 시 마커 80m 전 진입 판정 → 체감 30~50m 전방 발현

## 3. 투표창 4회 중복 스팸 박멸
- [x] `app.js` — `voteLockedZones` Map 도입 (zoneId → 해제 시각)
- [x] 진입 분기에서 락 확인 → 락 중이면 재진입 자체를 차단
- [x] 해제 조건: 9초 경과 **AND** 진입 반경 + `ZONE_REARM_MARGIN` 밖으로 실제 이격
- [x] `BackgroundSafetyPlugin.swift` 동일 락 미러링 (네이티브도 같은 재진입 구조)
- [x] `backgroundZoneExit` 리스너에도 동일 락 적용 (JS/네이티브 이중 발현 차단)
- 검증: 마커 1개 통과 시 투표창 정확히 1회

## 4. 앱 실행 시 상단 문구 번쩍임 제거
- [x] `index.html` head 인라인 `<style>`에 `.hidden { display:none !important }` 선언
- [x] `#vote-popup` 초기 `visibility:hidden` + `.open` 시 노출 (페이드인)
- 검증: 새로고침 시 `#verification-modal` / `#form-signup` 플래시 없음

## 5. 레거시 마커 투표창 미발현 / undefined 표기
- [x] `zoneLabel(zone)` 헬퍼 — 알 수 없는 type/빈 title에도 항상 유효한 한글 반환
- [x] `VotePopup.show()` 전체 try/catch — 렌더 실패해도 팝업 자체는 반드시 열림
- [x] `Alert.show()`, `ZoneList.render()`, `NativeTTS.getZoneMessage()` 널 세이프티
- 검증: `type: 'wet_road'`, `title: null`, `address` 없는 레거시 행에서도 투표창 정상

## 6. PWA TTS 무음 해결 (Audio Unlock 강화)
- [x] 무음 HTML5 `<audio>` (data URI WAV) 강제 재생 추가
- [x] `speechSynthesis.getVoices()` 프라이밍 + `voiceschanged` 리스너
- [x] 언락 실패 시 다음 터치에서 재시도 (`once` 제거, 성공 시에만 확정)
- [x] `visibilitychange` 복귀 시 AudioContext 재개
- [x] 한국어 보이스 캐싱 → 첫 발화 무음 방지
- 검증: PWA 최초 실행 → 아무 곳 터치 → 마커 진입 시 음성 출력

## 7. PWA 잠금화면 제약 안내
- [x] `PwaNotice` 모듈 — 네이티브(Capacitor)가 아닐 때만 안내 배너 노출
- [x] 우측 상단 배지 + 최초 1회 안내 문구 (닫기 후 localStorage 기억)
- 검증: 사파리 PWA에서 안내 노출, 네이티브 빌드에서 미노출

## 마감
- [x] `node --check` 전체 JS 구문 검증
- [x] `npm start` 서버 기동 확인
- [ ] Swift 컴파일 검증 — **불가(윈도우 환경)**. 맥북에서 `npm run cap:sync` 후 빌드 필요
- [x] 커밋 + main 푸시 (Render 자동 배포 트리거)
