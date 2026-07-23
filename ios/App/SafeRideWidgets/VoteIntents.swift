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
        // 네트워크가 느려도 잠금화면 카드가 무한정 멈춰있지 않도록 상한 시간을 두고,
        // 그 안에서 못 끝나면 투표 기록은 포기하더라도 카드는 반드시 idle로 복귀시킨다.
        await withTimeout(seconds: 6) {
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

// 지정 시간 내에 operation이 끝나지 않으면 포기하고 반환 — LiveActivityIntent가
// 네트워크 지연 때문에 응답 없이 멈춘 것처럼 보이는 문제(먹통) 방지
private func withTimeout(seconds: TimeInterval, operation: @escaping () async -> Void) async {
    await withTaskGroup(of: Void.self) { group in
        group.addTask { await operation() }
        group.addTask { try? await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000)) }
        await group.next()
        group.cancelAll()
    }
}
