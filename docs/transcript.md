# Transcript, attachments, and notifications

The chat transcript renders markdown (code, tables, math) and inline cards. The composer accepts files. The sidecar can search and fetch the web, ask a question, and hand files back.

## Attachments

Paste, drag onto the composer, or use **Attach**. Up to **6** files per message. Each file is at most **25 MB**. Video (`video/*`) may be **200 MB**.

- Images (`png`, `jpeg`, `gif`, `webp`) are sent to Pi as image content.
- Other files are written under the workspace at `uploads/<session>/<id>-<name>`. The turn text includes that path.
- The Mesh stores the same bytes in R2 at `uploads/<mesh>/<id>`. After the container wakes, the snapshot index (`uploads/index.json` in the agent dir) is used to copy those objects back into the workspace.

The browser posts `multipart/form-data` to `POST /api/chat`. JSON also works:

```json
{ "message": "look at this", "attachments": [{ "name": "notes.txt", "type": "text/plain", "data": "<base64>" }] }
```

The agent sends a file back with the `send_attachment` tool. The transcript shows an artifact card. Images render inline. **Download** fetches `GET /api/files/:id` with the same auth as the rest of the API.

## Cards

Approvals, Ready-to-send drafts, questions, and artifacts share one SSE event:

```
event: card
data: {"id":"...","kind":"approval|draft|question|artifact", ...}
```

`kind` is also copied to `type`. The approval gate still emits the older `approval` event so existing clients keep working. The web UI renders the `card` event.

`ask_user` shows a question card (options, multi-select, optional custom answer). `POST /api/cards/:id/answer` with `{ "options": ["..."], "custom": "..." }` resolves the tool. The reply text is the user's answer, and the UI appends it as a user message.

## Web search and fetch

`web_fetch` returns markdown wrapped in `<untrusted-web>`. `web_search` is described in [browser.md](browser.md).

## Notifications

When the tab is in the background (hidden or unfocused), the page notifies you if:

- a turn finishes
- a routine run finishes or fails
- an approval, draft, or question card is waiting

In a normal browser that is the Notification API, unless a Web Push subscription is active. Then the service worker (`/sw.js`) shows the push instead, including when the tab is not running the page.

Web Push needs a VAPID key pair on the Worker (public values, never commit the private key):

```bash
# any VAPID P-256 pair; the public key is the uncompressed point, base64url
npx wrangler secret put VAPID_PUBLIC_KEY
npx wrangler secret put VAPID_PRIVATE_KEY
npx wrangler secret put VAPID_SUBJECT   # mailto:you@example.com
```

`GET /api/config` includes `pushPublicKey`. The page subscribes and `POST /api/push/subscriptions` stores `{ endpoint, keys, meshId }` on the Mesh Durable Object (`push-subs`, last 20 per user). The Mesh sends a push when a cloud turn's SSE stream contains `done` or a waiting `card`, and when a routine run finishes.

The Electron app does not subscribe to Web Push. `desktop/preload.mjs` exposes `piBoxDesktop.notify`, and the main process shows a native `Notification` for the same background events.

Search and VAPID private keys are stripped from the bash tool environment, same as the other sidecar secrets.
