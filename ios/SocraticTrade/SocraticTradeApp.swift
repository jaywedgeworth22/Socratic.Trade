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
    @EnvironmentObject private var store: MobileStore

    var body: some View {
        Group {
            if !store.hasInitialized {
                ProgressView()
                    .onAppear {
                        Task {
                            await store.load()
                            if store.isAuthenticated {
                                store.startEvents()
                            }
                        }
                    }
            } else if store.isAuthenticated {
                MobileControlView()
            } else {
                LoginView()
            }
        }
    }
}
