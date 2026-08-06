import SwiftUI

@main
struct SocraticTradeApp: App {
    @StateObject private var store = MobileStore(
        client: MobileAPIClient(baseURL: URL(string: "https://socratictrade.com")!)
    )

    var body: some Scene {
        WindowGroup {
            ContentView()
                .environmentObject(store)
        }
    }
}

struct ContentView: View {
    @Environment(\.scenePhase) private var scenePhase
    @EnvironmentObject private var store: MobileStore

    var body: some View {
        ZStack {
            LoginView()
                .opacity(store.hasInitialized && !store.isAuthenticated ? 1 : 0)
                .allowsHitTesting(store.hasInitialized && !store.isAuthenticated)
                .accessibilityHidden(!store.hasInitialized || store.isAuthenticated)

            MobileControlView()
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
    }

    private func bootstrap() async {
        guard !store.hasInitialized else { return }
        await store.load()
        if store.isAuthenticated {
            store.startEvents()
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
