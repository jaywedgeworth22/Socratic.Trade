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
        "strategy.close_only": "Close Only",
        "strategy.liquidating": "Wind Down",
        "proposal.approve": "Approve Proposal",
        "proposal.reject": "Reject Proposal",
        "account.activate": "Switch Account",
        "watchlist.add": "Add to Watchlist",
        "watchlist.remove": "Remove from Watchlist",
        "alert.create": "Create Alert",
        "alert.delete": "Delete Alert"
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

    /// Authority glossary: never show raw propose/decide — Ask-First / Autopilot (console parity).
    /// Title-ish for chips/status next to headings; settings *values* use `strategyAuthorityValue`.
    static func strategyAuthorityLabel(_ value: String?) -> String {
        switch value?.lowercased() {
        case "propose": return "Ask-First"
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

struct AppCard<Content: View>: View {
    private let content: Content

    init(@ViewBuilder content: () -> Content) {
        self.content = content()
    }

    var body: some View {
        content
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(16)
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
                .font(.title3.weight(.semibold))
            if let subtitle {
                Text(subtitle)
                    .font(.caption)
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
                .font(.caption)
                .foregroundStyle(.secondary)
            if let detail, detailPlacement == .trailing {
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    Text(value)
                        .font(.title3.weight(.semibold))
                        .foregroundStyle(tint)
                        .fixedSize(horizontal: true, vertical: true)
                    Text(detail)
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                    Spacer(minLength: 0)
                }
            } else {
                Text(value)
                    .font(.title3.weight(.semibold))
                    .foregroundStyle(tint)
                    .fixedSize(horizontal: false, vertical: true)
                if let detail {
                    Text(detail)
                        .font(.caption2)
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
            .font(.system(size: max(9, size * 0.38), weight: .semibold, design: .rounded))
            .foregroundStyle(.secondary)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
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
        .font(.caption.weight(.semibold))
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
                    .font(.title2)
                    .foregroundStyle(.secondary)
                Text(title)
                    .font(.headline)
                Text(message)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
            }
            .frame(maxWidth: .infinity)
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
                        .font(.subheadline)
                        .fixedSize(horizontal: false, vertical: true)
                    HStack {
                        Button("Retry", action: retry)
                            .buttonStyle(.bordered)
                        Button("Dismiss", action: dismiss)
                            .buttonStyle(.plain)
                            .foregroundStyle(.secondary)
                    }
                }
                Spacer(minLength: 0)
            }
        }
    }
}

struct SnapshotScaffold<Content: View>: View {
    @EnvironmentObject private var store: MobileStore

    let content: (MobileSnapshot) -> Content

    init(@ViewBuilder content: @escaping (MobileSnapshot) -> Content) {
        self.content = content
    }

    var body: some View {
        ZStack {
            AppPalette.background.ignoresSafeArea()

            ScrollView {
                TimelineView(.periodic(from: .now, by: 30)) { context in
                    LazyVStack(spacing: 14) {
                        if let snapshot = store.snapshot {
                            SnapshotStatusBanner(snapshot: snapshot, now: context.date)
                            if let error = store.error {
                                InlineErrorBanner(
                                    message: error,
                                    retry: refresh,
                                    dismiss: store.dismissError
                                )
                            }
                            content(snapshot)
                        }
                    }
                    .padding(.horizontal, 16)
                    .padding(.vertical, 12)
                }
            }
            .refreshable {
                await store.load()
            }

            if store.snapshot == nil {
                InitialSnapshotState()
            }
        }
    }

    private func refresh() {
        Task { await store.load() }
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
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            } else {
                Image(systemName: "wifi.exclamationmark")
                    .font(.largeTitle)
                    .foregroundStyle(AppPalette.warning)
                Text("Couldn’t load your workspace")
                    .font(.headline)
                Text(store.error ?? "Check your connection and try again.")
                    .font(.subheadline)
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
                .font(.caption)
                .foregroundStyle(.secondary)
            Spacer()
            if store.isRefreshing {
                ProgressView()
                    .controlSize(.small)
                    .accessibilityLabel("Refreshing")
            } else {
                Image(systemName: store.isStreamConnected ? "dot.radiowaves.left.and.right" : "arrow.triangle.2.circlepath")
                    .foregroundStyle(store.isStreamConnected ? AppPalette.positive : .secondary)
                    .accessibilityLabel(store.isStreamConnected ? "Stream connected" : "Reconnecting")
            }
            // Keep the circlepath / radio glyph; label is "Market Closed" etc. on every tab.
            Text(AppFormat.marketSessionBannerLabel(snapshot.marketSession))
                .font(.caption.weight(.medium))
                .foregroundStyle(.secondary)
        }
        .padding(.horizontal, 4)
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
    }
}
