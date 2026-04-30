## Goals
- **Multiple game types** with different information visibility rules.
- **No "host/god-mode" as an in-game visibility mechanic**: don't design games around a special omniscient player role.
- **Deterministic randomness**: whenever randomness is used (shuffle, dealing, random selection), use a **configurable seed** so results are reproducible.

---

## Core concepts (shared across all games)

- **GameType**: branded string identifying one of the registered games (see `GAME_REGISTRY`).
- **GameDefinition\<TConfig\>**: the registry entry for a game — holds `configSchema`, `defaultConfig`, `ConfigUI`, `godotAssetsPath`, etc. Defined in `platform/web/src/games/registry.ts`.
- **Visibility model**: each game defines what is visible to whom.
  - Consistent labels reason about it (e.g. **public**, **playerPrivate**, **rolePrivate**), but the game is responsible for deciding which data belongs in each category.
  - **Privacy is enforced by encryption, not by DO-level filtering.** The room store is a single shared `MergeableStore` synced identically to all clients. Private data is written to the shared store in encrypted form (ECDH + AES-GCM via the `secretPool` pattern); players decrypt only what their key allows. The DO never filters or projects per-player views.
- **Seeded RNG**:
  - `zRoom` includes a `seed` field (string) set at room creation.
  - Per-game/per-round seeds are derived from `seed + roomId + gameId + roundId` (or similar stable inputs).
  - All random decisions (shuffle, deal, pick) are produced by the **host client** using these derived seeds. Results are written to the shared room store and sync to all peers. The DO stores and forwards; it does not generate random outcomes.

---

## Privacy implementation (how visibility patterns map to our stack)

The room store is a shared `MergeableStore` — all clients see the same rows. Privacy is achieved through selective writing and encryption, not server-side projection:

| Pattern label | How we implement it |
|---|---|
| **PublicOnly** | Data written directly to the room store. All clients see it as-is. |
| **AsymmetricSecret** | Host encrypts secret with player's `encPubKey` via ECDH→HKDF→AES-GCM. Ciphertext written to `secretPool`. Only the target player can decrypt. |
| **PerPlayerPrivateBoards** | Each player's private state encrypted separately with that player's key. Host writes one encrypted row per player in a game-specific table. Each player decrypts their own row. |
| **DeckOrBagHidden** | Source deck lives in the host's **local store** only — never written to the room store. Only drawn/revealed items are written to the room store as they happen. |
| **MaskedFields** | The canonical private field is encrypted (or local-only); the public aggregate (e.g. "player has 5 cards") is written to the room store as a plain numeric field. |

The "host visibility" that exists for admin/debug purposes is the host's **local store** — the host can see plaintext originals, but this never enters the room store or the game protocol.

---

## Default visibility patterns (for game design reference)

- **PublicOnly**: all state is public (e.g. TicTacToe, Acronym scores/submissions).
- **AsymmetricSecret**: one player has a secret; others see a masked version (e.g. Hangman — clue giver knows the word; players see the pattern).
- **PerPlayerPrivateBoards**: each player has private state; public state is derived/aggregate (e.g. Bingo boards, GoFish hands).
- **DeckOrBagHidden**: the source of randomness stays in host's local store; only revealed draws/actions are public.
- **MaskedFields**: public aggregate fields alongside encrypted private fields (e.g. card count is public; card identities are encrypted).

---

## Responsibilities (React vs Godot vs Edge)

- **Edge (Durable Object)**:
  - Authoritative **store** — persists the shared `MergeableStore` via `DurableObjectSqlStoragePersister`.
  - Syncs the full store to all connected clients via `WsServerDurableObject`.
  - Enforces **write authorization** (which player can write which table/field) by intercepting merge ops in `webSocketMessage`.
  - Does **not** filter per-player views or generate random outcomes — it is a store and a gatekeeper, not a game engine.
- **Host client (React)**:
  - Produces all random outcomes (seeded RNG derived from `room.seed`).
  - Writes results (shuffled decks revealed over time, dealt cards as encrypted rows, etc.) to the room store.
  - Encrypts per-player private data before writing it to the shared store.
  - Maintains game keys and plaintext references in the **local store** only.
- **React site (all clients)**:
  - Lobby + routing + HUD + player controls.
  - Consumes `useRoomStore()` / `useLocalStore()` — never TinyBase APIs directly.
  - Decrypts own private data from the room store using local keys.
  - Embeds Godot at `/room/:roomId/play`.
- **Godot (web export)**:
  - Visual/interactive board rendering.
  - Sends user interaction events as intents via the JS bridge.
  - Receives public + player-specific view-model updates forwarded from React via `window.__godotBridge.receive()`. These payloads are already decrypted and filtered by the React layer before being passed to Godot.

---

## Game registry

Every game is registered as a `GameDefinition<TConfig>` in `platform/web/src/games/registry.ts`:

```ts
interface GameDefinition<TConfig = unknown> {
  gameType:       GameType;
  displayName:    string;
  minPlayers:     number;
  maxPlayers:     number;
  configSchema:   z.ZodSchema<TConfig>;
  defaultConfig:  TConfig;
  ConfigUI:       React.ComponentType<{ config: TConfig; onChange: (c: TConfig) => void }>;
  godotAssetsPath: string;   // e.g. "acronym" → public/godot/acronym/
}
```

`gameConfig` is `z.unknown()` at the core schema level (`zRoom`) and typed `TConfig` at call sites via `GameDefinition<TConfig>.configSchema`. The DO validates `gameConfig` against the game's schema before accepting writes.

Adding a new game:
1. Create `games/<name>/` Godot project.
2. Add `platform/shared-types/src/games/<name>/schemas.ts` + `bridge-events.ts`.
3. Register a `GameDefinition` in `platform/web/src/games/registry.ts`.
4. Add `godot:export:<name>` script in root `package.json`.

---

## Phase 1 game implementation

**TicTacToe** — the initial game, used to validate the full framework end-to-end. Fully public information; no encryption or private state required. Minimal game logic makes it the fastest path to proving the lobby, bridge, and sync layers work correctly before tackling more complex visibility models.

Deferred (not in scope for Phase 1):
- **Hangman**: `AsymmetricSecret` — clue giver knows the word; others see the masked pattern.
- **Bingo**: clue/call sequence in host's local store; each player's board is `PerPlayerPrivateBoards`.
- **GoFish**: each hand is `PerPlayerPrivateBoards`; deck is `DeckOrBagHidden`; public info includes completed books and turn.

---

## Client-side visibility utilities (shared helpers games can use)

These are **client-side** utilities in `platform/web/src/games/visibility.ts`. They help games derive display-ready views from the decrypted room store data — not server-side projection.

- **Masking/redaction primitives**
  - `maskArray(items, visibleIndices)` — show only revealed items
  - `maskString(secret, revealedSet)` — Hangman-style pattern (e.g. `"_E_"`)
  - `redactFields(obj, fieldPaths)` / `pickFields(obj, fieldPaths)`
  - `replaceWithCounts(collection)` — e.g. "opponent has 5 cards"

- **Deterministic RNG helpers** (used by host client)
  - `deriveSeed(roomSeed, ...tags)` → per-game/per-round seed string
  - `shuffle<T>(seed, items: T[]): T[]` — stable, deterministic shuffle
  - `deal<T>(seed, deck: T[], handsSpec: HandSpec[]): T[][]` — deterministic dealing
  - `pickN<T>(seed, items: T[], n: number): T[]`
  - `randInt(seed, min: number, max: number): number`

- **Testing/verification helpers**
  - Snapshot tests asserting player A's view never contains player B's encrypted private field (plaintext).
  - RNG assertions: same seed + input → same output every time.

---

## Minimum shared data needs (so all games fit one framework)

- **Room/game selection**: host selects `gameType` (from `GAME_REGISTRY`) and `gameConfig` before starting.
- **Seed**: `room.seed` — set at room creation; all per-game/per-round seeds derived from it.
- **Turn + phase**: a standard way to represent "whose turn" (`currentPlayerId`) and "what phase" (`room.status`: `waiting` → `starting` → `active` → `finished`). Per-game round state lives in a game-specific table in the room store.
- **Per-player private data**: encrypted rows in the room store (secretPool or game-specific private table). Each player decrypts their own data; host decrypts via local plaintext reference.
- No omniscient "hostOnly" view in the game protocol. Host's plaintext state lives in the local store only.

---

## Open questions (parked for later)

- How to assign in-game roles like "clue giver" — host-chosen vs auto-rotating vs volunteer.
- Per-game room store tables: how much schema sharing vs game-specific isolation.
- `room.seed` initialization: random on room creation vs host-configurable.
