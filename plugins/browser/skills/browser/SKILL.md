---
name: browser
description: Open pages, screenshot, and extract text in a real browser. Use when the user asks to visit a URL, click through a site, or capture what a page looks like.
license: MIT
compatibility: Requires a browser on this host (Playwright/Chromium, or Cloudflare Browser Rendering).
metadata: host=browser
---

# Browser

This skill is only live on a pi-box whose host has a browser.

## Local / machine box

Prefer Playwright if installed:

```bash
npx --yes playwright screenshot \"$URL\" /tmp/pi-box-browser.png
```

Or open Chromium headless. Save screenshots under `/workspace` and tell the user the path.

## Cloudflare box

If `CLOUDFLARE_BROWSER=1`, use the Worker's browser binding / CDP proxy instead of shipping Chromium in the image. Do not apt-get install Chrome in the container.

## Rules

- Never dump cookies or passwords into the chat.
- If the capability is missing, say this box cannot browse and suggest a machine box or enabling Browser Rendering.
