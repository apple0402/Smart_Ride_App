// 잠금화면 투표 카드 버튼 — LiveActivityIntent로 앱 프로세스에서 처리 (App·SafeRideWidgets 두 타겟 모두에 포함되어야 함)
import AppIntents
import ActivityKit
import Foundation

struct VoteSafeIntent: LiveActivityIntent {
    static var title: LocalizedStringResource = "안전 투표"

    @Parameter(title: "Zone ID")
    var zoneId: String = ""

    @Parameter(title: "Zone Type")
    var zoneType: String = ""

    init() {}

    init(zoneId: String, zoneType: String) {
        self.zoneId = zoneId
        self.zoneType = zoneType
    }

    func perform() async throws -> some IntentResult {
        // [5차 수정] 카드 복귀를 "가장 먼저" 실행한다.
        // 4차에서 withTaskGroup → Task.detached로 바꾼 것 자체는 옳았다(네트워크를 기다리지 않음).
        // 그럼에도 버튼이 씹힌 실제 원인은 returnToIdle() 내부의 early-return이었다(아래 참조).
        // 여기서는 순서까지 뒤집어, 투표 전송 Task 생성보다 카드 복귀를 앞세운다 →
        // 실행 프로세스가 언제 종료되든 유저가 본 카드는 이미 복귀한 뒤가 되도록 보장.
        await LiveActivityEnder.returnToIdle()

        // 전송 실패·타임아웃·프로세스 강제 종료 여부와 무관하게 위 복귀는 이미 끝났다.
        // (voteSafe는 내부에서 try?로 모든 실패를 삼키므로 throw 경로가 존재하지 않는다)
        let capturedZoneId = zoneId
        Task.detached(priority: .userInitiated) {
            await SupabaseVoteService.voteSafe(zoneId: capturedZoneId)
        }
        return .result()
    }
}

struct VoteDangerIntent: LiveActivityIntent {
    static var title: LocalizedStringResource = "위험 유지"

    @Parameter(title: "Zone ID")
    var zoneId: String = ""

    init() {}

    init(zoneId: String) {
        self.zoneId = zoneId
    }

    // 서버에는 아무 것도 기록하지 않음 — 현재 웹의 VotePopup.vote('danger')와 동일하게 카드만 대기 상태로 복귀
    func perform() async throws -> some IntentResult {
        await LiveActivityEnder.returnToIdle()
        return .result()
    }
}

enum LiveActivityEnder {
    // [6차 수정] 5차에서 early-return을 제거했는데도 카드가 그대로 남은 진짜 이유.
    //
    // LiveActivityIntent는 "앱 프로세스"에서 실행되도록 설계된 프로토콜이다. 단, 시스템이 그렇게
    // 라우팅하려면 인텐트 타입이 앱 번들의 AppIntents 메타데이터에 들어 있어야 한다 = 소스가
    // App 타겟에도 컴파일되어 있어야 한다. 그런데 VoteIntents.swift는 SafeRideWidgets 익스텐션
    // 타겟에만 들어 있었다(project.pbxproj Sources 빌드 단계 확인). 그 결과 perform()이 위젯
    // 익스텐션 프로세스에서 돌았고, 그 프로세스의 Activity.activities는 앱이 request()한 활동을
    // 담고 있지 않다 → 루프가 0회 돌거나 update()가 조용히 버려졌다. 5차에 early-return을
    // 없애도 루프 "본문"이 효력이 없었으므로 증상이 그대로였던 것.
    //
    // 근본 수정은 project.pbxproj 쪽이다(VoteIntents.swift + SupabaseVoteService.swift를
    // App 타겟 Sources에 추가). 이제 perform()이 앱 프로세스에서 돌고 activities가 채워지므로
    // update()가 실제로 반영된다.
    //
    // end(dismissalPolicy:)는 쓰지 않는다 — 이 앱은 라이딩 세션당 활동을 1개만 request()해서
    // 계속 재사용하는 구조라(LiveActivityManager), 투표 한 번에 end()를 걸면 남은 주행 내내
    // 경고·투표 카드가 다시는 뜨지 않는다. 상태를 .idle로 되돌리는 쪽이 맞다.
    static func returnToIdle() async {
        let idleState = SafeRideActivityAttributes.ContentState(
            mode: .idle, zoneId: "", zoneType: "", korean: "", icon: "", message: ""
        )
        let content = ActivityContent(state: idleState, staleDate: nil)
        for activity in Activity<SafeRideActivityAttributes>.activities {
            await activity.update(content)
        }

        // perform()이 반환되는 순간 시스템은 프로세스를 즉시 정지시킬 수 있다. update()가
        // ActivityKit에 접수된 뒤 위젯 타임라인이 실제로 다시 그려질 짧은 여유를 남긴다.
        try? await Task.sleep(nanoseconds: 250_000_000)
    }
}
