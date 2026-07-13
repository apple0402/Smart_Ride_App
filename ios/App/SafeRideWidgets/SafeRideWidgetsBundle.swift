// SafeRideWidgets 익스텐션의 진입점 — Live Activity 하나만 제공
import WidgetKit
import SwiftUI

@main
struct SafeRideWidgetsBundle: WidgetBundle {
    var body: some Widget {
        SafeRideLiveActivity()
    }
}
