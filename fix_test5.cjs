const fs = require('fs');

let content = fs.readFileSync('test/strategy-tuning.test.ts', 'utf8');

// Replace specific lines in test/strategy-tuning.test.ts where userId is in scope
content = content.replace(
  'const { proposeStrategyTuning } = await import("../src/lib/strategy-tuning");\n\n    upsertUserApiKey(LOCAL_USER, "openai", "test-key");',
  'const { proposeStrategyTuning } = await import("../src/lib/strategy-tuning");\n\n    upsertUserApiKey(userId, "openai", "test-key");'
);

fs.writeFileSync('test/strategy-tuning.test.ts', content);
