#!/usr/bin/env python3
"""
gws-auth-headless.py — Two-phase headless OAuth for gws CLI

Designed to be driven by a bot (Hermes / OpenClaw) over TG:
  phase 1 = bot calls `start`  → gets URL → forwards to user via TG
  phase 2 = bot calls `finish` → with the redirect URL user pasted back

State (PKCE verifier + CSRF state + scopes) is persisted to a session file
between the two calls, so this script can be invoked twice — once to print
the URL, once to finish — and the OAuth handshake remains intact.

Usage:
  # Phase 1: produce auth URL
  python3 gws-auth-headless.py start [--scopes drive,gmail] [--full]
      → prints URL on stdout (last line)
      → saves session to ~/.config/gws/.auth-session.json

  # Phase 2: complete with the redirect URL the user pastes back
  python3 gws-auth-headless.py finish "http://localhost/?state=...&code=..."
      → writes credentials to ~/.config/gws/credentials.json
      → prints the path on stdout (last line)

  # Optional: legacy interactive mode (single invocation, input prompt)
  python3 gws-auth-headless.py interactive

Env / flags:
  GWS_CLIENT_SECRET    path to OAuth client_secret.json (default ~/.config/gws/client_secret.json)
  --client-secret PATH overrides env
  --output PATH        credentials JSON destination (default ~/.config/gws/credentials.json)
  --session PATH       session file location (default ~/.config/gws/.auth-session.json)

Requires:
  pip install google-auth-oauthlib
"""

import argparse
import json
import os
import sys
from pathlib import Path

# Loopback (http://localhost) is the OAuth-spec-approved redirect for installed apps,
# but oauthlib refuses plain http by default. Allow it explicitly for the loopback case.
os.environ.setdefault("OAUTHLIB_INSECURE_TRANSPORT", "1")
# Google sometimes grants extra scopes (e.g. cloud-platform when Workspace APIs are involved);
# tell oauthlib not to error when the granted scope set differs from what we requested.
os.environ.setdefault("OAUTHLIB_RELAX_TOKEN_SCOPE", "1")

try:
    from google_auth_oauthlib.flow import Flow
except ImportError:
    print("ERROR: google-auth-oauthlib not installed. Run: pip install google-auth-oauthlib")
    sys.exit(1)


SCOPE_PRESETS = {
    "openid": [
        "openid",
        "email",
        "profile",
        "https://www.googleapis.com/auth/userinfo.email",
        "https://www.googleapis.com/auth/userinfo.profile",
    ],
    "drive": ["https://www.googleapis.com/auth/drive"],
    "gmail": ["https://www.googleapis.com/auth/gmail.modify"],
    "calendar": ["https://www.googleapis.com/auth/calendar"],
    "docs": ["https://www.googleapis.com/auth/documents"],
    "sheets": ["https://www.googleapis.com/auth/spreadsheets"],
    "slides": ["https://www.googleapis.com/auth/presentations"],
    "chat": ["https://www.googleapis.com/auth/chat.messages"],
    "tasks": ["https://www.googleapis.com/auth/tasks"],
    "forms": ["https://www.googleapis.com/auth/forms.body"],
    "contacts": ["https://www.googleapis.com/auth/contacts"],
    "meet": ["https://www.googleapis.com/auth/meetings.space.created"],
}
DEFAULT_SERVICES = ["openid", "drive", "gmail", "calendar", "docs", "sheets"]


def resolve_client_secret(cli_arg):
    path = cli_arg or os.environ.get(
        "GWS_CLIENT_SECRET",
        str(Path.home() / ".config" / "gws" / "client_secret.json"),
    )
    path = os.path.expanduser(path)
    if not os.path.exists(path):
        print(f"ERROR: client_secret.json not found at {path}", file=sys.stderr)
        print("Run `gws auth setup` first, or pass --client-secret <path>", file=sys.stderr)
        sys.exit(1)
    return path


def build_scopes(services):
    out, seen = [], set()
    for svc in services:
        if svc not in SCOPE_PRESETS:
            print(f"WARN: unknown service '{svc}', skipping. Known: {list(SCOPE_PRESETS)}", file=sys.stderr)
            continue
        for s in SCOPE_PRESETS[svc]:
            if s not in seen:
                seen.add(s)
                out.append(s)
    return out


def cmd_start(args):
    client_secret = resolve_client_secret(args.client_secret)

    if args.full:
        services = list(SCOPE_PRESETS.keys())
    elif args.scopes:
        services = [s.strip() for s in args.scopes.split(",") if s.strip()]
    else:
        services = DEFAULT_SERVICES
    scopes = build_scopes(services)

    flow = Flow.from_client_secrets_file(
        client_secret, scopes=scopes, redirect_uri="http://localhost"
    )
    auth_url, state = flow.authorization_url(
        access_type="offline", prompt="consent", include_granted_scopes="true"
    )

    session = {
        "client_secret": client_secret,
        "scopes": scopes,
        "state": state,
        "code_verifier": flow.code_verifier,
    }
    session_path = os.path.expanduser(args.session)
    Path(session_path).parent.mkdir(parents=True, exist_ok=True)
    with open(session_path, "w") as f:
        json.dump(session, f, indent=2)
    os.chmod(session_path, 0o600)

    print(f"Services: {services}", file=sys.stderr)
    print(f"Scopes ({len(scopes)}):", file=sys.stderr)
    for s in scopes:
        print(f"  • {s}", file=sys.stderr)
    print(f"\nSession saved: {session_path}", file=sys.stderr)
    print("\nInstructions for the user:", file=sys.stderr)
    print("  1. Open the URL below on your own device", file=sys.stderr)
    print("  2. Sign in to Google + complete 2FA + click Allow", file=sys.stderr)
    print("  3. Browser will redirect to http://localhost/?... ('Unable to connect' is expected)", file=sys.stderr)
    print("  4. Copy the FULL localhost URL from the address bar and send back\n", file=sys.stderr)

    # The auth URL is the only thing on stdout — easy to scrape from a bot
    print(auth_url)


def cmd_finish(args):
    session_path = os.path.expanduser(args.session)
    if not os.path.exists(session_path):
        print(f"ERROR: session file not found: {session_path}", file=sys.stderr)
        print("Run `gws-auth-headless.py start` first.", file=sys.stderr)
        sys.exit(1)
    with open(session_path) as f:
        session = json.load(f)

    redirect_url = args.redirect_url.strip()
    if not redirect_url.startswith("http://localhost"):
        print(f"ERROR: URL must start with http://localhost, got: {redirect_url[:60]}...", file=sys.stderr)
        sys.exit(1)

    flow = Flow.from_client_secrets_file(
        session["client_secret"],
        scopes=session["scopes"],
        redirect_uri="http://localhost",
        state=session["state"],
    )
    # Restore the PKCE verifier so token exchange succeeds
    flow.code_verifier = session["code_verifier"]

    try:
        flow.fetch_token(authorization_response=redirect_url)
    except Exception as e:
        print(f"ERROR exchanging code: {e}", file=sys.stderr)
        sys.exit(1)

    creds = flow.credentials
    if not creds.refresh_token:
        print("ERROR: no refresh_token returned. Re-run `start` to retry.", file=sys.stderr)
        sys.exit(1)

    output = os.path.expanduser(args.output)
    Path(output).parent.mkdir(parents=True, exist_ok=True)
    with open(output, "w") as f:
        json.dump({
            "client_id": creds.client_id,
            "client_secret": creds.client_secret,
            "refresh_token": creds.refresh_token,
            "type": "authorized_user",
        }, f, indent=2)
    os.chmod(output, 0o600)

    # Best-effort: remove session file (PKCE used)
    try:
        os.unlink(session_path)
    except OSError:
        pass

    print(f"✅ Saved credentials to: {output}", file=sys.stderr)
    print(f"To use with gws:", file=sys.stderr)
    print(f"  export GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE={output}", file=sys.stderr)
    # Last line on stdout = path, for bot scraping
    print(output)


def cmd_interactive(args):
    """Single-process flow with input() prompt — for human shell users."""
    cmd_start(args)
    print("\n", file=sys.stderr)
    redirect_url = input("Paste the full localhost URL here:\n> ").strip()
    args.redirect_url = redirect_url
    cmd_finish(args)


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest="cmd", required=True)

    common = argparse.ArgumentParser(add_help=False)
    common.add_argument("--client-secret", help="Path to OAuth client_secret.json")
    common.add_argument("--output", default=str(Path.home() / ".config" / "gws" / "credentials.json"),
                        help="Where to write credentials JSON")
    common.add_argument("--session", default=str(Path.home() / ".config" / "gws" / ".auth-session.json"),
                        help="Where to store/read the OAuth session state")

    p_start = sub.add_parser("start", parents=[common], help="Phase 1: produce auth URL")
    p_start.add_argument("--scopes", help="Comma-separated services (drive,gmail,...)")
    p_start.add_argument("--full", action="store_true", help="Request all preset scopes")
    p_start.set_defaults(func=cmd_start)

    p_finish = sub.add_parser("finish", parents=[common], help="Phase 2: complete with redirect URL")
    p_finish.add_argument("redirect_url", help="The full http://localhost/?... URL the user pasted back")
    p_finish.set_defaults(func=cmd_finish)

    p_inter = sub.add_parser("interactive", parents=[common], help="Single-process flow with input() prompt")
    p_inter.add_argument("--scopes")
    p_inter.add_argument("--full", action="store_true")
    p_inter.set_defaults(func=cmd_interactive)

    args = p.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
