---
name: vault
description: List, set up, and fill saved logins, cards, addresses, and contacts from the encrypted vault. Never put passwords or card numbers in prompts or tool arguments. Use opaque handles only.
license: MIT
compatibility: Requires vault on this host.
metadata: host=vault
---

# Vault

Secrets live in the sidecar, encrypted at rest. You never see passwords, card numbers, or CVCs. You only see `{handle, kind, label, account, available}`.

Talk to the sidecar on this box (default `http://127.0.0.1:8788`). Do not print response bodies that are not these endpoints; list/setup/fill never return secret values.

## When to list

Call list before filling a login, payment, address, or contact field so you can pick a handle.

```bash
curl -sS http://127.0.0.1:8788/api/vault
```

Returns `{ "items": [{ "handle", "kind", "label", "account", "available" }] }`.

`account` is metadata only (origin + identifier type, card brand + last4, city). It is not a password or PAN.

## When to set up

If no item matches, do **not** ask the user to paste a password or card into chat. Create a setup link and tell the coordinator to give that URL to the user. The user enters secrets on the vault page.

```bash
curl -sS -X POST http://127.0.0.1:8788/api/vault/setup \
  -H 'content-type: application/json' \
  -d '{"kind":"login","label":"site login","identifierType":"email","origin":"https://example.com"}'
```

`kind` must be `login`, `payment`, `address`, or `contact`.

Never put an identifier value or a secret in the setup body. `origin` and `identifierType` (`email` | `phone` | `username`) are allowed for logins. Names, email addresses, and other non-secrets the user already typed in chat are **not** vaulted; use them directly.

The JSON is `{ "url": "/vault?setup=..." }` (or an absolute URL). Hand that URL to the coordinator. Do not open it yourself. Do not scrape it.

## When to fill

1. Focus the intended form field in the page first (browser skill).
2. Then fill by handle only:

```bash
curl -sS -X POST http://127.0.0.1:8788/api/vault/fill \
  -H 'content-type: application/json' \
  -d '{"handle":"vlt_...","browserSessionId":"SESSION"}'
```

Arguments are **only** `{handle, browserSessionId}`. Never pass a password, card, or CVC.

The response is `{ok, kind, origin, filledClaims}`. `filledClaims` is a list of **names** (for example `password`, `cardNumber`), never values. After a successful fill, do not inspect the field contents and do not return what was typed.

If `ok` is false and `code` is `no-browser`, the browser sidecar is not wired; say so. Do not invent a success.

## Hard rules

- Never put secrets in prompts, tool args, bash history on purpose, or chat.
- Opaque handles only.
- Fill only after the field is focused.
- Missing item: setup URL, not "please type your password here".
- Non-secrets (name, email from chat) are not vault items.
