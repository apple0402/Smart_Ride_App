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
        // LiveActivityIntent는 익스텐션 프로세스의 짧은 실행 예산 안에서 끝나야 한다.
        // 기존에는 withTaskGroup으로 네트워크 완료를 "대기 후 취소"했는데, TaskGroup은
        // cancelAll() 이후에도 스코프를 벗어나기 전 자식 Task가 실제로 반환할 때까지
        // 구조적으로 기다리므로, 네트워크가 느리면 그 대기 자체가 실행 예산을 넘겨
        // 응답을 기록하기도 전에 프로세스가 통째로 종료되는(카드가 idle로 못 돌아오는)
        // 원인이 됐다. → 투표 전송은 완전히 분리된(unstructured) Task로 흘려보내고,
        // 카드 복귀는 그 네트워크 완료를 절대 기다리지 않고 즉시 실행한다.
        Task.detached(priority: .userInitiated) {
            await SupabaseVoteService.voteSafe(zoneId: zoneId)
        }
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
