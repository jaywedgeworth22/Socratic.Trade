import Foundation
import Sentry

/// Native Sentry telemetry and crash reporting for Socratic Trade iOS.
///
/// Features enabled under the sponsored tier:
/// - Native crash reporting (SIGSEGV, uncaught exceptions, OOM)
/// - UI freeze / App hang detection (>2.0s main thread hang)
/// - HTTP 5xx client request failure capture
/// - Distributed tracing (0.2 sample rate)
/// - Strict financial privacy: screenshot & view hierarchy capture disabled, PII disabled
enum SentryTelemetry {
    static let defaultDSN = "https://sentry.io/api/0/" // Gated via bundle/Info.plist or hardcoded project DSN

    static func start() {
        guard !SocraticTradeApp.isScreenshotMode else { return }

        // Socratic Trade project DSN
        let dsn = Bundle.main.object(forInfoDictionaryKey: "SENTRY_DSN") as? String
            ?? "https://4511650513158144@o4511650476326912.ingest.us.sentry.io/4511650513158144"

        guard !dsn.isEmpty else { return }

        SentrySDK.start { options in
            options.dsn = dsn
            options.environment = "production"
            options.tracesSampleRate = 0.2
            options.enableAppHangTracking = true
            options.appHangTimeoutInterval = 2.0
            options.enableCaptureFailedRequests = true
            options.failedRequestStatusCodes = [HttpStatusCodeRange(min: 500, max: 599)]
            options.attachScreenshot = false
            options.attachViewHierarchy = false
            options.sendDefaultPii = false
            options.beforeSend = { event in
                // Redact any possible sensitive query parameters in event URLs
                if let request = event.request, let url = request.url {
                    var sanitized = url
                    for param in ["symbol", "proposal", "account", "token", "key", "secret"] {
                        sanitized = sanitized.replacingOccurrences(
                            of: "([?&]\(param)=)[^&#\\s]+",
                            with: "$1[REDACTED]",
                            options: .regularExpression
                        )
                    }
                    request.url = sanitized
                }
                return event
            }
        }
    }
}
