// Step 12 — Write the 8 wrangler secrets for this Hermes worker.
// Cross-platform (Mac / Linux / Windows). Locates its own bot workspace
// ($script_dir/..), loads that bot's .env, and uses the bot's local wrangler.
// Values come from .env — never hard-coded here.
//
// Secret NAMES follow the OpenClaw convention (R2_*, CF_ACCOUNT_ID). The
// worker forwards them to the container as-is (see hermes-cf/src/index.ts
// `HermesContainer.envVars`); start.sh then writes its own rclone.conf from
// R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY / CF_ACCOUNT_ID / R2_BUCKET_NAME
// and uses rclone to restore + back up /opt/data to R2. So the names below
// must be exactly these — renaming them breaks the rclone config and the
// restore step. OPENAI_*/HERMES_MODEL/TELEGRAM are passed through as-is.
//
// Usage (from kit root, any OS):
//   node deploy-scripts/secrets.js
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const DIR = __dirname;
const BOT = path.resolve(DIR, '..');
const hermes = path.join(BOT, 'hermes-cf');
const isWin = process.platform === 'win32';
const wrangler = path.join(hermes, 'node_modules', '.bin', isWin ? 'wrangler.cmd' : 'wrangler');

// Load uncommented KEY=value lines from .env into process.env.
for (const line of fs.readFileSync(path.join(BOT, '.env'), 'utf8').split(/\r?\n/)) {
  const m = line.match(/^([A-Z][A-Z0-9_]*)=(.*)$/);
  if (m) process.env[m[1]] = m[2];
}

const { NAME, ACCOUNT_ID, AIG_TOKEN, R2_ACCESS_KEY, R2_SECRET_KEY,
        TELEGRAM_TOKEN } = process.env;

const SECRETS = [
  ['R2_ACCESS_KEY_ID',     R2_ACCESS_KEY],
  ['R2_SECRET_ACCESS_KEY', R2_SECRET_KEY],
  ['CF_ACCOUNT_ID',        ACCOUNT_ID],
  ['R2_BUCKET_NAME',       `hermes-${NAME}-data`],
  ['OPENAI_API_BASE_URL',  `https://gateway.ai.cloudflare.com/v1/${ACCOUNT_ID}/agent-shared-gateway/workers-ai/v1`],
  ['OPENAI_API_KEY',       AIG_TOKEN],
  ['HERMES_MODEL',         '@cf/google/gemma-4-26b-a4b-it'],
  ['TELEGRAM_BOT_TOKEN',   TELEGRAM_TOKEN],
];

function putSecret(name, value) {
  return new Promise((resolve, reject) => {
    const p = spawn(wrangler, ['secret', 'put', name], {
      cwd: hermes,
      stdio: ['pipe', 'inherit', 'inherit'],
      shell: isWin,    // .cmd shim on Windows needs cmd.exe
    });
    p.stdin.end(value);
    p.on('exit', code => code === 0 ? resolve() : reject(new Error(`wrangler secret put ${name} failed (exit ${code})`)));
    p.on('error', reject);
  });
}

(async () => {
  for (const [name, value] of SECRETS) {
    if (value === undefined || value === '') {
      throw new Error(`Missing value for ${name} — check your .env`);
    }
    await putSecret(name, value);
  }
})().catch(err => { console.error(err.message); process.exit(1); });
