const fs = require('fs');

let content = fs.readFileSync('test/strategy-tuning.test.ts', 'utf8');

if (!content.includes('db-api-keys')) {
  content = content.replace(
    'import { LLM_OUTPUT_TOKEN_CAPS',
    'import { LOCAL_USER, removeUserApiKey, setUserApiKey } from "../src/lib/db-api-keys";\nimport { LLM_OUTPUT_TOKEN_CAPS'
  );
}

content = content.replace(/process\.env\.OPENAI_API_KEY\s*=\s*"test-key";/g, 'setUserApiKey(LOCAL_USER, "openai", "test-key");');
content = content.replace(/delete process\.env\.OPENAI_API_KEY;/g, 'removeUserApiKey(LOCAL_USER, "openai");');

fs.writeFileSync('test/strategy-tuning.test.ts', content);
