import { redactForTelemetry, safeErrorMessage } from "./telemetry-sanitize";

type LlmGenerationOptions<T> = {
  name: string;
  model: string;
  userId?: string;
  sessionId?: string;
  input?: unknown;
  metadata?: Record<string, unknown>;
  tags?: string[];
  output?: (result: T) => unknown;
};

type TraceProvider = {
  register: () => void;
};

type TraceProviderConstructor = new (config: { spanProcessors: unknown[] }) => TraceProvider;
type SpanProcessorConstructor = new (config: Record<string, unknown>) => unknown;
type LangfuseGeneration = {
  update: (fields: Record<string, unknown>) => void;
  end: () => void;
};
type LangfuseTracing = {
  propagateAttributes: <T>(attributes: Record<string, unknown>, run: () => Promise<T>) => Promise<T>;
  startObservation: (
    name: string,
    attributes: Record<string, unknown>,
    options: Record<string, unknown>
  ) => LangfuseGeneration;
};

declare global {
  // eslint-disable-next-line no-var
  var __tradingObservabilityStarted: boolean | undefined;
  // eslint-disable-next-line no-var
  var __tradingObservabilitySdk: unknown | undefined;
  // eslint-disable-next-line no-var
  var __tradingObservabilityWarned: boolean | undefined;
}

const runtimeImport = new Function("specifier", "return import(specifier)") as <T>(specifier: string) => Promise<T>;

export async function startObservability(): Promise<void> {
  if (!langfuseConfigured() || globalThis.__tradingObservabilityStarted) return;

  try {
    const [{ NodeTracerProvider }, { LangfuseSpanProcessor }] = await Promise.all([
      runtimeImport<{ NodeTracerProvider: TraceProviderConstructor }>("@opentelemetry/sdk-trace-node"),
      runtimeImport<{ LangfuseSpanProcessor: SpanProcessorConstructor }>("@langfuse/otel")
    ]);

    const provider = new NodeTracerProvider({
      spanProcessors: [
        new LangfuseSpanProcessor({
          publicKey: process.env.LANGFUSE_PUBLIC_KEY,
          secretKey: process.env.LANGFUSE_SECRET_KEY,
          baseUrl: process.env.LANGFUSE_BASE_URL,
          environment: process.env.LANGFUSE_TRACING_ENVIRONMENT || process.env.NODE_ENV || "development",
          release: process.env.LANGFUSE_RELEASE || process.env.VERCEL_GIT_COMMIT_SHA || process.env.npm_package_version,
          mask: ({ data }: { data: unknown }) => redactForTelemetry(data)
        })
      ]
    });

    provider.register();
    globalThis.__tradingObservabilitySdk = provider;
    globalThis.__tradingObservabilityStarted = true;
  } catch (error) {
    warnOnce(`Langfuse OpenTelemetry startup failed: ${safeErrorMessage(error)}`);
  }
}

export async function withLlmGeneration<T>(options: LlmGenerationOptions<T>, run: () => Promise<T>): Promise<T> {
  if (!langfuseConfigured()) return run();

  let attemptedRun = false;

  try {
    const { propagateAttributes, startObservation } = await runtimeImport<LangfuseTracing>("@langfuse/tracing");
    const observationMetadata = redactForTelemetry(options.metadata) as Record<string, unknown> | undefined;
    return (await propagateAttributes(
      {
        userId: options.userId,
        sessionId: options.sessionId,
        traceName: options.name,
        tags: options.tags,
        metadata: compactTraceMetadata(options.metadata)
      },
      async () => {
        let generation: ReturnType<typeof startObservation>;

        try {
          generation = startObservation(
            options.name,
            {
              model: options.model,
              input: redactForTelemetry(options.input),
              metadata: observationMetadata
            },
            { asType: "generation" }
          );
        } catch (error) {
          warnOnce(`Langfuse observation startup failed: ${safeErrorMessage(error)}`);
          attemptedRun = true;
          return run();
        }

        try {
          attemptedRun = true;
          const result = await run();
          try {
            generation.update({
              output: redactForTelemetry(options.output ? options.output(result) : undefined),
              level: "DEFAULT"
            });
            generation.end();
          } catch (error) {
            warnOnce(`Langfuse observation update failed: ${safeErrorMessage(error)}`);
          }
          return result;
        } catch (error) {
          try {
            generation.update({
              output: { error: safeErrorMessage(error) },
              level: "ERROR",
              statusMessage: safeErrorMessage(error)
            });
            generation.end();
          } catch (telemetryError) {
            warnOnce(`Langfuse observation error update failed: ${safeErrorMessage(telemetryError)}`);
          }
          throw error;
        }
      }
    )) as T;
  } catch (error) {
    if (attemptedRun) throw error;
    warnOnce(`Langfuse manual tracing failed: ${safeErrorMessage(error)}`);
    return run();
  }
}

function langfuseConfigured(): boolean {
  return (
    process.env.LANGFUSE_ENABLED !== "off" &&
    Boolean(process.env.LANGFUSE_PUBLIC_KEY) &&
    Boolean(process.env.LANGFUSE_SECRET_KEY)
  );
}

function warnOnce(message: string): void {
  if (globalThis.__tradingObservabilityWarned) return;
  globalThis.__tradingObservabilityWarned = true;
  console.warn(message);
}

function compactTraceMetadata(metadata: Record<string, unknown> | undefined): Record<string, string> | undefined {
  if (!metadata) return undefined;
  const redacted = redactForTelemetry(metadata) as Record<string, unknown>;
  return Object.fromEntries(
    Object.entries(redacted)
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => {
        const raw = typeof value === "string" ? value : JSON.stringify(value);
        return [key, raw.length > 200 ? `${raw.slice(0, 197)}...` : raw];
      })
  );
}
