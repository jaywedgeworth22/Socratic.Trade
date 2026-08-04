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
    private var reloadInFlight = false
    private var reloadPending = false
    private var loadGeneration = 0
    private var commandAttemptTracker = CommandAttemptTracker()

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
        // Account switch is a pure active-pointer flip on the server (now also executes
        // immediately, outside the strategy.run_once queue). It must remain available when
        // portfolio/snapshot data is stale — that is exactly when users try to switch away
        // from a stuck/stale context. Requires any loaded snapshot so we still know accounts.
        if commandType == "account.activate" {
            return snapshot != nil
        }
        guard let snapshot, !isSnapshotStale(at: now) else { return false }
        if Self.readinessDependentCommands.contains(commandType) {
            return snapshot.readiness.hasAccount && snapshot.readiness.hasUniverse
        }
        return true
    }

    func load() async {
        loadGeneration &+= 1
        let generation = loadGeneration
        let shouldReportSessionExpiry = hasInitialized || isAuthenticated
        isRefreshing = true
        defer {
            if generation == loadGeneration {
                isRefreshing = false
                hasInitialized = true
            }
        }
        do {
            let loadedSnapshot = try await client.snapshot()
            guard generation == loadGeneration else { return }
            snapshot = loadedSnapshot
            lastUpdatedAt = Date()
            snapshotLoadFailed = false
            isAuthenticated = true
            error = nil
            reconcileTrackedCommands(loadedSnapshot.recentCommands)
        } catch is CancellationError {
            return
        } catch let caught {
            guard generation == loadGeneration else { return }
            snapshotLoadFailed = true
            applyAuthAwareError(caught, showUnauthorizedMessage: shouldReportSessionExpiry)
        }
    }

    func startEvents() {
        eventTask?.cancel()
        eventTask = Task { [weak self, client] in
            while !Task.isCancelled {
                do {
                    try await client.events {
                        Task { @MainActor [weak self] in
                            self?.isStreamConnected = true
                            self?.scheduleReload()
                        }
                    }
                    if !Task.isCancelled {
                        self?.isStreamConnected = false
                    }
                } catch is CancellationError {
                    return
                } catch {
                    self?.isStreamConnected = false
                    self?.applyAuthAwareError(error, preserveTransientMessage: self?.snapshot == nil)
                    if self?.isAuthenticated != true { return }
                }

                do {
                    try await Task.sleep(nanoseconds: 5_000_000_000)
                } catch {
                    return
                }
            }
        }
    }

    func stopEvents() {
        eventTask?.cancel()
        eventTask = nil
        isStreamConnected = false
    }

    @discardableResult
    func submit(
        _ commandType: String,
        payload: [String: Any] = [:],
        operationID: String? = nil
    ) async -> Bool {
        let operationID = operationID ?? commandType
        guard !busyOperations.contains(operationID) else { return false }
        guard canSubmit(commandType) else {
            error = unavailableMessage(for: commandType)
            return false
        }
        let idempotencyKey = commandAttemptTracker.idempotencyKey(
            operationID: operationID,
            commandType: commandType,
            payload: payload
        )
        busyOperations.insert(operationID)

        do {
            let command = try await client.submit(
                commandType: commandType,
                payload: payload,
                idempotencyKey: idempotencyKey
            )
            commandAttemptTracker.track(command, operationID: operationID)
            // Immediate commands (account.activate, stop, …) return terminal in the POST body.
            // Clear the busy spinner before the snapshot reload so the Use button does not
            // stay locked for the duration of a slow /api/mobile/snapshot fetch.
            reconcileTrackedCommands([command])
            await load()
            // A deduplicated request can already be terminal even if it has fallen out of the
            // latest snapshot page. Reconcile that direct response as a final fallback.
            reconcileTrackedCommands([command])
            return !command.didFail
        } catch is CancellationError {
            busyOperations.remove(operationID)
            return false
        } catch let caught {
            if shouldReleaseCommandAttempt(after: caught) {
                commandAttemptTracker.release(operationID: operationID)
            }
            // Network/decoding errors keep the idempotency key for an explicit retry, but they do
            // not leave the control visually locked when no command id was confirmed.
            busyOperations.remove(operationID)
            applyAuthAwareError(caught)
            return false
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

    func loginWithWebAuthCode(_ code: String, verifier: String) async {
        guard !isSigningIn else { return }
        isSigningIn = true
        defer { isSigningIn = false }
        do {
            try await client.exchangeWebAuthCode(code, verifier: verifier)
            await load()
            if isAuthenticated {
                startEvents()
            } else if error == nil {
                error = "Authentication failed after web sign-in. Try again."
            }
        } catch {
            applyAuthAwareError(error)
            self.error = "Web sign-in could not be completed. Try again."
        }
    }

    func dismissError() {
        error = nil
    }

    func clearLocalSession() {
        stopEvents()
        for cookie in HTTPCookieStorage.shared.cookies ?? [] where client.ownsCookie(cookie) {
            HTTPCookieStorage.shared.deleteCookie(cookie)
        }
        loadGeneration &+= 1
        snapshot = nil
        lastUpdatedAt = nil
        snapshotLoadFailed = false
        deletionRequest = nil
        busyOperations = []
        commandAttemptTracker.removeAll()
        isRefreshing = false
        isAuthenticated = false
        hasInitialized = true
        error = nil
    }

    private func scheduleReload() {
        guard !reloadInFlight else {
            reloadPending = true
            return
        }
        reloadInFlight = true
        Task { [weak self] in
            guard let self else { return }
            repeat {
                reloadPending = false
                await load()
            } while reloadPending && !Task.isCancelled
            reloadInFlight = false
        }
    }

    private func reconcileTrackedCommands(_ commands: [MobileCommand]) {
        let resolutions = commandAttemptTracker.reconcile(commands)
        for resolution in resolutions {
            busyOperations.remove(resolution.operationID)
            guard resolution.status == "failed" || resolution.status == "cancelled" else { continue }
            let detail = resolution.error?.trimmingCharacters(in: .whitespacesAndNewlines)
            error = detail?.isEmpty == false
                ? detail
                : "The queued action was \(resolution.status)."
        }
    }

    private func applyAuthAwareError(
        _ caught: Error,
        preserveTransientMessage: Bool = true,
        showUnauthorizedMessage: Bool = true
    ) {
        if let apiError = caught as? MobileAPIError, case .unauthorized = apiError {
            clearLocalSession()
            error = showUnauthorizedMessage ? apiError.localizedDescription : nil
            return
        }
        if preserveTransientMessage {
            error = caught.localizedDescription
        }
    }

    private func shouldReleaseCommandAttempt(after error: Error) -> Bool {
        guard let apiError = error as? MobileAPIError else { return false }
        switch apiError {
        case .serverError, .unauthorized:
            return true
        case .network, .decoding:
            return false
        }
    }

    private func unavailableMessage(for commandType: String) -> String {
        if Self.readinessDependentCommands.contains(commandType),
           let snapshot,
           !snapshot.readiness.hasAccount || !snapshot.readiness.hasUniverse {
            return "Connect an account and configure a symbol universe before running the agent."
        }
        return "Refresh the latest server state before submitting this action. Stop remains available."
    }

    private static let protectiveCommands: Set<String> = [
        "strategy.stop",
        "strategy.close_only",
        "strategy.liquidating",
        "proposal.reject"
    ]

    private static let readinessDependentCommands: Set<String> = [
        "strategy.run_once",
        "strategy.start"
    ]
}
