import UIKit
import Capacitor
import AVFoundation

@UIApplicationMain
class AppDelegate: UIResponder, UIApplicationDelegate {

    var window: UIWindow?

    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        applyMixablePlaybackCategory()
        registerAudioSessionObservers()
        return true
    }

    // MARK: - Audio Session

    // .playback + .mixWithOthers: 잠금화면에서 AVAudioPlayer·AVSpeechSynthesizer 동작
    //   - 타 앱 음악과 공존 (음악 앱 끊김 없음)
    //   - 잠금화면 미디어 컨트롤 위젯 미표시 (MPNowPlayingInfoCenter 미사용)
    //
    // NativeAudio 등 서드파티 플러그인이 load()에서 mixWithOthers 없이 카테고리를 덮어쓸 수
    // 있어(브리지 초기화가 실행 시점보다 늦음), 포그라운드 복귀·인터럽션 종료 때마다 재확정한다.
    private func applyMixablePlaybackCategory() {
        do {
            let session = AVAudioSession.sharedInstance()
            try session.setCategory(.playback, mode: .default, options: [.mixWithOthers])
            try session.setActive(true)
        } catch {
            print("[SafeRide] AVAudioSession 설정 실패: \(error)")
        }
    }

    private func registerAudioSessionObservers() {
        let center = NotificationCenter.default
        // 포그라운드 복귀 시 재확정 (UIScene 라이프사이클에서도 확실히 불리도록 델리게이트 대신 알림 사용)
        center.addObserver(self,
                           selector: #selector(handleDidBecomeActive),
                           name: UIApplication.didBecomeActiveNotification,
                           object: nil)
        // 전화·타 앱 등으로 인한 오디오 인터럽션이 끝난 시점에 재확정
        center.addObserver(self,
                           selector: #selector(handleAudioSessionInterruption(_:)),
                           name: AVAudioSession.interruptionNotification,
                           object: nil)
    }

    @objc private func handleDidBecomeActive() {
        applyMixablePlaybackCategory()
    }

    @objc private func handleAudioSessionInterruption(_ notification: Notification) {
        guard let info = notification.userInfo,
              let raw = info[AVAudioSessionInterruptionTypeKey] as? UInt,
              let type = AVAudioSession.InterruptionType(rawValue: raw) else { return }
        // 중단(interruption)이 끝난 .ended 케이스에서만 카테고리 재적용
        if type == .ended {
            applyMixablePlaybackCategory()
        }
    }

    deinit {
        NotificationCenter.default.removeObserver(self)
    }

    // MARK: - URL Scheme (Capacitor 플러그인 딥링크 전달용)

    func application(_ app: UIApplication, open url: URL, options: [UIApplication.OpenURLOptionsKey: Any] = [:]) -> Bool {
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
}
