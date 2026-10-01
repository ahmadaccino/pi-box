# Vault

Encrypted store for logins, payment cards, addresses, and contacts. The model
never sees passwords or card numbers. The user types secrets only on `/vault`.
Fill injects into a focused form field through the browser sidecar and returns
claim **names**, not values.

## How it works

1. The agent lists metadata: `{handle, kind, label, account, available}`.
2. If nothing matches, it creates a setup token. You open `/vault?setup=...` and
   submit the form. `POST /api/vault/items` is the **only** place secret values
   appear on the wire. The sidecar does not log that body.
3. To fill a page, the agent focuses a field, then calls fill with
   `{handle, browserSessionId}` only. The sidecar decrypts in-process and calls
   `fillNative` from `container/browser.mjs` when that export exists.

Kinds: `login`, `payment`, `address`, `contact`. Names and emails the user
already typed in chat are not vaulted.

One box, one user for now. Per-user Clerk scoping can wrap the store later
without changing this contract.

## Encryption

- Algorithm: AES-256-GCM (Node crypto), random 12-byte IV, 16-byte auth tag.
- Key: VAULT_ENCRYPTION_KEY, 32-byte base64. The sidecar copies it into memory at startup and removes the env var.
- Generate with openssl rand, then base64-encode 32 bytes.
- Store: PI_CODING_AGENT_DIR/vault/items.json (ciphertext only). Mode 0600, directory 0700.
- If the env var is unset, the sidecar uses an all-zero local-dev key and
  prints NOT FOR PRODUCTION. That default exists so local dev works; it
  is not a secret. Set a real key before storing anything you care about.
- Rotating the key cannot decrypt existing items. Re-save them.

## Threat model

Trusted boundary: the box filesystem plus the sidecar process.

- Language model / Pi session: cannot decrypt. List and fill responses have no secret values. Setup tokens carry kind, label, origin, identifierType only.
- Model shell: Pi's bash tool would otherwise inherit the sidecar environment. `container/shell-env.mjs` strips `VAULT_ENCRYPTION_KEY`, provider API keys, `GOOGLE_CLIENT_SECRET`, `BROWSER_CDP_TOKEN`, `CLOUDFLARE_API_TOKEN`, `GATEWAY_TOKEN`, and the other names in `SECRET_ENV_NAMES` before every bash child. `env` inside a bash tool call does not show them. Provider keys stay in the sidecar process so the model runtime can authenticate; they are not exported to the shell.
- Vault key in the sidecar process: `server.mjs` (and the device node) calls `sealVaultKeyFromEnv()` at startup. That reads `VAULT_ENCRYPTION_KEY` once into memory and deletes it from `process.env`, so later shell commands cannot inherit it and a child cannot read it back from the parent environment.
- Vault page in the user browser: sees secrets while typing. After save the page does not display the secret.
- Sidecar process (container/vault.mjs): can decrypt. It holds the key and plaintext in memory during save/fill.
- Box filesystem: ciphertext lives here. Anyone with the key and the files can decrypt. Disk encryption and file modes are the next layer.
- browser.mjs fillNative: receives claims in-process for native inject. Must not log or return them.

This is not a multi-tenant HSM. Do not put the local-dev key on a shared host.

## Environment

    VAULT_ENCRYPTION_KEY=   # 32 random bytes, base64
    PI_BOX_PUBLIC_URL=      # optional, absolute origin for setup URLs
    PI_CODING_AGENT_DIR=    # vault files go in <this>/vault/

## HTTP

| Method | Path | Result |
| --- | --- | --- |
| GET | /vault | Setup form (public/vault.html) |
| GET | /api/vault | { items: metadata[] } |
| GET | /api/vault/setup-form?setup= | Token metadata (no secrets) |
| POST | /api/vault/setup | { url } |
| POST | /api/vault/items | Save (body has secrets; never log) |
| POST | /api/vault/oauth-token | Upsert plugin OAuth/API token (refresh_token + expires_at in ciphertext; response is metadata only) |
| GET | /api/vault/oauth-token | Public plugin connection metadata (no secrets) |
| POST | /api/vault/fill | { handle, browserSessionId } in; { ok, kind, origin, filledClaims } out |

Fill errors include { ok: false, code: "no-browser" } when browser.mjs is
missing. That is not a successful fill.

## Sidecar exports

container/vault.mjs exports VAULT_ROUTES, handleVaultHttp,
vaultPublicStatus, vaultSkillRequires, plus isVaultAvailable,
listItems, createSetupToken, saveItem, fillFromVault.
