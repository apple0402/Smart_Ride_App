// App(WebView 로그인)과 SafeRideWidgets 익스텐션이 Supabase 인증 토큰을 공유하기 위한 Keychain 래퍼
// — 두 타겟 모두 이 파일을 포함하고, 동일한 Keychain Sharing access group을 엔타이틀먼트에 등록해야 함
import Foundation
import Security

enum KeychainHelper {

    // project.pbxproj의 DEVELOPMENT_TEAM 값과 동일 — App/SafeRideWidgets 두 타겟 모두 같은 Team으로 서명되어야 함
    private static let teamID = "H7M78L3MFD"
    private static let accessGroup = "\(teamID).com.gansam.smartrider.shared"

    private static let accessTokenAccount = "supabaseAccessToken"
    private static let userIdAccount      = "supabaseUserId"

    static func saveAuthSession(accessToken: String, userId: String) {
        save(accessToken, account: accessTokenAccount)
        save(userId, account: userIdAccount)
    }

    static func clearAuthSession() {
        delete(account: accessTokenAccount)
        delete(account: userIdAccount)
    }

    static func readAccessToken() -> String? { read(account: accessTokenAccount) }
    static func readUserId() -> String?      { read(account: userIdAccount) }

    // MARK: - SecItem 래핑

    private static func save(_ value: String, account: String) {
        guard let data = value.data(using: .utf8) else { return }

        let query: [String: Any] = [
            kSecClass as String:              kSecClassGenericPassword,
            kSecAttrAccount as String:         account,
            kSecAttrAccessGroup as String:     accessGroup
        ]
        SecItemDelete(query as CFDictionary)

        var addQuery = query
        addQuery[kSecValueData as String] = data
        addQuery[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock
        SecItemAdd(addQuery as CFDictionary, nil)
    }

    private static func read(account: String) -> String? {
        let query: [String: Any] = [
            kSecClass as String:              kSecClassGenericPassword,
            kSecAttrAccount as String:         account,
            kSecAttrAccessGroup as String:     accessGroup,
            kSecReturnData as String:          true,
            kSecMatchLimit as String:          kSecMatchLimitOne
        ]
        var item: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess,
              let data = item as? Data,
              let value = String(data: data, encoding: .utf8)
        else { return nil }
        return value
    }

    private static func delete(account: String) {
        let query: [String: Any] = [
            kSecClass as String:          kSecClassGenericPassword,
            kSecAttrAccount as String:     account,
            kSecAttrAccessGroup as String: accessGroup
        ]
        SecItemDelete(query as CFDictionary)
    }
}
