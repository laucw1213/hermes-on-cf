// Step 11 — Read the Telegram bot's @username from its token (getMe).
// The bot token does NOT contain the username; getMe is the only way to
// recover it. Self-loads .env. Prints the username (no '@'), or empty if
// the token is invalid (which also doubles as a token check).
const https = require('https');
const fs = require('node:fs');
const path = require('node:path');
for (const line of fs.readFileSync(path.join(__dirname, '..', '.env'), 'utf8').split(/\r?\n/)) {
  const m = line.match(/^([A-Z][A-Z0-9_]*)=(.*)$/); if (m) process.env[m[1]] = m[2];
}
https.get(`https://api.telegram.org/bot${process.env.TELEGRAM_TOKEN}/getMe`, res => {
  let d = ''; res.on('data', c => d += c); res.on('end', () => {
    try { const r = JSON.parse(d); process.stdout.write(r.result?.username || ''); } catch (e) {}
  });
});
