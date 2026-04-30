# CHECKPOINT 6 — Multiplayer abstractions + GameEngine plugin system + Godot bridge + observer/reload correctness

Date: 2026-04-25

This checkpoint is a delta from `old-plans/CHECKPOINT-5.md`.

## What changed since CHECKPOINT 5

### Multiplayer is now driven by transport-agnostic interfaces (`RoomStore`, host loops)

We moved the core multiplayer surface area into `@brute-force-games/multiplayer-types` so the web app and games no longer depend on TinyBase-specific shapes.

- **New**: `RoomStore` interface that matches what the app actually needs (room/player getters, subscriptions, `submit`, host-only methods, snapshots).
- **New**: host loop primitives owned by the `RoomStore` implementation (not React):
  - `startHostLoop({ onSubmission })`
  - `startLobbyChatHostLoop()`
  - `applyHostActions(actions)` with monotone `seq` handling
- **Result**: the play route consumes only `RoomStore` and game engines; TinyBase details stay inside `multiplayer-tinybase`.

Files:
- `platform/multiplayer-types/src/index.ts`
- `platform/multiplayer-tinybase/src/tinybase-room-store.ts`
- `platform/shared-types/src/core/store.ts` (now only `LocalStore`)

### New: local-only “master table” of rooms (`roomsIndex`)

We added a local-only TinyBase “master store” inside `SyncProvider` to track all rooms the current browser knows about and your relationship to each one.

Tracked per room:
- **connection**: `connected`, `wsUrl`, `lastSeenAt`
- **room metadata**: `roomStatus`, `gameType`, `hostPlayerId`
- **your relationship**: `selfRole` (`host | player | observer | unknown`)

Data is updated by:
- per-room `onRoomChanged` (updates status/gameType/hostPlayerId)
- play route “touch” on connect/disconnect

UI:
- Home now shows a **Rooms** panel listing known rooms and your current role/status, with an **Open** button.

Files:
- `platform/web/src/sync/SyncContext.tsx`
- `platform/web/src/routes/index.tsx`

### Local per-room roles (trust-the-client host claim) via `RoomRoleTracker`

Host-ness is now *local-only* (trusted client model) and does not rely on the synced room row.

- **New**: `RoomRoleTracker` abstraction.
- **Implementation**: `BrowserRoomRoleTracker` persists `LocalRoomRole` records in `localStorage`.
- **Result**:
  - room id comes from URL
  - whether you are host comes from local role state
  - room status and game state still come from the multiplayer implementation

Files:
- `platform/shared-types/src/core/local-room-role.ts`
- `platform/multiplayer-tinybase/src/browser-room-role-tracker.ts`
- `platform/web/src/sync/SyncContext.tsx`

### Lobby game selection + per-game variant controls (TicTacToe symbol variants)

The lobby now has a host-only “Game” section with:
- a **game selector** (currently only TicTacToe is exposed in the dropdown)
- a **per-game “Variant”** section for TicTacToe:
  - `X & O`
  - `Lion vs Lamb`
  - `Red vs Blue`

This is stored in `room.gameConfig` and affects UI rendering (mark → symbol mapping).

Files:
- `platform/shared-types/src/games/tictactoe/schemas.ts` (adds `symbolPair` to `zTicTacToeConfig`)
- `platform/web/src/routes/room.$roomId.play.tsx`

### Game logic/UI moved out of the play route via a `GameEngine` plugin system

The previously-monolithic `room.$roomId.play.tsx` game logic has been extracted into per-game engines.

- **New**: `GameEngine<TConfig>` interface (host-side `startGame/applySubmission` + player-side `PlayerUI`)
- **New**: central registry (`getGameEngine`, `renderPlayerUI`)
- **Engines implemented**:
  - TicTacToe (`platform/web/src/games/tictactoe/engine.ts` + `PlayerUI.tsx`)
  - Go Fish (`platform/web/src/games/gofish/engine.ts` + `PlayerUI.tsx`)

Files:
- `platform/web/src/games/types.ts`
- `platform/web/src/games/registry.ts`
- `platform/web/src/games/tictactoe/engine.ts`
- `platform/web/src/games/tictactoe/PlayerUI.tsx`
- `platform/web/src/games/gofish/engine.ts`
- `platform/web/src/games/gofish/PlayerUI.tsx`
- `platform/web/src/routes/room.$roomId.play.tsx`

### TicTacToe is host-authoritative and playable end-to-end (shared-state loop)

Implemented the full “Phase 1” shared-state loop:
- players submit encrypted moves to `submissions`
- host validates + decrypts + applies rules
- host writes canonical `events` and a signed `gameStatePublic` snapshot (`TicTacToeState`)

Also added lobby readiness flow:
- players can **Join game / Leave game** (toggles `players.isReady`)
- host automatically flips `room.status` between `waiting` and `starting` based on joined count
- host can start when ready count ≥ 2

Files:
- `platform/multiplayer-tinybase/src/tinybase-room-store.ts`
- `platform/web/src/games/tictactoe/engine.ts`

### TicTacToe Godot wiring (iframe + versioned `postMessage` bridge)

The TicTacToe UI is now intended to be rendered by a Godot HTML5 export embedded in the web page.

- **Godot project additions**:
  - `games/tictactoe/scenes/Main.tscn`
  - `games/tictactoe/scripts/Main.gd` (grid UI + move intent → bridge)
  - `games/tictactoe/scripts/WebBridge.gd` (HTML5 bridge using `JavaScriptBridge`, talks via `postMessage`)
  - `games/tictactoe/project.godot` sets `run/main_scene`

- **Web embedding**:
  - `TicTacToePlayerUI` embeds an iframe pointing to:
    - `platform/web/public/godot/tictactoe/index.html`
  - Web ↔ Godot protocol now uses a **shared envelope**:
    - `platform/shared-types/src/core/bridge.ts`
    - Envelope: `{ bfg: true, v: 1, game, type, payload }` where `payload` is JSON string
  - TicTacToe-specific bridge events/payloads:
    - `platform/shared-types/src/games/tictactoe/bridge-events.ts`
    - Godot → web: `godot_ready`, `intent` (`{ kind: 'tictactoe/move', cellIndex }`)
    - Web → Godot: `state_init` / `state_public` (public snapshot + view role)

- **Docs**:
  - `platform/web/public/godot/tictactoe/README.md` describes expected export location and message formats.

Files:
- `games/tictactoe/project.godot`
- `games/tictactoe/scenes/` and `games/tictactoe/scripts/`
- `platform/shared-types/src/core/bridge.ts`
- `platform/shared-types/src/games/tictactoe/bridge-events.ts`
- `platform/web/src/games/tictactoe/PlayerUI.tsx`

### Godot “warnings as errors” hardening + deterministic script compile check

To avoid whack-a-mole parse failures when GDScript warnings are treated as errors:

- **New**: `npm run godot:check:tictactoe` which runs the TicTacToe Godot project headless and **fails if any parse/load errors appear**.
  - Script: `scripts/godot-check-tictactoe.sh`
  - Implementation detail: writes a log to `tmp/godot-check/tictactoe.log` via `--log-file` so headless runs are deterministic in restricted environments.
- **Bridge boundary validation**: `Main.gd` now validates inbound bridge payload shapes before applying them:
  - `_validate_state_init(d: Dictionary) -> Dictionary`
  - `_validate_state_public(d: Dictionary) -> Dictionary`
  - Invalid payloads are ignored (no partial state application).
- **Typing fixes for HTML5 JS interop**:
  - `WebBridge.gd` uses `JavaScriptObject.call("addEventListener"/"removeEventListener", ...)` to avoid strict typing errors.
  - Inbound envelope fields are normalized from `Variant` to `bool/int/String` via explicit `typeof(...)` checks.

Files:
- `scripts/godot-check-tictactoe.sh`
- `games/tictactoe/scripts/Main.gd`
- `games/tictactoe/scripts/WebBridge.gd`

### Observer + reload correctness improvements

Several correctness fixes landed while testing:

- **Connect ordering**: `TinyBaseRoomStoreClient.connect` now sets `connectedRoomId` *before* `startSync()` to avoid `room` listeners getting stuck on `null` (observers joining active games must see the game UI).
- **Ready persistence on reconnect**: a reconnect no longer clobbers `players.isReady` back to false; if your synced row says you were ready, the client preserves that on connect.
- **Observers see public view**:
  - Go Fish hides the participant-only “Your hand” panel and shows an observing banner.
  - TicTacToe shows an observing banner; input is disabled when not X/O.
- **Finished games remain visible**: play route renders the game view for `status: 'finished'` and TicTacToe marks the room `finished` on win/draw so a refresh still shows the final snapshot.

Files:
- `platform/multiplayer-tinybase/src/tinybase-room-store.ts`
- `platform/web/src/routes/room.$roomId.play.tsx`
- `platform/web/src/games/gofish/PlayerUI.tsx`
- `platform/web/src/games/tictactoe/PlayerUI.tsx`
- `platform/web/src/games/tictactoe/engine.ts`

### SyncProvider stability (Safari/StrictMode loop fix)

`SyncContext` functions (`getRoomStore`, `updatePreferences`, `createHostedRoom`) are now referentially stable via `useCallback` + `bootstrapRef`, and store lifetime is owned by `SyncProvider` (cleanup only on provider unmount). This prevents StrictMode re-mount loops that were exhausting Safari’s WebSocket resources.

Files:
- `platform/web/src/sync/SyncContext.tsx`

### Preferences are now schema’d and editable in Settings

Checkpoint 5 introduced auto-generated preferences; this checkpoint makes them **typed + editable** and republishes to the room immediately.

- Added `zPreferencesV1` schema in shared-types.
- Settings page edits `displayName` and `avatarColor`, persists to localStorage, and republishes to the shared `players` row via `setSelfProfile`.

Files:
- `platform/shared-types/src/core/preferences.ts`
- `platform/web/src/sync/localStore.ts`
- `platform/web/src/routes/settings.tsx`
- `platform/web/src/sync/SyncContext.tsx`

### Host restart robustness improvements

On host reload:
- primes replay protection based on max nonce seen
- avoids duplicating already-accepted submissions/chat messages

Files:
- `platform/multiplayer-tinybase/src/tinybase-room-store.ts`

### Go Fish engine exists (public + private state, observer-friendly UI)

This checkpoint includes Go Fish work:
- shared schemas under `platform/shared-types/src/games/gofish/`
- registry wiring in web
- Go Fish host logic + Player UI are implemented as a `GameEngine`

Files:
- `platform/shared-types/src/games/gofish/`
- `platform/web/src/games/gofish/`
- `platform/web/src/games/registry.ts`

## How to run what exists now

Web dev server:

```bash
npm -w @brute-force-games/web run dev
```

Typecheck:

```bash
npm -w @brute-force-games/multiplayer-tinybase run typecheck
npm -w @brute-force-games/shared-types run typecheck
npm -w @brute-force-games/web run typecheck
```

### Godot export (to test the embedded TicTacToe UI)

To see the Godot iframe load:
- Export `games/tictactoe` as HTML5 (Godot 4.6.x)
- Run:

```bash
# If `godot` is on PATH:
npm run godot:export:tictactoe

# macOS helper (uses Godot.app):
bash scripts/with-godot-macos.sh npm run godot:export:tictactoe
```

### Godot script compile check (recommended before exporting)

```bash
# macOS helper (uses Godot.app):
bash scripts/with-godot-macos.sh npm run godot:check:tictactoe
```

Export output should land at:
- `platform/web/public/godot/tictactoe/index.html`

Then open a room, join, start, and click moves in the embedded Godot UI.

## Notes / known gaps

- The Godot export is still a binary artifact; the repo provides scripts, but you need Godot + export templates installed locally.
- The multiplayer server URL is still pointing at a demo WS endpoint; this is Phase-2 scaffolding.

