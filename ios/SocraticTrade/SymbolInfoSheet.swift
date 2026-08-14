import Foundation
import SwiftUI

/// Company / fill / position detail sheet — the mobile counterpart to the web console's
/// symbol drilldown drawer (app/console/ui/symbol-drilldown.tsx). Presented from any row
/// that shows a symbol via `PresentedMarketItem` (fill and position cards tap anywhere;
/// logo-only rows still present `.company`). Fetches the same on-demand `/api/quote`
/// cascade the web drawer uses; every field degrades honestly to "—"/"n/a" instead of
/// being fabricated. Backend remains authoritative — this reads only.
struct SymbolInfoSheet: View {
    @EnvironmentObject private var store: MobileStore
    @Environment(\.dismiss) private var dismiss

    let item: PresentedMarketItem

    init(symbol: String) {
        self.item = .company(symbol)
    }

    init(item: PresentedMarketItem) {
        self.item = item
    }

    private var symbol: String { item.symbol }

    @State private var loadState: LoadState = .loading

    private enum LoadState {
        case loading
        case loaded(SymbolQuoteInfo)
        case failed(String)
    }

    private var normalized: String {
        symbol.trimmingCharacters(in: .whitespacesAndNewlines).uppercased()
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    if let fill = item.fill {
                        FillDetailCard(fill: fill)
                    }
                    if let position = item.position {
                        PositionDetailCard(position: position)
                    }
                    switch loadState {
                    case .loading:
                        loadingState
                    case .failed(let message):
                        InlineErrorBanner(
                            message: message,
                            retry: { Task { await load() } },
                            dismiss: { dismiss() }
                        )
                    case .loaded(let info):
                        SymbolInfoHeaderCard(symbol: normalized, info: info)
                        SymbolInfoStatsCard(info: info)
                        SymbolInfoAnalystCard(info: info)
                        if let asOfLine {
                            Text(asOfLine)
                                .font(.appCaption2)
                                .foregroundStyle(.secondary)
                        }
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, 16)
                .padding(.vertical, 14)
            }
            .background(AppPalette.background.ignoresSafeArea())
            .navigationTitle(normalized)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Done") { dismiss() }
                }
            }
        }
        .task { await load() }
    }

    private var loadingState: some View {
        VStack(spacing: 12) {
            ProgressView()
                .controlSize(.large)
            Text("Loading \(normalized)…")
                .font(.appSubheadline)
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity)
        .padding(.top, 48)
    }

    private var asOfLine: String? {
        guard case .loaded(let info) = loadState, info.asOf != nil else { return nil }
        return "Quote data from a live fetch (\(AppFormat.dateTimeCentral(info.asOf)))."
    }

    private func load() async {
        loadState = .loading
        do {
            let info = try await store.fetchSymbolQuote(normalized)
            loadState = .loaded(info)
        } catch is CancellationError {
            // Sheet dismissed mid-fetch — nothing left to show.
        } catch {
            // MobileAPIClient's URLSession call wraps a mid-fetch cancellation as
            // MobileAPIError.network(URLError(.cancelled)) rather than rethrowing
            // CancellationError, so a sheet dismissed while the fetch is in flight would
            // otherwise flash a real error state for a fetch nobody is waiting on anymore.
            // Treat that case — and any lingering Task cancellation — as the same silent
            // no-op as the CancellationError branch above.
            guard !Task.isCancelled, !isCancelledNetworkError(error) else { return }
            loadState = .failed(error.localizedDescription)
        }
    }

    private func isCancelledNetworkError(_ error: Error) -> Bool {
        if let urlError = error as? URLError {
            return urlError.code == .cancelled
        }
        if case MobileAPIError.network(let underlying) = error, let urlError = underlying as? URLError {
            return urlError.code == .cancelled
        }
        return false
    }
}

private struct FillDetailCard: View {
    let fill: FillEvent

    private var sideColor: Color {
        fill.side == "buy" || fill.side == "cover" ? AppPalette.positive : AppPalette.negative
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            SectionHeading("Fill")
            AppCard {
                VStack(alignment: .leading, spacing: 10) {
                    HStack {
                        StatusPill(fill.side.uppercased(), color: sideColor)
                        Spacer()
                        Text(AppFormat.dateTime(fill.filledAt))
                            .font(.appCaption)
                            .foregroundStyle(.secondary)
                    }
                    LabeledContent("Quantity", value: AppFormat.number(fill.quantity))
                    LabeledContent("Price", value: AppFormat.money(fill.price))
                    LabeledContent("Notional", value: AppFormat.money(fill.notional))
                    if !fill.status.isEmpty {
                        LabeledContent("Status", value: fill.status.capitalized)
                    }
                }
            }
        }
    }
}

private struct PositionDetailCard: View {
    let position: Position

    private var unrealized: Double? {
        guard let averageCost = position.averageCost else { return nil }
        return position.marketValue - position.quantity * averageCost
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            SectionHeading("Position")
            AppCard {
                VStack(alignment: .leading, spacing: 10) {
                    if position.quantity < 0 {
                        StatusPill("Short", color: AppPalette.negative)
                    }
                    LabeledContent("Quantity", value: "\(AppFormat.number(abs(position.quantity))) shares")
                    LabeledContent("Market Value", value: AppFormat.money(position.marketValue))
                    LabeledContent("Average Cost", value: AppFormat.money(position.averageCost))
                    if let unrealized {
                        LabeledContent("Open P&L", value: AppFormat.money(unrealized))
                    }
                    if let sector = position.sector, !sector.isEmpty {
                        LabeledContent("Sector", value: sector)
                    }
                    if let industry = position.industry, !industry.isEmpty, industry != position.sector {
                        LabeledContent("Industry", value: industry)
                    }
                }
            }
        }
    }
}

private struct SymbolInfoHeaderCard: View {
    let symbol: String
    let info: SymbolQuoteInfo

    var body: some View {
        AppCard {
            VStack(alignment: .leading, spacing: 10) {
                HStack(spacing: 10) {
                    TickerLogo(symbol: symbol, size: 40)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(symbol)
                            .font(.appTitle3.weight(.bold))
                        if let companyName = info.companyName, !companyName.isEmpty {
                            Text(companyName)
                                .font(.appSubheadline)
                                .foregroundStyle(.secondary)
                        }
                    }
                }

                HStack(alignment: .firstTextBaseline, spacing: 10) {
                    Text(AppFormat.money(info.price))
                        .font(.appLargeTitle.weight(.semibold))
                    if let changePct = info.intradayChangePct {
                        Text("\(AppFormat.percent(changePct, signed: true)) today")
                            .font(.appSubheadline.weight(.semibold))
                            .foregroundStyle(changePct >= 0 ? AppPalette.positive : AppPalette.negative)
                    }
                }

                if let sector = info.sector, !sector.isEmpty {
                    Text(industryLine(sector: sector, industry: info.industry))
                        .font(.appCaption)
                        .foregroundStyle(.secondary)
                }
            }
        }
    }

    private func industryLine(sector: String, industry: String?) -> String {
        guard let industry, !industry.isEmpty, industry != sector else { return sector }
        return "\(sector) · \(industry)"
    }
}

private struct SymbolInfoStatsCard: View {
    let info: SymbolQuoteInfo

    private var columns: [GridItem] { [GridItem(.flexible()), GridItem(.flexible())] }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            SectionHeading("Key Stats")
            LazyVGrid(columns: columns, spacing: 10) {
                MetricTile(title: "Volume", value: AppFormat.number(info.volume))
                MetricTile(title: "P/E Ratio", value: AppFormat.peRatioDisplay(peRatio: info.peRatio, eps: info.eps))
                MetricTile(title: "EPS", value: AppFormat.money(info.eps))
                MetricTile(title: "Dividend Yield", value: AppFormat.percent(info.dividendYield))
                MetricTile(title: "Beta", value: AppFormat.number(info.beta))
                MetricTile(title: "52W High", value: AppFormat.money(info.fiftyTwoWeekHigh))
                MetricTile(title: "52W Low", value: AppFormat.money(info.fiftyTwoWeekLow))
            }
        }
    }
}

/// Only rendered when at least one field is present — an empty analyst/earnings card would
/// assert a negative ("no data") the on-demand fetch can't actually confirm.
private struct SymbolInfoAnalystCard: View {
    let info: SymbolQuoteInfo

    private var hasData: Bool {
        info.analystRating != nil || info.analystScore != nil
            || info.targetMean != nil || info.targetHigh != nil || info.targetLow != nil
            || info.daysToEarnings != nil
    }

    var body: some View {
        if hasData {
            AppCard {
                VStack(alignment: .leading, spacing: 10) {
                    SectionHeading("Analyst & Earnings")
                    if info.analystRating != nil || info.analystScore != nil {
                        LabeledContent("Rating", value: analystLine)
                    }
                    if info.targetMean != nil || info.targetLow != nil || info.targetHigh != nil {
                        LabeledContent("Price Target", value: targetLine)
                    }
                    if let daysToEarnings = info.daysToEarnings {
                        LabeledContent("Next Earnings", value: "In \(Int(daysToEarnings.rounded())) trading days")
                    }
                }
            }
        }
    }

    private var analystLine: String {
        let rating = info.analystRating?.isEmpty == false ? info.analystRating : nil
        let score = info.analystScore.map { "\(Int($0.rounded()))/100" }
        switch (rating, score) {
        case let (rating?, score?): return "\(rating) (\(score))"
        case let (rating?, nil): return rating
        case let (nil, score?): return score
        case (nil, nil): return "—"
        }
    }

    private var targetLine: String {
        if let mean = info.targetMean {
            if let low = info.targetLow, let high = info.targetHigh {
                return "\(AppFormat.money(mean)) (\(AppFormat.money(low))–\(AppFormat.money(high)))"
            }
            return AppFormat.money(mean)
        }
        if let low = info.targetLow, let high = info.targetHigh {
            return "\(AppFormat.money(low))–\(AppFormat.money(high))"
        }
        return "—"
    }
}
