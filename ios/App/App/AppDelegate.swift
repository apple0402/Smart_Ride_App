import UIKit
import Capacitor
import AVFoundation
import UserNotifications

@UIApplicationMain
class AppDelegate: UIResponder, UIApplicationDelegate {

    var window: UIWindow?

    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        configureBackgroundAudio()
        configureLocalNotifications()
        return true
    }

    // MARK: - Audio Session

    // .playback + .mixWithOthers: 잠금화면에서 AVAudioPlayer·AVSpeechSynthesizer 동작
    //   - 타 앱 음악과 공존 (음악 앱 끊김 없음)
    //   - 잠금화면 미디어 컨트롤 위젯 미표시 (MPNowPlayingInfoCenter 미사용)
    private func configureBackgroundAudio() {
        do {
            let session = AVAudioSession.sharedInstance()
            try session.setCategory(.playback, mode: .default, options: [.mixWithOthers, .duckOthers])
            try session.setActive(true)
        } catch {
            print("[SmartRider] AVAudioSession 설정 실패: \(error)")
        }
    }

    // MARK: - Local Notifications

    private func configureLocalNotifications() {
        let center = UNUserNotificationCenter.current()
        center.delegate = self

        // 잠금화면 알림 권한 요청 — 경보(alert)·배지·사운드
        center.requestAuthorization(options: [.alert, .sound, .badge]) { granted, error in
            if let error = error {
                print("[SmartRider] 알림 권한 요청 실패: \(error)")
            }
        }
    }

    // MARK: - URL Scheme (deeplink fallback)

    func application(_ app: UIApplication, open url: URL, options: [UIApplication.OpenURLOptionsKey: Any] = [:]) -> Bool {
        // smartrider://vote?result=safe|danger — 투표 딥링크 처리
        if url.scheme == "smartrider", url.host == "vote",
           let components = URLComponents(url: url, resolvingAgainstBaseURL: false),
           let result = components.queryItems?.first(where: { $0.name == "result" })?.value {
            let zoneId   = components.queryItems?.first(where: { $0.name == "zoneId" })?.value ?? ""
            let zoneType = components.queryItems?.first(where: { $0.name == "zoneType" })?.value ?? "other"
            fireVoteEvent(zoneId: zoneId, zoneType: zoneType, result: result)
        }
        return ApplicationDelegateProxy.shared.application(app, open: url, options: options)
    }

    func application(_ application: UIApplication, continue userActivity: NSUserActivity, restorationHandler: @escaping ([UIUserActivityRestoring]?) -> Void) -> Bool {
        return ApplicationDelegateProxy.shared.application(application, continue: userActivity, restorationHandler: restorationHandler)
    }

    // MARK: - App Lifecycle

    func applicationWillResignActive(_ application: UIApplication) {}
    func applicationDidEnterBackground(_ application: UIApplication) {}
    func applicationWillEnterForeground(_ application: UIApplication) {}
    func applicationDidBecomeActive(_ application: UIApplication) {}
    func applicationWillTerminate(_ application: UIApplication) {}

    // MARK: - Internal

    private func fireVoteEvent(zoneId: String, zoneType: String, result: String = "") {
        // BackgroundSafetyPlugin이 NSNotification을 수신해 JS notifyListeners로 전달
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) {
            NotificationCenter.default.post(
                name: NSNotification.Name("SmartRiderZoneExitVote"),
                object: nil,
                userInfo: ["zoneId": zoneId, "zoneType": zoneType, "result": result]
            )
        }
    }
}

// MARK: - UNUserNotificationCenterDelegate

extension AppDelegate: UNUserNotificationCenterDelegate {

    // 앱이 포그라운드 상태일 때 알림 도착 — 배너 표시
    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification,
        withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
    ) {
        // 포그라운드에서도 배너·사운드 표시 (iOS 14+ .banner, 하위 .alert)
        if #available(iOS 14.0, *) {
            completionHandler([.banner, .sound])
        } else {
            completionHandler([.alert, .sound])
        }
    }

    // 사용자가 알림 배너를 탭했을 때 — 앱 포그라운드로 복귀, 투표창 표시
    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse,
        withCompletionHandler completionHandler: @escaping () -> Void
    ) {
        let userInfo = response.notification.request.content.userInfo
        let action   = userInfo["action"]   as? String ?? ""
        let zoneId   = userInfo["zoneId"]   as? String ?? ""
        let zoneType = userInfo["zoneType"] as? String ?? "other"

        if action == "vote" {
            fireVoteEvent(zoneId: zoneId, zoneType: zoneType)
        }
        completionHandler()
    }
}
