// Step 5 — Fetch the account's *.workers.dev subdomain.
// Self-loads .env. Prints the subdomain (or empty).
const https = require('https');
const fs = require('node:fs');
const path = require('node:path');
for (const line of fs.readFileSync(path.join(__dirname, '..', '.env'), 'utf8').split(/\r?\n/)) {
  const m = line.match(/^([A-Z][A-Z0-9_]*)=(.*)$/); if (m) process.env[m[1]] = m[2];
}
https.get({hostname:'api.cloudflare.com',path:`/client/v4/accounts/${process.env.ACCOUNT_ID}/workers/subdomain`,headers:{Authorization:`Bearer ${process.env.CLOUDFLARE_API_TOKEN}`}},res=>{
  let d='';res.on('data',c=>d+=c);res.on('end',()=>{
    try{const r=JSON.parse(d);process.stdout.write(r.result?.subdomain||'');}catch(e){}});
});
