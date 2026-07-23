// 잠금화면·Dynamic Island에 표시되는 위험구역 경고/투표 Live Activity UI
import ActivityKit
import WidgetKit
import SwiftUI

struct SafeRideLiveActivity: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: SafeRideActivityAttributes.self) { context in
            LockScreenCardView(attributes: context.attributes, state: context.state)
                .activityBackgroundTint(Color(red: 0.059, green: 0.09, blue: 0.165))
                .activitySystemActionForegroundColor(.white)

        } dynamicIsland: { context in
            DynamicIsland {
                DynamicIslandExpandedRegion(.center) {
                    LockScreenCardView(attributes: context.attributes, state: context.state)
                        .padding(.vertical, 4)
                }
            } compactLeading: {
                Text(compactSymbol(for: context.state.mode, icon: context.state.icon))
            } compactTrailing: {
                switch context.state.mode {
                case .idle:  EmptyView()
                case .entry: Text("주의").font(.caption2)
                case .vote:  Text("투표").font(.caption2)
                }
            } minimal: {
                Text(compactSymbol(for: context.state.mode, icon: context.state.icon))
            }
        }
    }

    private func compactSymbol(for mode: SafeRideActivityAttributes.ContentState.Mode, icon: String) -> String {
        switch mode {
        case .idle:  return "🚲"
        case .entry: return icon
        case .vote:  return "🚦"
        }
    }
}

private struct LockScreenCardView: View {
    let attributes: SafeRideActivityAttributes
    let state: SafeRideActivityAttributes.ContentState

    var body: some View {
        switch state.mode {
        case .idle:   IdleCard()
        case .entry:  EntryCard(state: state)
        case .vote:   VoteCard(zoneId: state.zoneId, state: state)
        }
    }
}

// MARK: - 대기 카드 (위험구역 밖 — 미니멀 유지)

private struct IdleCard: View {
    var body: some View {
        HStack(spacing: 10) {
            Text("🚲")
                .font(.system(size: 20))
            Text("안전 라이딩 중")
                .font(.footnote)
                .foregroundStyle(.white.opacity(0.7))
            Spacer()
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
    }
}

// MARK: - 진입 경고 카드

private struct EntryCard: View {
    let state: SafeRideActivityAttributes.ContentState

    var body: some View {
        HStack(spacing: 14) {
            Text(state.icon)
                .font(.system(size: 40))

            VStack(alignment: .leading, spacing: 4) {
                Text(state.korean)
                    .font(.headline)
                    .foregroundStyle(.white)
                Text(state.message)
                    .font(.subheadline)
                    .foregroundStyle(.white.opacity(0.85))
            }
            Spacer()
        }
        .padding(16)
    }
}

// MARK: - 이탈 투표 카드

private struct VoteCard: View {
    let zoneId: String
    let state: SafeRideActivityAttributes.ContentState

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("🚦 위험 지역 통과")
                .font(.headline)
                .foregroundStyle(.white)

            Text("방금 지나온 [\(state.korean)] 안전해졌나요?")
                .font(.subheadline)
                .foregroundStyle(.white.opacity(0.85))

            HStack(spacing: 10) {
                Button(intent: VoteDangerIntent(zoneId: zoneId)) {
                    Text("🚨 아직 위험해요")
                        .font(.title3.weight(.bold))
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 10)
                }
                .tint(.red.opacity(0.85))

                Button(intent: VoteSafeIntent(zoneId: zoneId, zoneType: state.zoneType)) {
                    Text("✅ 이젠 안전해요")
                        .font(.title3.weight(.bold))
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 10)
                }
                .tint(.green.opacity(0.85))
            }
            .buttonStyle(.borderedProminent)
            .controlSize(.large)
        }
        .padding(16)
    }
}
