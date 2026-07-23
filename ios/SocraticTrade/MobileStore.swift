import Foundation
import Combine

struct CommandAttemptTracker {
    private struct PendingAttempt {
        let fingerprint: String
        let idempotencyKey: String
        var commandID: String?
    }

    struct Resolution: Equatable {
        let operationID: String
        let status: String
        let error: String?
    }

    private var attempts: [String: PendingAttempt] = [:]

    mutating func idempotencyKey(
        operationID: String,
        commandType: String,
        payload: [String: Any]
    ) -> String {
        let object: [String: Any] = ["commandType": commandType, "payload": payload]
        let data = try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
        let fingerprint = data?.base64EncodedString() ?? "\(commandType):\(operationID)"
        if let pending = attempts[operationID], pending.fingerprint == fingerprint {
            return pending.idempotencyKey
        }
        let key = UUID().uuidString
        attempts[operationID] = PendingAttempt(
            fingerprint: fingerprint,
            idempotencyKey: key,
            commandID: nil
        )
        return key
    }

    mutating func track(_ command: MobileCommand, operationID: String) {
        guard var attempt = attempts[operationID] else { return }
        attempt.commandID = command.id
        attempts[operationID] = attempt
    }

    mutating func reconcile(_ commands: [MobileCommand]) -> [Resolution] {
        let commandsByID = Dictionary(uniqueKeysWithValues: commands.map { ($0.id, $0) })
        var resolutions: [Resolution] = []
        for (operationID, attempt) in Array(attempts) {
            guard
                let commandID = attempt.commandID,
                let command = commandsByID[commandID],
                command.isTerminal
            else {
                continue
            }
            attempts.removeValue(forKey: operationID)
            resolutions.append(
                Resolution(operationID: operationID, status: command.status, error: command.error)
            )
        }
        return resolutions
    }

    mutating func release(operationID: String) {
        attempts.removeValue(forKey: operationID)
    }

    mutating func removeAll() {
        attempts = [:]
    }
}

@MainActor
final class MobileStore: ObservableObject {
    @Published private(set) var snapshot: MobileSnapshot?
    @Published var error: String?
    @Published private(set) var isAuthenticated = false
    @Published private(set) var hasInitialized = false
    @Published private(set) var isRefreshing = false
    @Published private(set) var lastUpdatedAt: Date?
    @Published private(set) var isStreamConnected = false
    @Published private(set) var busyOperations: Set<String> = []
    @Published private(set) var deletionRequest: AccountDeletionRequest?
    @Published private(set) var isDeletingAccount = false
    @Published private(set) var isSigningIn = false
    @Published private(set) var snapshotLoadFailed = false

    private let client: MobileAPIClient
    private var eventTask: Task<Void, Never>?
    // Coalesces SSE-triggered reloads (item 31): at most one `load()` runs at a time. If another
    // SSE frame arrives while a reload is already in flight, it's marked pending instead of
    // spawning a second overlapping request; the in-flight reload's completion then runs exactly
    // one follow-up reload, collapsing any number of frames that arrived meanwhile.
    private var reloadInFlight = false
    private var reloadPending = false

    init(client: MobileAPIClient, previewSnapshot: MobileSnapshot? = nil) {
        self.client = client
        snapshot = previewSnapshot
        isAuthenticated = previewSnapshot != nil
        hasInitialized = previewSnapshot != nil
        lastUpdatedAt = previewSnapshot == nil ? nil : Date()
    }

    var isInitialLoading: Bool {
        !hasInitialized && snapshot == nil
    }

    var hasActiveCommandWork: Bool {
        !busyOperations.isEmpty
    }

    func isBusy(_ operationID: String) -> Bool {
        busyOperations.contains(operationID)
    }

    func isSnapshotStale(at now: Date = Date()) -> Bool {
        guard let lastUpdatedAt else { return snapshot != nil }
        return snapshotLoadFailed || now.timeIntervalSince(lastUpdatedAt) > 180
    }

    func canSubmit(_ commandType: String, at now: Date = Date()) -> Bool {
        if Self.protectiveCommands.contains(commandType) {
            return true
        }
        guard let snapshot, !isSnapshotStale(at: now) else { return false }
        if Self.readinessDependentCommands.contains(commandType) {
            return snapshot.readiness.hasAccount && snapshot.readiness.hasUniverse
        }
        return true
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
            let command = try await client.submit(
                commandType: commandType,
                payload: payload,
                idempotencyKey: idempotencyKey
            )
            commandAttemptTracker.track(command, operationID: operationID)
            await load()
        } catch {
            applyAuthAwareError(error)
        }
    }

    func loadAccountDeletionPreview() async {
        guard !isDeletingAccount else { return }
        isDeletingAccount = true
        defer { isDeletingAccount = false }
        do {
            deletionRequest = try await client.accountDeletionPreview()
            error = nil
        } catch {
            applyAuthAwareError(error)
        }
    }

    func clearAccountDeletionPreview() {
        deletionRequest = nil
    }

    func confirmAccountDeletion(typedIdentity: String, typedText: String) async -> URL? {
        guard deletionRequest != nil, !isDeletingAccount else { return nil }
        isDeletingAccount = true
        defer { isDeletingAccount = false }
        do {
            let result = try await client.confirmAccountDeletion(
                typedIdentity: typedIdentity,
                typedText: typedText
            )
            // The HTTP success is authoritative. Clear cookies and all in-memory account state
            // before inspecting optional receipt fields so response drift cannot preserve access.
            clearLocalSession()
            return client.resolvedURL(result.logoutUrl ?? "/logout")
        } catch {
            applyAuthAwareError(error)
            return nil
        }
    }

    func loginWithApple(identityToken: String, name: String?) async {
        guard !isSigningIn else { return }
        isSigningIn = true
        defer { isSigningIn = false }
        do {
            _ = try await client.loginWithApple(identityToken: identityToken, name: name)
            isAuthenticated = true
            error = nil
            await load()
            if isAuthenticated {
                startEvents()
            }
        } catch {
            applyAuthAwareError(error)
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
