# Notifications (in-app + ntfy)

KaneGrowth stores every notification as a row first, then delivers it to an
[ntfy](https://ntfy.sh) topic when the server is configured for one. In-app delivery therefore
never depends on the push channel: an unconfigured or unreachable ntfy leaves the bell working and
only affects `ntfyStatus` on the row.

## How delivery works

```
event producer ──► notifications::emit
                     │ 1. preference gate (master + per-type switches)
                     │ 2. INSERT … ON CONFLICT(user_id, dedupe_key) DO NOTHING
                     │ 3. ntfy configured? ntfy_status = pending : ntfy_status = skipped
                     └─► background publish ──► ntfy_status = sent | failed (+ ntfyError)
```

- A duplicate `dedupeKey` returns the existing row and publishes nothing.
- A type the user has muted creates **no** row at all (so the bell never shows a muted type).
- Delivery failures never fail the request. The row keeps `ntfyStatus: "failed"` and a truncated
  `ntfyError` for troubleshooting.

### When evaluation runs

There is no background scheduler. Due date producers run:

- on every `GET /notifications` (idempotent through dedupe keys), and
- after an applied `POST /sync/push` (plus a once-per-day sync-completion notice).

### Producers

| Event | Source | Dedupe key |
|---|---|---|
| `budget_threshold` / `budget_over_limit` | budget evaluation on list/sync | `budget_threshold:<budget>:<periodStart>` / `budget_over_limit:<budget>:<periodStart>` |
| `bill_due` | active `recurringRules` due within `billReminderDaysBefore` | `bill_due:<rule>:<nextDueDate>` |
| `sync_completed` | applied ops in `POST /sync/push` (default off) | `sync_completed:<YYYY-MM-DD>` |
| `maintenance_due` | `POST /notifications/events` (Phase 2 Home Maintenance module) | caller-supplied |
| `import_completed` | client after a successful import | caller-supplied |
| `savings_milestone`, `workspace_invite` | supported event types / future producers | caller-supplied |

Budget evaluation is alert-only. It reads synced `budgets` and posted expense `transactions`,
never writes financial rows, and compares dates in UTC (the financial progress UI stays
authoritative for local-time periods).

## Environment

| Variable | Default | Meaning |
|---|---|---|
| `NTFY_URL` | unset | Base URL of the ntfy server (`http://ntfy:80` in compose). Unset = in-app only. |
| `NTFY_TOPIC` | unset | Topic to publish to. Required together with `NTFY_URL`. |
| `NTFY_TOKEN` | unset | Optional `Authorization: Bearer` token for a protected topic. Never logged. |

With `NTFY_URL` or `NTFY_TOPIC` empty, the server logs one startup warning and every row is
written with `ntfyStatus: "skipped"`.

## Docker Compose quick start

`docker-compose.yml` runs an `ntfy` service (`binwiederhier/ntfy:v2.38.2`) with a persisted
`ntfy-cache` volume, publishes it on `127.0.0.1:2586`, and waits for its healthcheck before
starting the API:

```bash
docker compose up --build
# App:      http://localhost:8080
# ntfy UI:  http://localhost:2586   (subscribe to the topic below)
```

Defaults:

- `NTFY_TOPIC` → `${NTFY_TOPIC:-kanegrowth}` (override in `.env` or the environment).
- `NTFY_TOKEN` → `${NTFY_TOKEN:-}`. Empty means the topic is open on the host-local port.
- `NTFY_BASE_URL` → `${NTFY_BASE_URL:-http://localhost:2586}` (used in ntfy's own links).

Subscribe from a browser or the mobile app at `http://localhost:2586/<topic>`.

### Enabling ntfy auth

The default bind (`127.0.0.1:2586`) and an open topic are deliberate for a single-host trial.
Before exposing ntfy beyond localhost, create an auth file and deny anonymous access:

```bash
docker run --rm -it -v "$PWD/ntfy:/etc/ntfy" binwiederhier/ntfy:v2.38.2 \
  user add --role=admin --auth-file=/etc/ntfy/user.db admin
docker run --rm -it -v "$PWD/ntfy:/etc/ntfy" binwiederhier/ntfy:v2.38.2 \
  token add --auth-file=/etc/ntfy/user.db --label=kanegrowth tk_...
```

Then add to the `ntfy` service:

```yaml
    environment:
      NTFY_AUTH_FILE: /var/cache/ntfy/user.db
      NTFY_AUTH_DEFAULT_ACCESS: deny-all
      NTFY_AUTH_USERS: ""
    volumes:
      - ./ntfy/user.db:/var/cache/ntfy/user.db
```

and give the API the token (`NTFY_TOKEN=tk_...`). Never commit a real token: compose only reads it
from the environment.

### Privacy caveat

One household-wide topic means every subscriber sees every member's notification titles and
messages. ntfy's server (or ntfy.sh, if you point `NTFY_URL` at the public service) sees them too.
Use a self-hosted ntfy instance and a protected topic for shared households, or keep ntfy
unconfigured and rely on in-app notifications.

## API

All routes require `Authorization: Bearer <access token>` and are scoped to the caller.

```bash
# List (runs due checks first); dismissed rows and unreadCount
curl -H "Authorization: Bearer $TOKEN" http://localhost:8080/api/v1/notifications

# Mark one read / dismiss one (404 for another user's id)
curl -X PATCH -H "Authorization: Bearer $TOKEN" \
  http://localhost:8080/api/v1/notifications/<id>/read
curl -X PATCH -H "Authorization: Bearer $TOKEN" \
  http://localhost:8080/api/v1/notifications/<id>/dismiss

# Mark every undismissed row read
curl -X PATCH -H "Authorization: Bearer $TOKEN" \
  http://localhost:8080/api/v1/notifications/read-all

# Read/write preferences (partial patches merge; unknown keys are preserved)
curl -H "Authorization: Bearer $TOKEN" http://localhost:8080/api/v1/notifications/preferences
curl -X PATCH -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"billReminderDaysBefore":7,"budgetAlertThresholdPercent":50}' \
  http://localhost:8080/api/v1/notifications/preferences

# Emit an event (always addressed to the caller; a supplied workspaceId must be a membership)
curl -X POST -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"type":"maintenance_due","title":"HVAC filter","message":"Replace the filter","dedupeKey":"hvac-2026-11"}' \
  http://localhost:8080/api/v1/notifications/events
```

The event response is always HTTP 200 when the input is valid:

```json
{ "success": true, "data": { "notification": { "_id": "…", "ntfyStatus": "pending" }, "deduped": false, "suppressed": false } }
```

`notification` is `null` with `suppressed: true` when the type is muted for that user, and
`deduped: true` when the `dedupeKey` already exists.

Event types: `budget_threshold`, `budget_over_limit`, `bill_due`, `maintenance_due`,
`sync_completed`, `import_completed`, `savings_milestone`, `workspace_invite`. Title and message are
truncated to 200 / 2 000 characters; unknown types are a 400.

### Preferences

Stored in `users.settings.notificationPreferences` and returned on both
`GET /auth/user` and `GET /notifications/preferences`. Defaults:

| Key | Default | Notes |
|---|---|---|
| `enabled` | `true` | Master switch |
| `budgetAlertsEnabled` | `true` | `budget_threshold` / `budget_over_limit` |
| `budgetAlertThresholdPercent` | `80` | Clamped to `1..=100` |
| `billRemindersEnabled` | `true` | `bill_due` |
| `billReminderDaysBefore` | `3` | Clamped to `0..=30` |
| `maintenanceRemindersEnabled` | `true` | `maintenance_due` |
| `syncNotificationsEnabled` | `false` | `sync_completed` |
| `savingsMilestoneEnabled` | `true` | `savings_milestone` |
| `workspaceInviteEnabled` | `true` | `workspace_invite` |

## Troubleshooting

| Symptom | Check |
|---|---|
| Rows stay `skipped` | `NTFY_URL`/`NTFY_TOPIC` are unset or empty on the API container |
| Rows go `failed` | `ntfyError` on the row; check the token/topic and that `http://localhost:2586/v1/health` responds |
| No `bill_due` row | The rule is active and not archived, and `nextDueDate <= today + billReminderDaysBefore` |
| No budget row | Budget period covers today, amount > 0, and posted expense transactions match its category/accounts |
| Duplicate suppressed | Expected: dedupe keys are per budget period / rule due date / day |

Retry policy: transport errors, `408`, `429` and `5xx` get three total attempts (5 s per attempt,
200 ms then 600 ms backoff). A `4xx` (bad token/topic) fails immediately without retrying.
