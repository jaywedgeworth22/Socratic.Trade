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
    // Coalesces SSE-triggered reloads (item 31): at most one `load()` runs at a time. If another
    // SSE frame arrives while a reload is already in flight, it's marked pending instead of
    // spawning a second overlapping request; the in-flight reload's completion then runs exactly
    // one follow-up reload, collapsing any number of frames that arrived meanwhile.
    private var reloadInFlight = false
    private var reloadPending = false

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
            applyAuthAwareError(error)
            hasInitialized = true
        }
    }

    func startEvents() {
        eventTask?.cancel()
        eventTask = Task { [client] in
            try? await client.events {
                Task { @MainActor in
                    self.scheduleReload()
                }
            }
        }
    }

    /// Runs at most one `load()` at a time in response to SSE frames (item 31). `MobileAPIClient
    /// .events` already fires `onEvent` once per accumulated frame rather than once per line; this
    /// adds the second half of the fix, coalescing bursts of frames (a single strategy tick can
    /// emit several) into a single reload instead of stacking concurrent snapshot fetches.
    private func scheduleReload() {
        guard !reloadInFlight else {
            reloadPending = true
            return
        }
        reloadInFlight = true
        Task {
            repeat {
                reloadPending = false
                await load()
            } while reloadPending
            reloadInFlight = false
        }
    }

    func submit(_ commandType: String, payload: [String: Any] = [:]) async {
        busy = true
        defer { busy = false }
        do {
            _ = try await client.submit(commandType: commandType, payload: payload)
            await load()
        } catch {
            applyAuthAwareError(error)
        }
    }

    func startAccountDeletion() async {
        busy = true
        defer { busy = false }
        do {
            deletionRequest = try await client.startAccountDeletion()
            error = nil
        } catch {
            applyAuthAwareError(error)
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
            applyAuthAwareError(error)
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

    /// Item 32: only a genuine 401/403 (`MobileAPIError.unauthorized`) means the session itself is
    /// gone, so that's the sole case that clears `isAuthenticated`. Any other failure -- 5xx,
    /// timeout, a decoding hiccup, offline -- is transient: it surfaces a retryable error message
    /// but leaves the session (and whatever snapshot/state is already loaded) intact instead of
    /// bouncing the user back to the login screen.
    private func applyAuthAwareError(_ caught: Error) {
        error = caught.localizedDescription
        if let apiError = caught as? MobileAPIError, case .unauthorized = apiError {
            isAuthenticated = false
        }
    }
}
