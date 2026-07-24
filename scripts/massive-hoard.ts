import fs from "fs";
import path from "path";
import zlib from "zlib";
import { businessDaysBetween } from "../src/lib/market-signals/massive-s3";
import { fetchGroupedBarsRest } from "../src/lib/market-signals/massive";

function loadMassiveKey() {
  try {
    const secretsPath = "/Users/jay/.secrets/global-api-keys.env";
    if (fs.existsSync(secretsPath)) {
      const content = fs.readFileSync(secretsPath, "utf-8");
      const match = content.match(/MASSIVE_API_KEY_ALT=("?[^"\n\r]+)/);
      if (match && match[1]) {
        process.env.MASSIVE_API_KEY = match[1].replace(/"/g, '');
      }
    }
  } catch (err) {
    console.error("Failed to load massive key", err);
  }
}

async function hoardMassive() {
  loadMassiveKey();
  // 5 years = ~1250 days
  const to = new Date().toISOString().slice(0, 10);
  const from = new Date(Date.now() - 5 * 365 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  
  const days = businessDaysBetween(from, to);
  console.log(`Starting Massive hoarding for ${days.length} business days (${from} to ${to})...`);
  
  const outDir = path.join(process.cwd(), "data", "massive-history");
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

  let idx = 0;
  let downloaded = 0;

  async function worker() {
    while (idx < days.length) {
      const date = days[idx++];
      const [year, month] = date.split("-");
      
      const fileDir = path.join(outDir, year, month);
      if (!fs.existsSync(fileDir)) fs.mkdirSync(fileDir, { recursive: true });
      
      const filePath = path.join(fileDir, `${date}.json.gz`);
      if (fs.existsSync(filePath)) {
        continue;
      }
      
      try {
        const data = await fetchGroupedBarsRest(date, "local");
        if (data && data.length > 0) {
          const buffer = zlib.gzipSync(JSON.stringify(data));
          fs.writeFileSync(filePath, buffer);
          downloaded++;
          if (downloaded % 50 === 0) console.log(`Downloaded ${downloaded} files...`);
        } else {
          // Null returned due to rate limiting or missing data. Put index back and wait before retry.
          idx--;
          await new Promise(r => setTimeout(r, 2000));
          continue;
        }
      } catch (err) {
        console.error(`Failed on ${date}:`, err);
      }
      // Add slight delay to pace properly with reserveMassiveRestCall
      await new Promise(r => setTimeout(r, 600)); 
    }
  }

  // Use low concurrency so we don't spam the internal rate limiter too hard simultaneously
  const workers = Array.from({ length: 4 }, () => worker());
  await Promise.all(workers);
  
  console.log(`Massive hoarding complete! Saved ${downloaded} new daily files.`);
}

hoardMassive().catch(console.error);
