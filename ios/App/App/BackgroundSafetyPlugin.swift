// 화면 잠금 상태에서도 동작하는 네이티브 백그라운드 위치 추적·위험구역 감지·오디오 트리거 플러그인
import Foundation
import Capacitor
import CoreLocation
import AVFoundation

@objc(BackgroundSafety)
public class BackgroundSafetyPlugin: CAPPlugin, CAPBridgedPlugin, CLLocationManagerDelegate {

    // Capacitor 8은 이 프로토콜을 구현하지 않으면 registerPluginInstance()가 플러그인을 조용히 무시함
    // (capacitor.config.json의 packageClassList는 npm 플러그인 전용이라 로컬 플러그인은 별도 등록 필요 — MainViewController.swift 참고)
    public let identifier = "BackgroundSafety"
    public let jsName = "BackgroundSafety"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "startBackgroundTracking", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stopBackgroundTracking", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setZones", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "syncAuthSession", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "clearAuthSession", returnType: CAPPluginReturnPromise)
    ]

    // 플러그인 인스턴스와 함께 앱 전체 생명주기 동안 유지되는 강한 참조 — 옵셔널 해제로 인한 GPS 중단 방지
    private let locationManager = CLLocationManager()
    private var zones: [[String: Any]] = []
    private var alertedZones   = Set<String>()  // 알림 중복 방지용
    private var enteredZones   = [String: Double]()  // 진입 중인 구역 id → 진입 후 관측된 최소 거리(minDist)
    // GPS 딜레이 보정 마진 — JS(app.js)의 GPS_DELAY_MARGIN과 동일한 의도: 설정 거리 그대로 판정하면
    // 주행 속도상 실제로는 수 미터 늦게 잡히므로, 진입 판정을 앞당겨 체감상 정확한 지점에서 경고되게 함
    private let gpsDelayMargin: Double = 15
    // 이탈(투표창) 확정 마진 — 절대 거리가 아닌 "진입 후 가장 가까웠던 지점(minDist)" 대비 재이격 거리.
    // JS의 VOTE_EXIT_MARGIN과 동일 — 마커를 지나친 직후 10m대에서 바로 이탈이 확정되게 함
    private let voteExitMargin: Double = 10
    private var audioPlayers: [String: AVAudioPlayer] = [:]
    private var synthesizer = AVSpeechSynthesizer()
    private var isTracking = false
    private var globalAlertDist: Double = 50

    private let ttsMessages: [String: String] = [
        "pothole":      "도로 파손, 단차 충격 주의!!",
        "slippery":     "맨홀 미끄럼 주의!!",
        "construction": "공사 중!! 서행 하세요!!",
        "other":        "위험 구역 주의하세요"
    ]

    // public/js/app.js의 ZONE_KOREAN과 동일한 문구로 통일 — 잠금화면 알림이 인앱 배너와 같은 텍스트를 쓰도록
    private let zoneKorean: [String: String] = [
        "pothole":      "포트홀 / 크랙",
        "slippery":     "맨홀 / 미끄러움",
        "construction": "도로 / 보도 공사",
        "other":        "기타 위험"
    ]

    // public/js/app.js의 ZONE_ICONS와 동일
    private let zoneIcons: [String: String] = [
        "pothole":      "🕳️",
        "slippery":     "🧼",
        "construction": "🚧",
        "other":        "⚠️"
    ]

    override public func load() {
        locationManager.delegate = self
        locationManager.desiredAccuracy = kCLLocationAccuracyBestForNavigation
        locationManager.distanceFilter = 1
        locationManager.allowsBackgroundLocationUpdates = true
        locationManager.pausesLocationUpdatesAutomatically = false
        locationManager.showsBackgroundLocationIndicator = true
        preloadAudio()
    }

    // MARK: - Auth Session Bridge (JS 로그인 세션 → 위젯 익스텐션 공유 Keychain)

    @objc func syncAuthSession(_ call: CAPPluginCall) {
        guard let token  = call.getString("accessToken"),
              let userId = call.getString("userId") else {
            call.reject("accessToken/userId가 필요합니다")
            return
        }
        KeychainHelper.saveAuthSession(accessToken: token, userId: userId)
        call.resolve()
    }

    @objc func clearAuthSession(_ call: CAPPluginCall) {
        KeychainHelper.clearAuthSession()
        call.resolve()
    }

    // MARK: - Plugin Methods

    @objc func startBackgroundTracking(_ call: CAPPluginCall) {
        if let raw = call.getArray("zones") {
            zones = raw.compactMap { $0 as? [String: Any] }
        }
        if let dist = call.getDouble("alertDist") {
            globalAlertDist = dist
        }
        alertedZones.removeAll()
        enteredZones.removeAll()

        DispatchQueue.main.async { [weak self] in
            guard let self = self else { return }
            self.isTracking = true
            self.locationManager.desiredAccuracy = kCLLocationAccuracyBestForNavigation
            self.locationManager.distanceFilter = 1
            self.locationManager.allowsBackgroundLocationUpdates = true
            self.locationManager.pausesLocationUpdatesAutomatically = false
            self.locationManager.showsBackgroundLocationIndicator = true

            // 라이딩 시작은 항상 앱이 포그라운드일 때 호출되므로, 잠금화면 카드를 여기서 1회만 미리 생성
            LiveActivityManager.shared.startSession()

            switch self.locationManager.authorizationStatus {
            case .authorizedAlways:
                self.locationManager.startUpdatingLocation()
            case .authorizedWhenInUse:
                // WhenInUse만 있으면 백그라운드 진입 시 GPS가 끊김 — 우선 추적 시작 + Always 업그레이드 요청
                self.locationManager.startUpdatingLocation()
                self.locationManager.requestAlwaysAuthorization()
            case .notDetermined:
                self.locationManager.requestAlwaysAuthorization()
            default:
                break
            }
        }
        call.resolve(["started": true])
    }

    @objc func stopBackgroundTracking(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in
            self?.locationManager.stopUpdatingLocation()
            self?.isTracking = false
            LiveActivityManager.shared.endSession()
        }
        call.resolve()
    }

    @objc func setZones(_ call: CAPPluginCall) {
        if let raw = call.getArray("zones") {
            zones = raw.compactMap { $0 as? [String: Any] }
        }
        if let dist = call.getDouble("alertDist") {
            globalAlertDist = dist
        }
        call.resolve()
    }

    // MARK: - CLLocationManagerDelegate

    public func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        guard let loc = locations.last else { return }

        var payload: [String: Any] = [
            "lat": loc.coordinate.latitude,
            "lng": loc.coordinate.longitude,
            "accuracy": loc.horizontalAccuracy
        ]
        if loc.course >= 0 { payload["course"] = loc.course }
        if loc.speed >= 0  { payload["speed"]  = loc.speed  }
        notifyListeners("locationUpdate", data: payload)

        checkProximity(location: loc)
    }

    public func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        guard isTracking else { return }
        let status = manager.authorizationStatus
        if status == .authorizedAlways || status == .authorizedWhenInUse {
            manager.startUpdatingLocation()
        }
    }

    // iOS 14 미만 호환
    public func locationManager(_ manager: CLLocationManager, didChangeAuthorization status: CLAuthorizationStatus) {
        guard isTracking else { return }
        if status == .authorizedAlways || status == .authorizedWhenInUse {
            manager.startUpdatingLocation()
        }
    }

    // MARK: - Zone Proximity Check

    private func checkProximity(location: CLLocation) {
        for zone in zones {
            guard let id  = zone["id"]  as? String,
                  let lat = zone["lat"] as? Double,
                  let lng = zone["lng"] as? Double else { continue }

            let type      = zone["type"] as? String ?? "other"
            let baseDist  = zone["alertDist"] as? Double ?? globalAlertDist
            let entryDist = baseDist + gpsDelayMargin  // GPS 딜레이 보정 — 설정 거리보다 앞서 진입 판정
            let distance  = location.distance(from: CLLocation(latitude: lat, longitude: lng))

            if let minDist = enteredZones[id] {
                // ── 진입 중: 정점(minDist) 갱신 또는 재이격 마진 통과 시 이탈 확정 ──
                if distance < minDist {
                    enteredZones[id] = distance
                } else if distance - minDist >= voteExitMargin {
                    enteredZones.removeValue(forKey: id)
                    triggerZoneExit(type: type, id: id)
                }
            } else if distance <= entryDist {
                // ── 구역 진입 확정 ──
                enteredZones[id] = distance
                triggerZoneEntry(type: type, distance: distance, id: id)
            }
        }
    }

    // MARK: - Zone Entry

    private func triggerZoneEntry(type: String, distance: Double, id: String) {
        guard !alertedZones.contains(id) else { return }
        alertedZones.insert(id)

        // 화면 잠금 여부와 무관하게 항상 네이티브 오디오·TTS 직접 실행
        // — iOS는 화면 잠금 시 WebView JS를 동결하므로 JS 레이어에 의존하지 않음
        activateAudioSession()
        playSound(type: type)
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.0) { [weak self] in
            self?.speakTTS(type: type)
        }
        notifyListeners("backgroundAlert", data: ["zoneType": type, "distance": distance])

        // 오디오와 동시에 잠금화면 경고 카드(Live Activity)를 경고 상태로 갱신
        let korean = zoneKorean[type] ?? "기타 위험"
        let icon   = zoneIcons[type] ?? "⚠️"
        let message = ttsMessages[type] ?? "위험 구역 주의하세요"
        LiveActivityManager.shared.showEntry(zoneId: id, zoneType: type, korean: korean, icon: icon, message: message)

        // 60초 후 동일 구역 재알림 허용
        DispatchQueue.main.asyncAfter(deadline: .now() + 60) { [weak self] in
            self?.alertedZones.remove(id)
        }
    }

    // MARK: - Zone Exit → 3초 후 경고 카드 소멸, 그 1.5초 후 투표 카드로 갱신

    private func triggerZoneExit(type: String, id: String) {
        let korean = zoneKorean[type] ?? "위험 구역"
        LiveActivityManager.shared.scheduleExitSequence(zoneId: id, zoneType: type, korean: korean)
        notifyListeners("backgroundZoneExit", data: ["zoneType": type, "zoneId": id])
    }

    // MARK: - Audio Session

    private func activateAudioSession() {
        let session = AVAudioSession.sharedInstance()
        // 백그라운드·잠금화면에서도 재생되도록 카테고리 재설정 후 활성화
        try? session.setCategory(.playback, mode: .default, options: [.mixWithOthers])
        try? session.setActive(true)
    }

    // MARK: - Audio Preload

    private func preloadAudio() {
        for type in ["pothole", "slippery", "construction", "other"] {
            // Capacitor 웹 에셋 경로 → public/sounds/. 실패 시 sounds/, 루트 순으로 폴백
            let url = Bundle.main.url(forResource: "beep_\(type)", withExtension: "wav", subdirectory: "public/sounds")
                   ?? Bundle.main.url(forResource: "beep_\(type)", withExtension: "wav", subdirectory: "sounds")
                   ?? Bundle.main.url(forResource: "beep_\(type)", withExtension: "wav")
            guard let url = url else { continue }
            guard let player = try? AVAudioPlayer(contentsOf: url) else { continue }
            player.prepareToPlay()
            audioPlayers[type] = player
        }
    }

    private func playSound(type: String) {
        let player = audioPlayers[type] ?? audioPlayers["other"]
        player?.stop()
        player?.currentTime = 0
        player?.play()
    }

    private func speakTTS(type: String) {
        let msg = ttsMessages[type] ?? "위험 구역 주의하세요"
        if synthesizer.isSpeaking { synthesizer.stopSpeaking(at: .immediate) }
        let utterance = AVSpeechUtterance(string: msg)
        utterance.voice  = AVSpeechSynthesisVoice(language: "ko-KR")
        utterance.rate   = 0.45
        utterance.volume = 1.0
        synthesizer.speak(utterance)
    }
}
