# CHECKPOINT 5 — Friendly Display Names (Auto-Generated + Used in UI)

Date: 2026-04-25

This checkpoint is a delta from `old-plans/CHECKPOINT-4.md`.

## What changed since CHECKPOINT 4

### Players now have a stable, readable display name by default

We added an auto-generated “friendly name” and made it the source of truth
for what the room shows for each player.

- **Format**: `Adj-Noun-####` (e.g. `Curious-Otter-4812`)
- **Persistence**: stored locally (not synced) so it survives reloads
- **Publishing**: every client writes its persisted values into the shared `players` row

### New: shared generator in `platform/shared-types`

#### `platform/shared-types/src/core/friendly-name.ts`
- `generateFriendlyName(seedBytes?)`: produces `Adj-Noun-####`
- `seedFromPlayerId(playerId)`: stable-ish bytes used to keep the name deterministic per identity
- `deriveColorHex(seedBytes?)`: produces a consistent-ish avatar color from the same seed

Exported via:
- `platform/shared-types/src/index.ts`

### Web: preferences bootstrap now ensures `displayName` + `avatarColor`

#### `platform/web/src/sync/localStore.ts`
- Preferences object (currently loosely typed at the storage boundary) now supports:
  - `displayName?: string`
  - `avatarColor?: string`
- `ensurePreferencesV1(playerId)`:
  - generates missing `displayName` and `avatarColor`
  - persists them under `localStorage['bfg.preferences.v1']`

### Multiplayer: `players` row uses the persisted values

#### `platform/web/src/sync/SyncContext.tsx`
- After identity loads, preferences are ensured and passed into the room store:
  - `displayName`
  - `avatarColor`

#### `platform/multiplayer-tinybase/src/tinybase-room-store.ts`
- `TinyBaseRoomStoreClient` now accepts optional `displayName` and `avatarColor`
- `upsertSelfPlayer()` writes those into the `players` table (instead of the previous `Player ####`)

### UI: chat + self-reference now prefer friendly name

#### `platform/web/src/routes/room.$roomId.play.tsx`
- **Players list** already shows `p.displayName` (unchanged)
- **Lobby chat messages** now render the sender as:
  - `players[evt.fromPlayerId].displayName` when available (and shows a small color dot)
  - fallback to short `playerId` prefix if the row isn’t present yet
- **Self reference** now shows both:
  - `displayName`
  - `playerId`

## Plan deviations (explicit)

- **Preferences are not editable yet**: settings UI still shows placeholder local state; we’re only auto-generating and persisting for now.
- **Preferences schema is not Zod-validated yet**: we treat the stored blob as `unknown` at the interface boundary and coerce internally.

## How to run what exists now

Same as before:

```bash
npm -w @brute-force-games/web run dev
```

What’s new in runtime behavior:
- The first time a browser loads an identity, it will also generate a friendly
  `displayName` + `avatarColor` and persist them.
- Opening the same browser profile in multiple tabs will show the same friendly name.
- Different browsers/profiles will get different friendly names.

Typecheck is clean.

## What’s next (suggested)

- **Make name modifiable**: wire `Settings` to `LocalStore` so `displayName` (and optionally `avatarColor`) can be edited and then re-published into `players`.
- **Add validation + migration**: introduce `zPreferencesV1` with a small migration path (or reset) to keep local storage robust as fields change.

