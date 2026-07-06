const fs = require('fs');

let content = fs.readFileSync('test/strategy-tuning.test.ts', 'utf8');

// replace the incorrect upsert with correct user keys
content = content.replace(
  'upsertUserApiKey(LOCAL_USER, "openai", "test-key");\n    process.env.OPENAI_API_URL = "https://api.openai.com/v1/responses";\n    setStrategyPrompt("RED TEAM REVIEW STRATEGY", userWithRedTeam);',
  'upsertUserApiKey(userWithRedTeam, "openai", "test-key");\n    upsertUserApiKey(userWithGreenOnly, "openai", "test-key");\n    process.env.OPENAI_API_URL = "https://api.openai.com/v1/responses";\n    setStrategyPrompt("RED TEAM REVIEW STRATEGY", userWithRedTeam);'
);

fs.writeFileSync('test/strategy-tuning.test.ts', content);
