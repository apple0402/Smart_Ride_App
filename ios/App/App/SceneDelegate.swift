// iOS 13+ UIScene 라이프사이클 채택 (iOS 26/27 부터는 미채택 시 런치 크래시 —
//   EXC_BREAKPOINT @ _UIApplicationEvaluateRuntimeIssueForNoSceneLifecycleAdoption).
//
// 실제 딥링크/유니버설 링크·씬 연결 처리는 Capacitor 8 이 내장한 SceneDelegateProxy
// (CAPSceneDelegateProxy) 에 그대로 위임한다. 윈도우/루트 뷰컨트롤러는 Info.plist 의
// UISceneStoryboardFile=Main 설정으로 UIKit 이 Main.storyboard(→ MainViewController)에서
// 자동 생성하므로 여기서 직접 만들지 않는다.
import UIKit
import Capacitor

class SceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?

    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options connectionOptions: UIScene.ConnectionOptions) {
        SceneDelegateProxy.shared.scene(scene, willConnectTo: session, options: connectionOptions)
    }

    func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
        SceneDelegateProxy.shared.scene(scene, openURLContexts: URLContexts)
    }

    func scene(_ scene: UIScene, continue userActivity: NSUserActivity) {
        SceneDelegateProxy.shared.scene(scene, continue: userActivity)
    }
}
