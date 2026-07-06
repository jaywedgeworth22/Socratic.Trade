const fs = require('fs');

let content = fs.readFileSync('test/red-team.test.ts', 'utf8');

content = content.replace(/process\.env\.OPENAI_API_KEY\s*=\s*"test-key";/g, 'upsertUserApiKey(LOCAL_USER, "openai", "test-key");');
content = content.replace(/process\.env\.ANTHROPIC_API_KEY\s*=\s*"sk-ant-test";/g, 'upsertUserApiKey(LOCAL_USER, "anthropic", "sk-ant-test");');

fs.writeFileSync('test/red-team.test.ts', content);
