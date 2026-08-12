import SwiftUI
import WebKit

/// Owner-only sheet hosting the web /admin console inside a locked-down WKWebView.
/// The app's URLSession cookies (HTTPCookieStorage.shared) are copied into the web view's
/// cookie store before the first load, so the existing native session signs the portal in.
/// Navigation is fenced to https://socratictrade.com under /admin (plus /login and
/// /api/auth for the session-expiry bounce); everything else is cancelled.
struct AdminPortalView: View {
    @Environment(\.dismiss) private var dismiss
    @State private var sessionExpired = false

    var body: some View {
        NavigationStack {
            Group {
                if sessionExpired {
                    VStack(spacing: 14) {
                        Image(systemName: "person.crop.circle.badge.exclamationmark")
                            .font(.largeTitle)
                            .foregroundStyle(AppPalette.warning)
                        Text("Session Expired")
                            .font(.headline)
                        Text("The web session for the admin portal has expired.  Sign in again from the app's login screen, then reopen the portal.")
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                            .multilineTextAlignment(.center)
                        Button("Close") { dismiss() }
                            .buttonStyle(.borderedProminent)
                            .tint(AppPalette.accent)
                    }
                    .padding(28)
                } else {
                    AdminPortalWebView(onSessionExpired: { sessionExpired = true })
                        .ignoresSafeArea(edges: .bottom)
                }
            }
            .navigationTitle("Admin Portal")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Done") { dismiss() }
                }
            }
        }
    }
}

// Internal (not private) so the unit suite can pin the navigation fence.
struct AdminPortalWebView: UIViewRepresentable {
    static let portalURL = URL(string: "https://socratictrade.com/admin")!
    static let allowedHost = "socratictrade.com"

    let onSessionExpired: () -> Void

    func makeCoordinator() -> Coordinator {
        Coordinator(onSessionExpired: onSessionExpired)
    }

    func makeUIView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        // Ephemeral store: the session cookie is copied in fresh on every open, so persisting
        // it to disk buys nothing and would let the admin session outlive a native sign-out.
        configuration.websiteDataStore = .nonPersistent()
        let webView = WKWebView(frame: .zero, configuration: configuration)
        webView.navigationDelegate = context.coordinator
        webView.allowsBackForwardNavigationGestures = true

        // Copy the native session cookies (the app talks to the API over URLSession.shared,
        // which persists into HTTPCookieStorage.shared) into the web view before first load.
        let cookieStore = configuration.websiteDataStore.httpCookieStore
        let sessionCookies = (HTTPCookieStorage.shared.cookies ?? []).filter { cookie in
            cookie.domain.trimmingCharacters(in: CharacterSet(charactersIn: ".")).hasSuffix(Self.allowedHost)
        }
        let group = DispatchGroup()
        for cookie in sessionCookies {
            group.enter()
            cookieStore.setCookie(cookie) { group.leave() }
        }
        group.notify(queue: .main) {
            webView.load(URLRequest(url: Self.portalURL))
        }
        return webView
    }

    func updateUIView(_ webView: WKWebView, context: Context) {}

    final class Coordinator: NSObject, WKNavigationDelegate {
        let onSessionExpired: () -> Void

        init(onSessionExpired: @escaping () -> Void) {
            self.onSessionExpired = onSessionExpired
        }

        func webView(
            _ webView: WKWebView,
            decidePolicyFor navigationAction: WKNavigationAction,
            decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
        ) {
            guard let url = navigationAction.request.url else {
                decisionHandler(.cancel)
                return
            }
            // about:blank and friends appear during initial setup — harmless, allow.
            if url.scheme == "about" {
                decisionHandler(.allow)
                return
            }
            guard Self.isAllowed(url) else {
                decisionHandler(.cancel)
                return
            }
            if url.path == "/login" || url.path.hasPrefix("/login/") {
                // The portal bounced to sign-in: the copied session is no longer valid.
                onSessionExpired()
                decisionHandler(.cancel)
                return
            }
            decisionHandler(.allow)
        }

        /// https + socratictrade.com + a path inside /admin, or the session-expiry
        /// bounce surface (/login, /api/auth).  Nothing else loads in this sheet.
        static func isAllowed(_ url: URL) -> Bool {
            guard url.scheme == "https", url.host == AdminPortalWebView.allowedHost else { return false }
            let path = url.path
            if path == "/admin" || path.hasPrefix("/admin/") { return true }
            if path == "/login" || path.hasPrefix("/login/") { return true }
            if path.hasPrefix("/api/auth") { return true }
            return false
        }
    }
}
