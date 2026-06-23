import SwiftUI

@main
struct AgenticTradingApp: App {
    @StateObject private var store = MobileStore(
        client: MobileAPIClient(baseURL: URL(string: "https://codex.jays.services")!)
    )

    var body: some Scene {
        WindowGroup {
            MobileControlView()
                .environmentObject(store)
        }
    }
}
