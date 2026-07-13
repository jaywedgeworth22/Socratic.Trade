import Foundation

struct MobileAPIClient {
    let baseURL: URL
    var session: URLSession = .shared

    func snapshot() async throws -> MobileSnapshot {
        let envelope: SnapshotEnvelope = try await get("/api/mobile/snapshot")
        return MobileSnapshot(
            currentUser: envelope.currentUser,
            readiness: envelope.readiness,
            policy: envelope.policy,
            portfolio: envelope.portfolio,
            positions: envelope.positions,
            pendingProposals: envelope.pendingProposals,
            watchlist: envelope.watchlist,
            alerts: envelope.alerts,
            recentCommands: envelope.recentCommands
        )
    }

    func submit(commandType: String, payload: [String: Any] = [:]) async throws -> MobileCommand {
        var request = URLRequest(url: baseURL.appending(path: "/api/mobile/commands"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        request.setValue("\(commandType):\(UUID().uuidString)", forHTTPHeaderField: "idempotency-key")
        request.httpBody = try JSONSerialization.data(withJSONObject: [
            "commandType": commandType,
            "payload": payload,
            "client": ["platform": "ios", "appVersion": Bundle.main.appVersion]
        ])
        let envelope: CommandEnvelope = try await send(request)
        return envelope.command
    }

    func startAccountDeletion() async throws -> AccountDeletionRequest {
        var request = URLRequest(url: baseURL.appending(path: "/api/mobile/account-deletion/request"))
        request.httpMethod = "POST"
        let envelope: DeletionRequestEnvelope = try await send(request)
        return envelope.deletionRequest
    }

    func confirmAccountDeletion(requestId: String, typedIdentity: String, typedText: String) async throws -> AccountDeletionResult {
        var request = URLRequest(url: baseURL.appending(path: "/api/mobile/account-deletion/confirm"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        request.httpBody = try JSONSerialization.data(withJSONObject: [
            "requestId": requestId,
            "typedIdentity": typedIdentity,
            "typedText": typedText
        ])
        return try await send(request)
    }

    func loginWithApple(identityToken: String, name: String?) async throws -> [String: String] {
        var request = URLRequest(url: baseURL.appending(path: "/api/mobile/auth/apple"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        var bodyParams: [String: Any] = ["identityToken": identityToken]
        if let name = name {
            bodyParams["name"] = name
        }
        request.httpBody = try JSONSerialization.data(withJSONObject: bodyParams)
        // URLSession will automatically store the set-cookie header in its HTTPCookieStorage.
        return try await send(request)
    }

    func events(onEvent: @escaping () -> Void) async throws {
        let request = URLRequest(url: baseURL.appending(path: "/api/mobile/events"))
        let (bytes, response) = try await session.bytes(for: request)
        guard let http = response as? HTTPURLResponse, 200..<300 ~= http.statusCode else {
            throw URLError(.badServerResponse)
        }
        for try await line in bytes.lines {
            if line.hasPrefix("event: ") || line.hasPrefix("data: ") {
                onEvent()
            }
        }
    }

    private func get<T: Decodable>(_ path: String) async throws -> T {
        let request = URLRequest(url: baseURL.appending(path: path))
        return try await send(request)
    }

    private func send<T: Decodable>(_ request: URLRequest) async throws -> T {
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse, 200..<300 ~= http.statusCode else {
            throw URLError(.badServerResponse)
        }
        return try JSONDecoder().decode(T.self, from: data)
    }
}

private extension Bundle {
    var appVersion: String {
        object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "dev"
    }
}
