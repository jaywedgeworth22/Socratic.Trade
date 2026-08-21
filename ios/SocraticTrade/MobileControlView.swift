import SwiftUI

enum AppTab: String, CaseIterable, Identifiable {
    case home
    case proposals
    /// Holdings, orders, watchlist, alerts (tab label "Assets"; same chart symbol).
    case markets
    case activity
    /// Snapshot brief + rule-based attention items — not the web console Coach chat.
    case insights
    /// Live Coach conversation (POST /api/chat).
    case coach
    /// Interactive market scan table.
    case scan
    /// Full policy + tighten-only edits.
    case guardrails
    /// Read-only P&L and tax-relevant fill receipts.
    case results
    /// Every screen + tab customization. Always present, always last — the iOS
    /// counterpart of the web mobile bar's "More" sheet (app/console/components/nav.tsx).
    case more

    var id: String { rawValue }

    /// Screens the owner can pin/unpin. `.more` is fixed chrome, not a destination.
    static var customizable: [AppTab] { allCases.filter { $0 != .more } }

    var title: String {
        switch self {
        case .home: return "Home"
        case .proposals: return "Proposals"
        case .markets: return "Assets"
        case .activity: return "Activity"
        case .insights: return "Insights"
        case .coach: return "Coach"
        case .scan: return "Scan"
        case .guardrails: return "Guardrails"
        case .results: return "Results"
        case .more: return "More"
        }
    }

    var systemImage: String {
        switch self {
        case .home: return "house.fill"
        case .proposals: return "checklist"
        case .markets: return "chart.line.uptrend.xyaxis"
        case .activity: return "clock.arrow.circlepath"
        case .insights: return "lightbulb.fill"
        case .coach: return "bubble.left.and.bubble.right.fill"
        case .scan: return "tablecells"
        case .guardrails: return "shield.checkered"
        case .results: return "chart.xyaxis.line"
        case .more: return "square.grid.2x2"
        }
    }

    /// Concise purpose line for the More list (mirrors the web rail's hover desc).
    var detail: String {
        switch self {
        case .home: return "Live thesis, actions, and agent controls."
        case .proposals: return "Trade proposals awaiting your judgment."
        case .markets: return "Holdings, orders, watchlist, and price alerts."
        case .activity: return "Notifications, fills, and what the agent did."
        case .insights: return "Status brief and attention items."
        case .coach: return "Ask the desk — a real Coach conversation."
        case .scan: return "Ranked names with watchlist actions."
        // Not "tighten it": this screen raises caps too, which GuardrailsView itself
        // says ("Caps can go up or down").  Web's enumeration is the accurate line.
        case .guardrails: return "Autonomy, spending caps, protective stops, schedule, and the trading rulebook."
        case .results: return "P&L, benchmark, and fill receipts."
        case .more: return "All screens and tab customization."
        }
    }

    @ViewBuilder
    var label: some View {
        Label(title, systemImage: systemImage)
    }
}

/// Persisted, owner-customizable tab-bar membership — the iOS counterpart of the web
/// console's pinned mobile tabs (app/console/lib/mobile-tabs.ts), extended for iPad and
/// Mac Catalyst.
///
/// Three rules the phone-only version did not have (owner 2026-08-21):
///
///  1. **Home is required.**  It can never leave the bar, so there is always one screen
///     that is exactly where you left it.
///  2. **The slot before More swaps.**  The bar is `stable` pins in canonical order, then
///     ONE `flex` slot, then More.  Opening a screen from the More list that has no tab
///     of its own moves it into that slot (Activity, the default occupant, steps out) —
///     instead of the old behaviour of pushing it onto a navigation stack inside More,
///     where it had no tab and no way back except the way you came.
///  3. **The bar grows with the window.**  A phone holds four; a wide iPad or a
///     full-screen Mac window holds up to seven.  Narrow the window past what the owner's
///     pins need and the bar falls back to the default pins — plus, still, the flex slot,
///     because the screen the owner is currently LOOKING at has to keep its tab.  Nothing
///     is forgotten: `stable` is untouched, so widening restores it exactly.
@MainActor
final class TabPreferences: ObservableObject {
    /// Home + the flex slot.  The smallest bar this model can produce.
    static let minTabs = 2
    /// Phone-width ceiling (plus More).  Five items is where UIKit's own bar starts to crowd.
    static let compactMaxTabs = 4
    /// Wide-window ceiling.  Past seven the floating pill stops reading as navigation.
    static let regularMaxTabs = 7
    /// Always on the bar, never unpinnable.
    static let requiredTab: AppTab = .home
    /// The bar as shipped: web's defaults (Home, Proposals, Activity, Orders) mapped onto
    /// this app's screens — Assets is where holdings/orders live on iOS.
    static let defaultTabs: [AppTab] = [.home, .proposals, .markets, .activity]
    /// Whoever starts in the swappable slot.  Owner: "Activity by default".
    static let defaultFlex: AppTab = .activity
    /// The pins that survive a too-narrow window.
    static var defaultStable: [AppTab] { defaultTabs.filter { $0 != defaultFlex } }

    private static let stableKey = "mobileTabs.stable.v2"
    private static let flexKey = "mobileTabs.flex.v2"
    /// Pre-flex-slot storage: a flat pinned list.  Its LAST entry becomes the flex slot.
    private static let legacyKey = "mobileTabs.v1"

    /// The owner's pinned screens.  Always contains `requiredTab`, never contains `flex`.
    @Published private(set) var stable: [AppTab]
    /// The swappable slot — the tab immediately before More.
    @Published private(set) var flex: AppTab
    /// How many bar slots the current window can hold, excluding More.  Written by the
    /// shell from the live width; never persisted, because it describes the window and
    /// not the owner.
    @Published private(set) var capacity: Int = TabPreferences.compactMaxTabs

    private let userDefaults: UserDefaults

    init(userDefaults: UserDefaults = .standard) {
        self.userDefaults = userDefaults

        let storedStable = (userDefaults.stringArray(forKey: Self.stableKey))
            .map { $0.compactMap(AppTab.init(rawValue:)) }
        let storedFlex = userDefaults.string(forKey: Self.flexKey).flatMap(AppTab.init(rawValue:))

        if let storedStable, !storedStable.isEmpty {
            (stable, flex) = Self.normalize(stable: storedStable, flex: storedFlex ?? Self.defaultFlex)
        } else if let legacy = userDefaults.stringArray(forKey: Self.legacyKey) {
            // Migration: the v1 list rendered in canonical order, so its last canonical
            // entry is the one that sat where the flex slot now sits.
            let tabs = AppTab.customizable.filter { legacy.contains($0.rawValue) }
            if tabs.count >= Self.minTabs, let last = tabs.last {
                (stable, flex) = Self.normalize(stable: tabs.dropLast(), flex: last)
            } else {
                (stable, flex) = (Self.defaultStable, Self.defaultFlex)
            }
        } else {
            (stable, flex) = (Self.defaultStable, Self.defaultFlex)
        }
    }

    /// Enforces every invariant in one place: `.more` is never a member, Home is always
    /// pinned, the flex occupant is never also a stable pin, and a set that collapsed below
    /// the floor resets to the defaults rather than rendering a broken bar.
    private static func normalize<S: Sequence>(stable: S, flex: AppTab) -> ([AppTab], AppTab)
    where S.Element == AppTab {
        let requested = Set(stable)
        var pins = AppTab.customizable.filter { requested.contains($0) }
        if !pins.contains(requiredTab) { pins.insert(requiredTab, at: 0) }
        var slot = flex == .more ? defaultFlex : flex
        pins.removeAll { $0 == slot }
        if pins.isEmpty { pins = [requiredTab] }
        // The flex occupant cannot also be the required tab, or the bar would be Home twice.
        if slot == requiredTab {
            slot = AppTab.customizable.first { $0 != requiredTab && !pins.contains($0) } ?? defaultFlex
        }
        return (Array(pins.prefix(regularMaxTabs - 1)), slot)
    }

    /// Pinned tabs in canonical order, then the swappable slot.  What the bar renders.
    ///
    /// Both branches filter `flex` out of the pins before appending it.  Normally the two
    /// sets are disjoint by construction, but `ensureVisible` can deliberately park a
    /// PINNED tab in the slot to keep it selectable at a narrow width; without the filter
    /// that tab would appear twice once the window widened again.
    var barTabs: [AppTab] {
        let pins = AppTab.customizable.filter { stable.contains($0) && $0 != flex }
        let full = pins + [flex]
        guard full.count > capacity else { return full }
        // Too narrow for the owner's pins.  Fall back to the defaults — but keep the flex
        // slot, so whatever screen is on screen right now still has a tab to be selected by.
        // Dropping it instead would leave `selectedTab` pointing at a tab that no longer
        // exists, which renders as an empty pane.
        return AppTab.customizable.filter { Self.defaultStable.contains($0) && $0 != flex } + [flex]
    }

    /// Everything on the bar except the swappable slot.
    var barLeadingTabs: [AppTab] { Array(barTabs.dropLast()) }
    /// The swappable slot as actually rendered — the tab immediately before More.
    var barTrailingTab: AppTab? { barTabs.last }

    func isOnBar(_ tab: AppTab) -> Bool { tab == .more || barTabs.contains(tab) }
    func isPinned(_ tab: AppTab) -> Bool { stable.contains(tab) }
    func isRequired(_ tab: AppTab) -> Bool { tab == Self.requiredTab }

    /// Whether pinning/unpinning this tab right now would respect the bounds.  Home is
    /// never toggleable; a new pin needs room for itself AND the flex slot.
    func canToggle(_ tab: AppTab) -> Bool {
        guard tab != .more, !isRequired(tab) else { return false }
        return stable.contains(tab) ? stable.count > 1 : stable.count + 2 <= capacity
    }

    func toggle(_ tab: AppTab) {
        guard canToggle(tab) else { return }
        if stable.contains(tab) {
            stable.removeAll { $0 == tab }
        } else {
            stable.append(tab)
            // Pinning the current occupant of the flex slot promotes it out of that slot,
            // which then needs a new tenant — Activity if it is free, else the first
            // unpinned screen, so the bar never shows a hole or a duplicate.
            if tab == flex {
                flex = Self.defaultFlex == tab || stable.contains(Self.defaultFlex)
                    ? (AppTab.customizable.first { $0 != tab && !stable.contains($0) } ?? Self.defaultFlex)
                    : Self.defaultFlex
            }
        }
        (stable, flex) = Self.normalize(stable: stable, flex: flex)
        persist()
    }

    /// Move a screen into the swappable slot.  A no-op for a screen that is already pinned
    /// (it has its own tab) or already in the slot.
    func setFlex(_ tab: AppTab) {
        guard tab != .more, !stable.contains(tab), tab != flex else { return }
        (stable, flex) = Self.normalize(stable: stable, flex: tab)
        persist()
    }

    /// Keep a screen selectable.  Called with the CURRENT selection whenever the bar
    /// changes shape: narrowing the window (or unpinning from the More list) can drop a
    /// tab the owner is actively looking at, and a selection with no matching `Tab`
    /// renders as an empty pane rather than falling back to anything.  Parking it in the
    /// swappable slot leaves its pin untouched, so widening restores the full set.
    func ensureVisible(_ tab: AppTab) {
        guard tab != .more, !barTabs.contains(tab) else { return }
        flex = tab
        persist()
    }

    /// Bar slots for a window this wide.  Compact width is always the phone bar; regular
    /// width earns slots as the window grows, so a Mac window that is dragged narrow loses
    /// them again.  `More` is budgeted separately because it is always present.
    static func capacity(forWidth width: CGFloat, horizontalSizeClass: UserInterfaceSizeClass?) -> Int {
        guard horizontalSizeClass == .regular, width > 0 else { return compactMaxTabs }
        let usable = width * 0.86 - moreSlotWidth
        return min(regularMaxTabs, max(compactMaxTabs, Int(usable / perItemWidth)))
    }

    /// Rough width of one icon+label tab item and of the More item, in points.  These only
    /// need to be good enough to decide HOW MANY fit — the bar sizes itself.
    private static let perItemWidth: CGFloat = 118
    private static let moreSlotWidth: CGFloat = 100

    func updateCapacity(width: CGFloat, horizontalSizeClass: UserInterfaceSizeClass?) {
        let next = Self.capacity(forWidth: width, horizontalSizeClass: horizontalSizeClass)
        guard next != capacity else { return }
        capacity = next
    }

    private func persist() {
        userDefaults.set(stable.map(\.rawValue), forKey: Self.stableKey)
        userDefaults.set(flex.rawValue, forKey: Self.flexKey)
    }
}

struct MobileControlView: View {
    @EnvironmentObject private var store: MobileStore
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass
    @StateObject private var tabPreferences = TabPreferences()
    @State private var selectedTab: AppTab = MobileControlView.initialTab()
    /// Proposal id a deep link asked for, handed to whichever ProposalsView is on screen.
    @State private var focusedProposalId: String?
    /// Ticker a deep link asked for, handed to MarketsView (Assets).
    @State private var focusedSymbol: String?
    /// Clears the ring above once the cue has been seen (see `apply`).
    @State private var focusExpiry: Task<Void, Never>?
    /// Last width the shell was laid out at, so a size-class flip (iPad Split View,
    /// a Catalyst window crossing the regular/compact line) can recompute capacity
    /// without waiting for a geometry change that may not come.
    @State private var lastKnownWidth: CGFloat = 0

    @Binding private var pendingDeepLink: DeepLinkDestination?

    init(pendingDeepLink: Binding<DeepLinkDestination?> = .constant(nil)) {
        self._pendingDeepLink = pendingDeepLink
    }

    private var pendingProposalCount: Int {
        store.snapshot?.pendingProposals.count ?? 0
    }

    private var unreadNotificationCount: Int {
        store.snapshot?.unreadNotificationCount ?? 0
    }

    /// The ONE way the selection ever moves — in-app jumps (Home's "Review Proposals"),
    /// deep links, notification taps, and the More list all go through here.  A target
    /// with no tab of its own is swapped into the bar's one flexible slot first, so every
    /// jump lands on a real, selectable tab instead of a selection with no matching Tab.
    private var selection: Binding<AppTab> {
        Binding(
            get: { selectedTab },
            set: { target in
                // Any tab change ends the deep-link ring: it has either been seen or been left
                // behind.  `apply` sets the focus AFTER moving the selection, so a link's own
                // jump is not the change that clears it.
                clearFocus()
                // A screen with no tab of its own takes over the swappable slot rather
                // than being pushed inside More.  `setFlex` runs FIRST so the Tab for
                // `target` already exists by the time the selection lands on it —
                // reversed, the selection would point at a value the TabView has no Tab
                // for and the pane would blank for a frame.
                if !tabPreferences.isOnBar(target) {
                    tabPreferences.setFlex(target)
                }
                selectedTab = target
            }
        )
    }

    var body: some View {
        // iOS 26 `Tab` builder (not legacy `.tabItem`) — this is what keeps the bar on
        // the system Liquid Glass appearance and its iPad/Mac sidebar adaptations.
        // Unrolled (no ForEach) so Release/archive can type-check; ForEach+Tab
        // times out the Swift 6 compiler ("unable to type-check this expression").
        //
        // Order is load-bearing: the pinned tabs come first in canonical order, then the
        // ONE swappable slot, then More.  That is why the swappable tab is a single
        // `Tab` whose value changes rather than nine more conditionals — it is the only
        // way to keep it rendering immediately before More whatever screen is in it.
        TabView(selection: selection) {
            // Grouped, not loose: `TabContentBuilder` tops out at ten children like every
            // other result builder, and nine pinnable tabs + the swappable slot + More is
            // eleven.  The failure mode is an opaque "extra argument in call" pointing at
            // the LAST child rather than at the arity, so leave the Group in place.
            Group {
                if tabPreferences.barLeadingTabs.contains(.home) {
                    Tab(AppTab.home.title, systemImage: AppTab.home.systemImage, value: AppTab.home) {
                        NavigationStack { destination(for: .home) }
                    }
                    .badge(badgeCount(for: .home))
                }
                if tabPreferences.barLeadingTabs.contains(.proposals) {
                    Tab(AppTab.proposals.title, systemImage: AppTab.proposals.systemImage, value: AppTab.proposals) {
                        NavigationStack { destination(for: .proposals) }
                    }
                    .badge(badgeCount(for: .proposals))
                }
                if tabPreferences.barLeadingTabs.contains(.markets) {
                    Tab(AppTab.markets.title, systemImage: AppTab.markets.systemImage, value: AppTab.markets) {
                        NavigationStack { destination(for: .markets) }
                    }
                    .badge(badgeCount(for: .markets))
                }
                if tabPreferences.barLeadingTabs.contains(.activity) {
                    Tab(AppTab.activity.title, systemImage: AppTab.activity.systemImage, value: AppTab.activity) {
                        NavigationStack { destination(for: .activity) }
                    }
                    .badge(badgeCount(for: .activity))
                }
                if tabPreferences.barLeadingTabs.contains(.insights) {
                    Tab(AppTab.insights.title, systemImage: AppTab.insights.systemImage, value: AppTab.insights) {
                        NavigationStack { destination(for: .insights) }
                    }
                    .badge(badgeCount(for: .insights))
                }
                if tabPreferences.barLeadingTabs.contains(.coach) {
                    Tab(AppTab.coach.title, systemImage: AppTab.coach.systemImage, value: AppTab.coach) {
                        NavigationStack { destination(for: .coach) }
                    }
                    .badge(badgeCount(for: .coach))
                }
                if tabPreferences.barLeadingTabs.contains(.scan) {
                    Tab(AppTab.scan.title, systemImage: AppTab.scan.systemImage, value: AppTab.scan) {
                        NavigationStack { destination(for: .scan) }
                    }
                    .badge(badgeCount(for: .scan))
                }
                if tabPreferences.barLeadingTabs.contains(.guardrails) {
                    Tab(AppTab.guardrails.title, systemImage: AppTab.guardrails.systemImage, value: AppTab.guardrails) {
                        NavigationStack { destination(for: .guardrails) }
                    }
                    .badge(badgeCount(for: .guardrails))
                }
                if tabPreferences.barLeadingTabs.contains(.results) {
                    Tab(AppTab.results.title, systemImage: AppTab.results.systemImage, value: AppTab.results) {
                        NavigationStack { destination(for: .results) }
                    }
                    .badge(badgeCount(for: .results))
                }
            }

            if let trailing = tabPreferences.barTrailingTab {
                Tab(trailing.title, systemImage: trailing.systemImage, value: trailing) {
                    NavigationStack { destination(for: trailing) }
                }
                .badge(badgeCount(for: trailing))
            }

            Tab(AppTab.more.title, systemImage: AppTab.more.systemImage, value: AppTab.more) {
                NavigationStack {
                    MoreView(
                        tabPreferences: tabPreferences,
                        pendingProposalCount: pendingProposalCount,
                        unreadNotificationCount: unreadNotificationCount,
                        openScreen: { selection.wrappedValue = $0 }
                    )
                }
            }
        }
        .tint(AppPalette.accent)
        // The bar earns slots as the window grows and gives them back as it shrinks —
        // the whole point on Mac Catalyst, where the owner drags the window, and on an
        // iPad rotating or entering Split View.  Width comes from the shell itself
        // rather than a device check, so a half-width iPad gets a half-width bar.
        .onGeometryChange(for: CGFloat.self) { proxy in
            proxy.size.width
        } action: { width in
            lastKnownWidth = width
            tabPreferences.updateCapacity(width: width, horizontalSizeClass: horizontalSizeClass)
        }
        .onChange(of: horizontalSizeClass) { _, _ in
            tabPreferences.updateCapacity(width: lastKnownWidth, horizontalSizeClass: horizontalSizeClass)
        }
        // Anything that reshapes the bar — a resize that drops pins, an unpin from the
        // More list — must not strand the screen the owner is on.  Converges in one pass:
        // the repair puts `selectedTab` on the bar, so the next round is a no-op.
        .onChange(of: tabPreferences.barTabs) { _, _ in
            tabPreferences.ensureVisible(selectedTab)
        }
        .onChange(of: pendingDeepLink) { _, destination in
            apply(destination)
        }
        .onAppear {
            // A link or notification tap that launched the app can arrive before this view
            // exists, and one that arrives while signed out waits here until it does.
            apply(pendingDeepLink)
        }
        .onReceive(NotificationCenter.default.publisher(for: .ascSelectTab)) { note in
            if let raw = note.object as? String, let tab = AppTab(rawValue: raw) {
                selection.wrappedValue = tab
            }
        }
    }

    /// Badges follow the screen, not the slot: Proposals and Activity carry theirs into
    /// the swappable slot too, so moving Activity there does not silently drop its count.
    private func badgeCount(for tab: AppTab) -> Int {
        switch tab {
        case .proposals: return pendingProposalCount
        case .activity: return unreadNotificationCount
        default: return 0
        }
    }

    /// `-ASCScreenshotTab home|proposals|markets|activity|insights` or UserDefaults `ascScreenshotTab`.
    private static func initialTab() -> AppTab {
        #if DEBUG
        if let idx = ProcessInfo.processInfo.arguments.firstIndex(of: "-ASCScreenshotTab"),
           ProcessInfo.processInfo.arguments.indices.contains(idx + 1),
           let tab = AppTab(rawValue: ProcessInfo.processInfo.arguments[idx + 1]) {
            return tab
        }
        if let raw = UserDefaults.standard.string(forKey: "ascScreenshotTab"),
           let tab = AppTab(rawValue: raw) {
            return tab
        }
        #endif
        return .home
    }

    /// Deep links reuse the SAME rerouting `selection` binding as in-app jumps, so a link to an
    /// UNPINNED screen lands in the More stack instead of selecting a tab that is not on the
    /// bar.  Clearing `pendingDeepLink` afterwards keeps a repeat of the same link routable.
    ///
    /// The focus id is set AFTER the tab move (the selection setter clears it) and expires on its
    /// own a few seconds later: the accent ring is a transient "here it is" cue for the card the
    /// link named, so once the scroll has landed and been seen it should stop marking that card
    /// out.  Leaving it set was making one proposal look permanently singled out for the rest of
    /// the session.  Clearing it does not scroll anything back — `SnapshotScaffold` only acts on a
    /// non-nil target.
    private func apply(_ destination: DeepLinkDestination?) {
        guard let destination else { return }
        selection.wrappedValue = destination.tab
        focusedProposalId = destination.proposalId
        focusedSymbol = destination.focusedSymbol
        pendingDeepLink = nil
        focusExpiry?.cancel()
        guard focusedProposalId != nil || focusedSymbol != nil else { return }
        focusExpiry = Task { @MainActor in
            try? await Task.sleep(for: .seconds(4))
            guard !Task.isCancelled else { return }
            focusedProposalId = nil
            focusedSymbol = nil
        }
    }

    private func clearFocus() {
        focusExpiry?.cancel()
        focusExpiry = nil
        focusedProposalId = nil
        focusedSymbol = nil
    }

    @ViewBuilder
    private func destination(for tab: AppTab) -> some View {
        switch tab {
        case .home: HomeView(selectedTab: selection)
        case .proposals: ProposalsView(focusedProposalId: $focusedProposalId)
        case .markets: MarketsView(selectedTab: selection, focusedSymbol: $focusedSymbol)
        case .activity: ActivityView()
        case .insights: InsightsView(selectedTab: selection)
        case .coach: CoachView()
        case .scan: ScanView()
        case .guardrails: GuardrailsView()
        case .results: ResultsView()
        case .more: EmptyView()
        }
    }
}

extension Notification.Name {
    static let ascSelectTab = Notification.Name("ascSelectTab")
}

/// The overflow + customization screen: every destination stays reachable here, and
/// each row's pin toggle edits the bar live — the same two jobs as the web TabsSheet.
///
/// Tapping a row now SELECTS that screen rather than pushing it inside this stack.  A
/// screen with no tab of its own slides into the bar's swappable slot on the way, so it
/// arrives with a tab you can come back to instead of being buried one level down inside
/// More with only a back button.
private struct MoreView: View {
    @ObservedObject var tabPreferences: TabPreferences
    let pendingProposalCount: Int
    let unreadNotificationCount: Int
    let openScreen: (AppTab) -> Void

    var body: some View {
        List {
            Section {
                ForEach(AppTab.customizable) { tab in
                    row(for: tab)
                }
            } header: {
                Text("Screens")
            } footer: {
                Text(footerText)
            }
        }
        .navigationTitle("More")
        .navigationBarTitleDisplayMode(.inline)
    }

    /// Says what the bar can actually do RIGHT NOW — the ceiling moves with the window,
    /// so a fixed "pin up to 4" would be wrong on an iPad the moment it was read.
    private var footerText: String {
        let pinnable = max(0, tabPreferences.capacity - 1)
        return "Home always stays on the bar, and the slot before More holds whichever "
            + "screen you opened last.  Pin up to \(pinnable) screens alongside them.  "
            + "This window fits \(tabPreferences.capacity); a wider one fits more, and a "
            + "narrower one falls back to the default tabs without forgetting your pins.  "
            + "Everything stays reachable from here either way."
    }

    private func row(for tab: AppTab) -> some View {
        HStack(spacing: 12) {
            Button {
                openScreen(tab)
            } label: {
                HStack(spacing: 12) {
                    Image(systemName: tab.systemImage)
                        .font(.appBody)
                        .foregroundStyle(AppPalette.accent)
                        .frame(width: 30, height: 30)
                        .background(AppPalette.accent.opacity(0.1), in: RoundedRectangle(cornerRadius: 8, style: .continuous))
                    VStack(alignment: .leading, spacing: 1) {
                        HStack(spacing: 6) {
                            Text(tab.title)
                                .font(.appBody.weight(.medium))
                            if tab == .proposals && pendingProposalCount > 0 {
                                countPill("\(pendingProposalCount)", tint: AppPalette.negative)
                            }
                            if tab == .activity && unreadNotificationCount > 0 {
                                countPill("\(unreadNotificationCount)", tint: AppPalette.accent)
                            }
                        }
                        Text(tab.detail)
                            .font(.appCaption)
                            .foregroundStyle(.secondary)
                    }
                    Spacer(minLength: 0)
                    Image(systemName: "chevron.right")
                        .font(.appCaption2.weight(.semibold))
                        .foregroundStyle(.tertiary)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)

            pinControl(for: tab)
        }
    }

    private func countPill(_ text: String, tint: Color) -> some View {
        Text(text)
            .font(.appCaption2.weight(.bold))
            .foregroundStyle(.white)
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .background(tint, in: Capsule())
    }

    /// Home shows a filled, dimmed pin it cannot lose — the affordance stays legible
    /// rather than vanishing, which would read as a rendering bug next to eight rows
    /// that all have one.
    @ViewBuilder
    private func pinControl(for tab: AppTab) -> some View {
        if tabPreferences.isRequired(tab) {
            Image(systemName: "pin.fill")
                .foregroundStyle(Color.secondary.opacity(0.4))
                .accessibilityLabel("\(tab.title) always stays on the tab bar")
        } else {
            Button {
                tabPreferences.toggle(tab)
            } label: {
                Image(systemName: tabPreferences.isPinned(tab) ? "pin.fill" : "pin")
                    .foregroundStyle(tabPreferences.canToggle(tab) ? AppPalette.accent : Color.secondary.opacity(0.4))
            }
            .buttonStyle(.borderless)
            .disabled(!tabPreferences.canToggle(tab))
            .accessibilityLabel(tabPreferences.isPinned(tab) ? "Unpin \(tab.title) from tab bar" : "Pin \(tab.title) to tab bar")
            .accessibilityHint(
                tabPreferences.canToggle(tab)
                    ? ""
                    : tabPreferences.isPinned(tab)
                        ? "Keep at least one pinned screen besides Home"
                        : "This window fits \(tabPreferences.capacity) tabs — unpin one first, or widen the window"
            )
        }
    }
}

#if DEBUG
#Preview("Customizable tab shell") {
    MobileControlView()
        .environmentObject(MobileStore.preview)
}
#endif
