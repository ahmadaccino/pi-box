# Bots, history, and memory

A bot is the thing you talk to. Each one has a name, a short description, an avatar color, its own instructions, and its own workspace. The chat that used to be the only thread is the **default** bot (`Assistant`). You can rename it. You cannot delete it.

Routines carry a `botId` (missing means `default`). Approval rules are stored in that bot's `approvals.json`, so Allow always applies to that bot only. User skills are shared across bots.

## Files

Under `PI_CODING_AGENT_DIR`:

| Path | What |
| --- | --- |
| `agents/<id>/AGENTS.md` | Instructions plus the memory and skill notes Pi loads |
| `agents/<id>/memory.json` | Profile facts and dated log facts |
| `agents/<id>/sessions/` | Pi session files for every bot except the default |
| `sessions/` | Pi session files for the default bot (same place as before) |
| `approvals.json` | Allow-always rules for the default bot |
| `agents/<id>/approvals.json` | Allow-always rules for every other bot |
| `skills/<name>/SKILL.md` | User skills, shared by every bot |
| `workspaces/<id>/` | Workspace when `PI_CWD` is unset (a joined machine) |

On the cloud computer the default bot's workspace stays `PI_CWD` (`/workspace`). Other bots use `PI_CWD/bots/<id>`. Those folders are included in the session snapshot. The default `/workspace` tree is still not snapshotted.

The sidebar's bot list, chat list, and transcripts live in the Mesh Durable Object (`bots` storage key), not in the browser. Opening the app on another device calls `GET /api/bots` and `GET /api/sessions/:id/transcript`.

## HTTP

| Method | Path | |
| --- | --- |
| `GET` | `/api/bots` | List bots. Creates the default bot if needed. |
| `POST` | `/api/bots` | `{ name, description?, avatarColor?, instructions? }` |
| `GET` | `/api/bots/:id` | One bot |
| `PATCH` | `/api/bots/:id` | Rename, recolor, or replace instructions |
| `DELETE` | `/api/bots/:id` | Delete. The default bot returns 409. |
| `GET` | `/api/bots/:id/sessions` | Chats for that bot, newest first |
| `POST` | `/api/bots/:id/sessions` | New chat. Optional `id` adopts an existing client id. |
| `GET` | `/api/sessions/:id/transcript` | `{ session, messages }` |
| `GET` | `/api/bots/:id/memory` | Profile and log facts (container) |
| `DELETE` | `/api/bots/:id/memory/:factId` | Remove one fact |

`avatarColor` is `#rrggbb`. Chat still uses `POST /api/chat` with `botId` and `session`.

## Memory tools

Each bot's agent has `memory_write`, `memory_forget`, and `memory_search`.

- **profile** facts are prepended to every prompt inside `<profile-memory>`.
- **log** facts are dated (`at`, default today) and are not in the prompt until `memory_search`.
- The system prompt tells the model to save stable preferences, identity, and decisions, and to search the log before claiming it forgot a dated event.

`save_skill` writes `skills/<name>/SKILL.md` with `name` and `description` frontmatter. The skills list marks it `source: "user"`.

## UI

The sidebar lists bots, then that bot's chats, with New chat. Settings opens a sheet for the name, description, avatar color, instructions, and memory (view and delete). Routines created from `/routines` pick a bot.
