const fs = require("fs");
const path = require("path");

const testDir = path.join(__dirname, "test");
const files = fs.readdirSync(testDir).filter(f => f.endsWith(".test.ts"));

for (const file of files) {
  const filePath = path.join(testDir, file);
  let content = fs.readFileSync(filePath, "utf-8");
  
  let changed = false;

  const replaceProcessEnv = (match, envName, val) => {
    changed = true;
    const serviceMap = {
      OPENAI_API_KEY: "openai",
      ANTHROPIC_API_KEY: "anthropic",
      FINNHUB_API_KEY: "finnhub",
      FRED_API_KEY: "fred",
      ALPACA_PAPER_API_KEY: "alpaca_paper_api_key",
      ALPACA_PAPER_SECRET_KEY: "alpaca_paper_secret_key"
    };
    const service = serviceMap[envName] || envName.toLowerCase().replace("_api_key", "");
    return `_test_upsertUserApiKey(typeof userId !== 'undefined' ? userId : "local", "${service}", ${val});`;
  };

  content = content.replace(/process\.env\.([A-Z_]+_KEY)\s*=\s*(['"][^'"]+['"]);/g, replaceProcessEnv);
  content = content.replace(/vi\.stubEnv\(['"]([A-Z_]+_KEY)['"],\s*(['"][^'"]+['"])\);/g, replaceProcessEnv);

  if (changed) {
    fs.writeFileSync(filePath, content, "utf-8");
  }
}
