import SwiftUI

struct MobileControlView: View {
    @EnvironmentObject private var store: MobileStore
    @State private var ticker = ""
    @State private var deleteIdentity = ""
    @State private var deletePhrase = ""
    // Item 30: typed-confirmation state for approving a broker/live proposal. Mirrors the PWA's
    // per-proposal `liveTextByProposal` (app/mobile/mobile-pwa-client.tsx), but as a native alert
    // (with a TextField) instead of an always-visible inline field, since only one proposal can be
    // confirmed at a time from this screen.
    @State private var confirmingLiveProposal: PendingProposal?
    @State private var liveConfirmationText = ""

    // The screen body is deliberately split into one computed property per section: as a single
    // `List { ... }` expression this view exceeded the Swift type-checker's solver budget
    // ("unable to type-check this expression in reasonable time" under `swiftc -typecheck`).
    // Each computed property is type-checked independently, keeping every expression small.
    var body: some View {
        NavigationStack {
            List {
                errorSection
                modeSection
                portfolioSection
                approvalsSection
                watchlistSection
                recentCommandsSection
                deletionSection
            }
            .tabItem { AppTab.home.label }
            .tag(AppTab.home)

            NavigationStack {
                ProposalsView()
            }
            // Item 30: typed-confirmation prompt for approving a broker/live proposal. Parity with
            // app/mobile/mobile-pwa-client.tsx's inline live-approval field and
            // app/console/components/approval-card.tsx's typed-confirmation gate, adapted to a
            // native alert since only one proposal is confirmed at a time here.
            .alert(
                "Confirm Live Order",
                isPresented: Binding(
                    get: { confirmingLiveProposal != nil },
                    set: { isPresented in
                        if !isPresented {
                            confirmingLiveProposal = nil
                            liveConfirmationText = ""
                        }
                    }
                ),
                presenting: confirmingLiveProposal
            ) { proposal in
                TextField(expectedLiveConfirmationText(for: proposal), text: $liveConfirmationText)
                    .textInputAutocapitalization(.characters)
                    .autocorrectionDisabled()
                Button("Approve", role: .destructive) {
                    approveLiveProposal(proposal)
                }
                .disabled(!liveConfirmationMatches(proposal))
                Button("Cancel", role: .cancel) {
                    confirmingLiveProposal = nil
                    liveConfirmationText = ""
                }
            } message: { proposal in
                Text("This is a live brokerage order for \(proposal.proposal.symbol). Type exactly: \(expectedLiveConfirmationText(for: proposal))")
            }
        }
    }

    @ViewBuilder
    private var errorSection: some View {
        if let error = store.error {
            Section {
                Text(error).foregroundStyle(.red)
            }
        }
    }

    private var modeSection: some View {
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
    }

    private var portfolioSection: some View {
        Section("Portfolio") {
            LabeledContent("Equity", value: money(store.snapshot?.portfolio?.totalMarketValue))
            LabeledContent("Buying power", value: money(store.snapshot?.portfolio?.buyingPower))
            LabeledContent("Account", value: store.snapshot?.readiness.activeConnectedAccount?.label ?? "None")
        }
    }

    private var approvalsSection: some View {
        Section("Approvals") {
            ForEach(store.snapshot?.pendingProposals ?? []) { proposal in
                ProposalApprovalRow(
                    proposal: proposal,
                    notionalText: money(proposal.estimatedNotional),
                    onApprove: {
                        // Item 30: broker/live orders need the typed confirmation phrase
                        // (policy.requireTypedConfirmation, on by default) before we'll
                        // submit -- mirrors the PWA's `willPromptTyped` gate.
                        if requiresLiveConfirmation(proposal) {
                            liveConfirmationText = ""
                            confirmingLiveProposal = proposal
                        } else {
                            Task { await store.submit("proposal.approve", payload: ["proposalId": proposal.id]) }
                        }
                    },
                    onReject: {
                        Task { await store.submit("proposal.reject", payload: ["proposalId": proposal.id]) }
                    }
                )
            }
        }
    }

    private var watchlistSection: some View {
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
    }

    private var recentCommandsSection: some View {
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
    }

    private var deletionSection: some View {
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
                .disabled(deleteConfirmDisabled(deletion))
            } else {
                Button("Start deletion steps", role: .destructive) {
                    Task { await store.startAccountDeletion() }
                }
                .disabled(store.busy)
            }
        }
    }

    private func deleteConfirmDisabled(_ deletion: AccountDeletionRequest) -> Bool {
        store.busy ||
        deleteIdentity.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() != (deletion.email ?? deletion.userId).lowercased() ||
        deletePhrase.trimmingCharacters(in: .whitespacesAndNewlines) != deletion.requiredText
    }

    private func money(_ value: Double?) -> String {
        guard let value else { return "-" }
        return value.formatted(.currency(code: "USD"))
    }

    /// Mirrors the PWA's `willPromptTyped` (app/mobile/mobile-pwa-client.tsx): only broker/live
    /// orders need the typed phrase, and only while `policy.requireTypedConfirmation` is on --
    /// which defaults to on when the field is missing, matching the server's own `!== false` check
    /// (app/api/mobile/snapshot/route.ts).
    private func requiresLiveConfirmation(_ proposal: PendingProposal) -> Bool {
        proposal.executionMode == "broker/live" && (store.snapshot?.policy.requireTypedConfirmation ?? true)
    }

    private func expectedLiveConfirmationText(for proposal: PendingProposal) -> String {
        liveApprovalConfirmationText(forSymbol: proposal.proposal.symbol)
    }

    private func liveConfirmationMatches(_ proposal: PendingProposal) -> Bool {
        liveConfirmationText.trimmingCharacters(in: .whitespacesAndNewlines).uppercased() == expectedLiveConfirmationText(for: proposal)
    }

    /// Submits `proposal.approve` with the `liveConfirmation` payload the server requires for a
    /// live order (src/lib/mobile-api.ts `normalizeCommandPayload` -> src/lib/strategy.ts
    /// `assertLiveApprovalConfirmation`). The server is the authority on the match; if it rejects
    /// the confirmation for any reason, that reason lands in the command's `error` field and shows
    /// under Recent Commands like any other failure -- no separate error path needed here.
    private func approveLiveProposal(_ proposal: PendingProposal) {
        let typedText = liveConfirmationText.trimmingCharacters(in: .whitespacesAndNewlines).uppercased()
        confirmingLiveProposal = nil
        liveConfirmationText = ""
        let confirmation = LiveApprovalConfirmation(
            proposalId: proposal.id,
            accountNumber: proposal.accountNumber,
            estimatedNotional: proposal.estimatedNotional,
            typedText: typedText
        )
        Task {
            await store.submit("proposal.approve", payload: [
                "proposalId": proposal.id,
                "liveConfirmation": confirmation.jsonObject
            ])
        }
    }
}

/// One pending-proposal card in the Approvals section. Extracted from `MobileControlView.body`
/// because the combined List expression grew past the Swift type-checker's solver budget
/// ("unable to type-check this expression in reasonable time" at the Approvals `VStack` under
/// `swiftc -typecheck`); a standalone subview keeps each body expression small and fast to check.
private struct ProposalApprovalRow: View {
    let proposal: PendingProposal
    let notionalText: String
    let onApprove: () -> Void
    let onReject: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text(proposal.proposal.symbol).font(.headline)
                Spacer()
                Text(notionalText)
            }
            Text("\(proposal.proposal.side.uppercased()) · \(proposal.executionMode ?? "mode unknown")")
                .font(.caption)
                .foregroundStyle(.secondary)
            if let rationale = proposal.proposal.rationale {
                Text(rationale).font(.caption)
            }
            HStack {
                Button("Approve", action: onApprove)
                Button("Reject", role: .destructive, action: onReject)
            }
            .buttonStyle(.bordered)
        }
    }
}

private enum AppTab: String, CaseIterable, Identifiable {
    case home
    case proposals
    case markets
    case activity
    case coach

    var id: String { rawValue }

    @ViewBuilder
    var label: some View {
        switch self {
        case .home:
            Label("Home", systemImage: "house.fill")
        case .proposals:
            Label("Proposals", systemImage: "checklist")
        case .markets:
            Label("Markets", systemImage: "chart.line.uptrend.xyaxis")
        case .activity:
            Label("Activity", systemImage: "clock.arrow.circlepath")
        case .coach:
            Label("Coach", systemImage: "bubble.left.and.text.bubble.right.fill")
        }
    }
}

#if DEBUG
#Preview("Five-tab shell") {
    MobileControlView()
        .environmentObject(MobileStore.preview)
}
#endif
