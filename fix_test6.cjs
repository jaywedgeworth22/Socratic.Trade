const fs = require('fs');

let content = fs.readFileSync('test/strategy-tuning.test.ts', 'utf8');

// Replace specific lines in test/strategy-tuning.test.ts where userId is in scope
content = content.replace(/upsertUserApiKey\(LOCAL_USER, "openai", "test-key"\)/g, (match, offset, str) => {
  // If there's a const userId before this in the function block, replace with userId
  const lastIndex = str.lastIndexOf("const userId", offset);
  if (lastIndex !== -1 && offset - lastIndex < 600) {
    return 'upsertUserApiKey(userId, "openai", "test-key")';
  }
  return match;
});

fs.writeFileSync('test/strategy-tuning.test.ts', content);
