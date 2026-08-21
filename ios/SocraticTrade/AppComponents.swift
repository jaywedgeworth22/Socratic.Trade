import SwiftUI

enum AppPalette {
    static let background = Color(uiColor: .systemGroupedBackground)
    static let card = Color(uiColor: .secondarySystemGroupedBackground)
    /// Brand teal — matches web `--brand-accent` (#12616f) and dark `--brand-accent-dark` (#58c7d3).
    static let accent = Color(uiColor: UIColor { traits in
        if traits.userInterfaceStyle == .dark {
            return UIColor(red: 0x58 / 255, green: 0xC7 / 255, blue: 0xD3 / 255, alpha: 1) // #58c7d3
        }
        return UIColor(red: 0x12 / 255, green: 0x61 / 255, blue: 0x6F / 255, alpha: 1) // #12616f
    })
    static let positive = Color.green
    static let warning = Color.orange
    static let negative = Color.red
}

enum AppFormat {
    /// Humanized mobile command types — mirrors PWA `commandLabel`. API ids stay dotted.
    private static let commandLabels: [String: String] = [
        "strategy.run_once": "Run Once",
        "strategy.start": "Start Agent",
        "strategy.stop": "Stop Agent",
        // Deliberately Title Case and NOT the state word "Exit-only": these are COMMAND
        // names, exactly like "Wind Down" below, whose state word is "Winding down".
        // Do not "unify" this with RunStateWord.exitOnly — the HomeView button of the
        // same name reads from this map, and the two forms are different parts of speech.
        "strategy.close_only": "Exit Only",
        "strategy.liquidating": "Wind Down",
        "proposal.approve": "Approve Proposal",
        "proposal.reject": "Reject Proposal",
        "proposal.retry_red_team": "Retry Red Team",
        "account.activate": "Switch Account",
        "order.cancel": "Cancel Order",
        "watchlist.add": "Add to Watchlist",
        "watchlist.remove": "Remove from Watchlist",
        "alert.create": "Create Alert",
        "alert.delete": "Delete Alert",
        // Neutral wording: the phone now edits in either direction, and Activity shows both.
        "policy.patch": "Policy Change"
    ]

    /// Full money by default (`$99,812.34`). Compact uses lowercase suffixes (`$99.8k`, `$1.2m`)
    /// to match web compact style when used.
    static func money(_ value: Double?, compact: Bool = false) -> String {
        guard let value else { return "—" }
        if compact, abs(value) >= 1_000 {
            let magnitude: Double
            let suffix: String
            if abs(value) >= 1_000_000_000 {
                magnitude = 1_000_000_000
                suffix = "b"
            } else if abs(value) >= 1_000_000 {
                magnitude = 1_000_000
                suffix = "m"
            } else {
                magnitude = 1_000
                suffix = "k"
            }
            let sign = value < 0 ? "−" : ""
            let scaled = abs(value) / magnitude
            return "\(sign)$\(scaled.formatted(.number.precision(.fractionLength(0...1))))\(suffix)"
        }
        return value.formatted(
            .currency(code: "USD")
                .precision(.fractionLength(0...2))
        )
    }

    static func number(_ value: Double?) -> String {
        guard let value else { return "—" }
        return value.formatted(.number.precision(.fractionLength(0...4)))
    }

    static func percent(_ value: Double?, signed: Bool = false) -> String {
        guard let value else { return "—" }
        let prefix = signed && value > 0 ? "+" : ""
        return "\(prefix)\(value.formatted(.number.precision(.fractionLength(1))))%"
    }

    static func dateTime(_ value: String?) -> String {
        guard let date = date(value) else { return "—" }
        return date.formatted(date: .abbreviated, time: .shortened)
    }

    static func relative(_ value: String?) -> String {
        // Value/answer copy — sentence case, not a heading.
        guard let date = date(value) else { return "not scheduled" }
        return date.formatted(.relative(presentation: .named))
    }

    static func relative(_ date: Date?) -> String {
        guard let date else { return "never" }
        return date.formatted(.relative(presentation: .named))
    }

    /// Authority glossary: never show raw propose/decide — Ask-first / Autopilot (console parity).
    /// This renders mid-sentence and inside status pills — both VALUE contexts, so it is
    /// sentence case, matching web `labels.ts` and its siblings "Exit-only" / "Winding down".
    /// Settings *values* use `strategyAuthorityValue`.
    static func strategyAuthorityLabel(_ value: String?) -> String {
        switch value?.lowercased() {
        case "propose": return "Ask-first"
        case "decide": return "Autopilot"
        case .none, .some(""): return "—"
        case .some(let raw): return raw.replacingOccurrences(of: "_", with: " ").capitalized
        }
    }

    /// Settings / LabeledContent *value* — not a heading (owner: "ask-first", "intraday").
    static func strategyAuthorityValue(_ value: String?) -> String {
        switch value?.lowercased() {
        case "propose": return "ask-first"
        case "decide": return "autopilot"
        case .none, .some(""): return "—"
        case .some(let raw): return raw.replacingOccurrences(of: "_", with: " ").lowercased()
        }
    }

    /// Policy horizon value for settings (e.g. "intraday"), not title case.
    static func policyHorizonValue(_ value: String?) -> String {
        guard let value, !value.isEmpty else { return "—" }
        return value.replacingOccurrences(of: "_", with: " ").lowercased()
    }

    /// Cadence value, e.g. "every 60 min" (not "Every 60 min").
    static func cadenceMinutesValue(_ minutes: Int?) -> String {
        guard let minutes else { return "manual" }
        return "every \(minutes) min"
    }

    /// Order / stop type slug → readable words (`stop_market` → `Stop Market`).
    static func orderTypeLabel(_ raw: String?) -> String {
        guard let raw, !raw.isEmpty else { return "—" }
        return raw
            .replacingOccurrences(of: "_", with: " ")
            .replacingOccurrences(of: "-", with: " ")
            .split(separator: " ")
            .map { $0.prefix(1).uppercased() + $0.dropFirst().lowercased() }
            .joined(separator: " ")
    }

    /// Market session for status banner: "Market Closed", "Market Open", etc.
    static func marketSessionBannerLabel(_ session: String?) -> String {
        switch (session ?? "").lowercased() {
        case "regular", "open": return "Market Open"
        case "pre": return "Pre-Market"
        case "post": return "After Hours"
        case "closed": return "Market Closed"
        case "": return "Market Session"
        default:
            return (session ?? "")
                .replacingOccurrences(of: "_", with: " ")
                .capitalized
        }
    }

    /// Account environment annotation: live is unmarked (all money is real to the owner);
    /// paper is "Broker (paper)" with lowercase p.
    static func accountBrokerEnvironmentLine(broker: String, environment: String) -> String {
        let name = broker.trimmingCharacters(in: .whitespacesAndNewlines)
        let display = name.isEmpty ? "Broker" : name.prefix(1).uppercased() + name.dropFirst().lowercased()
        if environment.lowercased() == "paper" {
            return "\(display) (paper)"
        }
        return String(display)
    }

    /// Red Team failure-kind slug → console wording (src/lib/red-team-routing.ts
    /// `describeRedTeamFailureKind`): "not configured", "provider error", …, else "unavailable".
    static func redTeamFailureKindLabel(_ failureKind: String?) -> String {
        switch failureKind {
        case "not_configured": return "not configured"
        case "timeout": return "timeout"
        case "provider_error": return "provider error"
        case "rate_limited": return "rate limited"
        case "malformed_response": return "malformed response"
        default: return "unavailable"
        }
    }

    /// AccountCapabilities.accountType slug → console wording (app/console/settings/brokers.tsx
    /// TAXATION_WORD style): never render raw snake_case slugs like "roth_ira" to the user.
    static func accountTypeWord(_ accountType: String) -> String {
        switch accountType {
        case "brokerage": return "brokerage"
        case "roth_ira": return "Roth IRA"
        case "traditional_ira": return "traditional IRA"
        case "crypto_exchange": return "crypto exchange"
        default: return accountType.replacingOccurrences(of: "_", with: " ")
        }
    }

    /// Humanized command type for Activity / busy strips.
    static func commandLabel(_ commandType: String) -> String {
        if let known = commandLabels[commandType] { return known }
        return commandType
            .replacingOccurrences(of: ".", with: " ")
            .replacingOccurrences(of: "_", with: " ")
            .split(separator: " ")
            .map { $0.capitalized }
            .joined(separator: " ")
    }

    /// Mirrors web `approval-card.tsx` placement toasts — same status strings, honest copy.
    static func placementApproveMessage(status: String, reasons: [String]?) -> String {
        let detail = reasons?
            .joined(separator: " ")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        if let detail, !detail.isEmpty,
           status == "blocked" || status == "busy" || status == "not_placed" || status == "error" {
            return detail
        }
        switch status {
        case "filled":
            return "Order filled — waiting for desk refresh."
        case "placed":
            return "Order placed — waiting for desk refresh."
        case "paper":
            return "Paper trade filled — waiting for desk refresh."
        case "blocked":
            return detail ?? "Blocked at approval time."
        case "busy":
            return detail ?? "Approval is still busy — wait for the run to finish, then approve again."
        case "not_placed":
            return detail ?? "Order not placed — safe to retry."
        default:
            return detail ?? placementStatusLabel(status)
        }
    }

    static func placementStatusLabel(_ status: String) -> String {
        switch status.lowercased() {
        case "filled": return "Filled"
        case "placed": return "Placed"
        case "paper": return "Paper trade"
        case "blocked": return "Blocked"
        case "busy": return "Busy"
        case "not_placed": return "Not placed — safe to retry"
        case "error": return "Placement failed"
        case "rejected", "rejected_by_broker": return "Rejected by broker"
        default:
            return status
                .replacingOccurrences(of: "_", with: " ")
                .split(separator: " ")
                .map { $0.capitalized }
                .joined(separator: " ")
        }
    }

    static func placementApproveColor(status: String) -> Color {
        switch status {
        case "filled", "placed", "paper":
            return AppPalette.positive
        case "blocked", "busy":
            return AppPalette.warning
        default:
            return AppPalette.accent
        }
    }

    static func placementApproveSystemImage(status: String) -> String {
        switch status {
        case "filled", "placed", "paper":
            return "checkmark.circle.fill"
        case "blocked", "busy":
            return "exclamationmark.triangle.fill"
        default:
            return "info.circle.fill"
        }
    }

    /// Central time, explicitly labeled — fleet convention for any user-facing timestamp that
    /// shows a timezone. Used by SymbolInfoSheet's quote-as-of line; other mobile timestamps
    /// intentionally stay device-local (unchanged, out of scope here).
    static func dateTimeCentral(_ value: String?) -> String {
        guard let date = date(value) else { return "—" }
        let central = TimeZone(identifier: "America/Chicago") ?? .current
        return date.formatted(Date.FormatStyle(date: .abbreviated, time: .shortened, timeZone: central)) + " CT"
    }

    /// P/E display per the repo's P/E honesty convention (mirrors
    /// app/console/ui/drilldown-data.ts `peDisplay`): eps decides the no-ratio state first —
    /// negative/zero trailing earnings render "n/a" (a real, computed "no ratio" state, not
    /// missing data); a strictly positive ratio renders as a number; anything else means the
    /// data simply wasn't available.
    static func peRatioDisplay(peRatio: Double?, eps: Double?) -> String {
        if let eps, eps <= 0 { return "n/a" }
        if let peRatio, peRatio > 0 { return peRatio.formatted(.number.precision(.fractionLength(1))) }
        return "—"
    }

    private static func date(_ value: String?) -> Date? {
        guard let value else { return nil }
        if let parsed = ISO8601DateFormatter.withFractionalSeconds.date(from: value) {
            return parsed
        }
        return ISO8601DateFormatter.standard.date(from: value)
    }
}

private extension ISO8601DateFormatter {
    static let standard = ISO8601DateFormatter()

    static let withFractionalSeconds: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()
}

// MARK: - Layout measures

/// The app's one answer to "how wide should this be?".
///
/// Everything here was phone-first: `SnapshotScaffold` padded a flat 16pt and let its
/// LazyVStack take whatever it was given, which is correct at 393pt and absurd at 1180pt.
/// On an iPad Air 11" in landscape every card became a 1148pt letterbox — a one-line
/// "Open P&L  $1,286.49" stretched a full foot across, and body copy ran past 150
/// characters a line, roughly twice the width type stops being readable at.  The same
/// happens in a maximised Mac Catalyst window.
///
/// Three rules decide which tool a layout uses.  Pick the weakest one that works:
///
///  * **R1 — a plain `maxWidth` ceiling, with NO size-class gate.**  `maxWidth` resolves to
///    `min(ceiling, proposal)`, and the widest content an iPhone in this app ever proposes
///    is ~408pt (440pt Pro Max less 32pt of gutters).  Every ceiling here is above that, so
///    on iPhone the frame is not "a branch to the same value" — it never binds at all.
///  * **R2 — a structural branch on `horizontalSizeClass`**, for grid-vs-stack and title
///    mode.  Provably unreachable on iPhone: the phone is portrait-locked
///    (`project.yml` `UISupportedInterfaceOrientations`), so its horizontal size class is
///    always `.compact`.
///  * **R3 — measure the view's own width** (`onGeometryChange`), for anything that must
///    track a RESIZED Mac Catalyst window or content inside a sheet.  Catalyst reports
///    `.regular` at every window size and a sheet inherits the WINDOW's traits, so a size
///    class would simply lie in both cases.
enum AppLayout {
    /// How wide a scrolling content column may grow before it stops being a column.
    enum Column {
        /// Prose-led screens.
        case reading
        /// Card screens that still run a single column.
        case standard
        /// Only for a screen that actually places a multi-column grid inside.  A `.wide`
        /// column wrapped around a single stack of cards is the original defect, not a fix.
        case wide

        var maxWidth: CGFloat {
            switch self {
            case .reading: return 720
            case .standard: return 820
            case .wide: return 1120
            }
        }
    }

    /// Running prose.  ~78 characters at `.appSubheadline`.  The column cap alone cannot
    /// reach this: an 820pt column still leaves ~756pt of in-card text, ~105 characters.
    /// Structure and typography are two separate ceilings and one screen needs both.
    static let prose: CGFloat = 560
    /// A centred message block — empty states, consent copy.
    static let message: CGFloat = 420
    /// One action control that owns its row.
    static let action: CGFloat = 360
    /// A paired action row, capped as a ROW so the pair still splits it evenly.
    static let actionRow: CGFloat = 520
    /// Label + value pair.
    static let pair: CGFloat = 520
    /// A short entry row: field plus its button.
    static let entryRow: CGFloat = 420
    /// Chat bubble body, and the row carrying it (bubble + the opposite gutter).
    static let chatBubble: CGFloat = 620
    static let chatRow: CGFloat = chatBubble + 36

    /// Screen-edge gutter.  16 is the phone constant that ships today.  Catalyst is always
    /// `.regular`, so it takes 24 at every window size — intentional: it has a real title
    /// bar and no bezel-hugging convention.
    static func gutter(_ sizeClass: UserInterfaceSizeClass?) -> CGFloat {
        sizeClass == .regular ? 24 : 16
    }
}

// MARK: - Measure modifiers (R1)

extension View {
    /// Plain ceiling, leading-aligned.  Prose, label/value pairs, entry rows.
    func appMeasure(_ maxWidth: CGFloat, alignment: Alignment = .leading) -> some View {
        frame(maxWidth: maxWidth, alignment: alignment)
    }

    /// Ceiling, then re-expand so the capped block CENTRES in its slot.  Order matters:
    /// cap first, expand second.  Reversed, the background and hit region stay full width
    /// with a small block floating inside them.
    func appCenteredMeasure(_ maxWidth: CGFloat) -> some View {
        frame(maxWidth: maxWidth).frame(maxWidth: .infinity)
    }

    /// Running-prose ceiling.  Apply AFTER `.fixedSize(horizontal: false, vertical: true)`
    /// — the frame has to be outside it, or the text takes its unwrapped ideal width first
    /// and runs straight past the cap.
    func appProseMeasure(
        _ maxWidth: CGFloat = AppLayout.prose,
        alignment: Alignment = .leading
    ) -> some View {
        appMeasure(maxWidth, alignment: alignment)
    }

    /// A single call to action that owns its row.
    func appActionWidth() -> some View { appMeasure(AppLayout.action) }
}

// MARK: - Content column (R1 + R2 gutter)

private struct ContentColumn: ViewModifier {
    @Environment(\.horizontalSizeClass) private var sizeClass
    let column: AppLayout.Column

    func body(content: Content) -> some View {
        content
            .padding(.horizontal, AppLayout.gutter(sizeClass))
            .appCenteredMeasure(column.maxWidth)
    }
}

extension View {
    /// The one content column for scrolling screens: gutters plus a centred ceiling.
    func appContentColumn(_ column: AppLayout.Column = .standard) -> some View {
        modifier(ContentColumn(column: column))
    }
}

// MARK: - Screen title (R2)

/// One title rule for every tab ROOT.  iPad and Catalyst draw the iOS 26 `Tab` bar as a
/// floating top pill, and an `.inline` title under it leaves a 1180pt bar holding one
/// centred 17pt word the pill already says.  A large title collapses on scroll, so it
/// costs nothing after the first flick and gives the content column a left-anchored start.
///
/// Only for scroll-rooted tab roots.  A large title in a non-scrolling root never collapses
/// and permanently eats height — which is why Coach keeps `.inline`.
private struct ScreenTitle: ViewModifier {
    @Environment(\.horizontalSizeClass) private var sizeClass
    let title: LocalizedStringKey

    func body(content: Content) -> some View {
        content
            .navigationTitle(title)
            .navigationBarTitleDisplayMode(sizeClass == .regular ? .large : .inline)
    }
}

extension View {
    /// `LocalizedStringKey`, not `String`: routing through a `String` silently rebinds
    /// `navigationTitle` to the non-localizing `StringProtocol` overload.
    func appScreenTitle(_ title: LocalizedStringKey) -> some View {
        modifier(ScreenTitle(title: title))
    }
}

// MARK: - Width measurement (R3)

private struct MeasuredWidth: ViewModifier {
    @Binding var width: CGFloat
    func body(content: Content) -> some View {
        content.onGeometryChange(for: CGFloat.self) { $0.size.width } action: { width = $0 }
    }
}

extension View {
    /// Publishes this view's own width, for the two places a size class lies: a resized
    /// Catalyst window (always `.regular`) and content inside a sheet (which inherits the
    /// window's traits, not the sheet's).
    func appMeasuredWidth(_ width: Binding<CGFloat>) -> some View {
        modifier(MeasuredWidth(width: width))
    }
}

// MARK: - Metric grid (R3)

/// Column arithmetic for `MetricTile` grids.  Pure, so tests cover the breakpoints without
/// hosting SwiftUI — the same split `WrappingHStackLayout` uses further down this file.
enum AppMetricGridLayout {
    /// Narrowest a `MetricTile` gets before its 20pt value and 11pt detail start wrapping.
    static let minimumTileWidth: CGFloat = 170

    static func columnCount(itemCount: Int, availableWidth: CGFloat, isRegularWidth: Bool) -> Int {
        guard itemCount > 1 else { return 1 }
        // Compact is exactly what ships today: two columns at every phone width.  This
        // returns before any width math, which is what makes iPhone byte-identical.
        guard isRegularWidth else { return 2 }
        // First layout pass, width not yet measured: assume roomy, so a regular-width grid
        // does not visibly reflow 2 -> 4 on appear.
        guard availableWidth > 0 else { return min(itemCount, 4) }
        // A short row fits on one line whenever each tile still clears the minimum.
        if itemCount <= 4, availableWidth / CGFloat(itemCount) >= minimumTileWidth {
            return itemCount
        }
        return max(2, min(itemCount, Int(availableWidth / minimumTileWidth)))
    }
}

/// A `MetricTile` row that packs to the width it actually has.
struct AppMetricGrid<Content: View>: View {
    @Environment(\.horizontalSizeClass) private var sizeClass
    @State private var measuredWidth: CGFloat = 0

    private let itemCount: Int
    private let rowSpacing: CGFloat
    private let content: Content

    /// Column spacing is left to SwiftUI's default so a swapped call site is identical to
    /// the `GridItem(.flexible())` array it replaces, including on iPhone.
    init(itemCount: Int, rowSpacing: CGFloat = 10, @ViewBuilder content: () -> Content) {
        self.itemCount = itemCount
        self.rowSpacing = rowSpacing
        self.content = content()
    }

    private var columns: [GridItem] {
        Array(
            repeating: GridItem(.flexible()),
            count: AppMetricGridLayout.columnCount(
                itemCount: itemCount,
                availableWidth: measuredWidth,
                isRegularWidth: sizeClass == .regular
            )
        )
    }

    var body: some View {
        LazyVGrid(columns: columns, spacing: rowSpacing) { content }
            .appMeasuredWidth($measuredWidth)
    }
}

// MARK: - Card list grid (R2)

/// Chronological and queue card lists: the single lazy column unchanged on phone, 2-3 up at
/// regular width.  Compact stays a `LazyVStack` rather than a one-column `LazyVGrid` so row
/// realization, per-row `@State` (swipe offset, confirmation flags) and `scrollTo` targets
/// behave exactly as they do before this type exists.
struct AppCardGrid<Data: RandomAccessCollection, Content: View>: View
where Data.Element: Identifiable {
    @Environment(\.horizontalSizeClass) private var sizeClass

    let data: Data
    var minimum: CGFloat = 340
    var spacing: CGFloat = 10
    @ViewBuilder let content: (Data.Element) -> Content

    var body: some View {
        if sizeClass == .regular {
            LazyVGrid(
                columns: [GridItem(.adaptive(minimum: minimum), spacing: spacing, alignment: .top)],
                alignment: .leading,
                spacing: spacing
            ) {
                ForEach(data) { element in
                    // LazyVGrid does not stretch its cells; without this a short card beside
                    // a tall one leaves a ragged half-height row.
                    content(element)
                        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
                }
            }
        } else {
            LazyVStack(spacing: spacing) {
                ForEach(data) { content($0) }
            }
        }
    }
}

// MARK: - Two-column card split (R3)

/// Two columns of cards at wide widths, today's single column otherwise.
///
/// Measured, NOT `ViewThatFits`: every `AppCard` is `maxWidth: .infinity` and its body text
/// reports a full unwrapped ideal line, so card ideal widths are effectively unbounded and
/// `ViewThatFits` would always pick the first branch.  Both branches here occupy the full
/// proposed width, so the measurement never depends on the branch and cannot oscillate.
struct AppSplitColumns<Left: View, Right: View, Narrow: View>: View {
    var spacing: CGFloat = 14
    /// Below this, two columns would each be narrower than a comfortable card.
    var minTwoColumnWidth: CGFloat = 900
    @ViewBuilder var left: () -> Left
    @ViewBuilder var right: () -> Right
    /// Explicit narrow ordering — never `left()` then `right()`, which would silently
    /// reorder the iPhone reading order.
    @ViewBuilder var narrow: () -> Narrow

    @State private var width: CGFloat = 0

    var body: some View {
        Group {
            if width >= minTwoColumnWidth {
                HStack(alignment: .top, spacing: spacing) {
                    VStack(spacing: spacing) { left() }.frame(maxWidth: .infinity)
                    VStack(spacing: spacing) { right() }.frame(maxWidth: .infinity)
                }
            } else {
                VStack(spacing: spacing) { narrow() }
            }
        }
        .appMeasuredWidth($width)
    }
}

struct AppCard<Content: View>: View {
    private let content: Content
    private let padding: CGFloat

    init(padding: CGFloat = 16, @ViewBuilder content: () -> Content) {
        self.padding = padding
        self.content = content()
    }

    var body: some View {
        content
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(padding)
            .background(AppPalette.card, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
            .overlay {
                RoundedRectangle(cornerRadius: 18, style: .continuous)
                    .stroke(Color.primary.opacity(0.06), lineWidth: 1)
            }
    }
}

struct SectionHeading: View {
    let title: String
    let subtitle: String?

    init(_ title: String, subtitle: String? = nil) {
        self.title = title
        self.subtitle = subtitle
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(title)
                .font(.appTitle3.weight(.semibold))
            if let subtitle {
                Text(subtitle)
                    .font(.appCaption)
                    .foregroundStyle(.secondary)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityAddTraits(.isHeader)
    }
}

/// Where the optional metric detail sits relative to the large value.
enum MetricTileDetailPlacement: Sendable {
    /// Under the value (default).
    case below
    /// Same row, smaller type to the right of the value (e.g. Positions: "14" + "open holdings").
    case trailing
}

struct MetricTile: View {
    let title: String
    let value: String
    let detail: String?
    let detailPlacement: MetricTileDetailPlacement
    let tint: Color

    init(
        title: String,
        value: String,
        detail: String? = nil,
        detailPlacement: MetricTileDetailPlacement = .below,
        tint: Color = AppPalette.accent
    ) {
        self.title = title
        self.value = value
        self.detail = detail
        self.detailPlacement = detailPlacement
        self.tint = tint
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title)
                .font(.appCaption)
                .foregroundStyle(.secondary)
            if let detail, detailPlacement == .trailing {
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    Text(value)
                        .font(.appTitle3.weight(.semibold))
                        .foregroundStyle(tint)
                        .fixedSize(horizontal: true, vertical: true)
                    Text(detail)
                        .font(.appCaption2)
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                    Spacer(minLength: 0)
                }
            } else {
                Text(value)
                    .font(.appTitle3.weight(.semibold))
                    .foregroundStyle(tint)
                    .fixedSize(horizontal: false, vertical: true)
                if let detail {
                    Text(detail)
                        .font(.appCaption2)
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(12)
        .background(tint.opacity(0.09), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        .accessibilityElement(children: .combine)
    }
}

/// Company logo for a ticker (same open ticker-icons source as the web console).
/// Falls back to a 1–2 letter monogram when the image is missing or fails to load.
struct TickerLogo: View {
    let symbol: String
    var size: CGFloat = 22

    @State private var failed = false

    private var normalized: String {
        symbol.trimmingCharacters(in: .whitespacesAndNewlines)
            .replacingOccurrences(of: "$", with: "")
            .uppercased()
    }

    private var monogram: String {
        let base = normalized.split { $0 == "." || $0 == "-" || $0 == "_" }.first.map(String.init) ?? normalized
        return String(base.prefix(2))
    }

    private var logoURL: URL? {
        guard !normalized.isEmpty else { return nil }
        // Parity with src/lib/ticker-logos.ts TICKER_LOGO_BASE_URL
        return URL(string: "https://raw.githubusercontent.com/davidepalazzo/ticker-logos/main/ticker_icons/\(normalized).png")
    }

    var body: some View {
        Group {
            if failed || logoURL == nil {
                monogramView
            } else if let logoURL {
                AsyncImage(url: logoURL) { phase in
                    switch phase {
                    case .success(let image):
                        image
                            .resizable()
                            .scaledToFit()
                            .padding(2)
                    case .failure:
                        monogramView
                            .onAppear { failed = true }
                    case .empty:
                        ProgressView()
                            .controlSize(.mini)
                    @unknown default:
                        monogramView
                    }
                }
            }
        }
        .frame(width: size, height: size)
        .background(Color.primary.opacity(0.06), in: RoundedRectangle(cornerRadius: size * 0.22, style: .continuous))
        .accessibilityHidden(true)
        .onChange(of: normalized) { _, _ in failed = false }
    }

    private var monogramView: some View {
        Text(monogram)
            .font(.custom(AppFont.bold, size: max(9, size * 0.38)))
            .foregroundStyle(.secondary)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

/// Identifiable wrapper for `.sheet(item:)` presentation of `SymbolInfoSheet` from any list row.
/// Each screen that shows symbols (Activity, Markets) owns one `@State private var
/// presentedSymbol: PresentedSymbol?` and threads it down as a `Binding` to `SymbolTapButton`.
struct PresentedSymbol: Identifiable, Equatable {
    let symbol: String
    var id: String { symbol }
}

/// Sheet payload for a company quote, a fill, or a position. Fill/position cards
/// present `.fill` / `.position` so tapping anywhere on the card opens trade or
/// position facts plus the same company stats the logo used to open alone.
enum PresentedMarketItem: Identifiable, Equatable {
    case company(String)
    case fill(FillEvent)
    case position(Position)

    var id: String {
        switch self {
        case .company(let symbol): return "company:\(symbol)"
        case .fill(let fill): return "fill:\(fill.id)"
        case .position(let position): return "position:\(position.symbol)"
        }
    }

    var symbol: String {
        switch self {
        case .company(let symbol): return symbol
        case .fill(let fill): return fill.symbol
        case .position(let position): return position.symbol
        }
    }

    var fill: FillEvent? {
        if case .fill(let fill) = self { return fill }
        return nil
    }

    var position: Position? {
        if case .position(let position) = self { return position }
        return nil
    }
}

/// Tappable ticker logo + symbol text that opens `SymbolInfoSheet` for `symbol` — the mobile
/// counterpart to the web console's `SymbolButton` (app/console/ui/symbol-drilldown.tsx). Wrap
/// wherever a row shows a symbol; pass `action` to set the screen's `presentedSymbol` state.
/// A real button (not a bare tap gesture), so it carries button accessibility traits for free —
/// only the accessible label needs to be supplied here.
struct SymbolTapButton: View {
    let symbol: String
    var logoSize: CGFloat = 26
    var font: Font = .headline
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 8) {
                TickerLogo(symbol: symbol, size: logoSize)
                Text(symbol)
                    .font(font)
            }
        }
        .buttonStyle(.plain)
        .accessibilityLabel("\(symbol) company info")
    }
}

struct StatusPill: View {
    let text: String
    let color: Color
    let systemImage: String?

    init(_ text: String, color: Color, systemImage: String? = nil) {
        self.text = text
        self.color = color
        self.systemImage = systemImage
    }

    var body: some View {
        HStack(spacing: 5) {
            if let systemImage {
                Image(systemName: systemImage)
            }
            Text(text)
        }
        .font(.appCaption.weight(.semibold))
        .foregroundStyle(color)
        .padding(.horizontal, 9)
        .padding(.vertical, 5)
        .background(color.opacity(0.12), in: Capsule())
    }
}

struct EmptyStateCard: View {
    let title: String
    let message: String
    let systemImage: String

    var body: some View {
        AppCard {
            VStack(spacing: 10) {
                Image(systemName: systemImage)
                    .font(.appTitle2)
                    .foregroundStyle(.secondary)
                Text(title)
                    .font(.appHeadline)
                Text(message)
                    .font(.appSubheadline)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
            }
            // Centred message block, not a full-card stretch.  "No proposals waiting" is
            // the NORMAL state of the Proposals tab, and centred text spread across a
            // 1116pt card reads as a rendering fault rather than a calm empty state.
            // 420 is never reached inside an iPhone card (~326pt of interior).
            .appCenteredMeasure(AppLayout.message)
            .padding(.vertical, 8)
        }
    }
}

struct InlineErrorBanner: View {
    let message: String
    let retry: () -> Void
    let dismiss: () -> Void

    var body: some View {
        AppCard {
            HStack(alignment: .top, spacing: 12) {
                Image(systemName: "exclamationmark.triangle.fill")
                    .foregroundStyle(AppPalette.warning)
                VStack(alignment: .leading, spacing: 8) {
                    Text(message)
                        .font(.appSubheadline)
                        .fixedSize(horizontal: false, vertical: true)
                    HStack {
                        Button("Retry", action: retry)
                            .buttonStyle(.bordered)
                        Button("Dismiss", action: dismiss)
                            .buttonStyle(.plain)
                            .foregroundStyle(.secondary)
                    }
                }
                // Ceiling on the message column, not on the row: a long error wraps at a
                // readable measure instead of running a 1084pt line.  The Spacer below is
                // what keeps this block leading-aligned under the glyph — do not remove it
                // in favour of the frame; they do different jobs.
                .appMeasure(AppLayout.prose)
                Spacer(minLength: 0)
            }
        }
    }
}

/// Presents `MobileStore` operation feedback as alerts anchored to the presenting view.
/// Snapshot refresh no longer clears these messages, so guardrail edits and queued commands
/// can surface failures after `load()` completes.
struct StoreTransientAlerts: ViewModifier {
    @EnvironmentObject private var store: MobileStore

    func body(content: Content) -> some View {
        content
            .alert(
                "Something Went Wrong",
                isPresented: Binding(
                    get: { store.error != nil },
                    set: { if !$0 { store.dismissError() } }
                )
            ) {
                Button("OK") { store.dismissError() }
            } message: {
                Text(store.error ?? "")
            }
            .alert(
                "Saved",
                isPresented: Binding(
                    get: { store.successMessage != nil },
                    set: { if !$0 { store.dismissSuccess() } }
                )
            ) {
                Button("OK") { store.dismissSuccess() }
            } message: {
                Text(store.successMessage ?? "")
            }
    }
}

extension View {
    func storeTransientAlerts() -> some View {
        modifier(StoreTransientAlerts())
    }
}

struct SnapshotScaffold<Content: View>: View {
    @EnvironmentObject private var store: MobileStore
    /// Fixed once, so the 30s refresh schedule below counts from first appearance.
    @State private var scheduleAnchor = Date()

    let content: (MobileSnapshot) -> Content
    /// Optional `.id(_:)` value inside `content` to scroll into view — used by deep links that
    /// point at one row (a specific proposal).  Screens that never take a link pass nothing.
    private let scrollTarget: String?
    /// Scan (and any other screen with its own Retry) must not stack a second
    /// workspace banner that reloads the snapshot instead of this screen's data.
    private let hidesWorkspaceError: Bool
    /// Content column for this screen.  Defaulted, so every adopter compiles untouched; a
    /// screen only moves to `.wide` in the same change that puts a real grid inside it.
    private let column: AppLayout.Column

    init(
        scrollTarget: String? = nil,
        hidesWorkspaceError: Bool = false,
        column: AppLayout.Column = .standard,
        @ViewBuilder content: @escaping (MobileSnapshot) -> Content
    ) {
        self.scrollTarget = scrollTarget
        self.hidesWorkspaceError = hidesWorkspaceError
        self.column = column
        self.content = content
    }

    var body: some View {
        ZStack {
            AppPalette.background.ignoresSafeArea()

            ScrollViewReader { proxy in
                ScrollView {
                    // `from: scheduleAnchor`, not `from: .now`: `.now` is re-read every time
                    // this body is re-evaluated, which inside a ScrollView is constantly, and
                    // each rebuild pushes the next entry a fresh 30s into the future — so the
                    // banner's "updated N seconds ago" could sit frozen on whatever it first
                    // rendered.  Same defect the login wordmark had (see CandleWordmarkView);
                    // a `@State` anchor is what makes the schedule actually periodic.
                    TimelineView(.periodic(from: scheduleAnchor, by: 30)) { context in
                        LazyVStack(spacing: 14) {
                            if let snapshot = store.snapshot {
                                SnapshotStatusBanner(snapshot: snapshot, now: context.date)
                                content(snapshot)
                            }
                        }
                        // THE keystone: one content column, inherited by every screen that
                        // renders through this scaffold rather than re-derived nine times.
                        .appContentColumn(column)
                        .padding(.vertical, 12)
                    }
                }
                .refreshable {
                    await store.load()
                }
                .onAppear { scroll(with: proxy) }
                .onChange(of: scrollTarget) { _, _ in scroll(with: proxy) }
                // The target row may only exist after the next snapshot lands.
                .onChange(of: store.lastUpdatedAt) { _, _ in scroll(with: proxy) }
            }

            if store.snapshot == nil {
                InitialSnapshotState()
            }
        }
    }

    private func refresh() {
        Task { await store.load() }
    }

    private func scroll(with proxy: ScrollViewProxy) {
        guard let scrollTarget else { return }
        withAnimation(.easeInOut(duration: 0.25)) {
            proxy.scrollTo(scrollTarget, anchor: .top)
        }
    }
}

private struct InitialSnapshotState: View {
    @EnvironmentObject private var store: MobileStore

    var body: some View {
        VStack(spacing: 16) {
            if store.isRefreshing || store.isInitialLoading {
                ProgressView()
                    .controlSize(.large)
                Text("Loading your trading workspace…")
                    .font(.appSubheadline)
                    .foregroundStyle(.secondary)
            } else {
                Image(systemName: "wifi.exclamationmark")
                    .font(.appLargeTitle)
                    .foregroundStyle(AppPalette.warning)
                Text("Couldn’t load your workspace")
                    .font(.appHeadline)
                Text(store.error ?? "Check your connection and try again.")
                    .font(.appSubheadline)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                Button("Try Again") {
                    Task { await store.load() }
                }
                .buttonStyle(.borderedProminent)
            }
        }
        .padding(28)
    }
}

private struct SnapshotStatusBanner: View {
    @EnvironmentObject private var store: MobileStore

    let snapshot: MobileSnapshot
    let now: Date

    var body: some View {
        let stale = store.isSnapshotStale(at: now)
        HStack(spacing: 8) {
            StatusPill(
                stale ? "Stale" : "Updated",
                color: stale ? AppPalette.warning : AppPalette.positive,
                systemImage: stale ? "clock.badge.exclamationmark" : "checkmark.circle.fill"
            )
            Text("\(AppFormat.relative(store.lastUpdatedAt))")
                .font(.appCaption)
                .foregroundStyle(.secondary)
            // Bounded, not greedy.  Even inside an 820pt column a plain `Spacer()` throws
            // "Updated · 2 minutes ago" and "Market Closed" ~780pt apart, and the row stops
            // reading as one status line and starts reading as two unrelated widgets.
            // On iPhone it still squeezes toward 12pt exactly as today — 420 is never
            // reached at phone widths.
            Spacer(minLength: 12)
                .frame(maxWidth: 420)
            if store.isRefreshing {
                ProgressView()
                    .controlSize(.small)
                    .accessibilityLabel("Refreshing")
            } else {
                Image(systemName: store.isStreamConnected ? "dot.radiowaves.left.and.right" : "arrow.triangle.2.circlepath")
                    .foregroundStyle(store.isStreamConnected ? AppPalette.positive : .secondary)
                    .accessibilityLabel(store.isStreamConnected ? "Live" : "Updating")
            }
            // Keep the circlepath / radio glyph; label is "Market Closed" etc. on every tab.
            Text(AppFormat.marketSessionBannerLabel(snapshot.marketSession))
                .font(.appCaption.weight(.medium))
                .foregroundStyle(.secondary)
        }
        .padding(.horizontal, 4)
    }
}

/// Presentation for the shared run-state vocabulary (tones mirror console deriveStateInfo:
/// running=pos, paused=muted, exit-only/winding-down=warn, stopped=neg).
extension RunStateWord {
    var pillColor: Color {
        switch self {
        case .running: return AppPalette.positive
        case .pausedMarketClosed: return .secondary
        case .exitOnly, .windingDown: return AppPalette.warning
        case .stopped: return AppPalette.negative
        }
    }

    var pillSystemImage: String {
        switch self {
        case .running: return "bolt.fill"
        case .pausedMarketClosed: return "moon.zzz.fill"
        case .exitOnly, .windingDown: return "arrow.down.right.circle"
        case .stopped: return "pause.fill"
        }
    }
}

/// Trailing swipe-reveal action for card rows inside ScrollView stacks (SwiftUI's
/// `.swipeActions` is List-only).  Swiping left reveals one action button; tapping it fires
/// `perform` and closes.  The gesture needs a mostly-horizontal drag, so vertical scrolling
/// keeps working.  This adds a faster path to EXISTING actions only — same handlers, same
/// ceremony — never a new kind of confirmation.
struct SwipeRevealAction: ViewModifier {
    let title: String
    let systemImage: String
    let tint: Color
    let isEnabled: Bool
    let perform: () -> Void

    @State private var offset: CGFloat = 0
    @State private var isOpen = false

    private let actionWidth: CGFloat = 88

    func body(content: Content) -> some View {
        content
            .accessibilityAction(named: Text(title)) {
                guard isEnabled else { return }
                perform()
            }
            .accessibilityHint("Swipe left to \(title.lowercased()), or use this action.")
            .offset(x: offset)
            .background(alignment: .trailing) {
                if offset < 0 {
                    Button(action: fire) {
                        VStack(spacing: 5) {
                            Image(systemName: systemImage)
                                .font(.appBody.weight(.semibold))
                            Text(title)
                                .font(.appCaption.weight(.semibold))
                        }
                        .foregroundStyle(.white)
                        .frame(width: actionWidth)
                        .frame(maxHeight: .infinity)
                        .background(tint, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel(title)
                }
            }
            // Plain .gesture (not highPriority): the ScrollView keeps winning vertical pans.
            .gesture(dragGesture, including: isEnabled ? .all : .subviews)
            .onTapGesture {
                if isOpen { close() }
            }
            .animation(.snappy(duration: 0.22), value: offset)
    }

    private var dragGesture: some Gesture {
        DragGesture(minimumDistance: 24, coordinateSpace: .local)
            .onChanged { value in
                guard isEnabled else { return }
                // Mostly-horizontal drags only, so the scroll view keeps vertical swipes.
                guard abs(value.translation.width) > abs(value.translation.height) else { return }
                let base = isOpen ? -actionWidth : 0
                offset = min(0, max(-actionWidth - 26, base + value.translation.width))
            }
            .onEnded { value in
                guard isEnabled else { return }
                if offset < -actionWidth * 0.55 {
                    offset = -actionWidth
                    isOpen = true
                } else {
                    close()
                }
            }
    }

    private func fire() {
        close()
        perform()
    }

    private func close() {
        offset = 0
        isOpen = false
    }
}

extension View {
    /// See `SwipeRevealAction`.
    func swipeRevealAction(
        title: String,
        systemImage: String,
        tint: Color,
        isEnabled: Bool = true,
        perform: @escaping () -> Void
    ) -> some View {
        modifier(SwipeRevealAction(
            title: title,
            systemImage: systemImage,
            tint: tint,
            isEnabled: isEnabled,
            perform: perform
        ))
    }
}

/// Horizontal wrap that sizes each child to its intrinsic width.
/// Used by watchlist chips so a logo + ticker + remove control is never
/// forced into a too-narrow equal-width grid cell (which wrapped `SPCX`
/// onto two lines).  Layout math is in `WrappingHStackLayout` so XCTest
/// can cover wrap vs. single-line without hosting SwiftUI.
struct WrappingHStack: Layout {
    var spacing: CGFloat = 8
    var lineSpacing: CGFloat = 8

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let sizes = subviews.map { $0.sizeThatFits(.unspecified) }
        return WrappingHStackLayout.place(
            widths: sizes.map(\.width),
            heights: sizes.map(\.height),
            containerWidth: proposal.width ?? .infinity,
            spacing: spacing,
            lineSpacing: lineSpacing
        ).size
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        let sizes = subviews.map { $0.sizeThatFits(.unspecified) }
        let result = WrappingHStackLayout.place(
            widths: sizes.map(\.width),
            heights: sizes.map(\.height),
            containerWidth: bounds.width,
            spacing: spacing,
            lineSpacing: lineSpacing
        )
        for index in subviews.indices {
            subviews[index].place(
                at: CGPoint(
                    x: bounds.minX + result.origins[index].x,
                    y: bounds.minY + result.origins[index].y
                ),
                proposal: ProposedViewSize(sizes[index])
            )
        }
    }
}

enum WrappingHStackLayout {
    struct Result: Equatable {
        var size: CGSize
        var origins: [CGPoint]
    }

    static func place(
        widths: [CGFloat],
        heights: [CGFloat],
        containerWidth: CGFloat,
        spacing: CGFloat,
        lineSpacing: CGFloat
    ) -> Result {
        precondition(widths.count == heights.count)
        guard !widths.isEmpty else {
            return Result(size: .zero, origins: [])
        }

        var x: CGFloat = 0
        var y: CGFloat = 0
        var lineHeight: CGFloat = 0
        var maxX: CGFloat = 0
        var origins: [CGPoint] = []
        origins.reserveCapacity(widths.count)

        for index in widths.indices {
            let width = widths[index]
            let height = heights[index]
            if x > 0 && x + width > containerWidth {
                y += lineHeight + lineSpacing
                x = 0
                lineHeight = 0
            }
            origins.append(CGPoint(x: x, y: y))
            x += width
            maxX = max(maxX, x)
            x += spacing
            lineHeight = max(lineHeight, height)
        }

        return Result(
            size: CGSize(width: maxX, height: y + lineHeight),
            origins: origins
        )
    }
}

struct CommandButton: View {
    let title: String
    let systemImage: String
    let isBusy: Bool
    let isDisabled: Bool
    let role: ButtonRole?
    let prominent: Bool
    let action: () -> Void

    init(
        _ title: String,
        systemImage: String,
        isBusy: Bool,
        isDisabled: Bool = false,
        role: ButtonRole? = nil,
        prominent: Bool = false,
        action: @escaping () -> Void
    ) {
        self.title = title
        self.systemImage = systemImage
        self.isBusy = isBusy
        self.isDisabled = isDisabled
        self.role = role
        self.prominent = prominent
        self.action = action
    }

    @ViewBuilder
    var body: some View {
        if prominent {
            button
                .buttonStyle(.borderedProminent)
        } else {
            button
                .buttonStyle(.bordered)
        }
    }

    private var button: some View {
        Button(role: role, action: action) {
            HStack(spacing: 7) {
                if isBusy {
                    ProgressView()
                        .controlSize(.small)
                } else {
                    Image(systemName: systemImage)
                }
                Text(title)
                    .fontWeight(.semibold)
            }
            .frame(maxWidth: .infinity)
            .frame(minHeight: 44)
        }
        .disabled(isBusy || isDisabled)
        // NO width cap here, deliberately.  ProposalsView puts Reject and Review & Approve
        // in a `ViewThatFits` HStack that depends on both buttons filling their share
        // equally; a per-button ceiling would break the 50/50 split AND change which
        // ViewThatFits branch is chosen.  Solitary CTAs cap at their call site with
        // `.appActionWidth()` instead.
    }
}

// MARK: - Justified paragraph

/// A paragraph set with `NSTextAlignment.justified`: every line but the last stretches to
/// the same right edge, and the last line is left alone (no stretched final row).
///
/// SwiftUI has no justified case — `TextAlignment` is leading/center/trailing only, and
/// `Text` ignores an `NSParagraphStyle` carried on an `AttributedString` — so this is the
/// one place the app drops to UIKit for type.  Used for the login legal block, where a
/// ragged right edge under three equal-width buttons reads as sloppy.
///
/// Sizes itself against the width SwiftUI proposes, scales with Dynamic Type (explicitly,
/// via `UIFontMetrics` — `adjustsFontForContentSizeCategory` on top of an already-scaled
/// font double-scales), and hands VoiceOver the plain string.
struct JustifiedText: UIViewRepresentable {
    private let text: String
    private let font: UIFont
    private let textStyle: UIFont.TextStyle
    private let color: UIColor
    private let lineSpacing: CGFloat

    /// Reading the environment here is what makes SwiftUI re-run `sizeThatFits` when the
    /// user changes text size; the label alone would resize without the layout following.
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    init(
        _ text: String,
        font: UIFont = AppFont.uiFont(12),
        textStyle: UIFont.TextStyle = .caption1,
        color: UIColor = .secondaryLabel,
        lineSpacing: CGFloat = 1.5
    ) {
        self.text = text
        self.font = font
        self.textStyle = textStyle
        self.color = color
        self.lineSpacing = lineSpacing
    }

    func makeUIView(context: Context) -> UILabel {
        let label = UILabel()
        label.numberOfLines = 0
        label.lineBreakMode = .byWordWrapping
        // SwiftUI owns the width; the label must not argue for a wider intrinsic one.
        label.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        label.setContentHuggingPriority(.required, for: .vertical)
        return label
    }

    func updateUIView(_ label: UILabel, context: Context) {
        label.attributedText = attributed()
    }

    func sizeThatFits(_ proposal: ProposedViewSize, uiView label: UILabel, context: Context) -> CGSize? {
        guard let width = proposal.width, width > 0, width < .greatestFiniteMagnitude else {
            return nil
        }
        // Measure off a throwaway label rather than the live one: `updateUIView` has not
        // necessarily run for this pass yet, so the on-screen label can still be holding the
        // previous string and would measure the wrong height.
        let probe = UILabel()
        probe.numberOfLines = 0
        probe.lineBreakMode = .byWordWrapping
        probe.attributedText = attributed()
        let fitted = probe.sizeThatFits(CGSize(width: width, height: .greatestFiniteMagnitude))
        return CGSize(width: width, height: ceil(fitted.height))
    }

    private func attributed() -> NSAttributedString {
        let paragraph = NSMutableParagraphStyle()
        paragraph.alignment = .justified
        paragraph.lineBreakMode = .byWordWrapping
        paragraph.lineSpacing = lineSpacing
        return NSAttributedString(
            string: text,
            attributes: [
                .font: UIFontMetrics(forTextStyle: textStyle).scaledFont(for: font),
                .foregroundColor: color,
                .paragraphStyle: paragraph
            ]
        )
    }
}
