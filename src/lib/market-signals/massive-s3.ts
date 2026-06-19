import crypto from "crypto";
import zlib from "zlib";
import { resolveApiKey } from "../db";

/**
 * Massive S3 "flat files" (files.massive.com, Polygon-style bucket) — bulk historical market
 * data: one gzipped CSV per day holding EVERY ticker's OHLCV. This is the data-lake / backfill
 * foundation (efficient for backtesting and multi-symbol history — one download = a full day of
 * the market, vs N REST calls). Access is S3 SigV4 with Massive flat-file Access Key ID
 * and Secret Access Key credentials. Server-side only.
 *
 * Layout (verified): {asset}/day_aggs_v1/{YYYY}/{MM}/{YYYY-MM-DD}.csv.gz
 *   assets: us_stocks_sip, us_options_opra, us_indices, us_futures_*, global_crypto, global_forex
 * CSV columns (Polygon day-aggs): ticker,volume,open,close,high,low,window_start,transactions
 *
 * NOTE: on the current Massive plan, S3 LIST works but object GET returns 403 "forbidden"
 * (signature is valid — it is an entitlement gate). So bulk data currently flows via the REST
 * grouped-daily endpoint (see massive.ts fetchGroupedBarsRest); this S3 path activates
 * automatically if/when flat-file download is granted. The signing below is verified-correct.
 */

export interface FlatFileBar {
  ticker: string;
  open?: number;
  high?: number;
  low?: number;
  close: number;
  volume?: number;
}

function cfg(userId?: string) {
  const accessKey = resolveApiKey("massive_access_key_id", userId) ?? "";
  const secret = resolveApiKey("massive_secret_access_key", userId) ?? resolveApiKey("massive", userId) ?? "";
  const host = (resolveApiKey("massive_s3_endpoint", userId) ?? "https://files.massive.com").replace(/^https?:\/\//, "");
  const bucket = resolveApiKey("massive_bucket", userId) ?? "flatfiles";
  const region = process.env.MASSIVE_S3_REGION ?? "us-east-1";
  return { accessKey, secret, host, bucket, region };
}

const sha256hex = (s: crypto.BinaryLike): string => crypto.createHash("sha256").update(s).digest("hex");
const hmac = (key: crypto.BinaryLike, s: string): Buffer => crypto.createHmac("sha256", key).update(s).digest();

/** GET a single S3 object via SigV4 (path-style). Returns the raw bytes, or null on any failure. */
async function getObject(key: string, userId?: string): Promise<Buffer | null> {
  const { accessKey, secret, host, bucket, region } = cfg(userId);
  if (!accessKey || !secret) return null;
  const amzDate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, ""); // YYYYMMDDTHHMMSSZ
  const dateStamp = amzDate.slice(0, 8);
  // Canonical URI: path-style /bucket/key, each segment encoded but slashes preserved.
  const canonicalUri = "/" + [bucket, ...key.split("/")].map(encodeURIComponent).join("/");
  const payloadHash = sha256hex("");
  const canonicalHeaders = `host:${host}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${amzDate}\n`;
  const signedHeaders = "host;x-amz-content-sha256;x-amz-date";
  const canonicalRequest = `GET\n${canonicalUri}\n\n${canonicalHeaders}\n${signedHeaders}\n${payloadHash}`;
  const scope = `${dateStamp}/${region}/s3/aws4_request`;
  const stringToSign = `AWS4-HMAC-SHA256\n${amzDate}\n${scope}\n${sha256hex(canonicalRequest)}`;
  const signingKey = hmac(hmac(hmac(hmac("AWS4" + secret, dateStamp), region), "s3"), "aws4_request");
  const signature = crypto.createHmac("sha256", signingKey).update(stringToSign).digest("hex");
  const authorization = `AWS4-HMAC-SHA256 Credential=${accessKey}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);
  try {
    const res = await fetch(`https://${host}${canonicalUri}`, {
      cache: "no-store",
      signal: controller.signal,
      headers: { Authorization: authorization, "x-amz-content-sha256": payloadHash, "x-amz-date": amzDate }
    });
    clearTimeout(timeout);
    if (!res.ok) return null;
    return Buffer.from(await res.arrayBuffer());
  } catch {
    clearTimeout(timeout);
    return null;
  }
}

/** Parse a Polygon-style day-aggs CSV (header-mapped, so column order is tolerated). Pure. */
export function parseDayAggsCsv(csv: string): FlatFileBar[] {
  const lines = csv.split(/\r?\n/);
  if (lines.length < 2) return [];
  const header = lines[0].split(",").map((h) => h.trim());
  const col = (name: string) => header.indexOf(name);
  const iT = col("ticker");
  const iO = col("open");
  const iH = col("high");
  const iL = col("low");
  const iC = col("close");
  const iV = col("volume");
  if (iT < 0 || iC < 0) return [];
  const out: FlatFileBar[] = [];
  const numAt = (parts: string[], i: number): number | undefined => {
    if (i < 0) return undefined;
    const n = Number(parts[i]);
    return Number.isFinite(n) ? n : undefined;
  };
  for (let i = 1; i < lines.length; i++) {
    const parts = lines[i].split(",");
    if (parts.length <= iC) continue;
    const ticker = parts[iT]?.trim();
    const close = Number(parts[iC]);
    if (!ticker || !Number.isFinite(close)) continue;
    out.push({ ticker, open: numAt(parts, iO), high: numAt(parts, iH), low: numAt(parts, iL), close, volume: numAt(parts, iV) });
  }
  return out;
}

const KEY_PREFIX: Record<string, string> = {
  stocks: "us_stocks_sip",
  options: "us_options_opra",
  indices: "us_indices",
  crypto: "global_crypto",
  forex: "global_forex"
};

/**
 * Download + parse one day's grouped OHLCV flat file for an asset class (default US stocks).
 * `date` = YYYY-MM-DD. Returns null on weekend/holiday/unavailable (never fabricated).
 */
export async function fetchGroupedDailyBars(date: string, asset: keyof typeof KEY_PREFIX = "stocks", userId?: string): Promise<FlatFileBar[] | null> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const [year, month] = date.split("-");
  const key = `${KEY_PREFIX[asset]}/day_aggs_v1/${year}/${month}/${date}.csv.gz`;
  const gz = await getObject(key, userId);
  if (!gz) return null;
  try {
    const csv = zlib.gunzipSync(gz).toString("utf8");
    const bars = parseDayAggsCsv(csv);
    return bars.length > 0 ? bars : null;
  } catch {
    return null;
  }
}
