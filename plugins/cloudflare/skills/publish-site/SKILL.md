---
name: publish-site
description: Deploy a folder on this box with wrangler using the Cloudflare vault token. Use when the user wants to publish a static site or Worker from a directory.
license: MIT
compatibility: Requires a Cloudflare API token in the vault. Never print the token.
metadata: host=cloudflare
---

# Publish a site

The Cloudflare API token lives in the vault. You never read it, echo it, or pass it as a flag.

```bash
BASE="${PI_BROWSER_API:-http://127.0.0.1:${PORT:-8788}}"
```

## 1. Prepare the folder

Write the site (or Worker) under `/workspace` (or `$PI_CWD`). Include `wrangler.jsonc` / `wrangler.toml` if needed.

## 2. Deploy through the sidecar

```bash
curl -sS -X POST "$BASE/api/plugins/cloudflare/publish" \
  -H 'content-type: application/json' \
  -d '{"dir":"site","name":"optional-worker-name"}'
```

The sidecar runs wrangler with `CLOUDFLARE_API_TOKEN` from the vault. The JSON log is redacted.

## 3. API calls

For account/zone reads, use the allowlisted proxy (`https://api.cloudflare.com/...`) the same way. Do not add Authorization.

If the response is `authenticate`, send the user to `/plugins` to paste a token. Do not run `npx wrangler` yourself with a token in the shell.
