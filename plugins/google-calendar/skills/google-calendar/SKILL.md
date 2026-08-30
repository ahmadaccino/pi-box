---
name: google-calendar
description: List and create Google Calendar events via the sidecar plugin proxy. Never ask for or print tokens.
license: MIT
compatibility: Requires a Google Calendar OAuth grant or a pasted token in the vault.
metadata: host=google-calendar
---

# Google Calendar

One Google grant covers Gmail and Calendar. Use the sidecar proxy only.

```bash
BASE="${PI_BROWSER_API:-http://127.0.0.1:${PORT:-8788}}"
```

If a call returns `authenticate` or 401, send the user to `/plugins` and Authenticate. Do not take tokens in chat.

## List upcoming events

```bash
curl -sS -X POST "$BASE/api/plugins/google-calendar/proxy" \
  -H 'content-type: application/json' \
  -d '{"url":"https://www.googleapis.com/calendar/v3/calendars/primary/events?maxResults=10&singleEvents=true&orderBy=startTime","method":"GET"}'
```

## Create an event

```bash
curl -sS -X POST "$BASE/api/plugins/google-calendar/proxy" \
  -H 'content-type: application/json' \
  -d '{"url":"https://www.googleapis.com/calendar/v3/calendars/primary/events","method":"POST","body":{"summary":"Title","start":{"dateTime":"2026-08-30T15:00:00Z"},"end":{"dateTime":"2026-08-30T16:00:00Z"}}}'
```

## Hard rules

- Only `www.googleapis.com` and `calendar.googleapis.com`.
- Never attach Authorization. The sidecar injects the vault token and refreshes it.
- Confirm times and timezone with the user before creating events.
