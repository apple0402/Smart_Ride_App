// 화면 잠금 상태에서도 동작하는 네이티브 백그라운드 위치 추적·위험구역 감지·오디오 트리거 플러그인
import Foundation
import Capacitor
import CoreLocation
import AVFoundation
import UserNotifications
import UIKit

@objc(BackgroundSafety)
public class BackgroundSafetyPlugin: CAPPlugin, CLLocationManagerDelegate {

    // 플러그인 인스턴스와 함께 앱 전체 생명주기 동안 유지되는 강한 참조 — 옵셔널 해제로 인한 GPS 중단 방지
    private let locationManager = CLLocationManager()
    private var zones: [[String: Any]] = []
    private var alertedZones   = Set<String>()  // 알림 중복 방지용
    private var enteredZones   = Set<String>()  // 현재 내부에 있는 구역 (이탈 감지)
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

    private let zoneKorean: [String: String] = [
        "pothole":      "포트홀 / 크랙",
        "slippery":     "맨홀 / 미끄러움",
        "construction": "공사 구간",
        "other":        "위험 구역"
    ]

    override public func load() {
        locationManager.delegate = self
        locationManager.desiredAccuracy = kCLLocationAccuracyBest
        locationManager.distanceFilter = 10
        locationManager.allowsBackgroundLocationUpdates = true
        locationManager.pausesLocationUpdatesAutomatically = false
        locationManager.showsBackgroundLocationIndicator = true
        preloadAudio()

        // 앱 포그라운드 복귀 시 펜딩 투표 알림 처리 — 알림 탭 후 앱이 열렸을 때 투표창 표시
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(handlePendingVoteNotification(_:)),
            name: NSNotification.Name("SmartRiderZoneExitVote"),
            object: nil
        )
    }

    // AppDelegate로부터 알림 탭 이벤트 수신 → JS VotePopup 트리거
    @objc private func handlePendingVoteNotification(_ notification: Foundation.Notification) {
        guard let info = notification.userInfo else { return }
        let zoneId   = info["zoneId"]   as? String ?? ""
        let zoneType = info["zoneType"] as? String ?? "other"
        notifyListeners("notificationVoteAction", data: [
            "zoneId":   zoneId,
            "zoneType": zoneType
        ])
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
            self.locationManager.allowsBackgroundLocationUpdates = true
            self.locationManager.pausesLocationUpdatesAutomatically = false
            self.locationManager.showsBackgroundLocationIndicator = true

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

            let type     = zone["type"] as? String ?? "other"
            let dist     = zone["alertDist"] as? Double ?? globalAlertDist
            let exitDist = dist + 20  // 히스테리시스: GPS 오차 20m 버퍼
            let distance = location.distance(from: CLLocation(latitude: lat, longitude: lng))

            let wasInside = enteredZones.contains(id)

            if distance <= dist && !wasInside {
                // ── 구역 진입 확정 ──
                enteredZones.insert(id)
                triggerZoneEntry(type: type, distance: distance, id: id)

            } else if distance > exitDist && wasInside {
                // ── 구역 이탈 확정 (히스테리시스 통과) ──
                enteredZones.remove(id)
                triggerZoneExit(type: type, id: id)
            }
        }
    }

    // MARK: - Zone Entry

    private func triggerZoneEntry(type: String, distance: Double, id: String) {
        guard !alertedZones.contains(id) else { return }
        alertedZones.insert(id)

        // 앱이 백그라운드(화면 잠금)일 때만 네이티브 오디오·TTS 실행 — 포그라운드는 JS 레이어가 담당
        if UIApplication.shared.applicationState == .background {
            activateAudioSession()
            playSound(type: type)
            DispatchQueue.main.asyncAfter(deadline: .now() + 1.0) { [weak self] in
                self?.speakTTS(type: type)
            }
        }
        notifyListeners("backgroundAlert", data: ["zoneType": type, "distance": distance])

        // 60초 후 동일 구역 재알림 허용
        DispatchQueue.main.asyncAfter(deadline: .now() + 60) { [weak self] in
            self?.alertedZones.remove(id)
        }
    }

    // MARK: - Zone Exit → 로컬 알림으로 투표 유도

    private func triggerZoneExit(type: String, id: String) {
        let korean = zoneKorean[type] ?? "위험 구역"
        sendExitLocalNotification(zoneId: id, zoneType: type, korean: korean)
        notifyListeners("backgroundZoneExit", data: ["zoneType": type, "zoneId": id])
    }

    private func sendExitLocalNotification(zoneId: String, zoneType: String, korean: String) {
        let center = UNUserNotificationCenter.current()

        center.getNotificationSettings { [weak self] settings in
            guard settings.authorizationStatus == .authorized ||
                  settings.authorizationStatus == .provisional else { return }
            guard let self = self else { return }

            let content = UNMutableNotificationContent()
            content.title = "✅ 위험 지역 통과"
            content.body  = "[\(korean)] 구역을 지나왔습니다. 현재 안전한가요?"
            content.sound = .default
            content.userInfo = [
                "action":   "vote",
                "zoneId":   zoneId,
                "zoneType": zoneType
            ]

            let trigger = UNTimeIntervalNotificationTrigger(timeInterval: 1.0, repeats: false)
            let request = UNNotificationRequest(
                identifier: "zone_exit_\(zoneId)",
                content:    content,
                trigger:    trigger
            )
            center.add(request) { error in
                if let error = error {
                    print("[SmartRider] 로컬 알림 발송 실패: \(error)")
                }
            }
        }
    }

    // MARK: - Audio Session

    private func activateAudioSession() {
        try? AVAudioSession.sharedInstance().setActive(true)
    }

    // MARK: - Audio Preload

    private func preloadAudio() {
        for type in ["pothole", "slippery", "construction", "other"] {
            guard let url = Bundle.main.url(
                forResource: "beep_\(type)", withExtension: "wav",
                subdirectory: "public/sounds"
            ) else { continue }
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
