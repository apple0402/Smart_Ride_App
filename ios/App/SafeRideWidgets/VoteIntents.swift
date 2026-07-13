// 잠금화면 투표 카드 버튼 — 앱을 열지 않고 익스텐션 프로세스 안에서 바로 처리 (LiveActivityIntent)
import AppIntents
import ActivityKit

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
        await SupabaseVoteService.voteSafe(zoneId: zoneId)
        await LiveActivityEnder.returnToIdle()
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
    // 라이딩 세션당 카드가 하나뿐이므로 첫 번째 활동을 그대로 idle 상태로 갱신
    static func returnToIdle() async {
        guard let activity = Activity<SafeRideActivityAttributes>.activities.first else { return }
        let idleState = SafeRideActivityAttributes.ContentState(
            mode: .idle, zoneId: "", zoneType: "", korean: "", icon: "", message: ""
        )
        await activity.update(.init(state: idleState, staleDate: nil))
    }
}
