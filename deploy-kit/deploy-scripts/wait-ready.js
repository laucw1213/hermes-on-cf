// Step 14 — Wait for the deployed Hermes container to be ready.
// Self-loads .env. Probes /debug/cli?cmd=hermes+version until exit_code 0
// (~7-8 min max: 30 × 15s + initial wake).
const https = require('node:https');
const fs = require('node:fs');
const path = require('node:path');

const KIT = path.resolve(__dirname, '..');
for (const line of fs.readFileSync(path.join(KIT, '.env'), 'utf8').split(/\r?\n/)) {
  const m = line.match(/^([A-Z][A-Z0-9_]*)=(.*)$/); if (m) process.env[m[1]] = m[2];
}
const { NAME, SUBDOMAIN } = process.env;
if (!NAME || !SUBDOMAIN) { console.error('❌ NAME / SUBDOMAIN missing in .env'); process.exit(1); }

const base = `https://hermes-${NAME}.${SUBDOMAIN}.workers.dev`;

function get(url, timeoutMs) {
  return new Promise(resolve => {
    const req = https.get(url, { timeout: timeoutMs }, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => resolve(d));
    });
    req.on('timeout', () => { req.destroy(); resolve(''); });
    req.on('error', () => resolve(''));
  });
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  console.log(`⏳ Waking the Hermes container (rclone restore + start, ~1-2 min cold)...`);
  await get(`${base}/id`, 30_000);
  for (let i = 1; i <= 30; i++) {
    const r = await get(`${base}/debug/cli?cmd=${encodeURIComponent('hermes version')}`, 30_000);
    if (/"exit_code"\s*:\s*0/.test(r)) {
      console.log(`\n✅ READY after ${i} probe(s).`);
      process.exit(0);
    }
    process.stdout.write('.');
    await sleep(15_000);
  }
  console.error(`\n⚠️ Container not ready after 7-8 min. Pull logs:`);
  console.error(`   curl -s "${base}/debug/processes?logs=true"`);
  process.exit(1);
})();
