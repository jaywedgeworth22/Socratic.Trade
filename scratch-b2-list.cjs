const { S3Client, ListObjectsV2Command } = require('@aws-sdk/client-s3');
const { execSync } = require('child_process');

const rawEnv = execSync('infisical export --env=prod --format=json').toString();
const env = JSON.parse(rawEnv);
const accessKeyId = env.find(e => e.key === 'AWS_ACCESS_KEY_ID').value;
const secretAccessKey = env.find(e => e.key === 'AWS_SECRET_ACCESS_KEY').value;
const endpoint = env.find(e => e.key === 'AWS_S3_ENDPOINT').value; 

const client = new S3Client({
  region: 'eu-central-003',
  endpoint,
  credentials: { accessKeyId, secretAccessKey }
});

async function run() {
  const command = new ListObjectsV2Command({
    Bucket: 'jays-socratic-trade-eu',
    Prefix: 'trading-live/app.db/'
  });
  const response = await client.send(command);
  for (const obj of response.Contents || []) {
    console.log(obj.Key, obj.Size);
  }
}
run().catch(console.error);
