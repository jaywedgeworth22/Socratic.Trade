import SwiftUI

struct ActivityView: View {
    var body: some View {
        SnapshotScaffold { snapshot in
            DailyActivityCard(snapshot: snapshot)
            SchedulerActivityCard(snapshot: snapshot)
            FillActivitySection(fills: snapshot.performance?.fills ?? [])
            CommandActivitySection(commands: snapshot.recentCommands)
        }
        .navigationTitle("Activity")
    }
}

private struct DailyActivityCard: View {
    let snapshot: MobileSnapshot

    var body: some View {
        VStack(spacing: 10) {
            SectionHeading("Today", subtitle: "America/New_York trading-day boundary")
            LazyVGrid(columns: columns, spacing: 10) {
                MetricTile(title: "All orders", value: "\(snapshot.dailyStats.orderCount)")
                MetricTile(title: "Opening orders", value: "\(snapshot.dailyStats.openingOrderCount)")
                MetricTile(
                    title: "Opening notional",
                    value: AppFormat.money(snapshot.dailyStats.notional, compact: true),
                    detail: dailyNotionalDetail(snapshot)
                )
                MetricTile(
                    title: "Command backlog",
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
                    StatusPill(
                        snapshot.readiness.systemState == "active" ? "Running" : "Paused",
                        color: snapshot.readiness.systemState == "active" ? AppPalette.positive : .secondary,
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

private struct FillActivitySection: View {
    let fills: [FillEvent]

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
                    FillActivityRow(fill: fill)
                }
            }
        }
    }
}

private struct FillActivityRow: View {
    let fill: FillEvent

    var body: some View {
        AppCard {
            HStack(spacing: 12) {
                Image(systemName: fill.side == "buy" || fill.side == "cover" ? "arrow.down.left" : "arrow.up.right")
                    .font(.headline)
                    .foregroundStyle(sideColor)
                    .frame(width: 34, height: 34)
                    .background(sideColor.opacity(0.1), in: Circle())
                VStack(alignment: .leading, spacing: 4) {
                    HStack(spacing: 7) {
                        Text(fill.symbol)
                            .font(.headline)
                        Text(fill.side.uppercased())
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(sideColor)
                    }
                    Text("\(AppFormat.number(fill.quantity)) @ \(AppFormat.money(fill.price))")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                Spacer()
                VStack(alignment: .trailing, spacing: 4) {
                    Text(AppFormat.money(fill.notional))
                        .font(.subheadline.weight(.semibold))
                    Text(AppFormat.dateTime(fill.filledAt))
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }
            }
        }
    }

    private var sideColor: Color {
        fill.side == "buy" || fill.side == "cover" ? AppPalette.positive : AppPalette.negative
    }
}

private struct CommandActivitySection: View {
    let commands: [MobileCommand]

    var body: some View {
        VStack(spacing: 10) {
            SectionHeading("Commands", subtitle: "Audited mobile command history")
            if commands.isEmpty {
                EmptyStateCard(
                    title: "No mobile commands",
                    message: "Commands submitted from this app or the mobile web surface will appear here.",
                    systemImage: "terminal"
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
                        .font(.subheadline.weight(.semibold))
                    Spacer()
                    StatusPill(command.status.capitalized, color: statusColor, systemImage: statusIcon)
                }
                HStack {
                    Text(AppFormat.dateTime(command.updatedAt))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    Spacer()
                    Text(String(command.id.prefix(8)))
                        .font(.caption2.monospaced())
                        .foregroundStyle(.tertiary)
                }
                if let error = command.error, !error.isEmpty {
                    Label(error, systemImage: "exclamationmark.triangle")
                        .font(.caption)
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
