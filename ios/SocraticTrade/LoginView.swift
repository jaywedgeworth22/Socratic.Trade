import SwiftUI
import AuthenticationServices

struct LoginView: View {
    @EnvironmentObject private var store: MobileStore
    
    var body: some View {
        VStack(spacing: 40) {
            Text("Socratic.Trade")
                .font(.largeTitle)
                .bold()
            
            if let error = store.error {
                Text(error)
                    .foregroundStyle(.red)
                    .multilineTextAlignment(.center)
                    .padding()
            }
            
            SignInWithAppleButton(
                .signIn,
                onRequest: { request in
                    request.requestedScopes = [.fullName, .email]
                },
                onCompletion: { result in
                    switch result {
                    case .success(let authorization):
                        handleAuthorization(authorization)
                    case .failure(let error):
                        if let asError = error as? ASAuthorizationError, asError.code == .canceled {
                            // User canceled, ignore
                        } else {
                            store.error = error.localizedDescription
                        }
                    }
                }
            )
            .signInWithAppleButtonStyle(.black)
            .frame(height: 50)
            .padding(.horizontal, 40)
            
            Button(action: {
                initiateWebAuth(provider: "google")
            }) {
                HStack {
                    Image(systemName: "g.circle.fill")
                    Text("Sign in with Google")
                        .bold()
                }
                .frame(maxWidth: .infinity)
                .frame(height: 50)
                .background(Color.blue)
                .foregroundColor(.white)
                .cornerRadius(8)
            }
            .padding(.horizontal, 40)

            Button(action: {
                initiateWebAuth(provider: "github")
            }) {
                HStack {
                    Image(systemName: "chevron.left.forwardslash.chevron.right")
                    Text("Sign in with GitHub")
                        .bold()
                }
                .frame(maxWidth: .infinity)
                .frame(height: 50)
                .background(Color.gray)
                .foregroundColor(.white)
                .cornerRadius(8)
            }
            .padding(.horizontal, 40)
            
            if store.busy {
                ProgressView()
            }
        }
        .padding()
    }
    
    private func initiateWebAuth(provider: String) {
        guard let url = URL(string: "https://socratictrade.com/api/auth/signin/\(provider)?callbackUrl=https://socratictrade.com/api/mobile/auth-redirect") else { return }
        
        let scheme = "socratictrade"
        
        let session = ASWebAuthenticationSession(url: url, callbackURLScheme: scheme) { callbackURL, error in
            if let error = error {
                if let asError = error as? ASWebAuthenticationSessionError, asError.code == .canceledLogin {
                    // user canceled, ignore
                } else {
                    store.error = error.localizedDescription
                }
                return
            }
            
            guard let callbackURL = callbackURL else { return }
            
            // Extract the token from the URL query params: socratictrade://auth?token=<jwt>
            guard let components = URLComponents(url: callbackURL, resolvingAgainstBaseURL: false),
                  let queryItems = components.queryItems,
                  let token = queryItems.first(where: { $0.name == "token" })?.value else {
                store.error = "Invalid callback URL from web auth."
                return
            }
            
            Task {
                await store.loginWithToken(jwt: token)
            }
        }
        
        let contextProvider = ContextProvider()
        session.presentationContextProvider = contextProvider
        session.prefersEphemeralWebBrowserSession = false 
        
        // Retain the context provider by storing it locally or letting it live during the call.
        // Actually, ASWebAuthenticationSession keeps a weak reference to presentationContextProvider!
        // We need to keep a strong reference. We can use a small hack or bind it to the view.
        // Let's create an instance property or a global temporary holder.
        WebAuthSessionManager.shared.start(session: session, provider: contextProvider)
    }
}

class WebAuthSessionManager {
    static let shared = WebAuthSessionManager()
    private var currentSession: ASWebAuthenticationSession?
    private var currentProvider: ContextProvider?
    
    func start(session: ASWebAuthenticationSession, provider: ContextProvider) {
        self.currentSession = session
        self.currentProvider = provider
        session.start()
    }
}

class ContextProvider: NSObject, ASWebAuthenticationPresentationContextProviding {
    func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        return UIApplication.shared.connectedScenes
            .compactMap { $0 as? UIWindowScene }
            .flatMap { $0.windows }
            .first { $0.isKeyWindow } ?? ASPresentationAnchor()
    }
    
    private func handleAuthorization(_ authorization: ASAuthorization) {
        guard let appleIDCredential = authorization.credential as? ASAuthorizationAppleIDCredential,
              let identityTokenData = appleIDCredential.identityToken,
              let identityToken = String(data: identityTokenData, encoding: .utf8) else {
            store.error = "Failed to extract identity token from Apple."
            return
        }
        
        let name: String? = {
            if let fullName = appleIDCredential.fullName {
                let parts = [fullName.givenName, fullName.familyName].compactMap { $0 }
                return parts.isEmpty ? nil : parts.joined(separator: " ")
            }
            return nil
        }()
        
        Task {
            await store.loginWithApple(identityToken: identityToken, name: name)
        }
    }
}
