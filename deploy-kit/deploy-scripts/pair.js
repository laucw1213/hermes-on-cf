// Step 15 — Approve a Telegram pairing code on the deployed Hermes bot.
//
// Hermes has no web dashboard: a user DMs their bot, the bot replies with
// a pairing code, and that code must be approved via the admin shim
// (`hermes pairing approve telegram <CODE>`) which this script calls over the
// Worker's /debug/cli route. Encapsulates the curl+JSON the SKILL.md used to
// inline, so the caller gets a clean ✅/❌ instead of eyeballing JSON.
//
// Usage:  node deploy-scripts/pair.js <PAIRING_CODE>
// Self-loads .env (NAME + SUBDOMAIN). Exit 0 + "✅ Telegram bot paired" on
// success; exit 1 + reason otherwise.
const https = require('https');
const fs = require('node:fs');
const path = require('node:path');
for (const line of fs.readFileSync(path.join(__dirname, '..', '.env'), 'utf8').split(/\r?\n/)) {
  const m = line.match(/^([A-Z][A-Z0-9_]*)=(.*)$/); if (m) process.env[m[1]] = m[2];
}

const code = (process.argv[2] || '').trim();
const NAME = process.env.NAME;
const SUBDOMAIN = process.env.SUBDOMAIN;

function fail(msg) { console.error('❌ ' + msg); process.exit(1); }

if (!code) fail('No pairing code given. Usage: node pair.js <CODE>');
if (!/^[A-Za-z0-9]{4,16}$/.test(code))
  fail(`Pairing code "${code}" looks malformed (expected 4-16 alphanumerics). Ask the user to send "hi" again for a fresh code.`);
if (!NAME || !SUBDOMAIN) fail('NAME and SUBDOMAIN must be set in .env');

const cmd = `hermes pairing approve telegram ${code}`;
const url = `https://hermes-${NAME}.${SUBDOMAIN}.workers.dev/debug/cli?cmd=${encodeURIComponent(cmd)}`;

const req = https.get(url, { timeout: 60000 }, res => {
  let d = '';
  res.on('data', c => (d += c));
  res.on('end', () => {
    let r;
    try { r = JSON.parse(d); } catch (e) { fail('Unexpected response (not JSON): ' + d.slice(0, 200)); }
    const out = (r.stdout || '') + (r.stderr || '');
    if (r.exit_code === 0 && /approved/i.test(out)) {
      // Surface the "Approved! User …" line for the report.
      const line = out.split('\n').map(s => s.trim()).find(s => /approved/i.test(s));
      console.log(line || 'Approved.');
      console.log('✅ Telegram bot paired.');
      process.exit(0);
    }
    if (/bad pairing code|invalid|not found|no such/i.test(out)) {
      fail(`Bad pairing code. Ask the user to send "hi" to the bot again for a fresh code.\n${out.trim().slice(0, 300)}`);
    }
    fail(`Pairing did not succeed (exit ${r.exit_code}).\n${out.trim().slice(0, 300)}`);
  });
});
req.on('timeout', () => { req.destroy(); fail('Timed out reaching the bot worker (container may still be cold-booting — retry in a minute).'); });
req.on('error', e => fail('Network error reaching the bot worker: ' + e.message));
