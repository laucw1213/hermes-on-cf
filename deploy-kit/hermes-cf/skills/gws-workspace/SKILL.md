---
name: google-workspace
description: >
  Manage Google Workspace via the `gws` CLI — Drive, Gmail, Calendar, Sheets, Docs, Chat, Admin,
  Tasks, Meet, Slides, Forms, Contacts, and every other Workspace API. Use when: (1) listing,
  uploading, downloading, or sharing files on Google Drive, (2) reading, sending, labeling, or
  filtering Gmail messages, (3) creating, updating, or querying Google Calendar events,
  (4) reading or writing Google Sheets data, (5) creating or editing Google Docs,
  (6) sending Google Chat messages, (7) managing Google Tasks, (8) any other Google Workspace
  operation. Wraps the official `gws` CLI which dynamically discovers all Workspace APIs.
  Outputs structured JSON suitable for agent pipelines.
metadata:
  openclaw:
    category: "productivity"
    requires:
      bins: ["gws", "gcloud", "python3"]
      files: ["/usr/local/bin/gws-auth-headless.py"]
    install:
      - id: gws
        kind: node
        package: "@googleworkspace/cli"
        bins: ["gws"]
        label: "Install Google Workspace CLI (npm)"
      - id: gcloud
        kind: system
        label: "Install Google Cloud CLI (baked into the OpenClaw container)"
      - id: python3
        kind: system
        label: "Python 3 + google-auth-oauthlib (baked into the OpenClaw container)"
---

# Google Workspace Skill

Operate all Google Workspace services through the `gws` CLI from OpenClaw.

## Prerequisites

The required binaries are pre-installed in the container image: the `gws`
CLI, Python 3, and the bundled `/usr/local/bin/gws-auth-headless.py` helper.
The Google OAuth **Desktop client is not shipped** in the image — you provide
your own `client_secret.json` once (see Step 0 below). It lives at
`$HOME/.config/gws/client_secret.json`.

## Authentication — first-time login (one-time, paste-back OAuth)

The container is headless, so you sign in on your own phone/laptop and paste a
URL back. Login needs two files under `$HOME/.config/gws/`: `client_secret.json`
(the OAuth Desktop client you provide once, Step 0) and `credentials.json`
(written automatically after you sign in).

**Step 0 — make sure the OAuth client is present:**

```bash
test -f "$HOME/.config/gws/client_secret.json" && echo HAVE_CLIENT || echo NEED_CLIENT
```

- `HAVE_CLIENT` → continue to the pre-check below.
- `NEED_CLIENT` → you need a Google **Desktop** OAuth client. Create one in the
  Google Cloud Console (APIs & Services → Credentials → Create credentials →
  OAuth client ID → Application type: **Desktop app**), enable the APIs you need
  (Gmail, Drive, Calendar, …) and add their scopes on the consent screen, then
  download the JSON. Save it to `$HOME/.config/gws/client_secret.json` (chmod
  600) — if the user pasted the JSON to you, write it there yourself. Re-run
  Step 0.

**Pre-check (skip the rest if already connected):**

```bash
test -f "$HOME/.config/gws/credentials.json" && \
  gws gmail users-messages list --params '{"userId":"me","maxResults":1}' >/dev/null 2>&1 \
  && echo ALREADY_CONNECTED
```

If `ALREADY_CONNECTED` → tell the user they are already linked and skip
to "Command Pattern" below.

**Step 1 — generate the OAuth URL:**

```bash
python3 /usr/local/bin/gws-auth-headless.py start \
  --scopes gmail,drive,calendar,docs,sheets
```

The script prints the URL on **stdout** (last line). Give it to the user:

> "Open this on your phone or laptop:
>
>  `<URL>`
>
> Sign in with the Google account you want to use, then click Allow. Your
> browser will say *'This site can't be reached'* — that is expected. Copy the
> **full** URL from the address bar (it starts with `http://localhost/?...`)
> and paste it back here."

Then **stop and wait** for the user's reply.

**Step 2 — exchange the code:**

Validate the URL: it must start with `http://localhost` and contain
`code=`. If the shape is wrong, ask again briefly. Otherwise:

```bash
python3 /usr/local/bin/gws-auth-headless.py finish "<the URL>"
```

On success the script writes `~/.config/gws/credentials.json` and prints the
path. Persist the env var so later `gws` calls find it:

```bash
export GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE=$HOME/.config/gws/credentials.json
grep -q GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE ~/.bashrc || \
  echo 'export GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE=$HOME/.config/gws/credentials.json' >> ~/.bashrc
```

**Step 3 — smoke test + report:**

```bash
gws gmail users-messages list --params '{"userId":"me","maxResults":1}'
```

JSON with `messages` or `resultSizeEstimate` → success. Tell the user:

> "✅ Connected to your Google account. You can now ask me about your
>  inbox, Drive files, calendar, etc."

Then STOP.

**Hard don'ts during login:**
- Don't call `gws auth login` — it opens a browser and binds a localhost
  callback, both of which fail in this container. Use the paste-back flow above.
- Don't run Step 1 again after a successful Step 3 — that invalidates the
  saved session and forces a redo.

### Other credential sources (advanced)

- **Service account** — `export GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE=/path/to/sa.json`
- **Short-lived access token** — `export GOOGLE_WORKSPACE_CLI_TOKEN=$(gcloud auth print-access-token)`

Credential resolution order inside `gws`:
`GOOGLE_WORKSPACE_CLI_TOKEN` → `GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE` →
encrypted `gws auth login` store → plaintext `~/.config/gws/credentials.json`.

## Command Pattern

```bash
gws <service> <resource> <method> [--params '{}'] [--json '{}'] [flags]
```

All responses are **structured JSON**. Use `jq` for extraction.

### Global Flags

| Flag | Purpose |
|------|---------|
| `--dry-run` | Preview request without executing |
| `--page-all` | Stream all pages as NDJSON |
| `--fields 'a,b'` | Select response fields |
| `--output table` | Table output for humans |

### Discover commands

```bash
gws --help              # list all services
gws drive --help        # list resources in a service
gws drive files --help  # list methods on a resource
gws schema drive.files.list  # full request/response schema
```

## Common Operations

### Drive

```bash
# List recent files
gws drive files list --params '{"pageSize": 10}'

# Search files
gws drive files list --params '{"q": "name contains '\''report'\''", "pageSize": 20}'

# Upload a file
gws drive +upload ./report.pdf

# Download a file
gws drive files get --params '{"fileId": "FILE_ID", "alt": "media"}' > output.pdf

# Create a folder
gws drive files create --json '{"name": "Project", "mimeType": "application/vnd.google-apps.folder"}'

# Share a file
gws drive permissions create \
  --params '{"fileId": "FILE_ID"}' \
  --json '{"role": "reader", "type": "user", "emailAddress": "user@example.com"}'

# List all pages
gws drive files list --params '{"pageSize": 100}' --page-all | jq -r '.files[].name'
```

### Gmail

```bash
# List inbox messages
gws gmail users-messages list --params '{"userId": "me", "maxResults": 10}'

# Read a message
gws gmail users-messages get --params '{"userId": "me", "id": "MSG_ID"}'

# Send an email
gws gmail users-messages send \
  --params '{"userId": "me"}' \
  --json '{"raw": "BASE64_ENCODED_EMAIL"}'

# Search messages
gws gmail users-messages list --params '{"userId": "me", "q": "from:boss@company.com is:unread"}'

# List labels
gws gmail users-labels list --params '{"userId": "me"}'

# Create a filter
gws gmail users-settings-filters create \
  --params '{"userId": "me"}' \
  --json '{"criteria": {"from": "noreply@example.com"}, "action": {"addLabelIds": ["LABEL_ID"], "removeLabelIds": ["INBOX"]}}'
```

### Calendar

```bash
# List upcoming events
gws calendar events list --params '{"calendarId": "primary", "timeMin": "2026-01-01T00:00:00Z", "maxResults": 10, "orderBy": "startTime", "singleEvents": true}'

# Create an event
gws calendar events insert \
  --params '{"calendarId": "primary"}' \
  --json '{"summary": "Team Sync", "start": {"dateTime": "2026-03-07T10:00:00+08:00"}, "end": {"dateTime": "2026-03-07T11:00:00+08:00"}, "attendees": [{"email": "user@example.com"}]}'

# Delete an event
gws calendar events delete --params '{"calendarId": "primary", "eventId": "EVENT_ID"}'

# Find free/busy slots
gws calendar freebusy query \
  --json '{"timeMin": "2026-03-07T00:00:00Z", "timeMax": "2026-03-07T23:59:59Z", "items": [{"id": "user@example.com"}]}'
```

### Sheets

```bash
# Create a spreadsheet
gws sheets spreadsheets create --json '{"properties": {"title": "Q1 Budget"}}'

# Read cell values
gws sheets spreadsheets-values get --params '{"spreadsheetId": "SHEET_ID", "range": "Sheet1!A1:D10"}'

# Write values
gws sheets spreadsheets-values update \
  --params '{"spreadsheetId": "SHEET_ID", "range": "Sheet1!A1", "valueInputOption": "USER_ENTERED"}' \
  --json '{"values": [["Name", "Amount"], ["Rent", "2000"]]}'

# Append a row
gws sheets spreadsheets-values append \
  --params '{"spreadsheetId": "SHEET_ID", "range": "Sheet1!A1", "valueInputOption": "USER_ENTERED"}' \
  --json '{"values": [["New Item", "500"]]}'
```

### Docs

```bash
# Create a document
gws docs documents create --json '{"title": "Meeting Notes"}'

# Get document content
gws docs documents get --params '{"documentId": "DOC_ID"}'

# Insert text (batchUpdate)
gws docs documents batchUpdate \
  --params '{"documentId": "DOC_ID"}' \
  --json '{"requests": [{"insertText": {"location": {"index": 1}, "text": "Hello World\n"}}]}'
```

### Chat

```bash
# List spaces
gws chat spaces list

# Send a message
gws chat spaces messages create \
  --params '{"parent": "spaces/SPACE_ID"}' \
  --json '{"text": "Deploy complete ✅"}'
```

### Tasks

```bash
# List task lists
gws tasks tasklists list

# List tasks
gws tasks tasks list --params '{"tasklist": "TASKLIST_ID"}'

# Create a task
gws tasks tasks insert \
  --params '{"tasklist": "TASKLIST_ID"}' \
  --json '{"title": "Review PR", "due": "2026-03-10T00:00:00Z"}'
```

### Admin (Directory)

```bash
# List users
gws admin users list --params '{"domain": "example.com"}'

# Get user details
gws admin users get --params '{"userKey": "user@example.com"}'
```

## Workflow Patterns

### Pipeline: Find → Process → Act

```bash
# Find unread emails from boss, extract subjects
gws gmail users-messages list --params '{"userId": "me", "q": "from:boss is:unread"}' \
  | jq -r '.messages[].id' \
  | while read id; do
      gws gmail users-messages get --params "{\"userId\": \"me\", \"id\": \"$id\"}" \
        | jq -r '.payload.headers[] | select(.name=="Subject") | .value'
    done
```

### Dry-run first

Always use `--dry-run` before destructive operations:

```bash
gws drive files delete --params '{"fileId": "FILE_ID"}' --dry-run
```

## Tips

- Use `gws schema <method>` to discover exact parameter names and types.
- All commands accept `--params` for URL/query parameters and `--json` for request body.
- Pipe through `jq` for field extraction in agent pipelines.
- Use `--page-all` for full result sets with automatic pagination.
- Credentials are encrypted at rest (AES-256-GCM) with OS keyring.

## Recipes

For 50+ ready-made workflow recipes (label & archive emails, organize Drive folders, schedule meetings, etc.), see the [official recipe library](https://github.com/googleworkspace/cli/tree/main/skills).

## Disclaimer

The `gws` CLI is **not an officially supported Google product**. It is a community/experimental tool. Use at your own discretion, and refer to the [upstream repository](https://github.com/googleworkspace/cli) for license and support details.

## Troubleshooting

| Issue | Fix |
|-------|-----|
| `gws: command not found` | The container image is missing the `gws` CLI — re-deploy. |
| 401 / `invalid_grant` / `UNAUTHENTICATED` on any call | Credentials expired or missing. Re-run the "Authentication" section above (Step 1 onwards) for a fresh login. |
| 403 / `accessNotConfigured` / `PERMISSION_DENIED` | The OAuth client's GCP project hasn't enabled the API, OR the consent screen is missing the scope. Enable the API and add the scope in your Google Cloud Console. |
| Scope error on a specific API | You logged in without the needed scope. Re-run the "Authentication" section with the right `--scopes`. |
| `client_secret.json not found` | No OAuth client at `$HOME/.config/gws/client_secret.json` — provide your own Desktop OAuth client there (see Authentication, Step 0). |
| "Access blocked" on Google sign-in | You signed in with a Google account that isn't allowed on the OAuth consent screen. Use the account you set the client up for, and add it as a test user if the consent screen is in testing. |
| Rate limited (429 / quota) | Add delays between calls, reduce `pageSize`, batch where possible. |
| Pagination cuts off results | Use `--page-all` to stream all pages as NDJSON. |
