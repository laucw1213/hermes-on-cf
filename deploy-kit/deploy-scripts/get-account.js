// Step 3 — Verify CF token + derive ACCOUNT_ID by running `wrangler whoami`.
// Self-loads .env. Appends ACCOUNT_ID + CLOUDFLARE_ACCOUNT_ID to .env.
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const isWin = process.platform === 'win32';
const KIT = path.resolve(__dirname, '..');
const hermes = path.join(KIT, 'hermes-cf');
const envPath = path.join(KIT, '.env');
const wrangler = path.join(hermes, 'node_modules', '.bin', isWin ? 'wrangler.cmd' : 'wrangler');

for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
  const m = line.match(/^([A-Z][A-Z0-9_]*)=(.*)$/);
  if (m) process.env[m[1]] = m[2];
}

const r = spawnSync(wrangler, ['whoami'], { cwd: hermes, encoding: 'utf8', shell: isWin });
const out = (r.stdout || '') + (r.stderr || '');
process.stdout.write(out);

if (r.status !== 0 || /authentication error|not authorized/i.test(out)) {
  console.error('\n❌ wrangler whoami failed. Token bad or missing perms — redo Step 2 (append a fresh CLOUDFLARE_API_TOKEN=… line).');
  process.exit(1);
}

const m = out.match(/[0-9a-f]{32}/);
if (!m) {
  console.error('\n❌ Could not extract ACCOUNT_ID from wrangler output. Escalate.');
  process.exit(1);
}
const id = m[0];

fs.appendFileSync(envPath, `ACCOUNT_ID=${id}\nCLOUDFLARE_ACCOUNT_ID=${id}\n`);
console.log(`\n✅ ACCOUNT_ID=${id} (written to .env, both names)`);
