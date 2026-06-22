// Step 4 — Confirm the CF account has the Workers Paid Plan.
// Self-loads .env. Prints OK / NO_WORKERS_PLAN / CHECK_FAILED.
const https = require('https');
const fs = require('node:fs');
const path = require('node:path');
for (const line of fs.readFileSync(path.join(__dirname, '..', '.env'), 'utf8').split(/\r?\n/)) {
  const m = line.match(/^([A-Z][A-Z0-9_]*)=(.*)$/); if (m) process.env[m[1]] = m[2];
}
https.get({hostname:'api.cloudflare.com',path:`/client/v4/accounts/${process.env.ACCOUNT_ID}/subscriptions`,headers:{Authorization:`Bearer ${process.env.CLOUDFLARE_API_TOKEN}`}},res=>{
  let d='';res.on('data',c=>d+=c);res.on('end',()=>{
    try{const r=JSON.parse(d);const w=(r.result||[]).find(s=>s.rate_plan?.public_name?.includes('Workers'));
      console.log(w&&w.state==='Paid'?'OK':'NO_WORKERS_PLAN');}catch(e){console.log('CHECK_FAILED');}});
});
