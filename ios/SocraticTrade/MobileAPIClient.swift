import CryptoKit
import Foundation
import Security

enum MobileAPIError: Error, LocalizedError {
    case unauthorized(statusCode: Int)
    case serverError(statusCode: Int, message: String?)
    case network(Error)
    case decoding(Error)

    var errorDescription: String? {
        switch self {
        case .unauthorized:
            return "Your session expired. Sign in again."
        case .serverError(let statusCode, let message):
            if let message, !message.isEmpty {
                return "\(message) (\(statusCode))"
            }
            return "The server returned an error (\(statusCode)). Try again."
        case .network(let error):
            return "Network error: \(error.localizedDescription)"
        case .decoding:
            return "The app could not read the latest server response."
        }
    }
}

struct SSEFrameAccumulator {
    private var frameHasPayload = false

    mutating func consume(line: String) -> Bool {
        if line.isEmpty {
            defer { frameHasPayload = false }
            return frameHasPayload
        }
        guard !line.hasPrefix(":") else { return false }
        if line.hasPrefix("event:") || line.hasPrefix("data:") {
            frameHasPayload = true
        }
        return false
    }
}

/// Networking-layer errors for mobile API calls. Distinguishes a genuinely dead session (401/403 --
/// the only case that should sign the user out, see `MobileStore.applyAuthAwareError`) from
/// transient failures (5xx, decode issues, offline) that should surface a retryable error instead
/// of dropping the user back to the login screen. See item 32 in
/// docs/rollouts/2026-07-18-ios-client-fixes.md.
enum MobileAPIError: Error, LocalizedError {
    case unauthorized(statusCode: Int)
    case serverError(statusCode: Int, body: String?)
    case network(Error)
    case decoding(Error)

    var errorDescription: String? {
        switch self {
        case .unauthorized:
            return "Your session has expired. Please sign in again."
        case .serverError(let statusCode, let body):
            if let message = Self.serverMessage(from: body), !message.isEmpty {
                return "\(message) (\(statusCode))"
            }
            return "Server error (\(statusCode)). Please try again."
        case .network(let underlying):
            return "Network error: \(underlying.localizedDescription)"
        case .decoding:
            return "Received an unexpected response from the server."
        }
    }

    /// Mirrors the PWA's `body.error ?? "Command failed."` pattern
    /// (app/mobile/mobile-pwa-client.tsx `submitCommand`): pulls the `"error"` field out of a JSON
    /// error body when the server sent one.
    private static func serverMessage(from body: String?) -> String? {
        guard let body, let data = body.data(using: .utf8) else { return nil }
        guard let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return nil }
        return object["error"] as? String
    }
}

struct MobileAPIClient {
    let baseURL: URL
    var session: URLSession = .shared

    func snapshot() async throws -> MobileSnapshot {
        try await get("/api/mobile/snapshot")
    }

    func submit(
        commandType: String,
        payload: [String: Any] = [:],
        idempotencyKey: String = UUID().uuidString
    ) async throws -> MobileCommand {
        var request = request(path: "/api/mobile/commands", method: "POST")
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        request.setValue("\(commandType):\(idempotencyKey)", forHTTPHeaderField: "idempotency-key")
        request.httpBody = try JSONSerialization.data(withJSONObject: [
            "commandType": commandType,
            "payload": payload,
            "client": [
                "platform": "ios",
                "appVersion": Bundle.main.appVersion,
                "buildNumber": Bundle.main.buildNumber
            ]
        ])
        let envelope: CommandEnvelope = try await send(request)
        return envelope.command
    }

    func accountDeletionPreview() async throws -> AccountDeletionRequest {
        let envelope: DeletionRequestEnvelope = try await send(
            request(path: "/api/mobile/account-deletion/request")
        )
        return envelope.deletionRequest
    }

    func confirmAccountDeletion(
        typedIdentity: String,
        typedText: String
    ) async throws -> AccountDeletionResult {
        var request = request(path: "/api/mobile/account-deletion/confirm", method: "POST")
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        request.httpBody = try JSONSerialization.data(withJSONObject: [
            "typedIdentity": typedIdentity,
            "typedText": typedText
        ])
        let data = try await successfulResponseData(for: request)
        // A 2xx from this endpoint means the backend completed account deletion. Optional receipt
        // fields must never strand a locally-authenticated session if the response evolves or is
        // empty after the destructive server transaction has committed.
        return (try? JSONDecoder().decode(AccountDeletionResult.self, from: data)) ?? .successfulHTTP
    }

    func loginWithApple(identityToken: String, name: String?) async throws -> AppleLoginResponse {
        var request = request(path: "/api/mobile/auth/apple", method: "POST")
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        var body: [String: Any] = ["identityToken": identityToken]
        if let name, !name.isEmpty {
            body["name"] = name
        }
        request.httpBody = try JSONSerialization.data(withJSONObject: body)
        return try await send(request)
    }

    /// Consumes the mobile SSE stream (app/api/mobile/events/route.ts), firing `onEvent` once per
    /// complete frame instead of once per line. The server writes each event as two lines --
    /// `event: <name>\n` then `data: <json>\n` -- terminated by a blank line; heartbeat/comment
    /// lines (`: connected`, `: ping`) start with `:` and never carry a payload on their own.
    /// Accumulate lines until the blank-line frame terminator, then dispatch once only if the frame
    /// actually contained an `event:`/`data:` line. See item 31 in
    /// docs/rollouts/2026-07-18-ios-client-fixes.md. Reload coalescing (so a burst of frames
    /// doesn't stack overlapping `load()` calls) lives in `MobileStore.scheduleReload`, since that's
    /// where the reload actually happens.
    func events(onEvent: @escaping () -> Void) async throws {
        let request = URLRequest(url: baseURL.appending(path: "/api/mobile/events"))
        let bytes: URLSession.AsyncBytes
        let response: URLResponse
        do {
            (bytes, response) = try await session.bytes(for: request)
        } catch {
            throw MobileAPIError.network(error)
        }
        try Self.requireSuccess(response, body: nil)

        var frameHasPayload = false
        for try await line in bytes.lines {
            if line.isEmpty {
                // Blank line = end of one SSE frame (per the SSE spec and how the server writes
                // frames: "event: ...\ndata: ...\n\n"). Dispatch once if this frame carried a
                // real event, not just a heartbeat/comment.
                if frameHasPayload { onEvent() }
                frameHasPayload = false
                continue
            }
            if line.hasPrefix(":") { continue } // comment/heartbeat line, never a payload by itself
            if line.hasPrefix("event:") || line.hasPrefix("data:") {
                frameHasPayload = true
            }
        } catch is CancellationError {
            throw CancellationError()
        } catch {
            throw MobileAPIError.network(error)
        }
    }

    func resolvedURL(_ pathOrURL: String) -> URL? {
        if let absolute = URL(string: pathOrURL), absolute.scheme != nil {
            guard
                absolute.scheme?.lowercased() == "https",
                absolute.host?.lowercased() == baseURL.host?.lowercased(),
                absolute.port == baseURL.port
            else {
                return nil
            }
            return absolute
        }
        return baseURL.appending(path: pathOrURL)
    }

    func ownsCookie(_ cookie: HTTPCookie) -> Bool {
        guard let host = baseURL.host?.lowercased() else { return false }
        let domain = cookie.domain
            .trimmingCharacters(in: CharacterSet(charactersIn: "."))
            .lowercased()
        return host == domain || host.hasSuffix(".\(domain)")
    }

    private func request(path: String, method: String = "GET") -> URLRequest {
        var request = URLRequest(url: baseURL.appending(path: path))
        request.httpMethod = method
        request.timeoutInterval = 30
        request.setValue("application/json", forHTTPHeaderField: "accept")
        return request
    }

    private func get<T: Decodable>(_ path: String) async throws -> T {
        try await send(request(path: path))
    }

    private func send<T: Decodable>(_ request: URLRequest) async throws -> T {
        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await session.data(for: request)
        } catch {
            throw MobileAPIError.network(error)
        }
        try Self.requireSuccess(response, body: data)
        do {
            return try JSONDecoder().decode(T.self, from: data)
        } catch {
            throw MobileAPIError.decoding(error)
        }
    }

    /// Shared status-code gate for both the JSON request path (`send`) and the SSE stream
    /// (`events`). Only 401/403 map to `.unauthorized` -- the sole case `MobileStore` treats as a
    /// dead session -- every other non-2xx becomes `.serverError` so callers can show a retryable
    /// error and keep the session instead of signing out. See item 32 in
    /// docs/rollouts/2026-07-18-ios-client-fixes.md.
    private static func requireSuccess(_ response: URLResponse, body: Data?) throws {
        guard let http = response as? HTTPURLResponse else {
            throw MobileAPIError.network(URLError(.badServerResponse))
        }
        guard 200..<300 ~= http.statusCode else {
            if http.statusCode == 401 || http.statusCode == 403 {
                throw MobileAPIError.unauthorized(statusCode: http.statusCode)
            }
            let bodyText = body.flatMap { String(data: $0, encoding: .utf8) }
            throw MobileAPIError.serverError(statusCode: http.statusCode, body: bodyText)
        }
    }
}

struct AppleLoginResponse: Decodable {
    let success: Bool
    let email: String?
}

private struct WebAuthExchangeResponse: Decodable {
    let success: Bool
}

struct WebAuthCodeVerifier {
    let value: String

    static func make() -> WebAuthCodeVerifier? {
        var bytes = [UInt8](repeating: 0, count: 32)
        guard SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) == errSecSuccess else {
            return nil
        }
        return WebAuthCodeVerifier(value: Data(bytes).base64URLEncodedString())
    }

    var challenge: String {
        Data(SHA256.hash(data: Data(value.utf8))).base64URLEncodedString()
    }
}

private extension Data {
    func base64URLEncodedString() -> String {
        base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }
}

private extension Bundle {
    var appVersion: String {
        object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "dev"
    }

    var buildNumber: String {
        object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "dev"
    }
}
