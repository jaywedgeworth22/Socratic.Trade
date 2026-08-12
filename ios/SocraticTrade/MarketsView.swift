import SwiftUI

struct MarketsView: View {
    @EnvironmentObject private var store: MobileStore
    @State private var ticker = ""
    @State private var presentedSheet: MarketsSheet?
    @State private var presentedSymbol: PresentedSymbol?

    var body: some View {
        SnapshotScaffold { snapshot in
            PositionsSection(positions: snapshot.positions, presentedSymbol: $presentedSymbol)
            OrdersSection(orders: snapshot.orders, presentedSymbol: $presentedSymbol)
            WatchlistSection(ticker: $ticker, items: snapshot.watchlist, presentedSymbol: $presentedSymbol)
            AlertsSection(alerts: snapshot.alerts, presentedSymbol: $presentedSymbol)
        }
        .navigationTitle("Assets")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .navigationBarTrailing) {
                // Always open the composer; Create is gated inside. Disabling the toolbar
                // button when the snapshot is briefly stale made it look permanently broken.
                Button {
                    presentedSheet = .newAlert
                } label: {
                    // bell.badge.plus is not a real SF Symbol (console: "No symbol named…").
                    Image(systemName: "bell.badge")
                }
                .accessibilityLabel("Create Price Alert")
            }
        }
        .sheet(item: $presentedSheet) { sheet in
            switch sheet {
            case .newAlert:
                AlertComposerView()
            }
        }
        .sheet(item: $presentedSymbol) { presented in
            SymbolInfoSheet(symbol: presented.symbol)
        }
    }
}

private enum MarketsSheet: String, Identifiable {
    case newAlert

    var id: String { rawValue }
}

private struct PositionsSection: View {
    let positions: [Position]
    @Binding var presentedSymbol: PresentedSymbol?

    var body: some View {
        VStack(spacing: 10) {
            SectionHeading("Positions", subtitle: "Current broker holdings")
            if positions.isEmpty {
                EmptyStateCard(
                    title: "No Open Positions",
                    message: "Holdings from the selected broker account will appear here.",
                    systemImage: "square.stack.3d.up"
                )
            } else {
                ForEach(positions) { position in
                    PositionRow(position: position, presentedSymbol: $presentedSymbol)
                }
            }
        }
    }
}

private struct PositionRow: View {
    let position: Position
    @Binding var presentedSymbol: PresentedSymbol?

    var body: some View {
        AppCard {
            HStack(alignment: .top, spacing: 12) {
                VStack(alignment: .leading, spacing: 5) {
                    HStack(spacing: 8) {
                        SymbolTapButton(symbol: position.symbol, logoSize: 26) {
                            presentedSymbol = PresentedSymbol(symbol: position.symbol)
                        }
                        if position.quantity < 0 {
                            StatusPill("Short", color: AppPalette.negative)
                        }
                    }
                    Text("\(AppFormat.number(abs(position.quantity))) shares")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                    if let sector = position.sector, !sector.isEmpty {
                        Text(sector)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
                Spacer()
                VStack(alignment: .trailing, spacing: 5) {
                    Text(AppFormat.money(position.marketValue))
                        .font(.headline)
                    Text("Avg \(AppFormat.money(position.averageCost))")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
        }
    }
}

private struct OrdersSection: View {
    let orders: [EquityOrder]
    @Binding var presentedSymbol: PresentedSymbol?

    var body: some View {
        VStack(spacing: 10) {
            SectionHeading("Orders", subtitle: "Open and Recent Broker Orders")
            if orders.isEmpty {
                EmptyStateCard(
                    title: "No Orders Reported",
                    message: "Broker orders for the selected account will appear here.",
                    systemImage: "doc.text.magnifyingglass"
                )
            } else {
                ForEach(orders) { order in
                    OrderRow(order: order, presentedSymbol: $presentedSymbol)
                }
            }
        }
    }
}

private struct OrderRow: View {
    let order: EquityOrder
    @Binding var presentedSymbol: PresentedSymbol?

    private var statusColor: Color {
        switch order.state.lowercased() {
        case "filled": return AppPalette.positive
        case "cancelled", "canceled", "rejected", "failed": return AppPalette.negative
        default: return AppPalette.warning
        }
    }

    var body: some View {
        AppCard {
            VStack(alignment: .leading, spacing: 10) {
                HStack {
                    SymbolTapButton(symbol: order.symbol, logoSize: 24) {
                        presentedSymbol = PresentedSymbol(symbol: order.symbol)
                    }
                    StatusPill(order.side.uppercased(), color: sideColor)
                    Spacer()
                    StatusPill(order.state.capitalized, color: statusColor)
                }
                HStack {
                    Text(orderDescription)
                        .font(.subheadline)
                    Spacer()
                    Text(AppFormat.dateTime(order.updatedAt ?? order.createdAt))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
        }
    }

    private var sideColor: Color {
        order.side == "buy" || order.side == "cover" ? AppPalette.positive : AppPalette.negative
    }

    private var orderDescription: String {
        var values = [AppFormat.orderTypeLabel(order.type)]
        if let quantity = order.quantity { values.append("\(AppFormat.number(quantity)) shares") }
        if let filled = order.filledQuantity, filled > 0 { values.append("\(AppFormat.number(filled)) filled") }
        if let limit = order.limitPrice { values.append("@ \(AppFormat.money(limit))") }
        if let stop = order.stopPrice { values.append("stop \(AppFormat.money(stop))") }
        return values.joined(separator: " · ")
    }
}

private struct WatchlistSection: View {
    @EnvironmentObject private var store: MobileStore

    @Binding var ticker: String
    let items: [WatchlistItem]
    @Binding var presentedSymbol: PresentedSymbol?

    var body: some View {
        VStack(spacing: 10) {
            SectionHeading("Watchlist")
            AppCard {
                VStack(spacing: 12) {
                    HStack {
                        TextField("Ticker", text: $ticker)
                            .textInputAutocapitalization(.characters)
                            .autocorrectionDisabled()
                            .submitLabel(.done)
                            .onSubmit(addTicker)
                        Button("Add", action: addTicker)
                            .buttonStyle(.borderedProminent)
                            .disabled(
                                normalizedTicker.isEmpty ||
                                store.isBusy(addOperationID) ||
                                !store.canSubmit("watchlist.add")
                            )
                    }

                    if items.isEmpty {
                        Text("No symbols watched yet.")
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    } else {
                        FlowSymbols(items: items, presentedSymbol: $presentedSymbol)
                    }
                }
            }
        }
    }

    private var normalizedTicker: String {
        ticker.trimmingCharacters(in: .whitespacesAndNewlines).uppercased()
    }

    private var addOperationID: String { "watchlist.add:\(normalizedTicker)" }

    private func addTicker() {
        let symbol = normalizedTicker
        guard !symbol.isEmpty else { return }
        ticker = ""
        Task {
            await store.submit(
                "watchlist.add",
                payload: ["symbol": symbol],
                operationID: "watchlist.add:\(symbol)"
            )
        }
    }
}

private struct FlowSymbols: View {
    @EnvironmentObject private var store: MobileStore

    let items: [WatchlistItem]
    @Binding var presentedSymbol: PresentedSymbol?

    var body: some View {
        LazyVGrid(columns: [GridItem(.adaptive(minimum: 92), spacing: 8)], spacing: 8) {
            ForEach(items) { item in
                let operationID = "watchlist.remove:\(item.symbol)"
                // Two sibling buttons, not nested: tapping the logo/symbol opens company info;
                // tapping the trailing x removes the watch. Both stay real, separately labeled
                // buttons for VoiceOver.
                HStack(spacing: 6) {
                    Button {
                        presentedSymbol = PresentedSymbol(symbol: item.symbol)
                    } label: {
                        HStack(spacing: 6) {
                            TickerLogo(symbol: item.symbol, size: 18)
                            Text(item.symbol)
                                .font(.subheadline.weight(.semibold))
                        }
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("\(item.symbol) company info")

                    Button {
                        Task {
                            await store.submit(
                                "watchlist.remove",
                                payload: ["symbol": item.symbol],
                                operationID: operationID
                            )
                        }
                    } label: {
                        if store.isBusy(operationID) {
                            ProgressView().controlSize(.mini)
                        } else {
                            Image(systemName: "xmark.circle.fill")
                                .foregroundStyle(.secondary)
                        }
                    }
                    // The icon alone is ~17pt — below the 44pt HIG minimum tap target, and
                    // sitting right next to the info button above. Pad the button out to a real
                    // 44x44 hit area and make the whole padded rect tappable (not just the
                    // icon's visible pixels) via .contentShape, without touching the sibling
                    // button's own bounds so the two targets stay non-overlapping.
                    .padding(14)
                    .contentShape(Rectangle())
                    .buttonStyle(.plain)
                    .disabled(store.isBusy(operationID) || !store.canSubmit("watchlist.remove"))
                    .accessibilityLabel("Remove \(item.symbol) from watchlist")
                }
                .frame(maxWidth: .infinity)
                .padding(.horizontal, 9)
                .padding(.vertical, 8)
                .background(AppPalette.accent.opacity(0.1), in: Capsule())
            }
        }
    }
}

private struct AlertsSection: View {
    @EnvironmentObject private var store: MobileStore

    let alerts: [PriceAlert]
    @Binding var presentedSymbol: PresentedSymbol?

    var body: some View {
        VStack(spacing: 10) {
            SectionHeading("Price Alerts", subtitle: "Create a New Alert from the Bell Button")
            if alerts.isEmpty {
                EmptyStateCard(
                    title: "No Price Alerts",
                    message: "Set above or below thresholds to keep watch without opening the app",
                    systemImage: "bell"
                )
            } else {
                ForEach(alerts) { alert in
                    AlertRow(alert: alert, presentedSymbol: $presentedSymbol)
                }
            }
        }
    }
}

private struct AlertRow: View {
    @EnvironmentObject private var store: MobileStore
    @State private var confirmingDeletion = false

    let alert: PriceAlert
    @Binding var presentedSymbol: PresentedSymbol?

    private var operationID: String { "alert.delete:\(alert.id)" }

    var body: some View {
        AppCard {
            HStack(spacing: 12) {
                VStack(alignment: .leading, spacing: 4) {
                    HStack(spacing: 6) {
                        SymbolTapButton(symbol: alert.symbol, logoSize: 26) {
                            presentedSymbol = PresentedSymbol(symbol: alert.symbol)
                        }
                        Image(systemName: alert.status == "armed" ? "bell.fill" : "bell.badge.fill")
                            .font(.caption)
                            .foregroundStyle(alert.status == "armed" ? AppPalette.accent : AppPalette.positive)
                    }
                    Text("\(alert.op) \(AppFormat.money(alert.price))")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                    Text(alert.note?.isEmpty == false ? alert.note! : alert.status.capitalized)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                Spacer()
                Button(role: .destructive) {
                    confirmingDeletion = true
                } label: {
                    if store.isBusy(operationID) {
                        ProgressView()
                    } else {
                        Image(systemName: "trash")
                    }
                }
                .disabled(store.isBusy(operationID) || !store.canSubmit("alert.delete"))
                .accessibilityLabel("Delete \(alert.symbol) alert")
            }
        }
        .confirmationDialog(
            "Delete \(alert.symbol) price alert?",
            isPresented: $confirmingDeletion,
            titleVisibility: .visible
        ) {
            Button("Delete Alert", role: .destructive, action: deleteAlert)
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("This removes a monitoring safeguard.  You can create it again later.")
        }
    }

    private func deleteAlert() {
        Task {
            await store.submit(
                "alert.delete",
                payload: ["alertId": alert.id],
                operationID: operationID
            )
        }
    }
}

private struct AlertComposerView: View {
    @Environment(\.dismiss) private var dismiss
    @EnvironmentObject private var store: MobileStore

    @State private var symbol = ""
    @State private var comparison = ">"
    @State private var price = ""
    @State private var note = ""

    private var parsedPrice: Double? {
        Double(price.trimmingCharacters(in: .whitespacesAndNewlines))
    }

    private var normalizedSymbol: String {
        symbol.trimmingCharacters(in: .whitespacesAndNewlines).uppercased()
    }

    private var operationID: String { "alert.create:\(normalizedSymbol):\(comparison):\(price)" }

    var body: some View {
        NavigationStack {
            Form {
                Section("Alert") {
                    TextField("Symbol", text: $symbol)
                        .textInputAutocapitalization(.characters)
                        .autocorrectionDisabled()
                    Picker("Notify when price is", selection: $comparison) {
                        Text("Above").tag(">")
                        Text("Below").tag("<")
                    }
                    TextField("Price", text: $price)
                        .keyboardType(.decimalPad)
                    TextField("Note (optional)", text: $note, axis: .vertical)
                        .lineLimit(2...4)
                }
            }
            .navigationTitle("New Price Alert")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Create", action: create)
                        .disabled(
                            normalizedSymbol.isEmpty ||
                            parsedPrice == nil ||
                            store.isBusy(operationID) ||
                            !store.canSubmit("alert.create")
                        )
                }
            }
        }
    }

    private func create() {
        guard let parsedPrice, parsedPrice > 0 else { return }
        var payload: [String: Any] = [
            "symbol": normalizedSymbol,
            "op": comparison,
            "price": parsedPrice
        ]
        let trimmedNote = note.trimmingCharacters(in: .whitespacesAndNewlines)
        if !trimmedNote.isEmpty { payload["note"] = trimmedNote }

        Task {
            let succeeded = await store.submit(
                "alert.create",
                payload: payload,
                operationID: operationID
            )
            if succeeded { dismiss() }
        }
    }
}
