import SwiftUI

@main
struct SocraticTradeApp: App {
    @StateObject private var store = MobileStore(
        client: MobileAPIClient(baseURL: URL(string: "https://socratictrade.com")!)
    )

    var body: some Scene {
        WindowGroup {
            MobileControlView()
                .environmentObject(store)
        }
    }
}
