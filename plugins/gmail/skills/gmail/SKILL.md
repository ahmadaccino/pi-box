---
name: gmail
description: Read and send Gmail via the sidecar plugin proxy. Never ask for or print tokens. Use when the user wants email listed, read, or sent.
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

## Send

Build an RFC 2822 message, base64url-encode it, then:

```bash
curl -sS -X POST "$BASE/api/plugins/gmail/proxy" \
  -H 'content-type: application/json' \
  -d '{"url":"https://gmail.googleapis.com/gmail/v1/users/me/messages/send","method":"POST","body":{"raw":"BASE64URL"}}'
```

## Hard rules

- Only `gmail.googleapis.com` and `www.googleapis.com`.
- Never put tokens, cookies, or Authorization headers in the proxy body.
- Never open oauth2.googleapis.com yourself; refresh is internal.
