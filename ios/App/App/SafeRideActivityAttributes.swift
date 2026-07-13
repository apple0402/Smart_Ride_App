// 잠금화면 위험구역 경고·투표 Live Activity의 공유 데이터 모델 — App, SafeRideWidgets 두 타겟 모두에 포함되어야 함
import ActivityKit
import Foundation

struct SafeRideActivityAttributes: ActivityAttributes {
    struct ContentState: Codable, Hashable {
        enum Mode: String, Codable {
            case idle   // 대기 — 위험구역 밖, 잠금화면에 미니멀하게 유지
            case entry  // 위험구역 진입 — 경고 카드
            case vote   // 위험구역 이탈 — 투표 카드
        }

        var mode: Mode
        var zoneId: String
        var zoneType: String
        var korean: String
        var icon: String
        var message: String
    }
}
