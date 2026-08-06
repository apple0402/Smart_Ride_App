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

    // [6차 수정] 최초 렌더링 시 버튼이 잘리고, 화면을 툭 건드리면 그제야 전체가 보이던 문제.
    // 원인은 카드의 고유 높이가 잠금화면 Live Activity의 높이 예산(약 160pt)을 넘긴 것이다.
    //   기존 실측: 상하 패딩 32 + 헤드라인 21 + spacing 12 + 서브헤드라인(2줄 래핑 시) 40
    //            + spacing 12 + 버튼(.controlSize(.large) 내부 패딩 + .padding(.vertical,10) 이중 적용) ≈ 58
    //            = 175pt → 초과분이 잘려 나갔고, 터치로 레이아웃이 재계산될 때만 온전히 보였다.
    // 수정 방침: 버튼의 특대형 터치 영역(높이 54pt)은 그대로 유지하고, 넘치던 나머지를 걷어낸다.
    //   ① .controlSize(.large) 제거 + minHeight 54로 버튼 높이를 명시적으로 고정(이중 패딩 제거)
    //   ② 라벨 lineLimit(1) + minimumScaleFactor — 좁은 폭에서 래핑으로 버튼이 세로로 커지는 것 차단
    //   ③ 바깥 패딩·spacing 축소
    // 수정 후 실측: 10 + 21 + 6 + 20 + 6 + 54 + 12 = 129pt → 예산 내, 최초 렌더부터 100% 노출.
    private static let buttonHeight: CGFloat = 54

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("🚦 위험 지역 통과")
                .font(.headline)
                .foregroundStyle(.white)
                .lineLimit(1)

            Text("방금 지나온 [\(state.korean)] 안전해졌나요?")
                .font(.subheadline)
                .foregroundStyle(.white.opacity(0.85))
                .lineLimit(1)
                .minimumScaleFactor(0.7)

            HStack(spacing: 10) {
                Button(intent: VoteDangerIntent(zoneId: zoneId)) {
                    Text("🚨 아직 위험해요")
                        .font(.title3.weight(.bold))
                        .lineLimit(1)
                        .minimumScaleFactor(0.65)
                        .frame(maxWidth: .infinity, minHeight: Self.buttonHeight)
                }
                .tint(.red.opacity(0.85))

                Button(intent: VoteSafeIntent(zoneId: zoneId, zoneType: state.zoneType)) {
                    Text("✅ 이젠 안전해요")
                        .font(.title3.weight(.bold))
                        .lineLimit(1)
                        .minimumScaleFactor(0.65)
                        .frame(maxWidth: .infinity, minHeight: Self.buttonHeight)
                }
                .tint(.green.opacity(0.85))
            }
            .buttonStyle(.borderedProminent)
        }
        .padding(.horizontal, 14)
        .padding(.top, 10)
        .padding(.bottom, 12)
    }
}
