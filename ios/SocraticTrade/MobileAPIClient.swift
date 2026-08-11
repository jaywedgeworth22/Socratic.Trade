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
            return "Your session expired.  Sign in again."
        case .serverError(let statusCode, let message):
            // Cloudflare edge codes when the origin (socratictrade.com backend) is unreachable.
            if (521...523).contains(statusCode) {
                return "Socratic Trade servers are unreachable right now (Cloudflare \(statusCode)).  Try again in a few minutes."
            }
            if let message, !message.isEmpty {
                return "\(message) (\(statusCode))"
            }
            return "The server returned an error (\(statusCode)).  Try again."
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

    func exchangeWebAuthCode(_ code: String, verifier: String) async throws {
        var request = request(path: "/api/mobile/auth/exchange", method: "POST")
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        request.httpBody = try JSONSerialization.data(withJSONObject: [
            "code": code,
            "codeVerifier": verifier
        ])
        let _: WebAuthExchangeResponse = try await send(request)
    }

    /// `onConnect` fires when the stream response is established and again on every received
    /// line — including ": ping" comment heartbeats (sent every 25s). Comment frames never reach
    /// `onEvent`, so before this hook a healthy idle stream kept the connected indicator false
    /// forever (#2559). `onEvent` still fires only for payload frames.
    func events(onConnect: @escaping () -> Void = {}, onEvent: @escaping () -> Void) async throws {
        let bytes: URLSession.AsyncBytes
        let response: URLResponse
        do {
            (bytes, response) = try await session.bytes(for: eventsRequest())
        } catch is CancellationError {
            throw CancellationError()
        } catch {
            throw MobileAPIError.network(error)
        }
        try Self.requireSuccess(response, body: nil)
        onConnect()

        var parser = SSEFrameAccumulator()
        do {
            for try await line in bytes.lines {
                try Task.checkCancellation()
                onConnect()
                if parser.consume(line: line) {
                    onEvent()
                }
            }
        } catch is CancellationError {
            throw CancellationError()
        } catch {
            throw MobileAPIError.network(error)
        }
    }

    /// Long-lived SSE request. Must not reuse the JSON helper defaults:
    /// - `Accept: application/json` confuses some edge/proxy paths for `text/event-stream`
    /// - `timeoutInterval = 30` is only ~5s above the server's 25s heartbeat, so jitter or
    ///   buffering yields NSURLErrorCannotParseResponse (-1017) / connection-reset noise
    func eventsRequest() -> URLRequest {
        var request = URLRequest(url: baseURL.appending(path: "/api/mobile/events"))
        request.httpMethod = "GET"
        // Idle timeout between packets. Server heartbeats every 25s; keep generous slack.
        request.timeoutInterval = 120
        request.setValue("text/event-stream", forHTTPHeaderField: "accept")
        request.setValue("no-cache", forHTTPHeaderField: "cache-control")
        return request
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
        let data = try await successfulResponseData(for: request)
        do {
            return try JSONDecoder().decode(T.self, from: data)
        } catch {
            throw MobileAPIError.decoding(error)
        }
    }

    private func successfulResponseData(for request: URLRequest) async throws -> Data {
        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await session.data(for: request)
        } catch is CancellationError {
            throw CancellationError()
        } catch {
            throw MobileAPIError.network(error)
        }
        try Self.requireSuccess(response, body: data)
        return data
    }

    private static func requireSuccess(_ response: URLResponse, body: Data?) throws {
        guard let response = response as? HTTPURLResponse else {
            throw MobileAPIError.network(URLError(.badServerResponse))
        }
        guard 200..<300 ~= response.statusCode else {
            if response.statusCode == 401 || response.statusCode == 403 {
                throw MobileAPIError.unauthorized(statusCode: response.statusCode)
            }
            throw MobileAPIError.serverError(
                statusCode: response.statusCode,
                message: serverMessage(from: body)
            )
        }
    }

    private static func serverMessage(from data: Data?) -> String? {
        guard let data, !data.isEmpty else { return nil }
        if let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
            return object["error"] as? String ?? object["message"] as? String
        }
        // Cloudflare often returns plain text like "error code: 522" when origin is down.
        if let text = String(data: data, encoding: .utf8)?
            .trimmingCharacters(in: .whitespacesAndNewlines),
           !text.isEmpty,
           text.count < 200,
           !text.hasPrefix("<") {
            return text
        }
        return nil
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
