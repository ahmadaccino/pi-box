---
name: telegram
description: File Telegram messages as drafts via the sidecar proxy. Never ask for or print the bot token. The user clicks Send before anything is delivered.
license: MIT
compatibility: Requires a Telegram bot token stored in the vault.
metadata: host=telegram
---

# Telegram

Store the bot token on `/plugins` (Authenticate → vault paste). The sidecar injects it. You never see it.

```bash
BASE="${PI_BROWSER_API:-http://127.0.0.1:${PORT:-8788}}"
```

The proxy rewrites `https://api.telegram.org/...` and adds the vault token. Prefer URLs without embedding a token.

Outgoing messages (`sendMessage` and the other send methods) are **not delivered**. The sidecar shows a Ready to send card. The user clicks Send or Discard. If the tool result says `draft: true` and `sent: false`, say the message is ready. Do not claim it was sent.

```bash
curl -sS -X POST "$BASE/api/plugins/telegram/proxy" \
  -H 'content-type: application/json' \
  -d '{"url":"https://api.telegram.org/bot/sendMessage","method":"POST","body":{"chat_id":"CHAT","text":"hello"}}'
```

Deletes and edits are separate: they wait on an approval card (Allow once / Always allow / Deny) and are not drafts.

If you must use the Bot API path form, still do not include the token; the sidecar fills it from the vault.

On `authenticate` / 401, send the user to `/plugins`. Host must be `api.telegram.org` only.
