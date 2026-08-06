import AuthenticationServices
import SwiftUI

struct LoginView: View {
    @Environment(\.colorScheme) private var colorScheme
    @EnvironmentObject private var store: MobileStore

    var body: some View {
        ZStack {
            LinearGradient(
                colors: [AppPalette.accent.opacity(0.22), AppPalette.background, AppPalette.background],
                startPoint: .topLeading,
                endPoint: .bottomTrailing
            )
            .ignoresSafeArea()

            ScrollView {
                VStack(spacing: 28) {
                    brand
                    valueCard
                    signIn
                    privacyNote
                }
                .frame(maxWidth: 560)
                .padding(.horizontal, 24)
                .padding(.vertical, 54)
                .frame(maxWidth: .infinity)
            }
        }
    }

    private var brand: some View {
        VStack(spacing: 14) {
            ZStack {
                RoundedRectangle(cornerRadius: 24, style: .continuous)
                    .fill(AppPalette.accent.gradient)
                Image(systemName: "chart.line.uptrend.xyaxis")
                    .font(.system(size: 38, weight: .semibold))
                    .foregroundStyle(.white)
            }
            .frame(width: 82, height: 82)
            .shadow(color: AppPalette.accent.opacity(0.28), radius: 20, y: 10)

            VStack(spacing: 5) {
                Text("Socratic Trade")
                    .font(.largeTitle.weight(.bold))
                Text("Control remote for your trading agent")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }
        }
    }

    private var valueCard: some View {
        AppCard {
            VStack(alignment: .leading, spacing: 14) {
                LoginFeature(systemImage: "checklist", text: "Review and approve proposals on the go")
                LoginFeature(systemImage: "chart.xyaxis.line", text: "Track positions, orders, and performance")
                LoginFeature(systemImage: "bolt.shield.fill", text: "Full desk stays on desktop — phone is a control remote")
            }
        }
    }

    private var signIn: some View {
        VStack(spacing: 12) {
            if let error = store.error {
                HStack(alignment: .top, spacing: 9) {
                    Image(systemName: "exclamationmark.triangle.fill")
                        .foregroundStyle(AppPalette.warning)
                    Text(error)
                        .font(.subheadline)
                        .fixedSize(horizontal: false, vertical: true)
                    Spacer(minLength: 0)
                }
                .padding(13)
                .background(AppPalette.warning.opacity(0.1), in: RoundedRectangle(cornerRadius: 14))
            }

            SignInWithAppleButton(
                .continue,
                onRequest: configure,
                onCompletion: complete
            )
            .signInWithAppleButtonStyle(colorScheme == .dark ? .white : .black)
            .frame(height: 52)
            // Apple's ASAuthorizationAppleIDButton hard-caps width at 375pt. Stretching the
            // UIKit host wider (e.g. 392pt after horizontal padding) trips unsatisfiable
            // NSAutoresizingMaskLayoutConstraints in the console. Do not follow this with
            // another maxWidth:.infinity — that re-expands the UIKit host and revives the conflict.
            .frame(maxWidth: 375)
            .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
            .disabled(store.isSigningIn)
            .overlay {
                if store.isSigningIn {
                    RoundedRectangle(cornerRadius: 12, style: .continuous)
                        .fill(Color.black.opacity(0.35))
                    ProgressView()
                        .tint(.white)
                }
            }

            webAuthButton(provider: "google", title: "Sign in with Google", systemImage: "g.circle.fill", tint: .blue)
            webAuthButton(provider: "github", title: "Sign in with GitHub", systemImage: "chevron.left.forwardslash.chevron.right", tint: .gray)
        }
    }

    private func webAuthButton(provider: String, title: String, systemImage: String, tint: Color) -> some View {
        Button {
            beginWebAuth(provider: provider)
        } label: {
            Label(title, systemImage: systemImage)
                .font(.body.weight(.semibold))
                .frame(maxWidth: .infinity)
                .frame(minHeight: 52)
                .foregroundStyle(.white)
                .background(tint, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        }
        .disabled(store.isSigningIn)
        .accessibilityHint("Opens the secure Socratic Trade sign-in page")
    }

    private var privacyNote: some View {
        Label(
            "The app stores only your Socratic Trade session. Broker and provider secrets stay on the backend.",
            systemImage: "lock.fill"
        )
        .font(.caption)
        .foregroundStyle(.secondary)
        .multilineTextAlignment(.center)
    }

    private func configure(_ request: ASAuthorizationAppleIDRequest) {
        store.dismissError()
        request.requestedScopes = [.fullName, .email]
    }

    private func complete(_ result: Result<ASAuthorization, Error>) {
        switch result {
        case .success(let authorization):
            handleAuthorization(authorization)
        case .failure(let error):
            if let authorizationError = error as? ASAuthorizationError,
               authorizationError.code == .canceled {
                return
            }
            store.error = error.localizedDescription
        }
    }

    private func handleAuthorization(_ authorization: ASAuthorization) {
        guard
            let credential = authorization.credential as? ASAuthorizationAppleIDCredential,
            let tokenData = credential.identityToken,
            let identityToken = String(data: tokenData, encoding: .utf8)
        else {
            store.error = "Apple did not return an identity token. Try again."
            return
        }

        let name: String? = {
            guard let fullName = credential.fullName else { return nil }
            let components = [fullName.givenName, fullName.familyName].compactMap { $0 }
            return components.isEmpty ? nil : components.joined(separator: " ")
        }()

        Task {
            await store.loginWithApple(identityToken: identityToken, name: name)
        }
    }

    private func beginWebAuth(provider: String) {
        store.dismissError()
        guard let verifier = WebAuthCodeVerifier.make() else {
            store.error = "Could not securely start web sign-in. Try again."
            return
        }
        guard var callbackComponents = URLComponents(string: "https://socratictrade.com/api/mobile/auth-redirect") else {
            store.error = "Could not prepare web sign-in."
            return
        }
        callbackComponents.queryItems = [
            URLQueryItem(name: "code_challenge", value: verifier.challenge)
        ]
        guard let callbackURL = callbackComponents.url,
              var components = URLComponents(string: "https://socratictrade.com/api/auth/signin/\(provider)") else {
            store.error = "Could not prepare web sign-in."
            return
        }
        components.queryItems = [
            URLQueryItem(name: "callbackUrl", value: callbackURL.absoluteString)
        ]
        guard let url = components.url else {
            store.error = "Could not start web sign-in."
            return
        }

        let contextProvider = WebAuthContextProvider()
        let session = ASWebAuthenticationSession(url: url, callbackURLScheme: "socratictrade") { callbackURL, error in
            if let error {
                if let authError = error as? ASWebAuthenticationSessionError, authError.code == .canceledLogin {
                    return
                }
                Task { @MainActor in store.error = error.localizedDescription }
                return
            }
            guard
                let callbackURL,
                let code = URLComponents(url: callbackURL, resolvingAgainstBaseURL: false)?.queryItems?.first(where: { $0.name == "code" })?.value,
                !code.isEmpty
            else {
                Task { @MainActor in store.error = "Invalid callback URL from web sign-in." }
                return
            }
            Task { @MainActor in
                await store.loginWithWebAuthCode(code, verifier: verifier.value)
            }
        }
        session.presentationContextProvider = contextProvider
        session.prefersEphemeralWebBrowserSession = false
        WebAuthSessionManager.shared.start(session: session, provider: contextProvider)
    }
}

private struct LoginFeature: View {
    let systemImage: String
    let text: String

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: systemImage)
                .foregroundStyle(AppPalette.accent)
                .frame(width: 28)
            Text(text)
                .font(.subheadline)
            Spacer(minLength: 0)
        }
    }
}

@MainActor
private final class WebAuthSessionManager {
    static let shared = WebAuthSessionManager()
    private var session: ASWebAuthenticationSession?
    private var contextProvider: WebAuthContextProvider?

    func start(session: ASWebAuthenticationSession, provider: WebAuthContextProvider) {
        self.session = session
        self.contextProvider = provider
        session.start()
    }
}

private final class WebAuthContextProvider: NSObject, ASWebAuthenticationPresentationContextProviding {
    func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        UIApplication.shared.connectedScenes
            .compactMap { $0 as? UIWindowScene }
            .flatMap(\.windows)
            .first(where: { $0.isKeyWindow }) ?? ASPresentationAnchor()
    }
}

#if DEBUG
#Preview("Login") {
    LoginView()
        .environmentObject(
            MobileStore(client: MobileAPIClient(baseURL: URL(string: "https://socratictrade.com")!))
        )
}
#endif
