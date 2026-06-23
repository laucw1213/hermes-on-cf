---
name: deploy-hermes
description: "Deploy your own Hermes Agent — a stateful AI agent reachable from your own Telegram bot — to your own Cloudflare account. Self-service: clone this kit, collect your Cloudflare + Telegram tokens into a local .env, run the pre-built deploy scripts, and ship a Worker + Container + R2 + AI Gateway. Hermes is Telegram long-poll (no webhook, no web dashboard). Use when a developer (or an agent acting for them) wants to stand up a Hermes bot on Cloudflare from scratch."
---

# Deploy Hermes Agent on Cloudflare (self-service)

This skill walks **you** (a developer, or an AI agent acting on your behalf in
Claude Code / Cursor / a terminal) through deploying a **Hermes Agent** to
**your own** Cloudflare account. Everything runs on your own machine against
your own accounts — there is no shared host and no multi-tenant isolation to
worry about.

**What you build:** a Cloudflare **Worker** (edge proxy) fronting a long-lived
**Container** (the agent runtime), backed by an **R2 bucket** (state via
rclone) and a shared **AI Gateway** (LLM proxy). Reachable from a Telegram bot
you create. ~15 steps, ~25 minutes.

## Prerequisites

- **node** ≥ 22 and **git** (Windows: run everything in **Git Bash**).
- **Docker Desktop** installed and **running** (the deploy builds an image
  locally). Confirm the whale icon is solid.
- A **Cloudflare account on the Workers Paid plan** ($5/mo — Containers
  require it).
- **Telegram** installed (you'll make a bot with BotFather).

You do **not** need a global `wrangler` install — the kit pins its own.

## How commands work

Every command runs from the kit root (`hermes-on-cf/deploy-kit`). The pre-built
scripts in `deploy-scripts/` each load `.env` themselves and use the kit-local
wrangler, so you just invoke them with `node deploy-scripts/<name>.js`. You
collect tokens into `.env` as you go; later steps read them from there. Treat
`.env` as secret (it's chmod 600 and gitignored) — don't paste its values back
into chat.

---

## Step 0: Get the kit and pick a name

Clone this repo (pin the released tag so your deploy matches the docs), enter
the kit, install the worker's deps once, seed your `.env`, and pick a `NAME`
for this bot:

```bash
git clone --branch v1.0 https://github.com/ZorCorp/hermes-on-cf.git
cd hermes-on-cf/deploy-kit
(cd hermes-cf && npm install --no-audit --no-fund)   # one-time, ~30s–2min
cp env.template .env && chmod 600 .env
printf 'NAME=alice\n' >> .env                         # ← change "alice"; lowercase, letters/digits/hyphens
set -a; source .env; set +a
echo "NAME=$NAME"
```

`NAME` becomes your worker (`hermes-<NAME>`) and R2 bucket
(`hermes-<NAME>-data`). It **must be lowercase** (R2 bucket names require it).

## Step 1: Verify tools

```bash
node deploy-scripts/verify-tools.js
```

Checks node, docker, the docker daemon, and the kit-local wrangler. If it exits
non-zero, fix the missing tool (most often: start Docker Desktop) and re-run.

## Step 2: Create a Cloudflare API Token

In the Cloudflare dashboard:

1. Open https://dash.cloudflare.com/profile/api-tokens
2. **Create Token** → use the **"Edit Cloudflare Workers"** template.
3. Add these permissions:
   - Account → **AI Gateway** → Edit
   - Account → **Workers R2 Storage** → Edit
   - Account → **Billing** → Read
4. Account Resources → Include → your account.
5. Zone Resources → All zones → Continue to summary → **Create Token** → copy it.

Save it into `.env`:

```bash
printf 'CLOUDFLARE_API_TOKEN=%s\n' 'PASTE_TOKEN_HERE' >> .env
```

## Step 3: Verify token + derive your account id

```bash
node deploy-scripts/get-account.js
```

Runs `wrangler whoami`, extracts your 32-hex account id, and writes both
`ACCOUNT_ID` and `CLOUDFLARE_ACCOUNT_ID` to `.env` (the second pins wrangler to
this account). If it fails, the token is wrong or missing permissions — redo
Step 2 (just append a fresh `CLOUDFLARE_API_TOKEN=` line; `source .env` uses the
last one).

## Step 4: Confirm Workers Paid plan

```bash
node deploy-scripts/check-plan.js
```

`OK` → good. `NO_WORKERS_PLAN` → upgrade your account to Workers Paid ($5/mo);
Containers require it.

## Step 5: Fetch your workers.dev subdomain

```bash
node deploy-scripts/get-subdomain.js
```

Prints your `<subdomain>.workers.dev`. If empty, register one at
`https://dash.cloudflare.com/<ACCOUNT_ID>/workers/onboarding`, then re-run.
Save it:

```bash
printf 'SUBDOMAIN=%s\n' 'YOUR_SUBDOMAIN' >> .env
```

Your bot will live at `https://hermes-<NAME>.<SUBDOMAIN>.workers.dev`.

## Step 6: Name the worker

```bash
node deploy-scripts/rename-worker.js
```

Rewrites `hermes-cf/wrangler.jsonc` from `hermes-cf` to `hermes-<NAME>`. (Hermes
has no R2 wrangler binding — rclone uses secrets at runtime — so only the worker
`name` changes.)

## Step 7: Create the R2 bucket

```bash
node deploy-scripts/create-bucket.js
```

Creates `hermes-<NAME>-data`. "Already exists" is fine (idempotent).

## Step 8: Create / reuse the shared AI Gateway

```bash
node deploy-scripts/create-gateway.js
```

Creates the fixed `agent-shared-gateway` in your account (reused if it already
exists). Idempotent.

## Step 9: Create an AI Gateway auth token

In the dashboard:

1. Open `https://dash.cloudflare.com/<ACCOUNT_ID>/ai/ai-gateway/gateways/agent-shared-gateway`
2. **Settings** tab → **Authenticated Gateway** → **Create authentication token**.
3. Name it `hermes-<NAME>`, keep defaults, Create, copy.
4. ⚠️ **Enable the "Authenticated Gateway" toggle.**

This token doubles as `OPENAI_API_KEY`. Save it:

```bash
printf 'AIG_TOKEN=%s\n' 'PASTE_AIG_TOKEN' >> .env
```

## Step 10: Create an R2 API token

Hermes stores state (sessions, memories, pairing list) on R2; the container uses
rclone to restore it at boot and back it up periodically. In the dashboard:

1. Open `https://dash.cloudflare.com/<ACCOUNT_ID>/r2/api-tokens`
2. **Create Account API Token**, name `hermes-<NAME>-r2`.
3. Permission: **Object Read & Write**.
4. Specify bucket → **Apply to specific buckets only** → `hermes-<NAME>-data`.
5. TTL: Forever → Create. Copy **both** the Access Key ID and Secret Access Key.

```bash
printf 'R2_ACCESS_KEY=%s\nR2_SECRET_KEY=%s\n' 'ACCESS_KEY_ID' 'SECRET_ACCESS_KEY' >> .env
```

## Step 11: Create your Telegram bot

1. In Telegram, open **@BotFather** (verified, blue tick).
2. Send `/newbot`, pick a display name, then a username ending in `bot`.
3. Copy the token it gives you (like `8622764702:AAGk-…`).

```bash
printf 'TELEGRAM_TOKEN=%s\n' 'PASTE_BOT_TOKEN' >> .env
```

Then read the bot's `@username` (the token doesn't contain it):

```bash
node deploy-scripts/get-bot-username.js
printf 'BOT_USERNAME=%s\n' 'THE_USERNAME_IT_PRINTED' >> .env
```

If it prints empty, the token is wrong — redo this step.

## Step 11.5: Completeness check (before deploy)

```bash
set -a; source .env; set +a
for k in NAME CLOUDFLARE_API_TOKEN ACCOUNT_ID SUBDOMAIN AIG_TOKEN R2_ACCESS_KEY R2_SECRET_KEY TELEGRAM_TOKEN BOT_USERNAME; do
  eval "v=\${$k}"; [ -z "$v" ] && echo "MISSING: $k"
done; echo "check done"
```

Fill any `MISSING` key from its step, then continue.

## Step 12: Write the 8 worker secrets

```bash
node deploy-scripts/secrets.js
```

Loads `.env` and writes all 8 secrets into your worker via wrangler (you never
type them). If one fails with a "use versions secret put" hint, retry just that
one: `(cd hermes-cf && ./node_modules/.bin/wrangler versions secret put <NAME>)`.

## Step 13: Deploy

```bash
set -a; source .env; set +a
(cd hermes-cf && npm run deploy 2>&1 | tail -40)
```

Builds the image with your local Docker, pushes to Cloudflare, and provisions
the container. ~5–10 minutes. Watch at
`https://dash.cloudflare.com/<ACCOUNT_ID>/workers/services/view/hermes-<NAME>/production`.
On success your worker is live at `https://hermes-<NAME>.<SUBDOMAIN>.workers.dev`.

## Step 14: Wait for the container to boot

```bash
node deploy-scripts/wait-ready.js
```

First cold boot restores state from R2, renders config, links bundled skills,
and starts the gateway. Polls until ready (~7–8 min max).

## Step 15: Pair your Telegram bot

Hermes uses Telegram **long-poll** — there is **no webhook to set** (setting one
would break it). Pair directly:

1. In Telegram, open **@<BOT_USERNAME>** (the bot you created in Step 11) and tap
   **Start** (or send `hi`).
2. The bot replies with a pairing code like `3GLKBD3W`.
3. Approve it:

```bash
node deploy-scripts/pair.js THE_PAIRING_CODE
```

If it reports a bad code, send `hi` again for a fresh one. If the call errors or
is empty, the container booted before R2 credentials propagated — re-run Step 14,
then retry.

## Done

Your Hermes bot is live on Telegram (`@<BOT_USERNAME>`). Out of the box it has
conversation with persistent memory, web search/extract, file and terminal
tools, and state on R2 that survives container restarts. First message warms up;
later ones are faster.

---

## Optional: Google Workspace (gws) access

The image bundles a `gws-workspace` skill (Gmail/Drive/Calendar via a headless
OAuth flow). The public image does **not** include any OAuth client — to use it,
supply your **own** Google Desktop OAuth `client_secret.json` at runtime. See
`deploy-kit/hermes-cf/skills/gws-workspace/` for how the skill authenticates.
You can skip this entirely; the bot works without it.

## Hard don'ts

- **Don't set a Telegram webhook.** Hermes is long-poll; a webhook breaks
  incoming messages.
- **Don't deploy with the bare `hermes-cf` name** — run Step 6 (rename) before
  Steps 7/12/13.
- **NAME is always lowercase** (folder, worker, bucket).
- Keep `.env` out of git (it's gitignored) and don't echo its secret values.

## Troubleshooting

| Symptom | Action |
|---|---|
| `wrangler whoami` fails after Step 2 | Token bad / missing perms → redo Step 2, append a fresh `CLOUDFLARE_API_TOKEN=` line |
| `ACCOUNT_ID` empty after Step 3 | Print raw `wrangler whoami`; confirm the token has account-level access |
| `SUBDOMAIN` empty | Register a workers.dev subdomain (Step 5) |
| `get-bot-username.js` prints empty | Telegram token wrong → redo Step 11 |
| `wrangler secret put` wants "versions secret put" | Use `versions secret put` for that one secret |
| `wait-ready.js` times out | Container still cold-booting; allow up to ~8 min |
| First AI call returns 401 | AIG token wrong, or the Step 9 toggle wasn't enabled — redo Step 9 |
| Bot silent after pairing | Check `…/debug/cli?cmd=hermes+gateway+status` via your worker URL |

Debug via your worker URL:

```bash
curl -s "https://hermes-<NAME>.<SUBDOMAIN>.workers.dev/health"
curl -s "https://hermes-<NAME>.<SUBDOMAIN>.workers.dev/debug/cli?cmd=hermes+pairing+list"
```
