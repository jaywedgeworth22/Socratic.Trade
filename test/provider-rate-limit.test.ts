import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ProviderRateLimiter,
  appendErrorCause,
  redactApiKeyParams,
  redactSecretValue,
  resolveProviderLimiterConfig,
  scrubProviderErrorText,
  type ProviderLimiterClock,
} from "../src/lib/provider-rate-limit";

/** Drain every currently-queued microtask (including ones scheduled BY other microtasks
 *  along the way) before returning. A macrotask boundary (real setTimeout) always runs
 *  after the microtask queue is fully empty, so this is robust regardless of how many
 *  promise-chain hops a given continuation needs — unlike counting `await Promise.resolve()`
 *  calls, which is fragile and engine-dependent. */
function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** A clock whose `sleep` never resolves on its own — the test advances virtual time and
 *  manually resolves any sleeps whose deadline has passed. Keeps pacing tests instant and
 *  deterministic instead of waiting on real timers. */
class FakeClock implements ProviderLimiterClock {
  private currentTime = 0;
  private pending: Array<{ resolveAt: number; resolve: () => void }> = [];

  now(): number {
    return this.currentTime;
  }

  sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      this.pending.push({ resolveAt: this.currentTime + ms, resolve });
    });
  }

  /** Advance virtual time, resolve any sleeps whose deadline has now passed, and let the
   *  resulting continuation chain (pump() re-entrancy, etc.) fully settle. */
  async advance(ms: number): Promise<void> {
    this.currentTime += ms;
    const ready = this.pending.filter((p) => p.resolveAt <= this.currentTime);
    this.pending = this.pending.filter((p) => p.resolveAt > this.currentTime);
    for (const p of ready) p.resolve();
    await flushMicrotasks();
  }
}

const ENV_KEYS = [
  "PROVIDER_RATE_LIMIT_TESTPROV_PER_MIN",
  "PROVIDER_RATE_LIMIT_TESTPROV_MIN_INTERVAL_MS",
  "PROVIDER_RATE_LIMIT_TESTPROV_CONCURRENCY",
  "PROVIDER_RATE_LIMIT_FINNHUB_PER_MIN",
  "PROVIDER_RATE_LIMIT_FINNHUB_MIN_INTERVAL_MS",
  "PROVIDER_RATE_LIMIT_ALPHA_VANTAGE_MIN_INTERVAL_MS",
  "PROVIDER_RATE_LIMIT_ALPHA_VANTAGE_CONCURRENCY",
];

function clearEnv() {
  for (const key of ENV_KEYS) delete process.env[key];
}

describe("resolveProviderLimiterConfig", () => {
  beforeEach(clearEnv);
  afterEach(clearEnv);

  it("returns undefined (unlimited) for a provider with no hard default and no env override", () => {
    expect(resolveProviderLimiterConfig("some-random-provider")).toBeUndefined();
  });

  it("derives finnhub's hard default of 50/min into a ~1200ms interval with unbounded concurrency", () => {
    const config = resolveProviderLimiterConfig("finnhub");
    expect(config).toBeDefined();
    expect(config?.minIntervalMs).toBe(Math.ceil(60_000 / 50));
    expect(config?.concurrency).toBe(Infinity);
  });

  it("uses alpha-vantage's hard default of >=1100ms spacing and concurrency 1", () => {
    const config = resolveProviderLimiterConfig("alpha-vantage");
    expect(config).toEqual({ minIntervalMs: 1100, concurrency: 1 });
  });

  it("uses yahoo-finance's hard default of ~400ms spacing and concurrency 2", () => {
    const config = resolveProviderLimiterConfig("yahoo-finance");
    expect(config).toEqual({ minIntervalMs: 400, concurrency: 2 });
  });

  // Regression: twelvedata had NO entry here at all, so its fetch call went completely
  // unpaced and was 100% HTTP 429 in prod even after finnhub/yahoo/alpha-vantage were fixed.
  it("uses twelvedata's hard default of strictly-serial 10s spacing (free Basic tier is 8 credits/min)", () => {
    const config = resolveProviderLimiterConfig("twelvedata");
    expect(config).toEqual({ minIntervalMs: 10_000, concurrency: 1 });
  });

  it("lets an env PER_MIN override win over a provider with no hard default", () => {
    process.env.PROVIDER_RATE_LIMIT_TESTPROV_PER_MIN = "30";
    const config = resolveProviderLimiterConfig("testprov");
    expect(config?.minIntervalMs).toBe(2000); // 60000 / 30
    expect(config?.concurrency).toBe(Infinity);
  });

  it("lets an env PER_MIN override replace finnhub's hard default", () => {
    process.env.PROVIDER_RATE_LIMIT_FINNHUB_PER_MIN = "30";
    const config = resolveProviderLimiterConfig("finnhub");
    expect(config?.minIntervalMs).toBe(2000);
  });

  it("prefers MIN_INTERVAL_MS over PER_MIN when both env vars are set", () => {
    process.env.PROVIDER_RATE_LIMIT_FINNHUB_PER_MIN = "30";
    process.env.PROVIDER_RATE_LIMIT_FINNHUB_MIN_INTERVAL_MS = "777";
    const config = resolveProviderLimiterConfig("finnhub");
    expect(config?.minIntervalMs).toBe(777);
  });

  it("lets an env CONCURRENCY override replace a hard default's concurrency", () => {
    process.env.PROVIDER_RATE_LIMIT_ALPHA_VANTAGE_CONCURRENCY = "3";
    const config = resolveProviderLimiterConfig("alpha-vantage");
    expect(config?.concurrency).toBe(3);
    expect(config?.minIntervalMs).toBe(1100); // untouched hard default
  });

  it("uppercases and normalizes non-alphanumeric characters into the env var name", () => {
    process.env.PROVIDER_RATE_LIMIT_ALPHA_VANTAGE_MIN_INTERVAL_MS = "2500";
    expect(resolveProviderLimiterConfig("alpha-vantage")?.minIntervalMs).toBe(2500);
  });
});

describe("ProviderRateLimiter pacing (fake clock)", () => {
  beforeEach(clearEnv);
  afterEach(clearEnv);

  it("passes an unconfigured provider straight through with no delay", async () => {
    const clock = new FakeClock();
    const limiter = new ProviderRateLimiter(clock);
    let called = false;
    const result = await limiter.withLimit("unlimited-provider", async () => {
      called = true;
      return 42;
    });
    expect(called).toBe(true);
    expect(result).toBe(42);
  });

  it("spaces successive dispatches by at least minIntervalMs", async () => {
    process.env.PROVIDER_RATE_LIMIT_TESTPROV_MIN_INTERVAL_MS = "100";
    process.env.PROVIDER_RATE_LIMIT_TESTPROV_CONCURRENCY = "10"; // isolate pacing from concurrency
    const clock = new FakeClock();
    const limiter = new ProviderRateLimiter(clock);
    const dispatchTimes: number[] = [];

    const task = (n: number) =>
      limiter.withLimit("testprov", async () => {
        dispatchTimes.push(clock.now());
        return n;
      });

    const p1 = task(1);
    const p2 = task(2);
    const p3 = task(3);

    // First dispatch is immediate (no prior dispatch to space against).
    await flushMicrotasks();
    expect(dispatchTimes).toEqual([0]);

    // Advancing less than the interval must not admit the next waiter yet.
    await clock.advance(50);
    expect(dispatchTimes).toEqual([0]);

    // Crossing the interval boundary admits exactly the next one.
    await clock.advance(50);
    expect(dispatchTimes).toEqual([0, 100]);

    await clock.advance(100);
    expect(dispatchTimes).toEqual([0, 100, 200]);

    await Promise.all([p1, p2, p3]);
  });

  it("never runs more than `concurrency` tasks at once even with zero spacing", async () => {
    process.env.PROVIDER_RATE_LIMIT_TESTPROV_MIN_INTERVAL_MS = "0";
    process.env.PROVIDER_RATE_LIMIT_TESTPROV_CONCURRENCY = "2";
    const clock = new FakeClock();
    const limiter = new ProviderRateLimiter(clock);

    let inFlight = 0;
    let maxInFlight = 0;
    const releasers: Array<() => void> = [];

    const task = () =>
      limiter.withLimit("testprov", () => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        return new Promise<void>((resolve) => {
          releasers.push(() => {
            inFlight--;
            resolve();
          });
        });
      });

    const results = [task(), task(), task(), task()];
    await flushMicrotasks();

    expect(maxInFlight).toBe(2); // never exceeds the configured concurrency cap
    expect(releasers.length).toBe(2); // only 2 admitted; the rest are queued

    // Release the first two — the queued pair should now be admitted.
    releasers[0]();
    releasers[1]();
    await flushMicrotasks();
    expect(releasers.length).toBe(4);

    releasers[2]();
    releasers[3]();
    await Promise.all(results);
    expect(maxInFlight).toBe(2);
  });

  it("reset() clears bookkeeping so a fresh call is treated as the first dispatch", async () => {
    process.env.PROVIDER_RATE_LIMIT_TESTPROV_MIN_INTERVAL_MS = "1000";
    const clock = new FakeClock();
    const limiter = new ProviderRateLimiter(clock);

    await limiter.withLimit("testprov", async () => "first");
    limiter.reset("testprov");

    let called = false;
    // No advance() at all — if state weren't reset, this would hang waiting on the interval.
    const p = limiter.withLimit("testprov", async () => {
      called = true;
    });
    await flushMicrotasks();
    expect(called).toBe(true);
    await p;
  });
});

// Regression coverage for a real bug: every withProviderLimit call site in
// data-providers.ts used to create its AbortController and arm its HTTP-timeout
// setTimeout BEFORE calling withProviderLimit, i.e. before the request even joined the
// pacer's queue. That means queue wait counted against the HTTP timeout — with enough
// near-simultaneous callers paced well apart (e.g. Finnhub's ~1200ms spacing), every
// request dispatched after ~timeoutMs was already aborted the instant it ran (an
// AbortError storm), even though nothing was actually slow. The fix (applied to the
// finnhub/alpha-vantage/yahoo-finance call sites in src/lib/data-providers.ts) arms the
// controller/timeout INSIDE the function passed to withProviderLimit, so the clock only
// starts ticking once the pacer actually dispatches the call.
//
// These tests model both shapes against a simulated fetch (checks `signal.aborted`
// up front, exactly like the real Fetch API does for an already-aborted signal) to prove
// the fix's shape survives a queue wait longer than the request timeout, and that the
// buggy shape it replaced would NOT have survived it.
describe("queue wait must not consume the caller's request timeout", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    clearEnv();
    delete process.env.PROVIDER_RATE_LIMIT_TESTPROVBUGGY_CONCURRENCY;
    delete process.env.PROVIDER_RATE_LIMIT_TESTPROVBUGGY_MIN_INTERVAL_MS;
  });

  /** Mimics a `fetch(url, { signal })` call: rejects immediately if the signal is ALREADY
   *  aborted (matching real Fetch API semantics for a pre-aborted signal), otherwise
   *  resolves after `delayMs` unless aborted first. */
  function simulatedFetch(signal: AbortSignal, delayMs: number): Promise<string> {
    return new Promise((resolve, reject) => {
      if (signal.aborted) {
        reject(new DOMException("The operation was aborted", "AbortError"));
        return;
      }
      const done = setTimeout(() => resolve("ok"), delayMs);
      signal.addEventListener(
        "abort",
        () => {
          clearTimeout(done);
          reject(new DOMException("The operation was aborted", "AbortError"));
        },
        { once: true }
      );
    });
  }

  it("FIXED shape: arming the abort timer INSIDE the limiter callback survives a queue wait longer than the timeout", async () => {
    process.env.PROVIDER_RATE_LIMIT_TESTPROV_CONCURRENCY = "1";
    // Force the 2nd call to queue for 8s -- longer than its own 6s request timeout below.
    process.env.PROVIDER_RATE_LIMIT_TESTPROV_MIN_INTERVAL_MS = "8000";
    // The pacer's own clock uses the SAME (faked) global timers as the abort timeout, so
    // vi.advanceTimersByTimeAsync moves both in lockstep, exactly like production where a
    // real setTimeout backs both the pacer's spacing and the caller's abort timer.
    const limiter = new ProviderRateLimiter({ now: () => Date.now(), sleep: (ms) => new Promise((r) => setTimeout(r, ms)) });

    const correctRequest = (label: string) =>
      limiter.withLimit("testprov", async () => {
        // Controller + timeout created INSIDE the pacer callback -- armed at dispatch time.
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 6000);
        try {
          return await simulatedFetch(controller.signal, 100).then((v) => `${label}-${v}`);
        } finally {
          clearTimeout(timeout);
        }
      });

    const first = correctRequest("first");
    const second = correctRequest("second");

    // First dispatches immediately; its simulated 100ms fetch completes well inside its
    // own 6s timeout.
    await vi.advanceTimersByTimeAsync(100);
    await expect(first).resolves.toBe("first-ok");

    // Second was queued the whole time and only gets admitted once the 8s pacing interval
    // elapses -- LONGER than the 6s timeout it will arm once dispatched. Advancing past
    // that point must still resolve it successfully, because its timer didn't even exist
    // (let alone start counting) until this moment.
    await vi.advanceTimersByTimeAsync(8000);
    await expect(second).resolves.toBe("second-ok");
  });

  it("BUGGY shape (regression guard): arming the abort timer BEFORE enqueueing aborts once queue wait exceeds the timeout", async () => {
    process.env.PROVIDER_RATE_LIMIT_TESTPROVBUGGY_CONCURRENCY = "1";
    process.env.PROVIDER_RATE_LIMIT_TESTPROVBUGGY_MIN_INTERVAL_MS = "8000";
    const limiter = new ProviderRateLimiter({ now: () => Date.now(), sleep: (ms) => new Promise((r) => setTimeout(r, ms)) });

    const buggyRequest = (label: string) => {
      // Controller + timeout created BEFORE calling withLimit -- the exact anti-pattern
      // this suite guards against. The clock starts ticking at ENQUEUE time.
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 6000);
      return limiter.withLimit("testprovbuggy", async () => {
        try {
          return await simulatedFetch(controller.signal, 100).then((v) => `${label}-${v}`);
        } finally {
          clearTimeout(timeout);
        }
      });
    };

    const first = buggyRequest("first");
    const second = buggyRequest("second");
    // Attach a rejection handler SYNCHRONOUSLY (same tick as creation) so this promise is
    // never observed as "unhandled" between the moment it rejects (deep inside the fake
    // timer/microtask machinery below) and the moment the assertion below awaits it --
    // that gap would otherwise trip Node's unhandledRejection detector as test noise.
    const secondSettled = second.then(
      (value) => ({ ok: true as const, value }),
      (error) => ({ ok: false as const, error })
    );

    await vi.advanceTimersByTimeAsync(100);
    await expect(first).resolves.toBe("first-ok");

    // By the time the pacer admits "second" (~8s in), its pre-armed 6s timer already fired
    // at ~6s, aborting a request that was still sitting in the queue and hadn't even been
    // dispatched yet -- reproducing the "instant AbortError storm" bug.
    await vi.advanceTimersByTimeAsync(8000);
    const result = await secondSettled;
    expect(result.ok).toBe(false);
    expect(result.ok === false && String(result.error)).toMatch(/aborted/i);
  });
});

describe("secret scrubbing", () => {
  it("redacts apikey=<value> query params regardless of casing", () => {
    const text = "GET https://example.com/query?function=X&apikey=SUPERSECRET123 failed";
    expect(redactApiKeyParams(text)).toBe("GET https://example.com/query?function=X&apikey=*** failed");
    expect(redactApiKeyParams("...&ApiKey=abc123&other=1")).toContain("ApiKey=***");
    expect(redactApiKeyParams("...&token=xyz")).toContain("token=***");
    expect(redactApiKeyParams("...&access_key=xyz")).toContain("access_key=***");
  });

  it("leaves text with no key-shaped query param untouched", () => {
    const text = "Alpha Vantage rate limit reached, please try again later";
    expect(redactApiKeyParams(text)).toBe(text);
  });

  it("redacts every literal occurrence of a known secret value", () => {
    // Deliberately NOT key-shaped: redactSecretValue matches the literal value, so any
    // string exercises it, and a realistic-looking fixture trips gitleaks' generic-api-key
    // rule (it flagged the previous "sk_live_"-prefixed value on PR #1087).
    const secret = "fixture-secret-value-123";
    const text = `Thank you for using our API! Your key ${secret} has exceeded the daily limit. Key: ${secret}`;
    const scrubbed = redactSecretValue(text, secret);
    expect(scrubbed).not.toContain(secret);
    expect(scrubbed.match(/\*\*\*/g)?.length).toBe(2);
  });

  it("redactSecretValue is a no-op when secret is undefined/empty", () => {
    expect(redactSecretValue("hello", undefined)).toBe("hello");
    expect(redactSecretValue("hello", "")).toBe("hello");
    expect(redactSecretValue("hello", null)).toBe("hello");
  });

  it("scrubProviderErrorText combines both: a literal key AND a query-param pattern", () => {
    const apiKey = "MYRAWKEY";
    const text = `Alpha Vantage API warning/error: please visit https://www.alphavantage.co/premium/?apikey=${apiKey} for a higher rate limit, key ${apiKey} used.`;
    const scrubbed = scrubProviderErrorText(text, apiKey);
    expect(scrubbed).not.toContain(apiKey);
    expect(scrubbed).toContain("apikey=***");
  });

  it("scrubProviderErrorText with no secret still redacts a generic apikey= param", () => {
    const text = "fetch failed for https://finnhub.io/api/v1/quote?symbol=AAPL&token=leaked-value";
    expect(scrubProviderErrorText(text)).toBe(
      "fetch failed for https://finnhub.io/api/v1/quote?symbol=AAPL&token=***"
    );
  });
});

describe("appendErrorCause", () => {
  it("appends a truncated err.cause when present", () => {
    const err = new Error("fetch failed", { cause: new Error("ECONNREFUSED 127.0.0.1:443") });
    const message = appendErrorCause("fetch failed", err);
    expect(message).toContain("fetch failed");
    expect(message).toContain("ECONNREFUSED");
  });

  it("returns the message unchanged when there is no cause", () => {
    const err = new Error("plain failure");
    expect(appendErrorCause("plain failure", err)).toBe("plain failure");
  });

  it("returns the message unchanged for a non-Error thrown value", () => {
    expect(appendErrorCause("some string", "not an error")).toBe("some string");
  });

  it("truncates an overly long cause to maxLen characters", () => {
    const longCause = "x".repeat(500);
    const err = new Error("boom", { cause: longCause });
    const message = appendErrorCause("boom", err, 20);
    // "boom (cause: " + 20 chars + ")"
    expect(message.length).toBe("boom (cause: )".length + 20);
    expect(message).toContain("x".repeat(20));
    expect(message).not.toContain("x".repeat(21));
  });
});
