---
name: ios-simulator
description: Control the iOS Simulator on a Mac (boot, screenshot, tap, type). Use when the user wants iOS QA or a simulator. Never claim a simulator exists on Linux or Cloudflare.
license: MIT
compatibility: Requires macOS with Xcode Simulator or Argent. iOS physical phones are not supported.
metadata: host=ios
---

# iOS Simulator

This skill is dead unless this pi-box is running **on a Mac** with Xcode (or Argent). Cloudflare containers and Linux boxes cannot boot simulators.

## Argent (preferred)

```bash
argent run list-devices
argent run screenshot --udid \"$UDID\"
```

Booted simulators show `state: "Booted"`. Physical iPhones are not supported.

## simctl fallback

```bash
xcrun simctl list devices available
```

If `xcrun` is missing, say this box is not a Mac and point the user at a machine box on the right device.
