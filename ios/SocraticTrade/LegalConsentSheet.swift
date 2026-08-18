import SwiftUI

/// Blocking first-use clickwrap.  Accepting the current version dismisses it
/// until Terms / data-pool versions bump.  There is no decline path.
struct LegalConsentSheet: View {
    @EnvironmentObject private var store: MobileStore

    var body: some View {
        NavigationStack {
            VStack(alignment: .leading, spacing: 16) {
                Text("Not investment advice.  You set authority.")
                    .font(.appHeadline)

                Text("Socratic Trade is software you configure.  Using the app requires accepting the Terms and Privacy Policy, and contributing general market data — quotes, fundamentals, history, and news — to a shared pool.  Personal account data stays private.")
                    .font(.appBody)
                    .foregroundStyle(.secondary)

                Text("You can delete your account yourself in Account & Settings.  Database backups are retained for 7 days.  Fact-tier research may join the shared RAG corpus; risk and strategy directives do not.")
                    .font(.appBody)
                    .foregroundStyle(.secondary)

                HStack(spacing: 16) {
                    Link("Terms", destination: URL(string: "https://socratictrade.com/terms-and-conditions")!)
                    Link("Privacy", destination: URL(string: "https://socratictrade.com/privacy-policy")!)
                }
                .font(.appSubheadline)

                Spacer()

                Button {
                    Task { await store.acceptAppConsent() }
                } label: {
                    Text(store.isAcceptingConsent ? "Saving…" : "Accept & Continue")
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)
                .disabled(store.isAcceptingConsent)
            }
            .padding(24)
            .navigationTitle("Terms, Privacy, and Shared Data")
            .navigationBarTitleDisplayMode(.inline)
        }
        .interactiveDismissDisabled()
    }
}
