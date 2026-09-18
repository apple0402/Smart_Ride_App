import UIKit
import Capacitor
import AVFoundation

@UIApplicationMain
class AppDelegate: UIResponder, UIApplicationDelegate {

    var window: UIWindow?

    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        // ⚠️ 반드시 최상단 — NativeAudio 등 플러그인 load() 보다 먼저 스위즐을 설치해야
        //    그들의 setCategory(.playback) 호출에도 mixWithOthers 가 강제 주입된다.
        AudioSessionHardening.install()
        AudioSessionLog.log("didFinishLaunching 진입")
        applyMixablePlaybackCategory(reason: "didFinishLaunching")
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
    // (근본 방어는 AudioSessionHardening 스위즐이 담당 — 여기는 세션 active 재확정 겸 진단 로그.)
    private static var applyCount = 0
    private func applyMixablePlaybackCategory(reason: String) {
        AppDelegate.applyCount += 1
        let n = AppDelegate.applyCount
        let session = AVAudioSession.sharedInstance()
        AudioSessionLog.log("applyMixablePlaybackCategory() #\(n) [\(reason)] 진입전 — cat=\(session.category.rawValue) opts=\(session.categoryOptions.rawValue) otherAudioPlaying=\(session.isOtherAudioPlaying)")
        do {
            try session.setCategory(.playback, mode: .default, options: [.mixWithOthers])
            try session.setActive(true)
            AudioSessionLog.log("applyMixablePlaybackCategory() #\(n) [\(reason)] 적용후 — cat=\(session.category.rawValue) opts=\(session.categoryOptions.rawValue) otherAudioPlaying=\(session.isOtherAudioPlaying)")
        } catch {
            AudioSessionLog.log("applyMixablePlaybackCategory() #\(n) [\(reason)] 실패: \(error)")
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
        AudioSessionLog.log("didBecomeActiveNotification 수신")
        applyMixablePlaybackCategory(reason: "didBecomeActive")
    }

    @objc private func handleAudioSessionInterruption(_ notification: Notification) {
        guard let info = notification.userInfo,
              let raw = info[AVAudioSessionInterruptionTypeKey] as? UInt,
              let type = AVAudioSession.InterruptionType(rawValue: raw) else { return }
        AudioSessionLog.log("interruption 수신 type=\(type == .began ? "began" : "ended")")
        // 중단(interruption)이 끝난 .ended 케이스에서만 카테고리 재적용
        if type == .ended {
            applyMixablePlaybackCategory(reason: "interruptionEnded")
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

// MARK: - Audio Session 진단 로그 + 하드닝(스위즐)

/// 콘솔 필터용 공통 prefix. Xcode 콘솔에서 "SafeRideAudio" 로 검색하면 오디오 세션 흐름만 모아 볼 수 있다.
/// 로그 출력은 DEBUG 빌드에서만 컴파일된다(Release 로그 스팸 방지). mixWithOthers 강제 주입 로직은 항상 동작.
enum AudioSessionLog {
    static func log(_ message: @autoclosure () -> String) {
        #if DEBUG
        NSLog("[SafeRideAudio] %.3f (%@) %@",
              Date().timeIntervalSince1970,
              Thread.isMainThread ? "main" : "bg",
              message())
        #endif
    }
}

/// AVAudioSession.setCategory / setActive 를 런타임 스위즐한다.
///  1) 진단: 누가 언제 어떤 category/options 로 세션을 건드리는지, setActive(true) 가 mixWithOthers 없이
///     몇 번 불리는지 전부 로깅한다. (요구사항 #2 플러그인 load() 시점, #3 setActive 횟수 확인)
///  2) 하드닝(FIX): .playback / .playAndRecord 로 카테고리를 세팅할 때 mixWithOthers 를 강제로 넣는다.
///     NativeAudio 플러그인 load() 가 mixWithOthers 없는 .playback 로 덮어써도, 이 스위즐이 항상
///     mixWithOthers 를 되살리므로 이후 setActive(true) 가 다른 앱(유튜브/음악) 오디오를 끊지 않는다.
enum AudioSessionHardening {
    private static var installed = false

    static func install() {
        guard !installed else { return }
        installed = true
        exchange(NSSelectorFromString("setCategory:error:"),              NSSelectorFromString("sr_setCategory:error:"))
        exchange(NSSelectorFromString("setCategory:mode:options:error:"), NSSelectorFromString("sr_setCategory:mode:options:error:"))
        exchange(NSSelectorFromString("setActive:error:"),                NSSelectorFromString("sr_setActive:error:"))
        exchange(NSSelectorFromString("setActive:withOptions:error:"),    NSSelectorFromString("sr_setActive:withOptions:error:"))
        AudioSessionLog.log("AudioSessionHardening 설치 완료 — setCategory/setActive 스위즐 활성")
    }

    private static func exchange(_ original: Selector, _ replacement: Selector) {
        let cls: AnyClass = AVAudioSession.self
        guard let o = class_getInstanceMethod(cls, original),
              let r = class_getInstanceMethod(cls, replacement) else {
            AudioSessionLog.log("⚠️ 스위즐 실패 — 셀렉터 미발견 \(original)/\(replacement)")
            return
        }
        method_exchangeImplementations(o, r)
    }
}

extension AVAudioSession {

    /// .playback/.playAndRecord 면 mixWithOthers 를 보강한 옵션을 돌려준다. 그 외 카테고리는 원본 유지.
    fileprivate func sr_mixEnforced(_ category: AVAudioSession.Category,
                                    _ options: AVAudioSession.CategoryOptions) -> AVAudioSession.CategoryOptions {
        guard category == .playback || category == .playAndRecord else { return options }
        var opts = options
        opts.insert(.mixWithOthers)
        return opts
    }

    // setCategory(_:) — NativeAudio.load() 가 부르는 경로. mode/options 버전으로 승격해 mix 를 주입.
    @objc(sr_setCategory:error:)
    fileprivate func sr_setCategory(_ category: AVAudioSession.Category) throws {
        let forced = sr_mixEnforced(category, [])
        if forced.contains(.mixWithOthers) {
            AudioSessionLog.log("setCategory(\(category.rawValue)) 감지 → mixWithOthers 강제 주입(opts=\(forced.rawValue))")
            try self.sr_setCategory(category, mode: .default, options: forced)  // exchange 후 → 원본 mode/options 구현
        } else {
            AudioSessionLog.log("setCategory(\(category.rawValue)) passthrough")
            try self.sr_setCategory(category)                                    // exchange 후 → 원본 구현
        }
    }

    @objc(sr_setCategory:mode:options:error:)
    fileprivate func sr_setCategory(_ category: AVAudioSession.Category,
                                    mode: AVAudioSession.Mode,
                                    options: AVAudioSession.CategoryOptions) throws {
        let forced = sr_mixEnforced(category, options)
        if forced != options {
            AudioSessionLog.log("setCategory(\(category.rawValue), reqOpts=\(options.rawValue)) → opts=\(forced.rawValue) (mix 강제)")
        } else {
            AudioSessionLog.log("setCategory(\(category.rawValue), opts=\(options.rawValue))")
        }
        try self.sr_setCategory(category, mode: mode, options: forced)           // exchange 후 → 원본 구현
    }

    @objc(sr_setActive:error:)
    fileprivate func sr_setActive(_ active: Bool) throws {
        sr_logActive(active)
        try self.sr_setActive(active)                                           // exchange 후 → 원본 구현
    }

    @objc(sr_setActive:withOptions:error:)
    fileprivate func sr_setActiveWithOptions(_ active: Bool,
                                             options: AVAudioSession.SetActiveOptions) throws {
        sr_logActive(active)
        try self.sr_setActiveWithOptions(active, options: options)              // exchange 후 → 원본 구현
    }

    private func sr_logActive(_ active: Bool) {
        let cat = self.category
        let opts = self.categoryOptions
        let mix = opts.contains(.mixWithOthers)
        AudioSessionLog.log("setActive(\(active)) 시점 — cat=\(cat.rawValue) opts=\(opts.rawValue) mixWithOthers=\(mix) otherAudioPlaying=\(self.isOtherAudioPlaying)")
        if active && !mix {
            AudioSessionLog.log("⚠️⚠️ setActive(true) WITHOUT mixWithOthers — 이 순간 다른 앱 오디오가 끊깁니다 (스위즐이 정상이면 발생하지 않아야 함)")
        }
    }
}
