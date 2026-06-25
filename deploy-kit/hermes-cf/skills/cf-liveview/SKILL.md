---
name: cf-liveview
description: >
  Hand a live, interactive browser to the human user (Human-in-the-Loop) via
  Cloudflare Browser Run. Use when a task needs the user to act in a real browser
  the bot cannot drive itself — logging into a site that has no API, solving an
  MFA/CAPTCHA, or any "you do this part in the browser" step. NOT for automated
  scraping/screenshots (use agent-browser) and NOT for Google sign-in (use the
  gws paste-back flow).
---

# cf-liveview — Human-in-the-Loop browser via Cloudflare Browser Run

The bot opens a remote browser, sends the user a Live View URL, the user does the
manual part, then the bot reads the resulting page and continues.

Script: `bash <skill-dir>/cf-liveview.sh <command>`
Needs `CF_ACCOUNT_ID` in env (already set) and a Browser-Rendering token (first-use setup below).

## First-time setup (one-time, paste-back)

Run any command; if it says "no token", walk the user through this:

> "To use the live browser, create a Cloudflare API token:
> open https://dash.cloudflare.com/profile/api-tokens → Create Token → Custom
> token → add permission **Account · Browser Rendering · Edit** → scope to your
> account → Create, then paste the token back here."

When the user pastes the token, store it:

```bash
bash <skill-dir>/cf-liveview.sh set-token "<the token>"
```

Stored at `~/.config/cf-liveview/token` (R2-backed), so this is needed only once.

## The flow

1. Start a session:

```bash
bash <skill-dir>/cf-liveview.sh start
# → sid=<id>
#   liveUrl=https://live.browser.run/ui/view?mode=tab&...
```

2. Send the `liveUrl` to the user over **Telegram DM only** (it is an access token
   to that browser — never post it in a group). Tell them which site to open and
   what to do, and to reply "done" when finished. The session lives ~10 minutes.

3. Detect completion (pick one):
   - Ask the user to reply "done", then read the page:
     ```bash
     bash <skill-dir>/cf-liveview.sh check <sid>
     # → url=<current page url>
     #   title=<page title>
     ```
   - Or wait for a known destination URL automatically:
     ```bash
     bash <skill-dir>/cf-liveview.sh wait <sid> '/dashboard' 120
     # → matched=true url=...   (or matched=false on timeout)
     ```

4. Use the result (e.g. confirm the URL reached) and continue the task.

5. Optionally close early (sessions also auto-close after ~10 min):

```bash
bash <skill-dir>/cf-liveview.sh stop <sid>
```

## Limits & safety

- Live View URL JWT is valid ~5 minutes; if the user is slow, run `start` again
  for a fresh URL.
- Session keep_alive max ~10 minutes — the whole interaction must finish inside
  that window.
- The remote browser uses Cloudflare datacenter IPs, so Google-style "this browser
  is not secure" bot-detection can trigger. This skill is for no-API login walls,
  not Google sign-in.
- The Live View URL grants control of that browser — Telegram DM only.
