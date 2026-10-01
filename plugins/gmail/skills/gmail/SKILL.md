---
name: gmail
description: Read Gmail and file drafts via the sidecar plugin proxy. Never ask for or print tokens. Sending happens only when the user clicks Send on the Ready to send card.
license: MIT
compatibility: Requires a Gmail OAuth grant or a pasted token in the vault.
metadata: host=gmail
---

# Gmail

Talk to Gmail only through this box's allowlisted proxy. The sidecar injects the vault token. You never see it.

```bash
BASE="${PI_BROWSER_API:-http://127.0.0.1:${PORT:-8788}}"
```

## Authenticate

If a call returns `authenticate` or 401, tell the coordinator to open `/plugins` and click Authenticate on Gmail. Do not ask the user to paste a token into chat.

## List messages

```bash
curl -sS -X POST "$BASE/api/plugins/gmail/proxy" \
  -H 'content-type: application/json' \
  -d '{"url":"https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=10","method":"GET"}'
```

## Read one

```bash
curl -sS -X POST "$BASE/api/plugins/gmail/proxy" \
  -H 'content-type: application/json' \
  -d '{"url":"https://gmail.googleapis.com/gmail/v1/users/me/messages/ID?format=metadata","method":"GET"}'
```

## Draft (the user sends)

Build an RFC 2822 message, base64url-encode it, then create a draft. Do not call `messages/send` or `drafts/send`. The sidecar files a **Ready to send** card. The message is not sent until the user clicks Send.

```bash
curl -sS -X POST "$BASE/api/plugins/gmail/proxy" \
  -H 'content-type: application/json' \
  -d '{"url":"https://gmail.googleapis.com/gmail/v1/users/me/drafts","method":"POST","body":{"message":{"raw":"BASE64URL"}}}'
```

If the tool result says `draft: true` and `sent: false`, tell the user the draft is ready. Do not claim the email was sent.

## Hard rules

- Only `gmail.googleapis.com` and `www.googleapis.com`.
- Never put tokens, cookies, or Authorization headers in the proxy body.
- Never open oauth2.googleapis.com yourself; refresh is internal.
- Never send mail yourself. Clicks on the Ready to send card are the only send path.
