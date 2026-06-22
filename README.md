# hermes-on-cf

Deploy your own **Hermes Agent** — a stateful AI agent reachable from your own
Telegram bot — to **your own Cloudflare account**.

Hermes runs as a Cloudflare **Worker + Container**, persists state to **R2**
(via rclone), and talks to **Workers AI** through a shared **AI Gateway**. It is
**Telegram long-poll** (no webhook, no web dashboard).

## Quick start

This repo is self-contained. To deploy, follow **[`SKILL.md`](./SKILL.md)** — it
is the single source of truth and works either way:

- **With an AI agent** (Claude Code / Cursor / a terminal agent): point it at
  `SKILL.md` and ask it to deploy. It runs the steps for you.
- **By hand:** open `SKILL.md` and copy-paste each command yourself.

In short:

```bash
git clone --branch v1.0 https://github.com/laucw1213/hermes-on-cf.git
cd hermes-on-cf/deploy-kit
(cd hermes-cf && npm install --no-audit --no-fund)
# then follow SKILL.md from Step 0
```

## What's in here

```
hermes-on-cf/
├── SKILL.md            ← the deploy guide (start here)
├── deploy-kit/
│   ├── env.template    ← schema for your local .env (secrets)
│   ├── deploy-scripts/ ← pre-built helpers, one per automated step
│   └── hermes-cf/      ← the Hermes Worker + Container source
├── .gitignore
└── README.md
```

## Requirements

- node ≥ 18, git, and **Docker Desktop running** (the deploy builds an image
  locally).
- A Cloudflare account on the **Workers Paid plan** ($5/mo — Containers require
  it).
- Telegram (you'll create a bot with BotFather).

You supply your own Cloudflare and Telegram tokens during the deploy; they go
into a local `.env` (gitignored) and are written to your worker as secrets.
Nothing secret is committed to this repo.
