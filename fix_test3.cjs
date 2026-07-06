const fs = require('fs');

let content2 = fs.readFileSync('test/red-team.test.ts', 'utf8');

if (!content2.includes('db-api-keys')) {
  content2 = content2.replace(
    'import { LLM_REQUEST_DEFAULTS }',
    'import { LOCAL_USER, deleteUserApiKey, upsertUserApiKey } from "../src/lib/db-api-keys";\nimport { LLM_REQUEST_DEFAULTS }'
  );
}

content2 = content2.replace(/delete process\.env\.OPENAI_API_KEY;/g, 'deleteUserApiKey(LOCAL_USER, "openai");');

fs.writeFileSync('test/red-team.test.ts', content2);
