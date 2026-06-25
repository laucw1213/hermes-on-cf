#!/usr/bin/env bash
# cf-liveview — hand a live Cloudflare Browser Run session to the human user
# (Human-in-the-Loop). Pure curl + python3. Token obtained via first-use
# paste-back; account id from CF_ACCOUNT_ID env.
set -euo pipefail

CFLV_DIR="${CF_LIVEVIEW_DIR:-$HOME/.config/cf-liveview}"
TOKEN_FILE="$CFLV_DIR/token"
CURL="${CURL:-curl}"
API="https://api.cloudflare.com/client/v4"

die() { echo "ERROR: $*" >&2; exit 1; }

read_token() {
  [ -f "$TOKEN_FILE" ] || die "no token — run: cf-liveview set-token <token>  (create one in the CF dashboard with 'Browser Rendering: Edit')"
  cat "$TOKEN_FILE"
}

acct() {
  [ -n "${CF_ACCOUNT_ID:-}" ] || die "CF_ACCOUNT_ID not set in env"
  printf '%s' "$CF_ACCOUNT_ID"
}

cf_api() { # METHOD path [data]
  local method="$1" path="$2" data="${3:-}" token
  token="$(read_token)" || exit $?
  if [ -n "$data" ]; then
    "$CURL" -fsS -X "$method" "$API/accounts/$(acct)/browser-rendering/$path" \
      -H "Authorization: Bearer $token" -H "Content-Type: application/json" -d "$data"
  else
    "$CURL" -fsS -X "$method" "$API/accounts/$(acct)/browser-rendering/$path" \
      -H "Authorization: Bearer $token"
  fi
}

cmd_set_token() {
  [ -n "${1:-}" ] || die "usage: cf-liveview set-token <token>"
  mkdir -p "$CFLV_DIR"; chmod 700 "$CFLV_DIR"
  printf '%s' "$1" > "$TOKEN_FILE"; chmod 600 "$TOKEN_FILE"
  echo "token saved to $TOKEN_FILE"
}

cmd_start() {
  local resp; resp="$(cf_api POST 'devtools/browser?keep_alive=600000&targets=true')"
  CFLV_RESP="$resp" python3 - <<'PY'
import os, json
d = json.loads(os.environ["CFLV_RESP"])
d = d.get("result", d)
sid = d.get("webSocketDebuggerUrl", "").rstrip("/").split("/")[-1]
url = d["targets"][0]["devtoolsFrontendUrl"]
tab = url.replace("/ui/view?", "/ui/view?mode=tab&", 1)
print("sid=" + sid)
print("liveUrl=" + tab)
PY
}

cmd_check() {
  local sid="${1:-}"; [ -n "$sid" ] || die "usage: cf-liveview check <sid>"
  local resp; resp="$(cf_api GET "devtools/browser/$sid/json/list")"
  CFLV_RESP="$resp" python3 - <<'PY'
import os, json
d = json.loads(os.environ["CFLV_RESP"])
items = d.get("result", d) if isinstance(d, dict) else d
pages = [t for t in items if t.get("type") == "page"] or items
if not pages:
    print("url="); print("title="); raise SystemExit(0)
print("url=" + pages[0].get("url", ""))
print("title=" + pages[0].get("title", ""))
PY
}

cmd_wait() {
  local sid="${1:-}" pat="${2:-}" timeout="${3:-120}" elapsed=0 url
  [ -n "$sid" ] && [ -n "$pat" ] || die "usage: cf-liveview wait <sid> <urlPattern> [timeoutSecs]"
  while [ "$elapsed" -lt "$timeout" ]; do
    url="$(cmd_check "$sid" | sed -n 's/^url=//p')"
    if printf '%s' "$url" | grep -qE -- "$pat"; then
      echo "matched=true url=$url"; return 0
    fi
    sleep 3; elapsed=$((elapsed + 3))
  done
  echo "matched=false"; return 0
}

cmd_stop() {
  local sid="${1:-}"; [ -n "$sid" ] || die "usage: cf-liveview stop <sid>"
  cf_api DELETE "devtools/browser/$sid" >/dev/null 2>&1 || true
  echo "stopped $sid"
}

main() {
  local cmd="${1:-}"; shift || true
  case "$cmd" in
    set-token) cmd_set_token "${1:-}";;
    start)     cmd_start;;
    check)     cmd_check "${1:-}";;
    wait)      cmd_wait "${1:-}" "${2:-}" "${3:-120}";;
    stop)      cmd_stop "${1:-}";;
    *)         die "usage: cf-liveview {set-token|start|check|wait|stop}";;
  esac
}
main "$@"
