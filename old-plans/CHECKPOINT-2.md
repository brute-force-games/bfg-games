# CHECKPOINT 2 — Phase 4 Sync + Multiplayer Packaging

Date: 2026-04-25

This checkpoint is a delta from `old-plans/CHECKPOINT-1.md`.

## What changed since CHECKPOINT 1

### Phase 4 sync layer is now implemented (not just planned)
- `/room/:roomId/play` is no longer “shell only” — it now connects to the **TinyBase public demo server** and renders a live player list.
- Implemented a TinyBase-backed room store client that:
  - creates a TinyBase `MergeableStore`
  - attaches `ROOM_TABLES_SCHEMA`
  - connects via `createWsSynchronizer(...).startSync()`
  - writes a `players[self]` row and maintains a `lastSeen` heartbeat (`5_000ms`)
- `BUILD-PLAN.md` was updated to document the demo base URL used:
  - `wss://todo.demo.tinybase.org/<roomId>`

### Multiplayer split into dedicated packages (new architecture decision)
We extracted networking/multiplayer into its own modules so other implementations can be added later.

New workspaces:
- `platform/multiplayer-types` → `@brute-force-games/multiplayer-types`
  - transport-agnostic interfaces (eg `RoomStore`, `LocalStore`)
  - re-exports shared domain types from `@brute-force-games/shared-types`
- `platform/multiplayer-tinybase` → `@brute-force-games/multiplayer-tinybase`
  - TinyBase implementation + schema/codec layer
  - exports `TinyBaseRoomStoreClient`

Web app changes:
- `platform/web` now depends on `@brute-force-games/multiplayer-tinybase` and no longer imports TinyBase directly.
- Moved/deleted the in-app TinyBase implementation files:
  - removed `platform/web/src/sync/tinybase/schema.ts`
  - removed `platform/web/src/sync/tinybase/RoomStore.ts`

### Git hygiene / ignores updated
- Unstaged everything (kept working tree changes) after accidental staging.
- Updated `.gitignore` to ignore Godot-generated files and Playwright artifacts:
  - `**/.godot/`, `**/.import/`, `**/*.import`, `**/*.uid`, `**/.mono/`
  - `platform/web/public/godot/`
  - `platform/web/test-results/`, `platform/web/playwright-report/`

## Plan deviations (explicit)

### File locations differ from BUILD-PLAN.md for Phase 4
`BUILD-PLAN.md` Phase 4 references:
- `platform/web/src/sync/tinybase/RoomStore.ts`

But the implementation now lives in:
- `platform/multiplayer-tinybase/src/tinybase-room-store.ts`
- `platform/multiplayer-tinybase/src/schema.ts`

This is an intentional refactor to support multiple multiplayer implementations.

### Phase 4 behavior expanded
The plan originally described Phase 4 as “two tabs see each other’s player rows live”.
We now also:
- create a minimal `room` row on first connect (to satisfy `zRoom` parsing)
- generate placeholder-but-valid key strings for `zPlayer` (`signingPubKey`, `encPubKey`) until Phase 1 identity is implemented

## How to run what exists now

Run web dev server:
```bash
npm -w @brute-force-games/web run dev
```

Use the exact URL Vite prints under **Local:** (the port can change if 5173 is already in use).

Recommended flow:
- Open the Home page (`/`) and click **New Game**
- Copy the resulting `/room/:roomId/play?...` URL and open it in a second tab

Notes:
- If you paste a malformed room URL, the room route now shows an **Invalid room link** screen with a **Go Home** action.
- Room ids must start with `room_` (per `zRoomId`).

You should see two players and `lastSeen` ticking.
