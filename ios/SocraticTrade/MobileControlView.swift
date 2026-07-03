import SwiftUI

struct MobileControlView: View {
    @EnvironmentObject private var store: MobileStore
    @State private var ticker = ""
    @State private var deleteIdentity = ""
    @State private var deletePhrase = ""

    var body: some View {
        NavigationStack {
            List {
                if let error = store.error {
                    Section {
                        Text(error).foregroundStyle(.red)
                    }
                }

                Section("Mode") {
                    HStack {
                        Text(store.snapshot?.readiness.systemState.capitalized ?? "Unknown")
                            .font(.title2.bold())
                        Spacer()
                        Text(store.snapshot?.readiness.strategyAuthority.capitalized ?? "-")
                            .foregroundStyle(.secondary)
                    }
                    HStack {
                        Button("Run once") { Task { await store.submit("strategy.run_once") } }
                        Button("Start") { Task { await store.submit("strategy.start") } }
                        Button("Stop", role: .destructive) { Task { await store.submit("strategy.stop") } }
                    }
                    .buttonStyle(.borderedProminent)
                    .disabled(store.busy)
                }

                Section("Portfolio") {
                    LabeledContent("Equity", value: money(store.snapshot?.portfolio?.totalMarketValue))
                    LabeledContent("Buying power", value: money(store.snapshot?.portfolio?.buyingPower))
                    LabeledContent("Account", value: store.snapshot?.readiness.activeConnectedAccount?.label ?? "None")
                }

                Section("Approvals") {
                    ForEach(store.snapshot?.pendingProposals ?? []) { proposal in
                        VStack(alignment: .leading, spacing: 8) {
                            HStack {
                                Text(proposal.proposal.symbol).font(.headline)
                                Spacer()
                                Text(money(proposal.estimatedNotional))
                            }
                            Text("\(proposal.proposal.side.uppercased()) · \(proposal.executionMode ?? "mode unknown")")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                            if let rationale = proposal.proposal.rationale {
                                Text(rationale).font(.caption)
                            }
                            HStack {
                                Button("Approve") {
                                    Task { await store.submit("proposal.approve", payload: ["proposalId": proposal.id]) }
                                }
                                Button("Reject", role: .destructive) {
                                    Task { await store.submit("proposal.reject", payload: ["proposalId": proposal.id]) }
                                }
                            }
                            .buttonStyle(.bordered)
                        }
                    }
                }

                Section("Watchlist") {
                    HStack {
                        TextField("Ticker", text: $ticker)
                            .textInputAutocapitalization(.characters)
                        Button("Add") {
                            let value = ticker
                            ticker = ""
                            Task { await store.submit("watchlist.add", payload: ["symbol": value]) }
                        }
                    }
                    ForEach(store.snapshot?.watchlist ?? []) { item in
                        Text(item.symbol)
                    }
                }

                Section("Recent Commands") {
                    ForEach(store.snapshot?.recentCommands ?? []) { command in
                        VStack(alignment: .leading) {
                            Text(command.commandType)
                            Text(command.status.capitalized).font(.caption).foregroundStyle(.secondary)
                            if let error = command.error {
                                Text(error).font(.caption).foregroundStyle(.red)
                            }
                        }
                    }
                }

                Section("Delete Account Connection") {
                    Text("Deletes app-side data and server-stored secrets for the current Google or Apple login. Signing in later creates a fresh app account for the same OAuth identity.")
                        .font(.caption)
                        .foregroundStyle(.secondary)

                    if let deletion = store.deletionRequest {
                        ForEach(deletion.steps, id: \.self) { step in
                            Text(step).font(.caption)
                        }
                        TextField(deletion.email ?? deletion.userId, text: $deleteIdentity)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                        TextField(deletion.requiredText, text: $deletePhrase)
                            .textInputAutocapitalization(.characters)
                            .autocorrectionDisabled()
                        Button("Delete and Sign Out", role: .destructive) {
                            Task {
                                if let result = await store.confirmAccountDeletion(
                                    typedIdentity: deleteIdentity,
                                    typedText: deletePhrase
                                ) {
                                    // Open backend logout in the hosting app's auth flow.
                                    print("Deleted account; open \(result.logoutUrl)")
                                }
                            }
                        }
                        .disabled(
                            store.busy ||
                            deleteIdentity.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() != (deletion.email ?? deletion.userId).lowercased() ||
                            deletePhrase.trimmingCharacters(in: .whitespacesAndNewlines) != deletion.requiredText
                        )
                    } else {
                        Button("Start deletion steps", role: .destructive) {
                            Task { await store.startAccountDeletion() }
                        }
                        .disabled(store.busy)
                    }
                }
            }
            .navigationTitle("Trading")
            .toolbar {
                Button("Refresh") { Task { await store.load() } }
            }
            .task {
                await store.load()
                store.startEvents()
            }
        }
    }

    private func money(_ value: Double?) -> String {
        guard let value else { return "-" }
        return value.formatted(.currency(code: "USD"))
    }
}
