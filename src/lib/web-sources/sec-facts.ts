import * as cheerio from "cheerio";
import { getDb } from "../db";
import { politeFetch } from "./http";
import { padCik } from "./sec-filings";
import crypto from "crypto";

const SEC_DATA_BASE = "https://data.sec.gov";

// High-yield GAAP concepts for scanning
const targetConcepts = new Set([
  "Assets",
  "Liabilities",
  "AssetsCurrent",
  "LiabilitiesCurrent",
  "Revenues",
  "SalesRevenueNet",
  "RevenueFromContractWithCustomerExcludingAssessedTax",
  "NetIncomeLoss",
  "OperatingIncomeLoss",
  "LongTermDebt",
  "ShortTermBorrowings"
]);

/**
 * Ingest all facts for a CIK from data.sec.gov/api/xbrl/companyfacts
 * and store them inside SQLite `sec_facts`.
 */
export async function ingestCompanyFacts(cik: string): Promise<void> {
  const db = getDb();
  const paddedCik = padCik(cik);
  const url = `${SEC_DATA_BASE}/api/xbrl/companyfacts/CIK${paddedCik}.json`;

  try {
    const res = await politeFetch(url, {
      headers: { "User-Agent": "Antigravity/1.0 (jay@socratic.trade)" }
    });
    if (!res.ok) {
      if (res.status === 404) return; // No facts available for CIK
      throw new Error(`Failed to fetch company facts: ${res.statusText}`);
    }

    const data = await res.json() as any;
    if (!data?.facts?.["us-gaap"]) {
      return;
    }

    const usGaap = data.facts["us-gaap"];
    const insertStmt = db.prepare(`
      INSERT OR REPLACE INTO sec_facts (
        id, cik, accession, concept, value, unit, period, start_date, end_date, accepted_at, segment
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    db.transaction(() => {
      for (const [concept, conceptData] of Object.entries(usGaap)) {
        if (!targetConcepts.has(concept)) continue;
        const units = (conceptData as any).units;
        if (!units || typeof units !== "object") continue;

        for (const [unitName, unitEntries] of Object.entries(units)) {
          if (!Array.isArray(unitEntries)) {
            continue;
          }

          for (const entry of unitEntries) {
            if (!entry || typeof entry !== "object") {
              continue;
            }
            const val = (entry as any).val;
            const accession = (entry as any).accn;
            const end = (entry as any).end;
            const form = (entry as any).form;
            const filed = (entry as any).filed;

            // Only care about periodic forms
            if (!form || !["10-K", "10-Q", "20-F", "40-F"].includes(form)) {
              continue;
            }
            if (typeof val !== "number" || !accession || !end) {
              continue;
            }

            const period = (entry as any).frame || `${(entry as any).fy || ""}-${(entry as any).fp || ""}`;
            const start = (entry as any).start || null;
            const accepted = (entry as any).filed || new Date().toISOString();
            const segment = (entry as any).segment ? JSON.stringify((entry as any).segment) : null;

            console.log("[DEBUG] inserting concept:", concept, "accession:", accession, "val:", val);
            // Generate deterministic ID
            const id = crypto.createHash("sha256")
              .update(`${paddedCik}:${accession}:${concept}:${period}:${segment || ""}`)
              .digest("hex");

            insertStmt.run(
              id,
              paddedCik,
              accession,
              concept,
              val,
              unitName,
              period,
              start,
              end,
              accepted,
              segment
            );
          }
        }
      }
    })();
  } catch (err: any) {
    console.error(`[sec-facts] Failed to ingest facts for CIK ${cik}:`, err.message);
  }
}

/**
 * Parses Form 4 XML string using cheerio and writes entries into `sec_insider_transactions`.
 */
export function parseAndSaveForm4(xmlContent: string, cik: string, accession: string): number {
  const db = getDb();
  const $ = cheerio.load(xmlContent, { xmlMode: true });
  const paddedCik = padCik(cik);

  const insiderName = $("reportingOwner > reportingOwnerId > rptOwnerName").first().text().trim();
  const isOfficer = $("reportingOwner > reportingOwnerRelationship > isOfficer").first().text().trim() === "true";
  const officerTitle = $("reportingOwner > reportingOwnerRelationship > officerTitle").first().text().trim();
  const isDirector = $("reportingOwner > reportingOwnerRelationship > isDirector").first().text().trim() === "true";
  const relationship = officerTitle || (isOfficer ? "Officer" : isDirector ? "Director" : "Ten Percent Owner");

  const periodOfReport = $("periodOfReport > value").first().text().trim();

  let count = 0;

  const insertStmt = db.prepare(`
    INSERT OR REPLACE INTO sec_insider_transactions (
      id, cik, accession, insider_name, relationship, side, shares, price, period_of_report, is_10b5_1
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  db.transaction(() => {
    $("nonDerivativeTransaction, derivativeTransaction").each((_, el) => {
      const sharesVal = $(el).find("transactionAmounts > transactionShares > value").text().trim();
      const priceVal = $(el).find("transactionAmounts > transactionPricePerShare > value").text().trim();
      const ad = $(el).find("transactionAmounts > transactionAcquiredDisposedCode > value").text().trim(); // A or D
      const is10b5_1 = $(el).find("transactionCoding > rule10b51Transaction").text().trim() === "true" ? 1 : 0;

      if (!sharesVal || !ad) return;

      const shares = parseFloat(sharesVal);
      const price = priceVal ? parseFloat(priceVal) : 0;
      const side = ad === "D" ? "sell" : "buy";

      // deterministic ID for duplicate prevention
      const id = crypto.createHash("sha256")
        .update(`${accession}:${count}:${shares}:${price}:${side}`)
        .digest("hex");

      insertStmt.run(
        id,
        paddedCik,
        accession,
        insiderName,
        relationship,
        side,
        shares,
        price,
        periodOfReport,
        is10b5_1
      );
      count++;
    });
  })();

  return count;
}

/**
 * Format structured facts for a symbol into a clean narrative Evidence Card for the LLM prompt.
 */
export function formatCompanyFactsEvidenceCard(cik: string): string {
  const db = getDb();
  const paddedCik = padCik(cik);

  const facts = db.prepare(`
    SELECT concept, value, unit, period, end_date, accepted_at
    FROM sec_facts
    WHERE cik = ?
    ORDER BY end_date DESC, accepted_at DESC
    LIMIT 50
  `).all(paddedCik) as Array<{
    concept: string;
    value: number;
    unit: string;
    period: string;
    end_date: string;
    accepted_at: string;
  }>;

  if (facts.length === 0) return "";

  const lines = [`[SEC Structured Financial Facts for CIK ${paddedCik}]`];
  for (const f of facts) {
    lines.push(`- ${f.concept}: ${f.value.toLocaleString()} ${f.unit} (${f.period || f.end_date}) [filed: ${f.accepted_at}]`);
  }
  return lines.join("\n");
}

/**
 * Format structured Form 4 insider transactions for a symbol into a clean narrative Evidence Card.
 */
export function formatInsiderTransactionsEvidenceCard(cik: string): string {
  const db = getDb();
  const paddedCik = padCik(cik);

  const txs = db.prepare(`
    SELECT insider_name, relationship, side, shares, price, period_of_report, is_10b5_1, accession
    FROM sec_insider_transactions
    WHERE cik = ?
    ORDER BY period_of_report DESC, price DESC
    LIMIT 30
  `).all(paddedCik) as Array<{
    insider_name: string;
    relationship: string;
    side: string;
    shares: number;
    price: number;
    period_of_report: string;
    is_10b5_1: number;
    accession: string;
  }>;

  if (txs.length === 0) return "";

  const lines = [`[SEC Insider Transactions (Form 4) for CIK ${paddedCik}]`];
  for (const t of txs) {
    lines.push(
      `- ${t.period_of_report}: ${t.insider_name} (${t.relationship}) ${t.side.toUpperCase()} ${t.shares.toLocaleString()} shares @ $${t.price.toFixed(2)} (10b5-1: ${t.is_10b5_1 ? "Yes" : "No"}) [acc: ${t.accession}]`
    );
  }
  return lines.join("\n");
}

