import Foundation
import SwiftUI

@MainActor
final class MobileStore: ObservableObject {
    @Published var snapshot: MobileSnapshot?
    @Published var error: String?
    @Published var busy = false
    @Published var deletionRequest: AccountDeletionRequest?
    @Published var isAuthenticated = false
    @Published var hasInitialized = false

    private let client: MobileAPIClient
    private var eventTask: Task<Void, Never>?

    init(client: MobileAPIClient) {
        self.client = client
    }

    func load() async {
        do {
            snapshot = try await client.snapshot()
            isAuthenticated = true
            hasInitialized = true
            error = nil
        } catch {
            self.error = error.localizedDescription
            if let urlError = error as? URLError, urlError.code == .badServerResponse {
                // If it's a 401 or 403, we can assume unauthenticated
                self.isAuthenticated = false
            }
            hasInitialized = true
        }
    }

    func startEvents() {
        eventTask?.cancel()
        eventTask = Task { [client] in
            try? await client.events {
                Task { @MainActor in
                    await self.load()
                }
            }
        }
    }

    func submit(_ commandType: String, payload: [String: Any] = [:]) async {
        busy = true
        defer { busy = false }
        do {
            _ = try await client.submit(commandType: commandType, payload: payload)
            await load()
        } catch {
            self.error = error.localizedDescription
        }
    }

    func startAccountDeletion() async {
        busy = true
        defer { busy = false }
        do {
            deletionRequest = try await client.startAccountDeletion()
            error = nil
        } catch {
            self.error = error.localizedDescription
        }
    }

    func confirmAccountDeletion(typedIdentity: String, typedText: String) async -> AccountDeletionResult? {
        guard let request = deletionRequest else { return nil }
        busy = true
        defer { busy = false }
        do {
            let result = try await client.confirmAccountDeletion(
                requestId: request.requestId,
                typedIdentity: typedIdentity,
                typedText: typedText
            )
            error = nil
            return result
        } catch {
            self.error = error.localizedDescription
            return nil
        }
    }

    func loginWithApple(identityToken: String, name: String?) async {
        busy = true
        defer { busy = false }
        do {
            _ = try await client.loginWithApple(identityToken: identityToken, name: name)
            error = nil
            isAuthenticated = true
            await load()
            startEvents()
        } catch {
            self.error = "Apple Sign-In failed: \(error.localizedDescription)"
        }
    }

    func loginWithToken(jwt: String) async {
        guard let url = URL(string: "https://socratictrade.com"),
              let cookie = HTTPCookie(properties: [
                  .domain: "socratictrade.com",
                  .path: "/",
                  .name: "__Secure-authjs.session-token",
                  .value: jwt,
                  .secure: "TRUE",
                  .expires: NSDate(timeIntervalSinceNow: 30 * 24 * 60 * 60)
              ]) else { return }

        // Auth.js falls back to non-secure cookie name in dev/http, 
        // but production is https, so we set both to be absolutely certain.
        if let fallbackCookie = HTTPCookie(properties: [
            .domain: "socratictrade.com",
            .path: "/",
            .name: "authjs.session-token",
            .value: jwt,
            .secure: "TRUE",
            .expires: NSDate(timeIntervalSinceNow: 30 * 24 * 60 * 60)
        ]) {
            HTTPCookieStorage.shared.setCookie(fallbackCookie)
        }

        HTTPCookieStorage.shared.setCookie(cookie)
        
        // Immediately try loading since we injected the token
        busy = true
        defer { busy = false }
        await load()
        if isAuthenticated {
            startEvents()
        } else {
            error = "Authentication failed after web redirect."
        }
    }
}
