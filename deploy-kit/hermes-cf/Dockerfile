# Hermes Agent on Cloudflare Containers
#
# Extends the official nousresearch/hermes-agent image with rclone so the
# container can pull persistent state from R2 at boot and push deltas back
# periodically. R2 is BACKUP, not primary storage — /opt/data is a regular
# local directory, so all of Hermes' file I/O (sqlite state.db, sessions,
# skill catalog) is local-disk fast instead of FUSE-network slow.
#
# Why not the FUSE/TigrisFS approach? Mounting R2 as /opt/data means every
# stat/read/write round-trips ~100ms to R2. Hermes' boot does ~600 small
# reads against state.db + skills, taking 5–7 minutes for the first reply.
# This is the same restore-on-boot + periodic-sync pattern OpenClaw uses.

# PINNED to a versioned release — do NOT use the floating `:main` tag. `main`
# moves without notice (it switched to s6-overlay mid-2026, which silently
# broke our start.sh/shim.py: gosu→s6-setuidgid, entrypoint.sh→/init, gateway
# double-run). A versioned tag + its digest freezes the base so rebuilds are
# reproducible and the start.sh / shim.py / secrets contracts stay valid.
# To intentionally bump: pull the new tag, re-validate start.sh + shim.py +
# gateway boot, then update the tag+digest here.
FROM nousresearch/hermes-agent:v2026.5.29@sha256:192a40783e9227b5f162b76af4d133050557adebd46e1c9cb40cb79a1317a9f7

# Install rclone (S3 client for R2) + envsubst (for config rendering).
# The base image already has curl, gosu/s6-setuidgid, tini, python3, and the
# hermes user (UID 10000 with /opt/data as home).
USER root
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates curl unzip \
      gettext-base \
 && curl -fsSL https://rclone.org/install.sh | bash \
 && rm -rf /var/lib/apt/lists/*
# gettext-base provides `envsubst`, used by start.sh to render
# cli-config.yaml.example into /opt/data/config.yaml at boot.

# ── Google Workspace + gcloud tooling (mirrors OpenClaw moltworker) ──
# Gives the Hermes agent the same Google capabilities OpenClaw has:
#   • gcloud   — Google Cloud SDK CLI
#   • gws      — Google Workspace CLI (Drive/Gmail/Calendar/Docs/Sheets/…)
#   • gws-auth-headless.py — two-phase headless OAuth driven over Telegram
# CF Containers run amd64 (x86_64), so we pull the x86_64 / musl assets.
#
# google-cloud-sdk → /opt/google-cloud-sdk (added to PATH).
RUN curl -fsSL https://dl.google.com/dl/cloudsdk/channels/rapid/downloads/google-cloud-cli-linux-x86_64.tar.gz \
      -o /tmp/gcloud.tar.gz \
 && tar -xzf /tmp/gcloud.tar.gz -C /opt \
 && /opt/google-cloud-sdk/install.sh --quiet --path-update=false --usage-reporting=false \
 && rm /tmp/gcloud.tar.gz
ENV PATH="/opt/google-cloud-sdk/bin:${PATH}"

# gws CLI (Google Workspace) — pinned musl x86_64 release → /usr/local/bin/gws.
RUN curl -fsSL https://github.com/googleworkspace/cli/releases/download/v0.22.5/google-workspace-cli-x86_64-unknown-linux-musl.tar.gz \
      | tar xz -C /usr/local/bin/

# google-auth-oauthlib for gws-auth-headless.py. The base image has no system
# pip (Hermes runs from a uv-managed venv), but `uv` IS on PATH — use it to
# install into the SYSTEM python3 so the script's `python3 …` contract works
# verbatim (its shebang is `#!/usr/bin/env python3`).
RUN uv pip install --system --break-system-packages google-auth-oauthlib

# Headless OAuth helper (driven by the agent over Telegram). Writes session +
# credentials under ~/.config/gws which, for the hermes user (HOME=/opt/data),
# resolves to /opt/data/.config/gws — already on the R2 sync path, so the
# Google auth state persists across container restarts with no extra wiring.
COPY skills/gws-workspace/gws-auth-headless.py /usr/local/bin/gws-auth-headless.py
RUN chmod +x /usr/local/bin/gws-auth-headless.py

# ── Browser automation (agent-browser skill) ────────────────────────
# Install Google Chrome stable from the official .deb so apt auto-resolves ALL
# runtime libs — Debian 13 (trixie) did the t64 lib rename, so hardcoding lib
# package names is fragile. Chrome lands at /usr/bin/google-chrome, a fixed
# path both the root build and the runtime hermes user can execute. This
# sidesteps `agent-browser install`'s HOME-based Chrome cache, which would
# mismatch between build-as-root (/root) and run-as-hermes (/opt/data).
RUN curl -fsSL https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb \
      -o /tmp/chrome.deb \
 && apt-get update \
 && apt-get install -y --no-install-recommends /tmp/chrome.deb \
 && rm -f /tmp/chrome.deb \
 && rm -rf /var/lib/apt/lists/*

# agent-browser CLI (Node — base image already has node/npm).
RUN npm install -g agent-browser

# Launch Chrome through a wrapper so EVERY invocation gets container-safe flags
# regardless of how agent-browser spawns it:
#   --no-sandbox          firecracker has no user namespaces for Chrome's sandbox
#   --disable-dev-shm-usage  /dev/shm is tiny in containers → use /tmp instead
#   --disable-gpu         headless, no GPU
# AGENT_BROWSER_EXECUTABLE_PATH (a Docker ENV, inherited by the gateway + the
# agent's terminal subprocess) points agent-browser at this wrapper.
RUN printf '#!/bin/sh\nexec /usr/bin/google-chrome --no-sandbox --disable-dev-shm-usage --disable-gpu "$@"\n' \
      > /usr/local/bin/chrome-nosandbox \
 && chmod +x /usr/local/bin/chrome-nosandbox
ENV AGENT_BROWSER_EXECUTABLE_PATH=/usr/local/bin/chrome-nosandbox
# Keep agent-browser's runtime state (daemon socket, profile) OFF the R2 sync
# path — it's ephemeral and a browser profile would bloat the bucket. start.sh
# creates /var/agent-browser owned by hermes (mirrors the /var/hermes-cache).
ENV AGENT_BROWSER_HOME=/var/agent-browser

# Bundle the two ported OpenClaw skills. Hermes auto-discovers any subdir of
# /opt/hermes/skills that has a SKILL.md (YAML frontmatter name/description) —
# start.sh symlinks /opt/data/skills → /opt/hermes/skills so they're visible.
#   gws-workspace → Google Workspace (uses gws + gws-auth-headless.py above)
#   agent-browser → browser automation (uses the Chrome + CLI above)
COPY skills/gws-workspace /opt/hermes/skills/gws-workspace
COPY skills/agent-browser /opt/hermes/skills/agent-browser

# Admin shim (Python stdlib only — base image already has python3).
# Listens on :9876, gated by the Worker's /debug/cli route.
COPY shim.py /usr/local/bin/shim.py
RUN chmod +x /usr/local/bin/shim.py

# Override the upstream Hermes config template. Upstream points at
# OpenRouter + claude-opus-4.6 which we have no credentials for; ours
# points at a Cloudflare AI Gateway and trims the Telegram toolset.
# Has ${VAR} placeholders that start.sh renders via envsubst at boot.
COPY cli-config.yaml.example /opt/hermes/cli-config.yaml.example

# Startup script: rclone restore → render config → background sync → boot Hermes gateway.
COPY start.sh /usr/local/bin/start.sh
RUN chmod +x /usr/local/bin/start.sh

# Hermes gateway listens on 8642 by default. (build 10 — shim HOME=/opt/data fix)
EXPOSE 8642

ENTRYPOINT ["/usr/local/bin/start.sh"]
