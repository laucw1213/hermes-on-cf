// Step 6 — Rename worker name in hermes-cf/wrangler.jsonc to match NAME.
// Self-loads .env. Replaces `hermes-cf` -> `hermes-${NAME}`. The Hermes R2
// binding is NOT in wrangler.jsonc (rclone uses secrets at runtime), so only
// the worker `name` field changes here.
const fs = require('node:fs');
const path = require('node:path');

const KIT = path.resolve(__dirname, '..');
const cfgPath = path.join(KIT, 'hermes-cf', 'wrangler.jsonc');

for (const line of fs.readFileSync(path.join(KIT, '.env'), 'utf8').split(/\r?\n/)) {
  const m = line.match(/^([A-Z][A-Z0-9_]*)=(.*)$/); if (m) process.env[m[1]] = m[2];
}
const NAME = process.env.NAME;
if (!NAME) { console.error('❌ NAME missing in .env (Setup step b)'); process.exit(1); }

const before = fs.readFileSync(cfgPath, 'utf8');
const after = before.replace(/hermes-cf/g, `hermes-${NAME}`);

if (before === after) {
  console.log(`(wrangler.jsonc already names this bot — no changes needed)`);
} else {
  fs.writeFileSync(cfgPath, after);
}

for (const line of after.split(/\r?\n/)) {
  if (/"name"/.test(line)) { console.log(line); break; }
}
console.log(`\n✅ Worker renamed to hermes-${NAME}.`);
