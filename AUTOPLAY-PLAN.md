## Autoplay plan (player drop + testing + demos)

### Goals
- **Any seat can progress even if the player disconnects**.
- **Deterministic and reproducible** when the game uses randomness (seeded RNG).
- **Game-defined**: each game controls what “autoplay” means and what actions are legal.
- **No omniscient in-game role required**: autoplay runs with the same information constraints that player would have.
- **Player-driven fallback**: each game exposes an **Autoplay** button that advances play without requiring the player to decide the optimal move.

### Core idea
Implement **autoplay as a client-side capability by default** (each player’s own client can auto-play their seat using only their info pool).

If (and only if) a player’s client is **disconnected or timed out**, the **host client** takes over autoplay for that seat to keep the game moving. The host is the authority for all backends — whether TinyBase + DO or P2P. For the DO backend, the DO enforces write rules but does not run autoplay logic itself.

This avoids:
- stalling games due to disconnects
- the DO needing to implement game logic
- trusting unvalidated client-generated moves (host writes go through normal DO auth)

### Definitions
- **Seat**: a player slot in a room (`playerId`).
- **Authority**: always the **host client** — regardless of backend (DO or P2P). The DO enforces write rules; it does not run game logic or autoplay.
- **Autoplay mode**:
  - `off`: normal
  - `assist`: client may suggest moves, but host validates/applies
  - `do`: host generates moves for the seat when needed
- **Trigger**: a condition when autoplay may act (e.g. “it’s their turn and timer expired”).

### Where it lives
- **Any player’s client (`platform/web/`)**:
  - Runs autoplay for *self* when enabled (opt-in, `mode = ‘assist’` or `’do’`).
  - Produces candidate intents using only their own `playerView` + seeded RNG.
  - Sends intents through the normal path (host validates, DO enforces write rules).
- **Host client (`platform/web/`)**:
  - Monitors `players[id].isConnected` for all seats.
  - Detects disconnects and enforces `disconnectGraceMs` / `turnTimeoutMs` timers.
  - When a seat is disconnected/timed out, takes over autoplay for that seat using the dropped player’s full `playerView` — the host holds the game encryption keys and can decrypt private state from its local store.
  - Writes `players[id].autoplayMode = ‘do’` and `autoplaySince` to the room store when takeover begins; resets on reconnect.
  - Produces autoplay intents as the dropped player, sends them under its own host session (tagged with `targetPlayerId`); DO validates that host is allowed to write on behalf of a seat.
- **`platform/shared-types/`**:
  - Protocol/types for autoplay settings, timers/timeouts, and autoplay audit events.

### Autoplay interface (per game)
Each game implements a small module consumed by the **host client**:

- `getAutoplayTriggers(state): Trigger[]`
  - Example triggers: `turnStart`, `timerExpired`, `awaitingChoice`, `mustDiscard`
- `getPlayerView(state, playerId, localStore): PlayerView`
  - Host decrypts private state from its local store keys — host has full visibility.
  - No god-mode in normal gameplay; this is strictly for advancing a disconnected seat.
- `chooseIntent(ctx): Intent | null`
  - `ctx` includes:
    - `state`
    - `playerId` (the dropped seat being played for)
    - `playerView` (decrypted by host)
    - `seed` (derived for deterministic choices)
    - `now` (wall clock from host client)
  - Returns a normal game intent tagged with `targetPlayerId`; the DO validates the host is permitted to submit on behalf of that seat.

Important: autoplay must only output **the same intents a human client could send**.

### Requirement for every game implementation
- Every game must define an **autoplay hook** at implementation time.
  - If a game doesn’t provide a bespoke strategy, the default behavior is: **make a random valid move** (deterministic via seed).
  - This keeps the framework consistent: the DO can always ask a game for an autoplay intent without special casing.

### Default autoplay behavior (when not customized)
- Provide `listValidIntents(ctx): Intent[]` (derived from `playerView` + rules).
- Default `chooseIntent(ctx)` picks one intent uniformly (or weighted) from `listValidIntents(ctx)` using the derived `seed`.
- If there are **no** valid intents, return `null` (no-op).

### Room-level policy
Room has an autoplay policy set by host (or default). These fields are added to `zRoom` in `platform/shared-types/src/core/schemas.ts`:

```ts
dropBehavior:       z.enum(['pause', 'skip', 'autoplay']).default('pause'),
disconnectGraceMs:  z.number().int().min(0).default(15_000),
turnTimeoutMs:      z.number().int().min(0).default(0),  // 0 = no timeout
```

- **`dropBehavior`**:
  - `pause`: pause game on disconnect — no state advances until player reconnects
  - `skip`: skip the disconnected player's turn after `disconnectGraceMs`
  - `autoplay`: DO takes over after `disconnectGraceMs` and plays on the seat's behalf
- **`disconnectGraceMs`**: how long to wait after a WebSocket close before acting (default 15 s)
- **`turnTimeoutMs`**: optional per-turn hard deadline regardless of connection state (0 = disabled)

### `autoplayMode` in the player schema
Each player row tracks autoplay state so it is synced to all clients and visible in the UI. The following fields are added to `zPlayer` in `platform/shared-types/src/core/schemas.ts`:

```ts
autoplayMode:  z.enum(['off', 'assist', 'do']).default('off'),
autoplaySince: z.number().nullable().default(null),  // epoch ms — when takeover started
```

**Who writes `players[id].autoplayMode`:**
- Normally, only that player can write their own row (per the DO write-auth table).
- `autoplayMode` and `autoplaySince` are exceptions — the DO may write these when it detects a disconnect and initiates takeover, and again when the client reconnects.
- This exception is documented in the DO write-auth table as: `players[id].autoplayMode`, `players[id].autoplaySince` — DO-writable for disconnect/reconnect events.

### `isConnected` — who writes it
`players[id].isConnected` (already in `zPlayer`) is also a DO-write exception. The DO sets it to `false` when the player's WebSocket closes and back to `true` on reconnect. No client can write another player's `isConnected`. This exception is added to the DO write-auth table alongside `autoplayMode`.

### Protocol additions (high level)
- **Client → DO**
  - `setAutoplayMode { playerId, mode }` (self only)
  - `setSeatAutoplayMode { targetPlayerId, mode }` (host/admin action)
- **Client → Authority (generic)**
  - `autoplayIntent { playerId, intent }` (just a normal intent; tagged for audit/UI)
- **Host → Clients** (via room store sync patches + bridge events)
  - `players[id].isConnected`, `players[id].autoplayMode`, `players[id].autoplaySince` updated in place in the room store — all clients receive the patch automatically.
  - React layer fires `EVT_PLAYER_CONNECTIVITY_CHANGED { playerId, isConnected, autoplayMode, autoplaySince }` to Godot via the bridge whenever any of these fields change for any player.

### How autoplay runs (algorithm)
#### Normal case: client-driven autoplay (preferred)
1. Client subscribes to room/game state and recomputes triggers locally.
2. When a trigger fires for **self** and autoplay is enabled:
   - Build `playerView` for self (game-specific projection on the client side, from already-received state).
   - Call `chooseIntent(...)` (or default random-valid).
   - Send the intent through the normal channel.
3. Authority validates/applies/broadcasts patches.

### UX requirement: per-game Autoplay button
- Every game’s UI should expose an **Autoplay** button (or equivalent control) for the current player when it is valid to do so.
- Pressing it triggers the game’s autoplay hook for that player **once** (single-step), producing a valid intent (often “random valid move”) rather than asking the player to choose manually.
- This is separate from “autoplay mode” (continuous) and is useful for:
  - players who are stuck/indecisive
  - accessibility
  - quickly advancing trivial turns

#### Fallback: host takeover (only when client is disconnected/timed out)
1. Host client observes `players[id].isConnected = false` (written by DO on WS close).
2. Host waits `disconnectGraceMs` — player may reconnect within the grace window.
3. If seat is still disconnected (or `turnTimeoutMs` elapsed on their turn):
   a. Host writes `players[id].autoplayMode = ‘do’`, `autoplaySince = now` to the room store.
   b. Host decrypts that seat’s private state using its local game encryption keys to build a full `playerView`.
   c. Host calls `chooseIntent(ctx)` (or default random-valid) on behalf of the dropped seat.
   d. Host sends the intent tagged with `targetPlayerId`; DO validates that the host session is permitted to submit on behalf of that seat.
   e. DO applies/broadcasts patches normally.
4. Stop takeover when the client reconnects (`isConnected = true`); host writes `autoplayMode = ‘off’`, `autoplaySince = null`.

The host can build a full `playerView` for any dropped seat because it holds the `GameEncPrivKeyJwk` in its local store and can decrypt all `secretPool` and per-player private rows. This is mechanically necessary for keeping the game moving — it is not available as a gameplay mechanic.

Loop safety:
- hard cap \(N\) autoplay intents per tick (e.g. 3)
- store an action counter in state to avoid repeated identical actions

### Determinism requirements
- Autoplay randomness must derive from:
  - room seed + gameId + turn counter + playerId (+ any stable tags)
- This guarantees:
  - reproducible replays
  - consistent behavior across restarts

### Information-safety requirement (critical)
- Autoplay must be **information-safe**:
  - It must run only from the **same information pool the player would have**.
  - Concretely: `chooseIntent(...)` may read only `playerView` (plus public metadata like `now`, derived `seed`, and rules/config).
  - It must **not** inspect other players’ private state, hidden decks/bags, or unrevealed secrets.
  - When a game needs hidden data to advance (e.g. drawing from a deck), the autoplay intent should request a standard action (e.g. `drawCard`) and the DO resolves the hidden outcome using seeded RNG, just like for a human player.

This applies both to:
- **client autoplay** (easy: it only has its own view anyway), and
- **authority takeover** (must intentionally restrict itself to the dropped player’s view, even if the authority can see more).

### Game examples (first wave)
- **TicTacToe**
  - Autoplay: pick first available winning move else block else random legal move (seeded tie-break).
- **Hangman**
  - Clue giver drop: choose word from seeded dictionary subset; guesser drop: guess a letter via heuristic.
- **Bingo**
  - Player drop: auto-mark called numbers; clue giver drop: auto-call next number from seeded sequence.
- **GoFish**
  - Player drop: ask for rank based on hand; fallback deterministic heuristic.

### Testing strategy
- Unit-test `chooseIntent` per game against fixed seeds/state snapshots.
- Property tests:
  - autoplay never references hidden info outside `playerView`
  - autoplay only emits legal intents
- Integration test in DO:
  - disconnect player → after grace period autoplay advances state.
