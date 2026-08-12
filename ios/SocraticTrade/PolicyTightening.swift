import SwiftUI

/// Phone-side guardrail TIGHTENING, submitted through the existing `policy.patch` mobile
/// command (src/lib/mobile-api.ts → `normalizePolicyPatch` → `applyPolicyPatch`).
///
/// **Why the phone only tightens.**  The server accepts either direction, and every value
/// here is one of the owner's own adjustable preferences — nothing in this file exists to
/// protect the owner from risk they have accepted.  The asymmetry is about the device: a
/// phone is the surface most likely to fire an unintended tap, be handed to someone else, or
/// be operated with three seconds of attention, and the only edits that stay safe under those
/// conditions are the ones that cannot increase exposure.  Loosening — Ask-First back to
/// Autopilot, or raising a cap — is a deliberate act that deserves the console's full policy
/// screen and the surrounding context it shows.  Nothing is blocked: the same change is one
/// tap away on the web.
///
/// **What the server actually accepts** (quoted from `normalizePolicyPatch`):
/// - `strategyAuthority` must be `"propose"` or `"decide"`.
/// - `["maxOrderNotional", 1, 100_000]` and `["maxDailyNotional", 1, undefined]` — both are
///   plain finite numbers with a minimum of 1.
/// Payloads are `{ "patch": { … } }`, matching
/// `case "policy.patch": return { patch: normalizePolicyPatch(payload.patch ?? payload) }`.
enum PolicyTightening {
    static let commandType = "policy.patch"

    /// `StrategyAuthority` wire values.  User-facing wording comes from
    /// `AppFormat.strategyAuthorityLabel` / `strategyAuthorityValue` (Autopilot / Ask-First).
    static let autopilot = "decide"
    static let askFirst = "propose"

    /// Server floor shared by both notional caps (`min` of 1 in `numericFields`).
    static let minimumNotional: Double = 1

    /// Offered reductions, strongest last so the menu reads from mildest to strictest.
    static let reductionFractions: [Double] = [0.75, 0.5, 0.25]

    /// The tightened authority value, or nil when there is nothing tighter to move to.
    /// Only Autopilot → Ask-First is a tightening; the reverse stays on the console.
    static func tightenedAuthority(current: String?) -> String? {
        let normalized = current?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        return normalized == autopilot ? askFirst : nil
    }

    /// The two notional caps this screen can lower.
    enum Cap: String, CaseIterable, Identifiable {
        case maxOrderNotional
        case maxDailyNotional

        var id: String { rawValue }

        /// Heading-style label, matching the existing "Current Policy" rows.
        var title: String {
            switch self {
            case .maxOrderNotional: return "Max Order"
            case .maxDailyNotional: return "Daily Cap"
            }
        }

        var menuTitle: String {
            switch self {
            case .maxOrderNotional: return "Lower Max Order"
            case .maxDailyNotional: return "Lower Daily Cap"
            }
        }

        /// The percent-of-NAV cap that is mutually exclusive with this notional cap
        /// (src/lib/policy-normalization.ts `normalizeExclusivePolicyCaps`).
        func competingPercentCap(in policy: PolicySummary?) -> Double? {
            switch self {
            case .maxOrderNotional: return policy?.maxOrderPctOfNav
            case .maxDailyNotional: return policy?.maxDailyPctOfNav
            }
        }

        func currentValue(in policy: PolicySummary?) -> Double? {
            switch self {
            case .maxOrderNotional: return policy?.maxOrderNotional
            case .maxDailyNotional: return policy?.maxDailyNotional
            }
        }
    }

    /// A lower value for `current`, or nil when the reduction is not offerable.
    ///
    /// Refuses when `competingPercentCap` is present: the server's
    /// `normalizeExclusivePolicyCaps` treats notional and percent-of-NAV caps as either/or, so
    /// sending a notional while a percent cap is also stored would DELETE the percent cap and
    /// switch which rule binds — an outcome that can be a loosening in practice.  Switching
    /// cap modes is a console decision, not a one-tap phone action.
    static func tightenedCap(current: Double?, competingPercentCap: Double?, fraction: Double) -> Double? {
        guard competingPercentCap == nil else { return nil }
        guard let current, current.isFinite, current > minimumNotional else { return nil }
        guard fraction > 0, fraction < 1 else { return nil }
        let proposed = (current * fraction).rounded(.down)
        guard proposed.isFinite, proposed >= minimumNotional, proposed < current else { return nil }
        return proposed
    }

    /// Every offerable reduction for a cap, largest (mildest) first, de-duplicated.
    static func tightenedCapOptions(current: Double?, competingPercentCap: Double?) -> [Double] {
        var seen: Set<Double> = []
        return reductionFractions.compactMap { fraction in
            guard let value = tightenedCap(
                current: current,
                competingPercentCap: competingPercentCap,
                fraction: fraction
            ) else { return nil }
            return seen.insert(value).inserted ? value : nil
        }
    }

    /// Whether `value` is STILL a tightening of `cap` as the policy reads RIGHT NOW.
    ///
    /// `tightenedCapOptions` runs when the menu's content is built, but the value it produced is
    /// an ABSOLUTE number and three things can happen between then and the patch landing:
    /// an open menu holds its options while a new snapshot arrives, the owner lowers the same cap
    /// in the web console, and `policy.patch` is a QUEUED mobile command that can execute minutes
    /// later behind a `strategy.run_once`.  The server enforces no direction on `policy.patch`
    /// (`normalizePolicyPatch` accepts both, `applyPolicyPatch` merges verbatim), so a stale
    /// option re-sent against a smaller cap RAISES it — the one outcome this whole file exists to
    /// prevent.  Re-checking at tap time closes every window the phone can see; the queue latency
    /// after submission is the server's to close.
    static func isStillATightening(_ cap: Cap, value: Double, in policy: PolicySummary?) -> Bool {
        guard cap.competingPercentCap(in: policy) == nil else { return false }
        guard let current = cap.currentValue(in: policy), current.isFinite else { return false }
        return value.isFinite && value >= minimumNotional && value < current
    }

    static func authorityPayload() -> [String: Any] {
        ["patch": ["strategyAuthority": askFirst]]
    }

    static func capPayload(_ cap: Cap, value: Double) -> [String: Any] {
        ["patch": [cap.rawValue: value]]
    }

    static func operationID(_ suffix: String) -> String {
        "\(commandType):\(suffix)"
    }
}

/// Settings-sheet section that submits the tightenings above.  It lives beside the read-only
/// "Current Policy" rows because that is where the same numbers are already shown — the
/// smallest possible IA delta, and no new destination to discover.  Submission uses the normal
/// `store.submit` path (busy guard + idempotency key + snapshot reload), and carries no extra
/// confirmation ceremony: it is the same weight of action as Close Only or Wind Down.
struct GuardrailTighteningSection: View {
    @EnvironmentObject private var store: MobileStore

    private var policy: PolicySummary? { store.snapshot?.policy }

    private var tightenedAuthority: String? {
        PolicyTightening.tightenedAuthority(current: policy?.strategyAuthority)
    }

    var body: some View {
        // Capability discovery: hide the whole section on a deployment that does not
        // advertise policy.patch rather than offering a control that would 400.
        if store.serverAdvertises(PolicyTightening.commandType) {
            Section {
                authorityRow
                ForEach(PolicyTightening.Cap.allCases) { cap in
                    capRow(cap)
                }
            } header: {
                Text("Tighten Guardrails")
            } footer: {
                Text("These controls only tighten.  Returning to Autopilot or raising a cap is done in the web console.")
            }
        }
    }

    @ViewBuilder
    private var authorityRow: some View {
        let operationID = PolicyTightening.operationID("strategyAuthority")
        if tightenedAuthority != nil {
            Button {
                Task {
                    await store.submit(
                        PolicyTightening.commandType,
                        payload: PolicyTightening.authorityPayload(),
                        operationID: operationID
                    )
                }
            } label: {
                HStack {
                    Label("Require Approval First", systemImage: "person.badge.shield.checkmark")
                    Spacer(minLength: 8)
                    if store.isBusy(operationID) {
                        ProgressView()
                    }
                }
            }
            .disabled(store.isBusy(operationID) || !store.canSubmit(PolicyTightening.commandType))
            .accessibilityHint("Switches strategy authority from autopilot to ask-first")
        } else {
            LabeledContent(
                "Authority",
                value: AppFormat.strategyAuthorityValue(policy?.strategyAuthority)
            )
            .foregroundStyle(.secondary)
        }
    }

    @ViewBuilder
    private func capRow(_ cap: PolicyTightening.Cap) -> some View {
        let current = cap.currentValue(in: policy)
        let competing = cap.competingPercentCap(in: policy)
        let options = PolicyTightening.tightenedCapOptions(current: current, competingPercentCap: competing)
        let operationID = PolicyTightening.operationID(cap.rawValue)

        if store.isBusy(operationID) {
            HStack {
                Text(cap.menuTitle)
                Spacer(minLength: 8)
                ProgressView()
            }
        } else if options.isEmpty {
            LabeledContent(cap.title, value: unavailableValue(current: current, competingPercentCap: competing))
                .foregroundStyle(.secondary)
        } else {
            Menu {
                ForEach(options, id: \.self) { value in
                    Button(AppFormat.money(value)) {
                        submit(cap, value: value, operationID: operationID)
                    }
                }
            } label: {
                HStack {
                    Text(cap.menuTitle)
                    Spacer(minLength: 8)
                    Text(AppFormat.money(current))
                        .foregroundStyle(.secondary)
                }
            }
            .disabled(!store.canSubmit(PolicyTightening.commandType))
            .accessibilityLabel("\(cap.menuTitle), currently \(AppFormat.money(current))")
        }
    }

    /// Submits a lowered cap, but only after re-reading the CURRENT snapshot: the value in hand
    /// was computed when the menu was built, and re-sending a stale one against a cap that has
    /// since dropped would raise it (see `isStillATightening`).  Refusing says so instead of
    /// silently doing nothing.
    private func submit(_ cap: PolicyTightening.Cap, value: Double, operationID: String) {
        guard PolicyTightening.isStillATightening(cap, value: value, in: store.snapshot?.policy) else {
            store.error = "\(cap.title) changed while that menu was open.  Nothing was sent — reopen it to see the current limit."
            return
        }
        Task {
            await store.submit(
                PolicyTightening.commandType,
                payload: PolicyTightening.capPayload(cap, value: value),
                operationID: operationID
            )
        }
    }

    /// Sentence-case value explaining why no reduction is on offer.
    private func unavailableValue(current: Double?, competingPercentCap: Double?) -> String {
        if competingPercentCap != nil {
            return "set as % of NAV — console only"
        }
        if current == nil {
            return "not set — console only"
        }
        return "already at the floor"
    }
}
