# CHECKPOINT 7 — Auto Play + Go Fish draw/finish + repo hygiene

Date: 2026-04-26

This checkpoint is a delta from `old-plans/CHECKPOINT-6.md`.

## What changed since CHECKPOINT 6

### High-level themes

This checkpoint is mostly about making the system **easier to iterate on and test** without compromising the engine/plugin boundaries:

- **Engine-driven “Auto Play”**: a lightweight, engine-owned way to produce a valid default move for the local player. This is primarily a **testing accelerator** (exercise host loops, event/state writes, encryption, and UI updates quickly).
- **Go Fish went from “exists” to “playable and legible”**: explicit draw action for empty-hand turns, richer canonical events (so spectators can understand what happened), and a clearer UI that surfaces turn/action/game-over state.
- **More deterministic private-state crypto plumbing**: reduce reliance on incidental metadata (like timestamps) needing to be stored/propagated for decryption.
- **Repo hygiene**: avoid committing machine-specific editor settings or local scratch artifacts.

### Repo hygiene: ignore machine-specific VSCode + local Godot check logs

- `.vscode/settings.json` is now ignored (it contains a machine-specific Godot path).
- `tmp/godot-check/` is now ignored (local logs produced by the Godot check command).

Files:
- `.gitignore`

### Deterministic Godot “script compile check” command (TicTacToe project)

We added a fast command that fails on GDScript parse/load errors (including “warnings treated as errors”), so UI/bridge tweaks don’t require a full export cycle to discover typing regressions.

- **New**: `npm run godot:check:tictactoe`
- **Implementation**: `scripts/godot-check-tictactoe.sh`
  - Runs the project headless and quits immediately.
  - Writes a log file using `--log-file` into `tmp/godot-check/tictactoe.log`.
  - Fails if output contains parse/load/crash markers.

Files:
- `scripts/godot-check-tictactoe.sh`
- `package.json` (adds `godot:check:tictactoe`)

### New engine capability: `autoPlay(...)`

We expanded the `GameEngine` interface with an optional-but-implemented-for-now method that returns a default move for the local player, and exposed it through the play route as a button.

- **New**: `GameEngine.autoPlay(input) -> Promise<AutoPlayResult>`
- **New types**: `AutoPlayInput<TConfig>`, `AutoPlayResult`
- **Result**: the play route can render an engine-agnostic “Auto Play” control that simply calls `engine.autoPlay(...)` and `store.submit(...)`.

Files:
- `platform/web/src/games/types.ts`
- `platform/web/src/routes/room.$roomId.play.tsx`

### TicTacToe: `autoPlay` implementation

TicTacToe’s `autoPlay` is intentionally simple for testing: if it’s your turn and the game isn’t over, it plays the first empty cell.

Files:
- `platform/web/src/games/tictactoe/engine.ts`

### Go Fish: new draw action + finish semantics + `autoPlay`

Go Fish got both gameplay and UX improvements:

- **New player action**: `gofish/draw`
  - Used when it’s your turn and your hand is empty (and the deck still has cards).
- **New canonical event**: `gofish/drew`
  - Published to the room event stream so observers/players can see the draw in the log.
- **Room finishing**: when the game ends, the host engine now returns:
  - `{ kind: 'updateRoom', patch: { status: 'finished' } }`
- **Game-over condition change**: game ends when **any player reaches `handCount === 0`** (instead of the prior “deck empty + all hands empty” style condition).
- **Auto Play**:
  - Draws if hand empty and deck has cards.
  - Otherwise asks the first other player for the first rank in the hand.

Files:
- `platform/shared-types/src/games/gofish/schemas.ts`
- `platform/web/src/games/gofish/engine.ts`

### Go Fish: UI overhaul (events + actions + game-over summary)

The Go Fish player UI was rewritten to make the game readable and playable:

- Adds a status/turn bar and clearer layout.
- Adds a visible action to **draw a card** when your hand is empty.
- Replaces dropdown “ask” controls with:
  - clickable player targets
  - hand “chips” to pick rank
- Adds an event feed with formatted canonical events (ask/transfer/go-fish/draw/book/game-over).
- Adds a game-over panel with winners and book counts.

Files:
- `platform/web/src/games/gofish/PlayerUI.tsx`

### Multiplayer (TinyBase): AAD timestamp dependency removed for private state

Private-state encryption now uses a fixed `createdAt` value in AAD, so decryption does not require the row to persist the timestamp.

Files:
- `platform/multiplayer-tinybase/src/tinybase-room-store.ts`

## Working tree status compared to CHECKPOINT 6

As of this checkpoint, the working tree differs from `CHECKPOINT 6` (`8b65645`) by:

- **Modified (tracked)**:
  - `.gitignore`
  - `platform/multiplayer-tinybase/src/tinybase-room-store.ts`
  - `platform/shared-types/src/games/gofish/schemas.ts`
  - `platform/web/src/games/gofish/PlayerUI.tsx`
  - `platform/web/src/games/gofish/engine.ts`
  - `platform/web/src/games/tictactoe/engine.ts`
  - `platform/web/src/games/types.ts`
  - `platform/web/src/routes/room.$roomId.play.tsx`
- **Untracked**:
  - `old-plans/CHECKPOINT-7.md`

Quick validation:
- `npm --workspaces run typecheck` (passes)
- `bash scripts/with-godot-macos.sh npm run godot:check:tictactoe` (passes)

```bash
bash scripts/with-godot-macos.sh npm run godot:check:tictactoe
bash scripts/with-godot-macos.sh npm run godot:export:tictactoe
```

## Notes / known gaps

- The Godot check script currently looks for parse/load/crash markers in stdout/stderr and the log file. If we later want stronger guarantees, we can switch to a dedicated “compile all scripts” scene/script once Godot’s `--check-only` workflow is reliable for our project.

