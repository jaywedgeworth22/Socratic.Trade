import Foundation
import SwiftUI

@MainActor
final class MobileStore: ObservableObject {
    @Published var snapshot: MobileSnapshot?
    @Published var error: String?
    @Published var busy = false
    @Published var deletionRequest: AccountDeletionRequest?

    private let client: MobileAPIClient
    private var eventTask: Task<Void, Never>?

    init(client: MobileAPIClient) {
        self.client = client
    }

    func load() async {
        do {
            snapshot = try await client.snapshot()
            error = nil
        } catch {
            self.error = error.localizedDescription
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
}
