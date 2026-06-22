#!/usr/bin/env bash
# Hermes-on-CF container entrypoint.
#
# Design: R2 is BACKUP, NOT primary storage (same pattern as OpenClaw).
#
# 1. Configure rclone for R2 (S3-compatible).
# 2. Restore persistent state from R2 → /opt/data (local disk).
# 3. Symlink ephemeral caches + bundled skills off /opt/data.
# 4. Render config.yaml from template via envsubst.
# 5. Start background sync loop (incremental every 30s, full every hour).
# 6. Start admin shim on :9876.
# 7. Hand off to s6 /init → hermes gateway run.
#
# Why not FUSE/TigrisFS? Mounting R2 as /opt/data round-trips every stat/read
# (~100ms) to R2 over the network. Hermes' boot does ~600 small reads against
# state.db (sqlite WAL) + skills, taking 5–7 min for the first reply. With
# rclone restore-on-boot + periodic sync, all I/O is local-disk (~1ms) and
# only deltas hit the network in the background.
#
# Required env (from wrangler secrets, forwarded by the Worker as-is):
#   R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY  — R2 token credentials
#   CF_ACCOUNT_ID                           — Cloudflare account id
#   R2_BUCKET_NAME                          — R2 bucket name
#   OPENAI_API_BASE_URL, OPENAI_API_KEY, HERMES_MODEL  — model config
set -euo pipefail

REQUIRED=(
  R2_ACCESS_KEY_ID R2_SECRET_ACCESS_KEY CF_ACCOUNT_ID R2_BUCKET_NAME
  OPENAI_API_BASE_URL OPENAI_API_KEY HERMES_MODEL
)
for v in "${REQUIRED[@]}"; do
  if [ -z "${!v-}" ]; then
    echo "[start] FATAL: \$${v} is not set"
    exit 1
  fi
done

DATA_DIR=/opt/data
RCLONE_CONF=/root/.config/rclone/rclone.conf
LAST_SYNC_FILE=/tmp/.last-sync

# ── Configure rclone ────────────────────────────────────────────────
echo "[start] Configuring rclone for R2 (bucket=${R2_BUCKET_NAME})"
mkdir -p "$(dirname "$RCLONE_CONF")"
cat > "$RCLONE_CONF" << EOF
[r2]
type = s3
provider = Cloudflare
access_key_id = ${R2_ACCESS_KEY_ID}
secret_access_key = ${R2_SECRET_ACCESS_KEY}
endpoint = https://${CF_ACCOUNT_ID}.r2.cloudflarestorage.com
acl = private
no_check_bucket = true
EOF
chmod 600 "$RCLONE_CONF"

RCLONE_FLAGS="--transfers=16 --fast-list --s3-no-check-bucket"

# ── Restore state from R2 ───────────────────────────────────────────
# /opt/data is a regular local directory (NOT a FUSE mount). The Hermes base
# image creates it as the hermes user's home. We populate it from R2 if a
# prior backup exists; otherwise we start fresh.
mkdir -p "$DATA_DIR"

echo "[start] Checking R2 for existing state..."
REMOTE_COUNT=$(rclone ls "r2:${R2_BUCKET_NAME}/" $RCLONE_FLAGS 2>/dev/null | wc -l || echo 0)
if [ "$REMOTE_COUNT" -gt 0 ]; then
  echo "[start] R2 has $REMOTE_COUNT objects — restoring to $DATA_DIR"
  rclone copy "r2:${R2_BUCKET_NAME}/" "$DATA_DIR/" $RCLONE_FLAGS \
    --exclude='cache/**' --exclude='image_cache/**' --exclude='audio_cache/**' \
    --exclude='logs/**' --exclude='*.lock' --exclude='*.pid' \
    2>&1 || echo "[start] WARNING: restore had errors (continuing)"
  echo "[start] Restore complete"
else
  echo "[start] R2 empty — starting fresh"
fi

# Ensure hermes user owns the data dir (first boot may have created empty paths as root).
chown -R 10000:10000 "$DATA_DIR" 2>/dev/null || true

# Pre-create the logs dir as the hermes user BEFORE the background sync loop
# (which runs as root) can create it root-owned. The Hermes gateway runs as
# hermes (UID 10000) and writes container-boot.log / agent.log here — if the
# dir is root-owned it hits PermissionError and s6 crash-loops the container.
mkdir -p "$DATA_DIR/logs"
chown 10000:10000 "$DATA_DIR/logs"

# ── Symlink redirects ───────────────────────────────────────────────
# Caches don't need R2 persistence — point them at a local tmpfs-like dir.
echo "[start] Symlinking caches → /var/hermes-cache"
for d in cache image_cache audio_cache; do
  if [ -e "$DATA_DIR/$d" ] && [ ! -L "$DATA_DIR/$d" ]; then
    rm -rf "$DATA_DIR/$d"
  fi
done
mkdir -p /var/hermes-cache/{cache,image_cache,audio_cache}
chown -R 10000:10000 /var/hermes-cache
ln -sfn /var/hermes-cache/cache "$DATA_DIR/cache"
ln -sfn /var/hermes-cache/image_cache "$DATA_DIR/image_cache"
ln -sfn /var/hermes-cache/audio_cache "$DATA_DIR/audio_cache"

# agent-browser runtime state (daemon socket + browser profile). Kept OFF the
# R2 sync path (ephemeral) and writable by hermes. Matches AGENT_BROWSER_HOME
# baked as a Docker ENV in the image.
mkdir -p /var/agent-browser
chown -R 10000:10000 /var/agent-browser

# Skills are baked into the image — point at the image-local path.
if [ -e "$DATA_DIR/skills" ] && [ ! -L "$DATA_DIR/skills" ]; then
  rm -rf "$DATA_DIR/skills"
fi
ln -sfn /opt/hermes/skills "$DATA_DIR/skills"

# ── Google Workspace / gcloud auth dirs (mirrors OpenClaw moltworker) ──
# The hermes user's HOME is /opt/data, so the agent's `gws` + gcloud + the
# headless OAuth script all resolve ~/.config/{gws,gcloud} under /opt/data —
# already on the R2 sync path, so Google auth state (refresh tokens, gcloud
# creds) persists across container restarts for free. Pre-create the dirs as
# hermes (UID 10000) so the agent can later write client_secret.json there
# (supply your own Google Desktop OAuth client_secret.json at runtime if you
# want Google Workspace access; the bot works fine without it).
echo "[start] Preparing /opt/data/.config/{gws,gcloud}"
mkdir -p "$DATA_DIR/.config/gws" "$DATA_DIR/.config/gcloud"
chown -R 10000:10000 "$DATA_DIR/.config"

# ── Render config.yaml ──────────────────────────────────────────────
# envsubst substitutes ${HERMES_MODEL}/${OPENAI_API_BASE_URL}/${OPENAI_API_KEY}
# placeholders. Writing the destination here means Hermes' official entrypoint
# sees it already exists and skips its own `cp` (so this template wins).
echo "[start] Rendering /opt/data/config.yaml from template"
envsubst < /opt/hermes/cli-config.yaml.example > "$DATA_DIR/config.yaml"
chown 10000:10000 "$DATA_DIR/config.yaml"
chmod 640 "$DATA_DIR/config.yaml"

# ── Background sync loop ────────────────────────────────────────────
# Incremental every 30s (find -newer + rclone copy --files-from), full every
# hour (rclone sync, cleans up deleted files from R2). Same pattern as
# OpenClaw's moltworker/start-openclaw.sh.
echo "[start] Starting background R2 sync loop"
(
  MARKER=/tmp/.last-sync-marker
  # Sync loop runs as root — keep its log OUT of /opt/data/logs (hermes-owned)
  # so we never drop a root-owned file into the gateway's log dir.
  LOGFILE=/var/hermes-cache/r2-sync.log
  CYCLE=0
  touch "$MARKER"

  while true; do
    sleep 30
    CYCLE=$((CYCLE + 1))

    if [ $((CYCLE % 120)) -eq 0 ]; then
      # Hourly full sync — cleans up files deleted locally from R2.
      echo "[sync] Full sync at $(date)" >> "$LOGFILE"
      rclone sync "$DATA_DIR/" "r2:${R2_BUCKET_NAME}/" $RCLONE_FLAGS \
        --exclude='cache/**' --exclude='image_cache/**' --exclude='audio_cache/**' \
        --exclude='skills/**' --exclude='logs/**' --exclude='bin/**' \
        --exclude='home/**' --exclude='.local/**' \
        --exclude='.config/gcloud/logs/**' \
        --exclude='*.lock' --exclude='*.pid' \
        --exclude='*-wal' --exclude='*-shm' \
        --exclude='.skills_prompt_snapshot.json' --exclude='.update_check' \
        --exclude='.install_method' --exclude='gateway_state.json' \
        2>> "$LOGFILE"
      touch "$MARKER"
      date -Iseconds > "$LAST_SYNC_FILE"
      echo "[sync] Full sync complete at $(date)" >> "$LOGFILE"
    else
      # Incremental — only upload files modified since last marker.
      CHANGED=/tmp/.changed-data
      find "$DATA_DIR" -newer "$MARKER" -type f \
        -not -path '*/cache/*' -not -path '*/image_cache/*' -not -path '*/audio_cache/*' \
        -not -path '*/skills/*' -not -path '*/logs/*' -not -path '*/bin/*' \
        -not -path '*/home/*' -not -path '*/.local/*' \
        -not -path '*/.config/gcloud/logs/*' \
        -not -name '*.lock' -not -name '*.pid' \
        -not -name '*-wal' -not -name '*-shm' \
        -not -name '.skills_prompt_snapshot.json' -not -name '.update_check' \
        -not -name '.install_method' -not -name 'gateway_state.json' \
        -printf '%P\n' 2>/dev/null > "$CHANGED" || true

      TOTAL=$(wc -l < "$CHANGED" 2>/dev/null || echo 0)
      if [ "$TOTAL" -gt 0 ]; then
        echo "[sync] Incremental upload ($TOTAL files) at $(date)" >> "$LOGFILE"
        rclone copy "$DATA_DIR/" "r2:${R2_BUCKET_NAME}/" \
          --files-from="$CHANGED" $RCLONE_FLAGS 2>> "$LOGFILE"
        echo "[sync] Incremental complete at $(date)" >> "$LOGFILE"
      fi
      touch "$MARKER"
      date -Iseconds > "$LAST_SYNC_FILE"
    fi
  done
) &
SYNC_PID=$!
echo "[start] Sync loop PID: $SYNC_PID"

# ── Admin shim ──────────────────────────────────────────────────────
# Listens on 0.0.0.0:9876, gated by the Worker's /debug/cli route. Runs as
# root so it can drop privileges (s6-setuidgid hermes) to exec the Hermes CLI.
echo "[start] Starting admin shim on :9876"
python3 /usr/local/bin/shim.py &

# ── Hand off to s6 /init → hermes gateway run ──────────────────────
# The base image (nousresearch/hermes-agent v2026.5.29) boots via s6-overlay:
# `/init` runs cont-init (UID remap, .venv, config/skills) then execs the CMD.
# CMD goes through main-wrapper.sh which drops to the `hermes` user and runs
# the subcommand → `hermes gateway run`.
#
# DO NOT call /opt/hermes/docker/entrypoint.sh — it is a deprecated no-op
# shim that never execs the CMD; wrapping it in `tini -g` mis-invokes the s6
# chain (`rc.init: -g: not found` → exit 127 → container crash-loop).
#
# `--replace`: on a container restart the s6 cont-init reconciler auto-starts
# the default profile's gateway (its last persisted state was `running`), so
# a plain `gateway run` would be a SECOND instance and the two fight
# ("Gateway already running (PID …)" loop). --replace makes ours take over.
echo "[start] Handing off to s6 /init → hermes gateway run --replace"
exec /init /opt/hermes/docker/main-wrapper.sh gateway run --replace
