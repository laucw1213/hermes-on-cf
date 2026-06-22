// Step 8 — Create (or reuse) the shared AI Gateway `agent-shared-gateway`.
// ONE gateway per CF account, shared by both OpenClaw and Hermes deploys;
// each bot still gets its own AIG auth token on it (Step 9). Self-loads
// .env. Idempotent: prints OK / EXISTS / <err>.
const https = require('https');
const fs = require('node:fs');
const path = require('node:path');
for (const line of fs.readFileSync(path.join(__dirname, '..', '.env'), 'utf8').split(/\r?\n/)) {
  const m = line.match(/^([A-Z][A-Z0-9_]*)=(.*)$/); if (m) process.env[m[1]] = m[2];
}
const data = JSON.stringify({id:'agent-shared-gateway',name:'agent-shared-gateway',collect_logs:true,rate_limiting_interval:0,rate_limiting_limit:0,rate_limiting_technique:'fixed',cache_ttl:0,cache_invalidate_on_update:false,authentication:true});
const req = https.request({hostname:'api.cloudflare.com',path:`/client/v4/accounts/${process.env.ACCOUNT_ID}/ai-gateway/gateways`,method:'POST',headers:{Authorization:`Bearer ${process.env.CLOUDFLARE_API_TOKEN}`,'Content-Type':'application/json','Content-Length':Buffer.byteLength(data)}},res=>{
  let d='';res.on('data',c=>d+=c);res.on('end',()=>{const r=JSON.parse(d);console.log(r.success?'OK':(r.errors?.[0]?.message||'EXISTS'));});
});
req.write(data); req.end();
