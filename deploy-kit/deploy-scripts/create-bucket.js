// Step 7 — Create the R2 bucket `hermes-${NAME}-data`.
// Self-loads .env. Unlike OpenClaw, Hermes has NO R2 binding in
// wrangler.jsonc (rclone reads R2 via secrets at runtime), so wrangler won't
// prompt about binding. Idempotent: "bucket already exists" is a non-error.
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const isWin = process.platform === 'win32';
const KIT = path.resolve(__dirname, '..');
const hermes = path.join(KIT, 'hermes-cf');
const wrangler = path.join(hermes, 'node_modules', '.bin', isWin ? 'wrangler.cmd' : 'wrangler');

for (const line of fs.readFileSync(path.join(KIT, '.env'), 'utf8').split(/\r?\n/)) {
  const m = line.match(/^([A-Z][A-Z0-9_]*)=(.*)$/); if (m) process.env[m[1]] = m[2];
}
const NAME = process.env.NAME;
if (!NAME) { console.error('❌ NAME missing in .env'); process.exit(1); }
const bucket = `hermes-${NAME}-data`;

const p = spawn(wrangler, ['r2', 'bucket', 'create', bucket], {
  cwd: hermes, stdio: ['inherit', 'pipe', 'pipe'], shell: isWin,
});
let out = '';
p.stdout.on('data', c => { out += c; process.stdout.write(c); });
p.stderr.on('data', c => { out += c; process.stderr.write(c); });
p.on('exit', code => {
  if (code === 0 || /already exists/i.test(out)) {
    console.log(`\n✅ R2 bucket ${bucket} ready.`);
    process.exit(0);
  }
  console.error(`\n❌ wrangler r2 bucket create failed (exit ${code}).`);
  process.exit(1);
});
