// public/js/api.js의 voteZoneSafe()를 네이티브로 포팅 — 위젯 익스텐션 프로세스에서 Supabase 직접 호출
// 토큰 만료·네트워크 실패는 요구사항대로 전부 조용히 무시 (재시도 없음)
//
// [재심사 대응] RLS 잠금으로 zones 테이블 직접 PATCH 권한이 제거됨.
// 중복 방지·집계·해제·투표 포인트(+5)를 모두 서버 RPC(cast_safety_vote, SECURITY DEFINER)가
// 원자적으로 처리하므로, 여기서는 read-modify-write 없이 RPC 한 번만 호출한다.
import Foundation

enum SupabaseVoteService {

    private static let baseURL = "https://jidpwflthppsltdayhoy.supabase.co"
    private static let anonKey = "sb_publishable_DiyfmExo-3Ycni7PBnNuSQ_zJH6IQRC"
    // 라이딩 중 네트워크 상태가 불안정할 때 기본 60초 타임아웃까지 기다리면 잠금화면 카드가
    // 응답 없이 멈춘 것처럼 보임(먹통) — LiveActivityIntent 실행 예산 내에 반드시 끝나도록 단축
    private static let requestTimeout: TimeInterval = 5

    static func voteSafe(zoneId: String) async {
        guard let token = KeychainHelper.readAccessToken() else { return }

        guard let url = URL(string: "\(baseURL)/rest/v1/rpc/cast_safety_vote") else { return }

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.timeoutInterval = requestTimeout
        request.setValue(anonKey, forHTTPHeaderField: "apikey")
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")

        // 중복 투표(이미 투표함)·비로그인 등은 RPC가 예외로 반환 → 조용히 무시(재시도 없음)
        request.httpBody = try? JSONSerialization.data(withJSONObject: ["p_zone_id": zoneId])

        _ = try? await URLSession.shared.data(for: request)
    }
}
