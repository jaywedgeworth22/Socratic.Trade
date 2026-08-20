import SwiftUI

struct ActivityView: View {
    @State private var presentedItem: PresentedMarketItem?

    var body: some View {
        SnapshotScaffold { snapshot in
            DailyActivityCard(snapshot: snapshot)
            SchedulerActivityCard(snapshot: snapshot)
            AlertActivitySection(notifications: snapshot.notifications)
            FillActivitySection(fills: snapshot.performance?.fills ?? [], presentedItem: $presentedItem)
            CommandActivitySection(commands: snapshot.recentCommands)
        }
        .navigationTitle("Activity")
        .navigationBarTitleDisplayMode(.inline)
        .sheet(item: $presentedItem) { item in
            SymbolInfoSheet(item: item)
        }
    }
}

private struct DailyActivityCard: View {
    let snapshot: MobileSnapshot

    var body: some View {
        VStack(spacing: 10) {
            SectionHeading("Today", subtitle: "this trading day (New York)")
            LazyVGrid(columns: columns, spacing: 10) {
                MetricTile(title: "All orders", value: "\(snapshot.dailyStats.orderCount)")
                MetricTile(title: "Opening orders", value: "\(snapshot.dailyStats.openingOrderCount)")
                MetricTile(
                    title: "Opening notional",
                    value: AppFormat.money(snapshot.dailyStats.notional, compact: true),
                    detail: dailyNotionalDetail(snapshot)
                )
                MetricTile(
                    title: "In Progress",
                    value: "\(snapshot.readiness.commandBacklog.queued + snapshot.readiness.commandBacklog.running)",
                    detail: "\(snapshot.readiness.commandBacklog.queued) queued · \(snapshot.readiness.commandBacklog.running) running"
                )
            }
        }
    }

    private var columns: [GridItem] {
        [GridItem(.flexible()), GridItem(.flexible())]
    }

    private func dailyNotionalDetail(_ snapshot: MobileSnapshot) -> String? {
        guard let cap = snapshot.policy.maxDailyNotional else { return nil }
        return "of \(AppFormat.money(cap, compact: true)) cap"
    }
}

private struct SchedulerActivityCard: View {
    let snapshot: MobileSnapshot

    var body: some View {
        AppCard {
            VStack(alignment: .leading, spacing: 12) {
                HStack {
                    SectionHeading("Scheduler")
                    Spacer()
                    // Shared market-aware run-state vocabulary (console deriveStateInfo parity).
                    StatusPill(
                        deriveRunStateWord(snapshot: snapshot).rawValue,
                        color: deriveRunStateWord(snapshot: snapshot).pillColor,
                        systemImage: "timer"
                    )
                }
                LabeledContent("Last Run", value: AppFormat.dateTime(snapshot.scheduler.lastRunAt))
                LabeledContent("Next run", value: AppFormat.dateTime(snapshot.scheduler.nextRunAt))
                LabeledContent("Cadence", value: snapshot.policy.runCadenceMinutes.map { "\($0) minutes" } ?? "Manual")
            }
        }
    }
}

private struct AlertActivitySection: View {
    let notifications: [MobileNotification]

    private var ordered: [MobileNotification] {
        notifications.sorted { lhs, rhs in
            let leftOpen = lhs.acknowledgedAt == nil
            let rightOpen = rhs.acknowledgedAt == nil
            if leftOpen != rightOpen { return leftOpen }
            let leftUrgent = isUrgent(lhs.type)
            let rightUrgent = isUrgent(rhs.type)
            if leftUrgent != rightUrgent { return leftUrgent }
            return lhs.createdAt > rhs.createdAt
        }
    }

    var body: some View {
        VStack(spacing: 10) {
            SectionHeading("Alerts", subtitle: "runs, kills, and other notices")
            if ordered.isEmpty {
                EmptyStateCard(
                    title: "No alerts yet",
                    message: "Failed runs and kill-switch trips will appear here after they fire.",
                    systemImage: "bell"
                )
            } else {
                ForEach(ordered) { event in
                    AlertActivityRow(event: event)
                }
            }
        }
    }

    private func isUrgent(_ type: String) -> Bool {
        type == "run_failed" || type == "kill_switch"
    }
}

private struct AlertActivityRow: View {
    let event: MobileNotification

    private var urgent: Bool {
        event.type == "run_failed" || event.type == "kill_switch"
    }

    var body: some View {
        AppCard(padding: 13) {
            VStack(alignment: .leading, spacing: 6) {
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Text(event.title)
                        .font(.appHeadline)
                        .foregroundStyle(urgent ? AppPalette.negative : .primary)
                    Spacer()
                    if event.acknowledgedAt == nil {
                        StatusPill("Open", color: urgent ? AppPalette.negative : AppPalette.warning)
                    }
                }
                Text(alertTypeLabel(event.type))
                    .font(.appCaption.weight(.semibold))
                    .foregroundStyle(.secondary)
                Text(AppFormat.dateTime(event.createdAt))
                    .font(.appFootnote)
                    .foregroundStyle(.secondary)
            }
        }
        .overlay {
            if urgent && event.acknowledgedAt == nil {
                RoundedRectangle(cornerRadius: 18, style: .continuous)
                    .stroke(AppPalette.negative.opacity(0.45), lineWidth: 1)
                    .allowsHitTesting(false)
            }
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(event.title). \(alertTypeLabel(event.type))")
    }
}

private func alertTypeLabel(_ type: String) -> String {
    switch type {
    case "run_failed": return "Strategy run failed"
    case "kill_switch": return "Kill switch"
    case "pending_approval": return "Waiting for approval"
    case "fill": return "Fill"
    case "price_alert": return "Price alert"
    case "limit_order_stale": return "Stale limit"
    case "provider_degraded": return "Provider"
    case "budget_alert": return "Budget"
    default: return type.replacingOccurrences(of: "_", with: " ")
    }
}

private struct FillActivitySection: View {
    let fills: [FillEvent]
    @Binding var presentedItem: PresentedMarketItem?

    private var recentFills: [FillEvent] {
        Array(fills.sorted { $0.filledAt > $1.filledAt }.prefix(20))
    }

    var body: some View {
        VStack(spacing: 10) {
            SectionHeading("Fills", subtitle: "Most recent executions")
            if recentFills.isEmpty {
                EmptyStateCard(
                    title: "No fills yet",
                    message: "Executed broker fills will appear here after the selected account trades.",
                    systemImage: "tray"
                )
            } else {
                ForEach(recentFills) { fill in
                    FillActivityRow(fill: fill, presentedItem: $presentedItem)
                }
            }
        }
    }
}

private struct FillActivityRow: View {
    let fill: FillEvent
    @Binding var presentedItem: PresentedMarketItem?

    var body: some View {
        Button {
            presentedItem = .fill(fill)
        } label: {
            AppCard(padding: 13) {
                HStack(alignment: .top, spacing: 12) {
                    VStack(alignment: .leading, spacing: 5) {
                        HStack(spacing: 8) {
                            TickerLogo(symbol: fill.symbol, size: 30)
                            Text(fill.symbol)
                                .font(.appTitle3.weight(.bold))
                            Text(fill.side.uppercased())
                                .font(.appCaption.weight(.semibold))
                                .foregroundStyle(sideColor)
                        }
                        Text("\(AppFormat.number(fill.quantity)) @ \(AppFormat.money(fill.price))")
                            .font(.appSubheadline)
                            .foregroundStyle(.secondary)
                    }
                    Spacer()
                    VStack(alignment: .trailing, spacing: 4) {
                        Text(AppFormat.money(fill.notional))
                            .font(.appTitle3.weight(.semibold))
                        Text(AppFormat.dateTime(fill.filledAt))
                            .font(.appFootnote)
                            .foregroundStyle(.secondary)
                    }
                    Image(systemName: "chevron.right")
                        .font(.appCaption.weight(.semibold))
                        .foregroundStyle(.tertiary)
                        .padding(.top, 6)
                }
            }
        }
        .buttonStyle(.plain)
        .contentShape(Rectangle())
        .accessibilityElement(children: .ignore)
        .accessibilityAddTraits(.isButton)
        .accessibilityLabel("\(fill.symbol) \(fill.side) fill")
        .accessibilityHint("Opens fill and company details")
    }

    private var sideColor: Color {
        fill.side == "buy" || fill.side == "cover" ? AppPalette.positive : AppPalette.negative
    }
}

private struct CommandActivitySection: View {
    let commands: [MobileCommand]

    var body: some View {
        VStack(spacing: 10) {
            SectionHeading("Recent Actions", subtitle: "what you asked this app to do")
            if commands.isEmpty {
                EmptyStateCard(
                    title: "No Recent Actions",
                    message: "Actions you take here will show up here.",
                    systemImage: "list.bullet"
                )
            } else {
                ForEach(commands) { command in
                    CommandActivityRow(command: command)
                }
            }
        }
    }
}

private struct CommandActivityRow: View {
    let command: MobileCommand

    private var statusColor: Color {
        switch command.status {
        case "succeeded": return AppPalette.positive
        case "failed", "cancelled": return AppPalette.negative
        case "running", "queued": return AppPalette.warning
        default: return .secondary
        }
    }

    var body: some View {
        AppCard {
            VStack(alignment: .leading, spacing: 8) {
                HStack {
                    Text(displayName)
                        .font(.appHeadline)
                    Spacer()
                    StatusPill(command.status.capitalized, color: statusColor, systemImage: statusIcon)
                }
                HStack {
                    Text(AppFormat.dateTime(command.updatedAt))
                        .font(.appFootnote)
                        .foregroundStyle(.secondary)
                    Spacer()
                }
                if let error = command.error, !error.isEmpty {
                    Label(error, systemImage: "exclamationmark.triangle")
                        .font(.appCaption)
                        .foregroundStyle(AppPalette.negative)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
        }
    }

    private var displayName: String {
        AppFormat.commandLabel(command.commandType)
    }

    private var statusIcon: String {
        switch command.status {
        case "succeeded": return "checkmark.circle.fill"
        case "failed", "cancelled": return "xmark.circle.fill"
        case "running": return "gearshape.2.fill"
        default: return "clock.fill"
        }
    }
}
