// public/js/api.js의 voteZoneSafe()를 네이티브로 포팅 — 위젯 익스텐션 프로세스에서 Supabase REST 직접 호출
// 토큰 만료·네트워크 실패는 요구사항대로 전부 조용히 무시 (재시도 없음)
import Foundation

enum SupabaseVoteService {

    private static let baseURL = "https://jidpwflthppsltdayhoy.supabase.co"
    private static let anonKey = "sb_publishable_DiyfmExo-3Ycni7PBnNuSQ_zJH6IQRC"

    private struct ZoneVoteRow: Decodable {
        let safeVotes: Int?
        let safeVoterIds: [String]?

        enum CodingKeys: String, CodingKey {
            case safeVotes    = "safe_votes"
            case safeVoterIds = "safe_voter_ids"
        }
    }

    static func voteSafe(zoneId: String) async {
        guard let token  = KeychainHelper.readAccessToken(),
              let userId = KeychainHelper.readUserId(),
              let zone   = await fetchZone(zoneId: zoneId, token: token)
        else { return }

        var voterIds = zone.safeVoterIds ?? []
        guard !voterIds.contains(userId) else { return }
        voterIds.append(userId)

        let newVotes  = (zone.safeVotes ?? 0) + 1
        let newStatus = newVotes >= 3 ? "cleared" : "active"

        await updateZone(zoneId: zoneId, votes: newVotes, voterIds: voterIds, status: newStatus, token: token)
    }

    private static func fetchZone(zoneId: String, token: String) async -> ZoneVoteRow? {
        guard var components = URLComponents(string: "\(baseURL)/rest/v1/zones") else { return nil }
        components.queryItems = [
            URLQueryItem(name: "id", value: "eq.\(zoneId)"),
            URLQueryItem(name: "select", value: "safe_votes,safe_voter_ids")
        ]
        guard let url = components.url else { return nil }

        var request = URLRequest(url: url)
        applyAuthHeaders(&request, token: token)

        guard let (data, response) = try? await URLSession.shared.data(for: request),
              let http = response as? HTTPURLResponse,
              http.statusCode == 200,
              let rows = try? JSONDecoder().decode([ZoneVoteRow].self, from: data)
        else { return nil }

        return rows.first
    }

    private static func updateZone(zoneId: String, votes: Int, voterIds: [String], status: String, token: String) async {
        guard var components = URLComponents(string: "\(baseURL)/rest/v1/zones") else { return }
        components.queryItems = [URLQueryItem(name: "id", value: "eq.\(zoneId)")]
        guard let url = components.url else { return }

        var request = URLRequest(url: url)
        request.httpMethod = "PATCH"
        applyAuthHeaders(&request, token: token)
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("return=minimal", forHTTPHeaderField: "Prefer")

        let body: [String: Any] = [
            "safe_votes": votes,
            "safe_voter_ids": voterIds,
            "status": status
        ]
        request.httpBody = try? JSONSerialization.data(withJSONObject: body)

        _ = try? await URLSession.shared.data(for: request)
    }

    private static func applyAuthHeaders(_ request: inout URLRequest, token: String) {
        request.setValue(anonKey, forHTTPHeaderField: "apikey")
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
    }
}
