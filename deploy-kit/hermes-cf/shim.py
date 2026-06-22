#!/usr/bin/env python3
# Internal admin HTTP shim for Hermes-on-CF.
#
# Listens on 0.0.0.0:9876 inside the container. The only ingress to that
# port is via the Worker's containerFetch — CF Containers do not expose
# arbitrary container ports publicly. So the security boundary is the
# Worker route (/debug/cli), not this listener.
#
# Endpoint:
#   GET /exec?cmd=<urlencoded shell cmd>
# Body:
#   { "command", "exit_code", "stdout", "stderr" }
#
# Only commands that begin with "hermes " are accepted, to mirror the
# OpenClaw /debug/cli surface (which is scoped to the `openclaw` CLI).
import http.server
import json
import os
import shlex
import shutil
import subprocess
import urllib.parse

ALLOWED_PREFIXES = ("hermes ", "curl ", "cat ", "ls ", "env")
EXEC_TIMEOUT_SEC = 60
# Hermes CLI lives inside the uv-managed venv — not on the default PATH.
HERMES_BIN = "/opt/hermes/.venv/bin/hermes"
# Privilege-drop wrapper to run hermes as the unprivileged `hermes` user.
# The base image (nousresearch/hermes-agent) migrated from `gosu` to
# s6-overlay's `s6-setuidgid`; resolve whichever exists so the shim keeps
# working across base-image bumps (a missing `gosu` raised FileNotFoundError
# and made every /debug/cli call return empty).
PRIV_DROP = (shutil.which("s6-setuidgid") or shutil.which("gosu")
             or "/command/s6-setuidgid")

# Run shim commands with the hermes user's real HOME (the gateway uses
# HOME=/opt/data). s6-setuidgid changes UID/GID but does NOT reset HOME, so
# without this the dropped command inherits the shim's root HOME=/root. Any
# `hermes` subcommand that touches ~/.config (e.g. `gateway status` probing
# ~/.config/systemd) would then hit /root/.config — which other tooling
# (npm/gcloud) created root-only — and crash with PermissionError instead of
# resolving to the hermes-owned /opt/data/.config. Pin HOME so shim commands
# match the gateway and stay consistent with pairing/CLI state.
CHILD_ENV = {**os.environ, "HOME": "/opt/data"}


class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        u = urllib.parse.urlparse(self.path)
        if u.path != "/exec":
            self._json(404, {"error": "not found", "path": u.path})
            return
        q = urllib.parse.parse_qs(u.query)
        cmd = (q.get("cmd") or [""])[0]
        if not any(cmd.startswith(p) for p in ALLOWED_PREFIXES):
            self._json(403, {"error": f"cmd must start with one of {ALLOWED_PREFIXES}", "cmd": cmd})
            return
        try:
            argv = shlex.split(cmd)
        except ValueError as e:
            self._json(400, {"error": f"shlex parse failed: {e}", "cmd": cmd})
            return
        # For hermes commands, swap with absolute venv binary path. Other
        # allowed commands (curl/cat/ls/env) execute as-is.
        if argv[0] == "hermes":
            argv[0] = HERMES_BIN
        try:
            proc = subprocess.run(
                [PRIV_DROP, "hermes", *argv],
                capture_output=True,
                text=True,
                timeout=EXEC_TIMEOUT_SEC,
                env=CHILD_ENV,
            )
            self._json(200, {
                "command": cmd,
                "exit_code": proc.returncode,
                "stdout": proc.stdout,
                "stderr": proc.stderr,
            })
        except subprocess.TimeoutExpired:
            self._json(504, {"error": "timeout", "cmd": cmd, "timeout_sec": EXEC_TIMEOUT_SEC})

    def _json(self, status, body):
        data = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, fmt, *a):
        return


if __name__ == "__main__":
    http.server.HTTPServer(("0.0.0.0", 9876), Handler).serve_forever()
