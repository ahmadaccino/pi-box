---
name: android-device
description: Control an Android emulator or a plugged-in Android phone (boot, screenshot, tap, type). Use when the user wants Android QA, an emulator, or adb.
license: MIT
compatibility: Requires adb or Argent on this host. Does not run inside a Cloudflare container.
metadata: host=android
---

# Android device

Only available on a machine box with Android SDK / an emulator / a phone, or Argent (`npx @swmansion/argent`).

## Argent (preferred)

```bash
argent run list-devices
argent run screenshot --udid \"$UDID\"
argent tools
```

Useful tools: `boot-device`, `launch-app`, `describe`, `gesture-tap`, `keyboard`, `open-url`.

## adb fallback

```bash
adb devices -l
adb emu avd name
```

If no device is listed, say so. Do not download system images unprompted.
