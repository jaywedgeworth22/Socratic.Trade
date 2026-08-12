import SwiftUI

@main
struct SocraticTradeApp: App {
    /// UIKit hands back the APNs device token nowhere else — see `PushAppDelegate`.
    @UIApplicationDelegateAdaptor(PushAppDelegate.self) private var pushDelegate
    @StateObject private var store = MobileStore(
        client: MobileAPIClient(baseURL: MobileAPIClient.productionBaseURL)
    )

    var body: some Scene {
        WindowGroup {
            ContentView()
                .environmentObject(store)
                .environmentObject(PushNotificationCoordinator.shared)
                // Owner 2026-08-10: light is the product default (no theme
                // picker on this app yet — do not follow OS dark by default).
                .preferredColorScheme(.light)
        }
    }
}

struct ContentView: View {
    @Environment(\.scenePhase) private var scenePhase
    @EnvironmentObject private var store: MobileStore
    /// Set by `onOpenURL` AND by a tapped push notification, consumed (and cleared) by the tab
    /// shell.  Held here rather than inside the shell so a link that arrives before sign-in
    /// still routes: the shell exists in this ZStack the whole time and applies the
    /// destination as soon as it is set, so the right screen is already showing when
    /// authentication completes.
    @State private var pendingDeepLink: DeepLinkDestination?

    var body: some View {
        ZStack {
            LoginView()
                .opacity(store.hasInitialized && !store.isAuthenticated ? 1 : 0)
                .allowsHitTesting(store.hasInitialized && !store.isAuthenticated)
                .accessibilityHidden(!store.hasInitialized || store.isAuthenticated)

            MobileControlView(pendingDeepLink: $pendingDeepLink)
                .opacity(store.isAuthenticated ? 1 : 0)
                .allowsHitTesting(store.isAuthenticated)
                .accessibilityHidden(!store.isAuthenticated)

            if !store.hasInitialized {
                LaunchStateView()
                    .transition(.opacity)
            }
        }
        .animation(.easeInOut(duration: 0.2), value: store.hasInitialized)
        .animation(.easeInOut(duration: 0.2), value: store.isAuthenticated)
        .task {
            await bootstrap()
        }
        .onChange(of: scenePhase) { _, phase in
            handleScenePhase(phase)
        }
        // The ONE router: `DeepLink.destination(for:)` decides what a URL means, and the
        // answer lands in `pendingDeepLink`.  A tapped notification is routed through the
        // same two lines below (`configure(route:)`), never through a parser of its own.
        .onOpenURL { url in
            guard let destination = DeepLink.destination(for: url) else { return }
            pendingDeepLink = destination
        }
    }

    private func bootstrap() async {
        PushNotificationCoordinator.shared.configure(
            route: { destination in pendingDeepLink = destination },
            isLiveStreamConnected: { store.isStreamConnected }
        )
        guard !store.hasInitialized else { return }
        await store.load()
        if store.isAuthenticated {
            store.startEvents()
            // Re-asserts an existing grant only — this never prompts.  APNs can hand out a
            // new device token after a restore or reinstall, and asking each launch is the
            // only way to notice.
            await PushNotificationCoordinator.shared.registerIfAlreadyAuthorized()
        }
    }

    private func handleScenePhase(_ phase: ScenePhase) {
        switch phase {
        case .active where store.isAuthenticated:
            store.startEvents()
            Task { await store.load() }
        case .background:
            store.stopEvents()
        default:
            break
        }
    }
}

private struct LaunchStateView: View {
    var body: some View {
        ZStack {
            AppPalette.background.ignoresSafeArea()
            VStack(spacing: 16) {
                ZStack {
                    RoundedRectangle(cornerRadius: 20, style: .continuous)
                        .fill(AppPalette.accent.gradient)
                    Image(systemName: "chart.line.uptrend.xyaxis")
                        .font(.system(size: 32, weight: .semibold))
                        .foregroundStyle(.white)
                }
                .frame(width: 70, height: 70)
                ProgressView()
                Text("Socratic.Trade")
                    .font(.headline)
            }
        }
    }
}
