// 화면 잠금 상태에서도 동작하는 네이티브 백그라운드 위치 추적·위험구역 감지·오디오 트리거 플러그인
import Foundation
import Capacitor
import CoreLocation
import AVFoundation
import UIKit

@objc(BackgroundSafety)
public class BackgroundSafetyPlugin: CAPPlugin, CLLocationManagerDelegate {

    private var locationManager: CLLocationManager?
    private var zones: [[String: Any]] = []
    private var alertedZones = Set<String>()
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

    override public func load() {
        preloadAudio()
    }

    @objc func startBackgroundTracking(_ call: CAPPluginCall) {
        if let raw = call.getArray("zones") {
            zones = raw.compactMap { $0 as? [String: Any] }
        }
        if let dist = call.getDouble("alertDist") {
            globalAlertDist = dist
        }
        alertedZones.removeAll()

        DispatchQueue.main.async { [weak self] in
            guard let self = self else { return }
            if self.locationManager == nil {
                let mgr = CLLocationManager()
                mgr.delegate = self
                mgr.desiredAccuracy = kCLLocationAccuracyBest
                mgr.distanceFilter = 10
                mgr.allowsBackgroundLocationUpdates = true
                mgr.pausesLocationUpdatesAutomatically = false
                mgr.showsBackgroundLocationIndicator = true
                self.locationManager = mgr
            }
            self.isTracking = true
            let status = self.locationManager!.authorizationStatus
            if status == .authorizedAlways || status == .authorizedWhenInUse {
                self.locationManager!.startUpdatingLocation()
            } else {
                self.locationManager!.requestAlwaysAuthorization()
            }
        }
        call.resolve(["started": true])
    }

    @objc func stopBackgroundTracking(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in
            self?.locationManager?.stopUpdatingLocation()
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
            guard let id  = zone["id"] as? String,
                  let lat = zone["lat"] as? Double,
                  let lng = zone["lng"] as? Double,
                  !alertedZones.contains(id) else { continue }

            let type     = zone["type"] as? String ?? "other"
            let dist     = zone["alertDist"] as? Double ?? globalAlertDist
            let distance = location.distance(from: CLLocation(latitude: lat, longitude: lng))

            if distance <= dist {
                alertedZones.insert(id)
                triggerAlert(type: type, distance: distance)
                // 60초 후 동일 구역 재알림 허용
                DispatchQueue.main.asyncAfter(deadline: .now() + 60) { [weak self] in
                    self?.alertedZones.remove(id)
                }
            }
        }
    }

    // MARK: - Alert Trigger

    private func triggerAlert(type: String, distance: Double) {
        // 앱이 포그라운드 활성 상태면 JS 레이어가 처리 — 중복 알림 방지
        guard UIApplication.shared.applicationState == .background else { return }

        activateAudioSession()
        playSound(type: type)
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.0) { [weak self] in
            self?.speakTTS(type: type)
        }
        notifyListeners("backgroundAlert", data: ["zoneType": type, "distance": distance])
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
        utterance.voice = AVSpeechSynthesisVoice(language: "ko-KR")
        utterance.rate = 0.45
        utterance.volume = 1.0
        synthesizer.speak(utterance)
    }
}
