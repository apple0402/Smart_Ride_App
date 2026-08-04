// 잠금화면 투표 카드 버튼 — 앱을 열지 않고 익스텐션 프로세스 안에서 바로 처리 (LiveActivityIntent)
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
        // 익스텐션 프로세스가 언제 종료되든 유저가 본 카드는 이미 사라진 뒤가 되도록 보장.
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
    // [5차 수정] 버튼 무반응의 실제 원인 지점.
    // 기존: `guard let activity = ...activities.first else { return }`
    //   → 익스텐션 프로세스에서 activities 배열이 아직 비어 있거나 동기화되지 않은 시점에
    //     호출되면 "조용히 아무것도 하지 않고" 반환했다. 유저 입장에서는 버튼을 눌렀는데
    //     카드가 그대로 남아 있는 = 터치가 씹힌 것으로 보였다.
    // 수정: early-return을 없애고 전체 활동을 순회 갱신한다. 배열이 비면 루프가 0회 돌 뿐,
    //      함수가 중간에 죽지 않으므로 호출자(perform)는 항상 정상 완료된다.
    static func returnToIdle() async {
        let idleState = SafeRideActivityAttributes.ContentState(
            mode: .idle, zoneId: "", zoneType: "", korean: "", icon: "", message: ""
        )
        let content = ActivityContent(state: idleState, staleDate: nil)
        for activity in Activity<SafeRideActivityAttributes>.activities {
            await activity.update(content)
        }
    }
}
