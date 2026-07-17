// 위험구역 진입/이탈에 따라 잠금화면 Live Activity를 시작·갱신·종료하는 매니저 (App 타겟 전용)
import ActivityKit
import Foundation

final class LiveActivityManager {
    static let shared = LiveActivityManager()
    private init() {}

    // 라이딩 세션당 카드 하나만 유지 — 구역마다 새로 request()하면 잠금화면(백그라운드) 상태에서
    // iOS가 새 Live Activity 시작을 제한해 카드가 뜨지 않는 문제가 있었음. 세션 시작 시 1회만 request()하고
    // 이후에는 같은 활동을 update()만 하도록 전환 (update()는 백그라운드 제한을 받지 않음)
    private var activity: Activity<SafeRideActivityAttributes>?
    private var returnToIdleWorkItem: DispatchWorkItem?

    private static let voteCardLifetime: TimeInterval = 10

    // MARK: - 라이딩 시작 → idle 카드 1회 생성 (반드시 포그라운드 호출 경로에서 실행)

    func startSession() {
        guard ActivityAuthorizationInfo().areActivitiesEnabled else { return }
        guard activity == nil else { return }

        do {
            activity = try Activity.request(
                attributes: SafeRideActivityAttributes(),
                content: .init(state: idleState(), staleDate: nil),
                pushType: nil
            )
        } catch {
            print("[SmartRider] Live Activity 세션 시작 실패: \(error)")
        }
    }

    // MARK: - 구역 진입 → 경고 카드로 갱신

    func showEntry(zoneId: String, zoneType: String, korean: String, icon: String, message: String) {
        guard let activity else { return }
        returnToIdleWorkItem?.cancel()

        let state = SafeRideActivityAttributes.ContentState(
            mode: .entry, zoneId: zoneId, zoneType: zoneType, korean: korean, icon: icon, message: message
        )
        Task { await activity.update(.init(state: state, staleDate: nil)) }
    }

    // MARK: - 구역 이탈 → 3초 후 경고 카드 소멸(idle), 그로부터 1.5초 후 투표 카드 표시(10초 후 idle 복귀)

    private static let exitDismissDelay: TimeInterval = 3
    private static let voteShowDelay: TimeInterval = 1.5

    func scheduleExitSequence(zoneId: String, zoneType: String, korean: String) {
        guard activity != nil else { return }
        returnToIdleWorkItem?.cancel()

        let dismissWork = DispatchWorkItem { [weak self] in
            guard let self, let activity = self.activity else { return }
            Task { await activity.update(.init(state: self.idleState(), staleDate: nil)) }

            let voteWork = DispatchWorkItem { [weak self] in
                guard let self, let activity = self.activity else { return }
                let state = SafeRideActivityAttributes.ContentState(
                    mode: .vote, zoneId: zoneId, zoneType: zoneType, korean: korean, icon: "", message: ""
                )
                Task { await activity.update(.init(state: state, staleDate: nil)) }
                self.scheduleReturnToIdle(after: Self.voteCardLifetime)
            }
            self.returnToIdleWorkItem = voteWork
            DispatchQueue.main.asyncAfter(deadline: .now() + Self.voteShowDelay, execute: voteWork)
        }
        returnToIdleWorkItem = dismissWork
        DispatchQueue.main.asyncAfter(deadline: .now() + Self.exitDismissDelay, execute: dismissWork)
    }

    // MARK: - 라이딩 종료 → 카드 완전 종료

    func endSession() {
        returnToIdleWorkItem?.cancel()
        returnToIdleWorkItem = nil

        guard let activity else { return }
        self.activity = nil
        Task { await activity.end(nil, dismissalPolicy: .immediate) }
    }

    private func scheduleReturnToIdle(after seconds: TimeInterval) {
        returnToIdleWorkItem?.cancel()
        let work = DispatchWorkItem { [weak self] in
            guard let self, let activity = self.activity else { return }
            Task { await activity.update(.init(state: self.idleState(), staleDate: nil)) }
        }
        returnToIdleWorkItem = work
        DispatchQueue.main.asyncAfter(deadline: .now() + seconds, execute: work)
    }

    private func idleState() -> SafeRideActivityAttributes.ContentState {
        .init(mode: .idle, zoneId: "", zoneType: "", korean: "", icon: "", message: "")
    }
}
