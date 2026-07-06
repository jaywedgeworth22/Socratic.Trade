const fs = require('fs');

let content = fs.readFileSync('test/strategy-tuning.test.ts', 'utf8');

content = content.replace(/removeUserApiKey/g, 'deleteUserApiKey');
content = content.replace(/setUserApiKey/g, 'upsertUserApiKey');

fs.writeFileSync('test/strategy-tuning.test.ts', content);

let content2 = fs.readFileSync('test/red-team.test.ts', 'utf8');

content2 = content2.replace(/setUserApiKey/g, 'upsertUserApiKey');

fs.writeFileSync('test/red-team.test.ts', content2);
