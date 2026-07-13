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
            
            if store.busy {
                ProgressView()
            }
        }
        .padding()
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
