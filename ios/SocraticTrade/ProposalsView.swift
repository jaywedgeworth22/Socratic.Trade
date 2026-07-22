import SwiftUI

struct ProposalsView: View {
    @EnvironmentObject private var store: MobileStore

    @State private var confirmingProposal: PendingProposal?
    @State private var confirmationText = ""

    var body: some View {
        SnapshotScaffold { snapshot in
            ProposalQueueSummary(snapshot: snapshot)
            if snapshot.pendingProposals.isEmpty {
                EmptyStateCard(
                    title: "No proposals waiting",
                    message: "New owner decisions will appear here after a strategy run.",
                    systemImage: "checkmark.seal"
                )
            } else {
                ForEach(snapshot.pendingProposals) { proposal in
                    ProposalCard(
                        proposal: proposal,
                        approveBusy: store.isBusy(approveOperationID(proposal)),
                        rejectBusy: store.isBusy(rejectOperationID(proposal)),
                        approveDisabled: !store.canSubmit("proposal.approve"),
                        rejectDisabled: !store.canSubmit("proposal.reject"),
                        requiresTypedConfirmation: requiresLiveConfirmation(proposal, snapshot: snapshot),
                        approve: { approve(proposal, snapshot: snapshot) },
                        reject: { reject(proposal) }
                    )
                }
            }
        }
        .navigationTitle("Proposals")
        .alert(
            "Confirm Live Order",
            isPresented: Binding(
                get: { confirmingProposal != nil },
                set: { isPresented in
                    if !isPresented { resetConfirmation() }
                }
            ),
            presenting: confirmingProposal
        ) { proposal in
            TextField(expectedConfirmation(for: proposal), text: $confirmationText)
                .textInputAutocapitalization(.characters)
                .autocorrectionDisabled()
            Button("Approve Live Order", role: .destructive) {
                approveConfirmedLiveProposal(proposal)
            }
            .disabled(!confirmationMatches(proposal))
            Button("Cancel", role: .cancel) {
                resetConfirmation()
            }
        } message: { proposal in
            Text("Type exactly “\(expectedConfirmation(for: proposal))”. The backend revalidates the proposal and confirmation before placing anything.")
        }
    }

    private func requiresLiveConfirmation(_ proposal: PendingProposal, snapshot: MobileSnapshot) -> Bool {
        proposal.executionMode == "broker/live" && (snapshot.policy.requireTypedConfirmation ?? true)
    }

    private func approve(_ proposal: PendingProposal, snapshot: MobileSnapshot) {
        if requiresLiveConfirmation(proposal, snapshot: snapshot) {
            confirmationText = ""
            confirmingProposal = proposal
        } else {
            Task {
                await store.submit(
                    "proposal.approve",
                    payload: ["proposalId": proposal.id],
                    operationID: approveOperationID(proposal)
                )
            }
        }
    }

    private func reject(_ proposal: PendingProposal) {
        Task {
            await store.submit(
                "proposal.reject",
                payload: ["proposalId": proposal.id],
                operationID: rejectOperationID(proposal)
            )
        }
    }

    private func approveConfirmedLiveProposal(_ proposal: PendingProposal) {
        let confirmation = LiveApprovalConfirmation(
            proposalId: proposal.id,
            accountNumber: proposal.accountNumber,
            estimatedNotional: proposal.estimatedNotional,
            typedText: confirmationText.trimmingCharacters(in: .whitespacesAndNewlines).uppercased()
        )
        resetConfirmation()
        Task {
            await store.submit(
                "proposal.approve",
                payload: [
                    "proposalId": proposal.id,
                    "liveConfirmation": confirmation.jsonObject
                ],
                operationID: approveOperationID(proposal)
            )
        }
    }

    private func approveOperationID(_ proposal: PendingProposal) -> String {
        "proposal.approve:\(proposal.id)"
    }

    private func rejectOperationID(_ proposal: PendingProposal) -> String {
        "proposal.reject:\(proposal.id)"
    }

    private func expectedConfirmation(for proposal: PendingProposal) -> String {
        liveApprovalConfirmationText(forSymbol: proposal.proposal.symbol)
    }

    private func confirmationMatches(_ proposal: PendingProposal) -> Bool {
        confirmationText.trimmingCharacters(in: .whitespacesAndNewlines).uppercased() == expectedConfirmation(for: proposal)
    }

    private func resetConfirmation() {
        confirmingProposal = nil
        confirmationText = ""
    }
}

private struct ProposalQueueSummary: View {
    let snapshot: MobileSnapshot

    var body: some View {
        AppCard {
            HStack(spacing: 14) {
                ZStack {
                    Circle()
                        .fill(AppPalette.accent.opacity(0.12))
                    Image(systemName: "checklist")
                        .foregroundStyle(AppPalette.accent)
                }
                .frame(width: 46, height: 46)

                VStack(alignment: .leading, spacing: 3) {
                    Text("\(snapshot.pendingProposals.count) awaiting review")
                        .font(.headline)
                    Text("\(snapshot.readiness.strategyAuthority.capitalized) authority · backend validation remains final")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
        }
    }
}

private struct ProposalCard: View {
    let proposal: PendingProposal
    let approveBusy: Bool
    let rejectBusy: Bool
    let approveDisabled: Bool
    let rejectDisabled: Bool
    let requiresTypedConfirmation: Bool
    let approve: () -> Void
    let reject: () -> Void

    private var sideColor: Color {
        switch proposal.proposal.side.lowercased() {
        case "buy", "cover": return AppPalette.positive
        default: return AppPalette.negative
        }
    }

    var body: some View {
        AppCard {
            VStack(alignment: .leading, spacing: 14) {
                HStack(alignment: .firstTextBaseline) {
                    Text(proposal.proposal.symbol.uppercased())
                        .font(.title2.weight(.bold))
                    StatusPill(proposal.proposal.side.uppercased(), color: sideColor)
                    Spacer()
                    Text(AppFormat.money(proposal.estimatedNotional))
                        .font(.headline)
                }

                HStack(spacing: 8) {
                    StatusPill(
                        proposal.executionMode == "broker/live" ? "Live" : "Paper",
                        color: proposal.executionMode == "broker/live" ? AppPalette.negative : AppPalette.accent,
                        systemImage: proposal.executionMode == "broker/live" ? "dollarsign.circle.fill" : "doc.text"
                    )
                    if let confidence = proposal.proposal.confidenceScore {
                        StatusPill("\(Int(confidence.rounded()))% confidence", color: AppPalette.accent)
                    }
                    if let performance = proposal.performanceSinceProposalPct {
                        StatusPill(
                            AppFormat.percent(performance, signed: true),
                            color: performance >= 0 ? AppPalette.positive : AppPalette.negative
                        )
                    }
                }

                VStack(alignment: .leading, spacing: 7) {
                    DetailLine(label: "Order", value: orderDescription)
                    if let thesis = proposal.proposal.tradeThesisTag, !thesis.isEmpty {
                        DetailLine(label: "Thesis", value: thesis)
                    }
                    if let regime = proposal.proposal.entryMarketRegime, !regime.isEmpty {
                        DetailLine(label: "Regime", value: regime)
                    }
                    if let model = proposal.proposal.proposedByModel, !model.isEmpty {
                        DetailLine(label: "Proposed by", value: model)
                    }
                    DetailLine(label: "Created", value: AppFormat.dateTime(proposal.createdAt))
                }

                if let rationale = proposal.proposal.greenTeamRationale ?? proposal.proposal.rationale,
                   !rationale.isEmpty {
                    Text(rationale)
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }

                if let note = proposal.revalidationNote, !note.isEmpty {
                    Label(note, systemImage: "arrow.triangle.2.circlepath")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }

                if let verdict = proposal.proposal.redTeamVerdict {
                    RedTeamReview(verdict: verdict)
                }

                Divider()

                if requiresTypedConfirmation {
                    Label("Typed confirmation required for this live order", systemImage: "keyboard.badge.ellipsis")
                        .font(.caption)
                        .foregroundStyle(AppPalette.warning)
                }

                ViewThatFits(in: .horizontal) {
                    HStack(spacing: 10) {
                        rejectButton
                        approveButton
                    }
                    VStack(spacing: 10) {
                        rejectButton
                        approveButton
                    }
                }
            }
        }
    }

    private var orderDescription: String {
        var pieces = [proposal.proposal.type.capitalized]
        if let quantity = proposal.proposal.quantity {
            pieces.append("\(AppFormat.number(quantity)) shares")
        }
        if let limitPrice = proposal.proposal.limitPrice {
            pieces.append("limit \(AppFormat.money(limitPrice))")
        }
        if let stopPrice = proposal.proposal.stopPrice {
            pieces.append("stop \(AppFormat.money(stopPrice))")
        }
        return pieces.joined(separator: " · ")
    }

    private var rejectButton: some View {
        CommandButton(
            "Reject",
            systemImage: "xmark",
            isBusy: rejectBusy,
            isDisabled: rejectDisabled,
            role: .destructive,
            action: reject
        )
    }

    private var approveButton: some View {
        CommandButton(
            requiresTypedConfirmation ? "Review & Approve" : "Approve",
            systemImage: "checkmark",
            isBusy: approveBusy,
            isDisabled: approveDisabled,
            prominent: true,
            action: approve
        )
    }
}

private struct RedTeamReview: View {
    let verdict: RedTeamVerdict

    private var title: String {
        guard verdict.available else { return "Adversarial review unavailable" }
        switch verdict.verdict {
        case "approve-at-half": return "Red Team: approved at half size"
        case "reject": return "Red Team: rejected"
        default: return verdict.rejected ? "Red Team: rejected" : "Red Team: approved"
        }
    }

    private var color: Color {
        if !verdict.available { return AppPalette.warning }
        return verdict.rejected ? AppPalette.negative : AppPalette.positive
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 7) {
            Label(title, systemImage: verdict.available ? "shield.checkered" : "exclamationmark.shield.fill")
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(color)
            Text(verdict.reason)
                .font(.caption)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            if let model = verdict.model, !model.isEmpty {
                Text("Reviewed by \(model)")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }
            if verdict.humanOverrideApplied == true {
                StatusPill("Human override applied", color: AppPalette.warning, systemImage: "person.badge.shield.checkmark")
            }
        }
        .padding(12)
        .background(color.opacity(0.08), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
    }
}

private struct DetailLine: View {
    let label: String
    let value: String

    var body: some View {
        HStack(alignment: .firstTextBaseline) {
            Text(label)
                .font(.caption)
                .foregroundStyle(.secondary)
                .frame(width: 58, alignment: .leading)
            Text(value)
                .font(.subheadline)
            Spacer(minLength: 0)
        }
    }
}
