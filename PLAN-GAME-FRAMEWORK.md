# Game Framework Plan

A consolidation plan for what was learned building TicTacToe, Go Fish, Hangman, and Bingo — and a path to make adding the next game be mostly business logic.

> **No migrations for live rooms.** In-progress rooms, old event payloads, and old state shapes are disposable. We are free to rename, remove, and reshape anything in the framework or any engine; no version fields, migrations, shims, or dual code paths exist to keep stale rooms working at runtime. If a change makes an existing room incompatible, the answer is "start a new room," not "preserve the old one."
>
> **Archives are a separate concern.** `GameArchive` carries opaque stamps (`engineVersion`, `frameworkBuild`) for **traceability and forensic replay** — recorded so a future reader of an archive can answer "what code produced this?" They are not interpreted at runtime, never trigger code branches, and don't gate any behavior. This is audit metadata, not backwards compatibility.

---

## 1. Goals

1. **Common chrome.** Lobby, player join, host config, status bar, activity feed, players list, game-over panel, "auto play" button, "new game" button, and reset are framework-owned. Games don't reimplement them.
2. **Engine = business logic only.** A new game is: a config schema, a state schema, a `startGame` function, an `applySubmission` function, a `PlayerUI` for the *playing surface only*, and small metadata adapters that let the framework chrome interpret state and steps.
3. **Uniform game step record.** Every state advancement is a `GameStep` with a stable framework envelope plus a game-specific payload. This is the canonical history; replay, audit, and the activity feed all read from it.
4. **State + step info are separable.** A step carries: the game-specific *kind* and *payload* (what happened), plus the resulting public state (or pointer to it). The framework treats these opaquely; the engine interprets them.
5. **Privacy unchanged.** The encryption / per-player private state model carries over — this plan is about layering, not crypto.
6. **Pluggable sync transport.** Storage is always TinyBase (one substrate, no abstraction over the storage layer). The **synchronizer** — how peers' stores stay in agreement — is the pluggable boundary. Today: WebSocket to a Durable Object. Tomorrow: P2P (Trystero, libp2p, or similar). Engines and shell code are agnostic to which.
7. **State ownership is separated structurally.** Three stores when host / two when not, each with a distinct lifecycle and audience: (a) **local app store** — identity, UI, role; (b) **host game store** — authoritative plaintext game data (deck, word, full hands), host-only, never synced, per match; (c) **synced room store** — events, public state, encrypted per-player private state, chat. Privacy boundaries are physical, not by convention.

---

## 2. Where We Are Today

**Implemented today:**

- The `RoomStore` interface (in `multiplayer-types`) is the contract engines and chrome talk to. Today's only implementation is a TinyBase-backed accessor over a `MergeableStore` (`platform/multiplayer-tinybase`) bundled with a `WsSynchronizer` for WS-to-DO sync. Storage and sync transport are not yet teased apart — see §3 for the target.
- A separate **local store** (`WebLocalStore`) for per-device data: identity keys, per-room role info, persistent submission nonces, and (on host) the host keypair + plaintext refs to host-private game data.
- `GameEngine<TConfig>` interface in `platform/web/src/games/types.ts`: `gameType`, `displayName`, `configSchema`, `ConfigUI`, `startGame`, `applySubmission`, `PlayerUI`, `autoPlay`.
- `HostLoopAction` set: `event`, `gameStatePublic`, `gameStatePrivate`, `updateRoom`.
- Per-player private state with encrypted snapshots.
- A signed `events` table that records every framework-level action with `seq`, `fromPlayerId`, `kind`, `publicPayload`.
- The play route owns: connect lifecycle, room metadata, players list, host loop wiring, lobby chat, "Auto Play" panel, "New Game" button.

**Target invariants** (after the refactor):

- **Engines and chrome depend only on `multiplayer-types`'s `RoomStore` interface** — never on TinyBase APIs (rows, listeners, schemas) or any other implementation detail. Reaching into the store from outside `multiplayer-tinybase` is a layering violation. This is the invariant that makes it possible to evolve the implementation (today TinyBase + WS; tomorrow TinyBase + P2P, or even something non-TinyBase) without touching engine or chrome code.
- The sync transport is exposed via a `RoomSyncProvider` interface (§3), separate from the room store itself. Today: `WsRoomSyncProvider`. Future: `P2PRoomSyncProvider`.
- Engines and chrome are sync-transport agnostic; they don't care whether the underlying provider is WS, P2P, or anything else. The same goes for the storage substrate behind the `RoomStore` accessor.

The current direction is to keep TinyBase as the underlying storage substrate (no abstraction over it inside `multiplayer-tinybase`) and let the `RoomSyncProvider` seam carry the transport flexibility. That's an implementation choice, not a contract — engines never see TinyBase either way.

Pain points to fix:

| Symptom | Where | Why it hurts |
|---|---|---|
| Per-game status bar | TTT, GoFish, Hangman, Bingo `PlayerUI.tsx` | Copy/paste; inconsistent UX; chrome and game logic tangled. |
| Per-game activity feed + `formatEvent` helpers | GoFish, Hangman, Bingo `PlayerUI.tsx` | Same pattern repeated 4×, all reading `store.getEvents()` and switching on kinds. |
| Per-game game-over panels | All four games | Same copy/paste. |
| Lobby config special-cased | `room.$roomId.play.tsx` has `TicTacToeLobbyConfig` inline; only TTT has lobby config | `engine.ConfigUI` exists but is unused (`() => null`). The route knows about specific game types. |
| `engine.ConfigUI` has wrong signature | `types.ts` declares `ComponentType` (no props) | Original spec called for `ComponentType<{ config; onChange; isHost }>`. |
| No `minPlayers` / `maxPlayers` / `defaultConfig` on engines | `types.ts` | Hardcoded in `ConnectedRoom` (`readyCount >= 2`); engines can't declare their own thresholds. Default config has to be reconstructed from `safeParse({}).data`. |
| Game type list hardcoded in route | The lobby `<select>` in `play.tsx` lists `tictactoe / gofish / hangman / bingo` literals | Adding a game means editing the route. |
| Game type `<select>` doesn't reset config | When the host swaps games, the new game inherits the old config | Engines should declare their own default config; switching games applies it. |
| No standardized "step" with state | Events exist but state snapshots aren't keyed to step seqs | Replay / scrubbing / audit can't be implemented generically. |
| `search` param leaks to engines | TTT uses `?godot=stub` for testing | **Plan:** remove from `PlayerUI`; framework reads dev flags (§7 / §9). Engines stay router-agnostic. |
| Storage & sync are bundled | `TinyBaseRoomStoreClient` owns both the TinyBase store and the `WsSynchronizer` directly | A future P2P backend would have to either fork the room store or inject a transport — but the seam isn't named. |
| Host's authoritative game data leaks into synced store | Go Fish stuffs `host: { deck, handsByPlayerId }` into the **host's own row of `gameStatePrivate`**, encrypted-to-self | Optional `host` slot in a public schema; encrypt-then-decrypt round trip on every step; same data living encrypted-on-wire and plaintext-locally; "local store" mixes UI state, identity, *and* host-only game scratch. |

---

## 3. Host/Shell Contract

The framework is two layers:

- A **shell** — transport-agnostic protocol layer that owns the log, sequencing, signing, and chrome.
- A per-game **engine** — game-specific business logic plugged into the shell.

The shell owns:

- The append-only log of game steps (`events` today).
- Seq allocation. Exactly one sequencer per room at any time.
- Step signatures (host signs each emitted event).
- Submission validation (player-signed; replay-protected via per-player nonces).
- Public state snapshots and the `gameStateHistory` archive.
- All chrome (status bar, activity feed, players list, game-over panel).
- **Framework lifecycle events** that mark canonical match boundaries: `framework/game_started` (with `playerIds`, `matchIndex`, `seed`), `framework/players_eliminated`, `framework/game_over`. Engines do not encode this metadata themselves — the framework records it once per match in a single canonical place that replay tools can rely on.

The engine owns:

- The shape of submissions, step payloads, and public/private state.
- Game logic: `startGame`, `applySubmission`, `autoPlay`.
- Adapters that let the chrome interpret state and steps: `getActiveGameMetadata`, `formatStep`.

### Scope: turn-based games with per-player submission slots

The shell targets **turn-based games** for the foreseeable future. All four current games (TTT, Go Fish, Hangman, Bingo) fit, and the framework leans on this in a load-bearing way. Real-time / simultaneous-action games where multiple players' inputs collide in the same tick are an explicit non-goal — they'd need consensus mechanisms we're not building.

**Submissions are stored in per-player append-only slots.** Each slot is keyed by `playerId` and contains submissions signed by that player's identity key. A peer can only write to its own slot (signature gates it). Replay protection is per-slot via monotonically increasing nonces.

Ordering has two related-but-distinct properties:

- **Canonical truth** is the host-signed `events` log with monotonic `seq`. The host accepts submissions, validates them, and emits signed events in a fixed order. Peers trust the canonical sequence because the host signature attests to it. There is always exactly one canonical sequencer at any moment.
- **Independent verification** is the ability for any peer (player, observer, third-party archive reader) to re-run the engine over the same ordered submission/event stream the host saw, and reproduce the state. Peers don't *derive* ordering on their own from raw slots; they *re-execute* against the host's already-ordered log to confirm it's consistent.

Per-player slots + turn validation are what make the host's job trivial — there's no consensus needed, no race to resolve. The host is structurally never asked to pick between two candidate next-moves: at any moment the public state designates eligible actors (usually one), and only their submissions are even valid input. So while ordering is **canonically host-assigned**, it's also **structurally constrained** enough that any honest host running the same engine on the same submission stream will produce the same `seq` order. That symmetry is what enables independent verification.

What this is *not*: it is not "peers independently CRDT-merge slots into a canonical log without a host." That's the multi-writer model we explicitly don't support. The host is always the authority; the slot structure just keeps the host's job simple and verifiable.

### What the host role still does

Even with ordering structurally solved, the cloud-mediated transport still designates a host because *somebody* has to run the engine, sign the derived events, and broadcast them. The host is:

- **The deriver**: runs `applySubmission` and emits events + state snapshots.
- **The authority**: signs the derived events with the host keypair so other peers have a single canonical reference to verify against.
- **The validator**: rejects malformed/out-of-turn/wrong-signature submissions before they enter the log.

Compatible transports:

- **Cloud-mediated** (current TinyBase + DO): the peer holding the room keypair plays host.
- **P2P with designated host** (e.g. Trystero with one peer designated host): same role, different sync layer.

**Host identity is fixed for the lifetime of the room.** The host is established at room creation (the keypair holder) and does not change. There is no host election, no rotation, no successor designation. If the host disappears, the room is over (see "Host continuity" below).

The host role is *operational*, not *security-critical for ordering*. Player signing + turn validation already prevents fake moves from being accepted. The host can't reorder what's structurally serialized.

### Storage layer: TinyBase + pluggable sync

The shell uses **TinyBase for all store data** — no abstraction over the storage substrate. What's pluggable is the **sync transport** — how the synchronized room store stays in agreement across peers.

**Three stores when host, two when not:**

| Store | Synced? | Lifetime | Holds | Who has it |
|---|---|---|---|---|
| **Local app store** | No | Across rooms (per-device) | Identity keys, UI state (draft chat, last viewed room), per-room role info, persistent submission nonces, host keypairs (one per hosted room) | Every peer |
| **Host game store** | No | **Per match** (cleared on `framework/game_over` or new match) | Authoritative plaintext game data — deck in Go Fish, word in Hangman, full per-player hands, any host-private derivation scratch | **Host only** |
| **Synced room store** | Yes (via the pluggable sync layer) | Room | Room row, players, events, submissions, gameStatePublic, gameStatePrivate (encrypted per-player), gameStateHistory, chat | Every peer (same contents after sync) |

**Authoritative game state lives in the host game store.** The synced room store is the **publication layer** — the host derives signed events, public-state snapshots, and per-player encrypted private rows from the host game store and writes them into the synced store. Other peers consume the publication; they never see the host game store.

For non-host peers, "private state" means *their own* row of `gameStatePrivate` in the synced store, encrypted to their key. That's it. No host-only data ever exists on their device.

#### Host game store: lifecycle and recovery

- **Created** when the host emits `framework/game_started` — the engine's `startGame` populates it with initial host-private state via the `hostGameStore` accessor on `ApplySubmissionInput`.
- **Updated** during each `applySubmission` pass as the host's authoritative game state advances.
- **Cleared** when the host emits `framework/game_over` (room finishes), when the host triggers a new match (matchIndex bumps within the same room), or when the room is reset.
- **Persisted to local IndexedDB** via TinyBase's persister, so a host who reloads the tab during an active match recovers their authoritative state without re-deriving from the synced store. Per the no-host-rotation rule, only the original host's device matters here.
- **Not in the archive.** `GameArchive` exports `events` + `gameStateHistory` + room metadata only. The host game store contains derivation scratch — useful for the host running the match, irrelevant to anyone reading an archive afterward (and would expose information the host explicitly chose not to publish).

If the host loses their game store (cleared cache, fresh device) without losing the keypair, the room is dead — same as losing the keypair itself. There is no automatic re-derivation from the events log, because some host-private state (Hangman's word) was never published. The "Clone and re-host" path (§3 Host continuity) applies.

**Sync transports are the pluggable boundary.** Two implementations envisioned:

- **WS sync (current)**: TinyBase's `WsSynchronizer` over a WebSocket to a Cloudflare Durable Object. The DO persists merge ops and forwards them to other connected peers. One source of truth on the wire.
- **P2P sync (future)**: a TinyBase synchronizer wired to a P2P channel (Trystero, libp2p). Same `MergeableStore` semantics — TinyBase already handles CRDT-style merging — different transport. Peers exchange merge ops directly with whoever is in the same room.

A `RoomSyncProvider` interface wraps a TinyBase synchronizer and exposes the connect / disconnect / status surface the shell needs. The shell, engines, and chrome are all sync-transport agnostic — they call into the room store API and never see whether the synchronizer underneath is WS, P2P, or anything else.

The host game store does not participate in any sync transport. It's a host-local TinyBase store, full stop.

Concretely:

- The current `RoomStore` typed accessor stays as the shell's interface to the synced TinyBase store. Its implementation is fixed (TinyBase-backed); only the sync provider varies.
- The **`HostGameStore` typed accessor** (new) is the engine's interface to host-private state during host-side derivation. Implementation is also TinyBase-backed; non-host peers don't have one.
- Replacing WS with P2P is a sync-layer swap. No engine, shell, or chrome code changes.
- The host's local app store and host game store have the same TinyBase API; nothing about their semantics depends on transport.

#### Player game state derivation

A player client's complete view of the game is composed from exactly two sources, both in the synced room store:

1. **Public state** — `gameStatePublic`. Host-signed, identical for every peer.
2. **Their own private state** — the player's row of `gameStatePrivate`. **Generated by the host, encrypted by the host to that player's identity-encryption public key (ECDH+AES-GCM), signed by the host.** Only that player can decrypt it.

The flow is one-way and host-driven:

```
host game store (plaintext authority)
        │ engine.applySubmission derives projections
        ▼
host encrypts per-player private projection
        │ one encrypted row per player, addressed to that player's key
        ▼
synced room store (gameStatePublic + gameStatePrivate[playerId])
        │ sync transport propagates
        ▼
player client reads + decrypts their own row
        │
        ▼
player's full view = public state + decrypted private state
```

Implications, all of which the plan relies on:

- **Players are pure consumers of private state.** Their client never runs engine logic to compute "what's in my hand" — they trust the host's derivation and just decrypt what's addressed to them. The engine's `PlayerUI` reads public state from the store, decrypts the player's `gameStatePrivate` row, and assembles a view; it does not synthesize private state from events.
- **Other players' private state is opaque.** A player can see that *a row exists* for another player in `gameStatePrivate`, but the ciphertext is encrypted to a different recipient — they cannot read it. The framework treats this as a structural privacy property, not a convention.
- **Late joiners and observers cannot recover private state from the events log.** Events carry public game progression; they don't carry per-player private payloads. An observer who joins mid-match and stays through to game-end cannot reconstruct any player's hand. Their view is bounded by what's in `gameStatePublic` plus events.
- **Archive verification operates on public state only.** §3 *Verifier input shape* commits to "events only" → that re-derives `gameStatePublic`, not the encrypted private rows. Verifying private state would require the relevant decryption keys; portable archive verification deliberately doesn't depend on them.
- **Empty `gameStatePrivate` is fine.** Games with no per-player private state (Hangman after the host-game-store split, TicTacToe, Bingo) write zero rows to `gameStatePrivate`. Players receive their entire view from `gameStatePublic` alone.

The host game store (above) and the per-player encrypted private rows are two sides of the same picture: the host game store is the **plaintext authoritative source** for host-private game data; the per-player private rows in the synced store are the **encrypted projections** the host derives for each player's consumption. The host game store never crosses the wire; the per-player private rows are how players learn their slice.

#### Pattern: hidden-draft phases (apparent simultaneous action)

Some games need players to act "simultaneously" with hidden choices that reveal at once: Catan's discard-on-7 (everyone with > 7 cards picks discards), Werewolf-style night votes, sealed bidding. The framework supports this without violating the turn-based + per-player-slot model — players accumulate **draft submissions** that the engine reveals atomically.

The pattern uses only existing primitives: per-player submission slots, host game store, per-player encrypted private state, public events on commit.

##### How it works

During a draft phase:

1. The engine sets `gameStatePublic.phase = '<draft phase name>'` and `eligiblePlayerIds` to the set of players expected to draft.
2. Each player submits one or more drafts to their slot. The submission acceptance rule (§3) admits each one; the engine handles them.
3. Per-draft, the engine:
   - Validates the draft (in the player's hand, valid target, etc.).
   - Records or **overwrites** the player's current draft in the **host game store** (`pendingDrafts[playerId] = ...`).
   - Updates the player's own `gameStatePrivate` row so they see their queued choice echoed back.
   - Updates `gameStatePublic.draftStatus[playerId] = 'submitted'` (a flag, not the content).
   - Emits a public event like `<game>/draft_recorded { playerId }` with **no content** — appropriate for the activity feed.
   - Returns `outcome: 'continue'`.
4. When the engine sees the commit trigger (last eligible player has at least one draft, an explicit lock-in, or a host-emitted timeout submission), the **same** `applySubmission` pass:
   - Reads all drafts from the host game store.
   - Emits a public event like `<game>/drafts_committed { drafts: { p1: ..., p3: ..., p4: ... } }` with all contents revealed atomically.
   - Updates `gameStatePublic` and `gameStatePrivate` per player to apply the committed effects (hand reductions, vote results, etc.).
   - Clears `pendingDrafts` from the host game store.
   - Transitions phase and resets `eligiblePlayerIds`.

##### Worked example: Catan discard-on-7

```ts
// During the phase
gameStatePublic = {
  phase: 'discard_for_7',
  eligiblePlayerIds: ['P1', 'P3', 'P4'],          // > 7 cards
  draftStatus: { P1: 'submitted', P3: 'pending', P4: 'submitted' },
  // ...
};

hostGameStore.pendingDrafts = {
  P1: ['wheat', 'wheat', 'sheep'],
  P4: ['ore', 'ore', 'brick', 'wood'],
  // P3 not yet
};

gameStatePrivate[P1] = { hand: [...], pendingDraft: ['wheat', 'wheat', 'sheep'] };
gameStatePrivate[P3] = { hand: [...] };  // no draft yet
```

P3 finally submits → engine commits → public event:

```
catan/drafts_committed {
  drafts: {
    P1: ['wheat', 'wheat', 'sheep'],
    P3: ['brick', 'wood'],
    P4: ['ore', 'ore', 'brick', 'wood'],
  }
}
```

All hands and counts update; phase advances to `'rolled'`.

##### Variations

- **Player revisions**: players resubmit their draft as many times as they want before commit. Each revision overwrites the previous entry in `pendingDrafts`. The activity feed shows `draft_recorded` once per revision.
- **Explicit lock-in**: add a `<game>/draft_lock_in` submission. The engine commits only when **all** eligible players have locked in. Lets players think indefinitely.
- **Timer-based commit**: the host's UI fires a self-submission `<game>/draft_timeout` after N seconds. Engine treats it as "commit current drafts; players who haven't drafted use a default rule (random / forfeit)." The timer itself lives in host UI, not the engine — keeps the engine pure (§3 Engine purity contract).
- **Voting**: same shape. `vote_draft { target }` accumulates per voter; commit reveals all votes atomically and tallies.
- **Sealed bidding**: same shape. `bid_draft { amount }` accumulates; commit reveals high bidder.

##### What stays hidden, what leaks

Hidden by construction:
- **Draft contents** — only the drafter, the host, and (after commit) everyone via the reveal event. While the phase is open, content lives in `hostGameStore` (host-only, never synced) and `gameStatePrivate[drafter]` (encrypted to drafter alone). Submissions themselves are encrypted to the host on the wire.
- **Cross-player draft equality** — no event reveals "P1 and P3 picked the same target" until commit.
- **Pre-commit aggregates** (vote tallies, bid totals) — the engine doesn't expose them in public state until commit.

Visible to all peers (mostly fine, sometimes worth knowing):
- **Whether a player has drafted** (via `draftStatus` in public state). Needed for UI ("waiting on P3").
- **How many times a player revised** (count of `draft_recorded` events for that player). Rarely strategy-relevant.
- **Draft submission timing** (`receivedAt` is UI-only, but `seq` ordering is observable). A meta-tell ("P1 hesitated for 30 seconds") but not content.

##### What this does not enable

This pattern is still strict turn-based. The host serializes draft submissions one at a time through `applySubmission` — whoever's signed message lands first gets `seq: N`, the next gets `seq: N+1`. From the players' perspective the *reveal* is atomic; from the log's perspective the *drafts* are sequential events. The plan's scope on real-time / simultaneous-action remains unchanged — that's a different problem requiring consensus mechanisms we're not building.

### Two security properties

- **Submission authenticity**: every submission is signed by the player's identity key. Any peer can verify, and only the player can produce signatures for their own slot. Impersonation requires a key compromise, not a transport compromise.
- **Derivation authority**: the host signs derived events / state snapshots so peers have a single canonical reference. A malicious host can refuse to derive, censor, or sign a wrong derivation — peers detect that by re-running the engine themselves and noticing the mismatch.

Player signing solves the "fake move" concern raised in P2P: a malicious peer cannot inject moves on behalf of another player. The host's role narrows to running the engine and signing its output, not to securing ordering.

### Submission acceptance rule

Across all transports — cloud-mediated, P2P, future — the engine / host loop accepts a submission **iff**:

1. The submission's signature verifies against the claimed player's signing key.
2. `fromPlayerId` is present in the room's canonical `players` table at the moment of acceptance.

That's the entire rule for **whether the host loop invokes `applySubmission` at all** — transport and identity admission only.

**Game rules** (whose turn it is, legal moves, lobby vs active, etc.) are enforced **inside `engine.applySubmission`**. The engine returns `null` or actions that leave state unchanged when a submission should not advance the game. Wrong-turn or malformed intents never override the acceptance rule above: they still reach `applySubmission` once admitted, where the engine drops them.

Everything client-side — observer mode disabling the "submit" button, the room store rejecting local `submit()` calls when `selfRole === 'observer'`, the lobby hiding the "Join game" button — is **ergonomics, not security**. Even when a transport delivers messages from a non-participant peer (Trystero rooms let any joined peer send; a malicious actor could patch their client to ignore observer guards), the host loop drops anything that doesn't satisfy both conditions above.

This rule is what makes "observer" a coherent concept across transports: an observer is simply a peer whose `playerId` is not in the canonical `players` table. They can read the synced store, but anything they try to write into a submission slot is filtered out by the acceptance rule.

### Engine purity contract

For replay and archive verification to be meaningful, engines must be deterministic functions of:

- `room.seed`
- `room.gameConfig`
- The ordered **`events` log** (host-signed steps — not raw submission ciphertext)

Engines must not depend on:

- Wall-clock time (`Date.now()`, any `ts` field). The framework will not pass arrival timestamps into engine inputs.
- Local machine state (system RNG, environment, network timing).
- The arrival order of submissions — only the host-assigned `seq` matters.

Given an exported archive's `seed` + `gameConfig` + ordered events, a verifier must be able to re-run the registered engine and reproduce `gameStateHistory` step-for-step. Mismatch ⇒ engine code drifted, archive is corrupt, or someone tampered with a step (in which case the host signature should also fail).

#### Verifier input shape

Archive verification uses **events only** as input — never submissions. Submissions are encrypted to the host; only events are universally readable. Locking this in now prevents two divergent verifier shapes from emerging later. Concretely, given a `GameArchive`, a verifier:

1. Reads the **`framework/game_started`** event (always the first match-lifecycle event in `events[]`) to recover the canonical match inputs: `playerIds`, `matchIndex`, `seed`. The framework — not the engine — records these, so the verifier doesn't need engine-specific event-shape knowledge to find them.
2. Re-derives the initial state by running `engine.startGame` with `room.seed`, `room.id`, `gameConfig`, `matchIndex`, and the recovered `playerIds`. Engines must not depend on any data outside these inputs.
3. For each subsequent event in `events` in `seq` order: applies it to the running state via an `engine.applyEvent(state, event, config) → TState` function (a new pure engine method, dedicated to replay). Skip or no-op kinds that don't affect public state (`host/accepted_submission`, etc.) per engine contract.
4. After each event that corresponds to a persisted snapshot, compares the running state to **`gameStateHistory`** at that **`seq`** (see §4 — not every `events.seq` has a row).

Inputs that are **not** part of verification:

- **Submissions.** Encrypted to the host; non-host verifiers can't read them. Events are the canonical replay input.
- **`host/accepted_submission` markers.** Host-loop bookkeeping, not relevant to deriving game state from events.
- **Wall-clock or arrival timestamps.** Determinism rules them out.
- **Any local state of any peer.** A verifier should be runnable from the archive alone.

`engine.applyEvent` is a deferred bonus feature — engines today only have `applySubmission`. Specifying the verifier shape here commits us to one canonical replay path; building it (`applyEvent` plus the verifier utility itself) lands later when we want runnable archive verification (§9 bonus features). The contract is fixed regardless of when it's implemented.

#### Keeping live play and replay from drifting

Live derivation uses **`applySubmission` → `HostLoopAction[]`**. Archive verification uses **`applyEvent(state, event, …)`** over **`events[]`**. Those must not become two handwritten stories.

**Implementation discipline:** introduce shared **pure** helpers (for example **reduce-on-event** helpers or a single internal `transitionFromEvent`) that **`applySubmission` builds its actions from** and that **`applyEvent` calls**. `applySubmission` stays the composition layer (submission → intents → events); `applyEvent` stays the replay projection (event → next state). Both must agree on **what each `eventKind` means for state** — one module, tests against both call paths.

Until `applyEvent` exists, **`gameStateHistory`** remains the authoritative cross-check against **`applySubmission`** behavior; keep history writes in lockstep with the exact state the host derived.

### Transport contract

This framework is designed for **HostAuthoritative** transport mode. Any `RoomSyncProvider` (§3 Storage layer) must satisfy the requirements below. Anything beyond is optional or out of scope.

**Required** (any compliant transport must provide):

- **Eventual delivery** of host-signed events and public state snapshots from the host to all peers in the room.
- **Eventual delivery** of player-signed submissions to the host.
- **Read access** for any joined peer to: the room row, players list, events log, public state, state history, and chat. Same content for everyone after sync settles.
- **Per-peer write authority** scoped to: that peer's own player row (subject to a write policy), its own submission slot, its own chat slot. No peer can write to another peer's slots.
- **A single fixed host for the lifetime of the room.** Host identity is established at room creation (the keypair holder) and does not change. No election, no rotation, no successor designation, no transferable keypair. If the host is permanently unavailable, the room is dead — see "Host continuity" below.

**Optional** (transports may or may not provide):

- **Server-side persistence** (the WS+DO transport persists to durable storage; a pure P2P transport may rely on at least one online peer to backfill late-joiners).
- **Observer connection mode** (the framework defines observers structurally — peers without a `players` row — so any transport that allows non-participants to subscribe automatically supports observers).
- **Late-join replay** (the synced store contains full history; a late-joining peer just receives the merged state).
- **Reconnect / retry semantics** (provider-specific; the shell tolerates transient disconnection).

**Not supported (yet)**:

- **Multi-writer / consensus-free CRDT step sequencing.** The shell's invariants — single signer, monotonic `seq`, host-derived state snapshots — require one host at a time. A true multi-writer P2P transport would need consensus on top of player signatures; that's an explicit non-goal.
- **Real-time / simultaneous-action games.** See §3 Scope.
- **Cross-room aggregation, matchmaking, server-validated game logic.** Out of scope for the shell; livable as add-ons later but the shell doesn't design for them.

Compatible providers under this contract:

- **`WsRoomSyncProvider`** (current): TinyBase + WS to a Cloudflare DO. Server-mediated. Host = peer holding the room keypair.
- **`P2PRoomSyncProvider`** (future): TinyBase synchronizer over Trystero / WebRTC / libp2p. Peer-to-peer; still **one fixed host identity per room** (same keypair-for-lifetime model as WS — transport delivers merge ops; it does not introduce host rotation).

The mode is named explicitly so we don't pretend the shell will "just work" over a transport that violates the required list. If a future transport doesn't fit, we either elect a host on top of it or it's not a candidate.

#### Host continuity (disconnect / reconnect)

When the host disconnects or crashes, the shell pauses:

- **Pending submissions remain in the synced store.** Per-player slots are append-only; nothing is lost while the host is away.
- **No new events are emitted** until the host returns. `seq` allocation, signature attestation, and state derivation all stop.
- **Players cannot make game progress** without the host. Submissions queue but don't apply.
- **On host return**, the same host (same keypair) re-primes its loop from the synced submissions table (skipping already-processed ones, signaled by `host/accepted_submission` events) and resumes deriving events. **Do not double-apply:** each submission is processed at most once — use the same dedup / processed-set rules as steady-state hosting so an ack row never triggers a second `applySubmission` for the same plaintext.

**If the host never returns, the room is dead.** There is no host re-election, no successor, no transferable keypair. The remaining peers' options are user-level, not framework-level:

- **Wait** — the host might come back. Their submissions stay queued in the synced store.
- **Abandon** — leave the room. The synced state remains in everyone's local TinyBase store; if anyone wants to study what happened, they can pull a `GameArchive`.
- **Clone and re-host** — pull the current archive (or just the room metadata if the game hasn't started yet), then create a **new room** with a fresh keypair and `room.id` where the cloning peer plays host. The other players join the new room. This is a UI-level "Start over with X as host" flow; at the framework level it's just fresh room creation. There is no automatic state transfer between rooms — if the original room had progressed, the clone is a fresh match (different `seed`, different log, different archive).

The shell's invariant: **at most one canonical host produces signed events for a given room, ever.** No mid-room handover. Two simultaneous hosts within one room is a bug — see below.

#### Two hosts is a transport violation

Because the host is fixed and the keypair is never transferred, two hosts within a single room is *always* a bug — there's no legitimate handover path that could produce it. TinyBase's CRDT merge won't naturally fail if two peers both write events claiming to be host; the shell relies on signatures and replay verification:

- **Detection (different keypair)**: every event is signed by the host keypair. Only one keypair is canonical for a room (`room.hostPublicKey`). A second peer writing events without that keypair produces signature failures during verification; peers reject those events.
- **Detection (compromised keypair)**: if the room keypair is stolen or accidentally duplicated to a second device, both can emit valid signatures. This is a key-management failure outside the shell's scope. Detection falls to **replay verification**: re-running the engine over the events log surfaces conflicting forks (two events at the same `seq`, or non-monotonic `seq`). The honest peer detects and refuses to accept the corrupted log.
- **Recovery**: there is none in-place. Affected peers fall back to the "Clone and re-host" flow — pull whatever archive they trust, create a fresh room with a fresh keypair, restart from scratch.

Providers must guarantee one-host uniqueness. If they fail, signatures + replay verification catch the symptom; the room is unrecoverable.

---

## 4. Game Step Model

The unit of game progress is a `GameStep`. Today's `events` row already carries the canonical fields we need.

```ts
type GameStep = {
  // Canonical identity — host-signed; replay reads these fields only.
  id: EventId;
  seq: number;                   // ordering key; assigned during host derivation
  fromPlayerId: PlayerId;        // who triggered (host for system events)
  kind: string;                  // game-specific: 'tictactoe/move_made', etc.
  payload: unknown;              // game-specific payload
  signature: HostSignature;

  // Optional UI metadata — not used for replay, verification, or determinism.
  receivedAt?: number;           // wall-clock at host when accepted; "5s ago" rendering only.
};
```

Wall-clock time is deliberately **not** part of canonical identity. Engines may not read `receivedAt`. Display-side code can use it for "X seconds ago" rendering, but it never feeds game logic.

The current `events` row maps directly to this. `gameType` lives on `room.gameType` — not duplicated per step. The "current state" lives in `gameStatePublic`, written once per step.

The step is **opaque to the framework**. Two adapters from the engine make it interpretable:

```ts
// Activity feed: how a step renders as a list item
type StepView = {
  icon?: string;                  // emoji or icon name
  summary: ReactNode;             // short one-liner ("Witty-Cedar gave 3 Aces to …")
  detail?: ReactNode;             // optional expander content
  tone?: 'info' | 'good' | 'warn' | 'system';
};

interface GameEngine<TConfig, TState = unknown> {
  formatStep(input: {
    step: GameStep;
    players: ReadonlyArray<Player>;
    currentState: TState | null;  // optional, for context
  }): StepView | null;            // null = hide from feed
}
```

`formatStep` is pure and replaces the duplicated `formatEvent` helpers in every game's `PlayerUI`.

### Step classification

The shell distinguishes four step roles:

- **Domain step** — emitted by `engine.applySubmission` via `kind: 'event'` host actions. Carries domain payload. Goes into the canonical log; **`gameStateHistory` gets a row only when that host-loop pass persists `gameStatePublic`** (see §4 gameStateHistory).
- **Framework lifecycle step** — shell-emitted, carries canonical match metadata that engines do not own:
  - **`framework/game_started`** — `{ playerIds, matchIndex, seed, gameType }`. Always the first lifecycle event in a match. Replay reads it to recover initial-state inputs without scanning engine-specific start events.
  - **`framework/players_eliminated`** — `{ playerIds, payload?: unknown }`. Emitted when `StepOutcome.kind === 'eliminated'`.
  - **`framework/game_over`** — `{ kind: 'won' | 'draw', winnerPlayerIds, payload?: unknown }`. Emitted when `StepOutcome.kind ∈ { 'won', 'draw' }`.
  These are game-meaningful — they mark phase transitions and feed the chrome's game-over panel — and they participate in `gameStateHistory` when a snapshot was persisted in the same host-loop pass. `formatStep` may opt in to handle them for domain-specific rendering (Hangman's word reveal, etc.); otherwise the framework supplies a generic fallback.
- **System step** — host bookkeeping (`host/accepted_submission`, etc.). In the events log for auditability but not game-meaningful. `formatStep` typically returns `null` for these. No `gameStateHistory` row for these on their own.
- **Chat / out-of-band** — already in its own table (`chatEvents`). Not part of game steps at all.

Engines don't need to declare classification explicitly; the shell infers it from the event `kind` prefix (`framework/`, `host/`, or game-type-prefixed). The important separation: `formatStep` returning `null` means "don't show in feed," not "skip from history" — a system step always lands in the log even when invisible to the UI.

### gameStateHistory (authoritative log)

The host writes a snapshot table alongside the live `gameStatePublic`:

```ts
type GameStateHistoryRow = {
  seq: number;        // identifies which event this snapshot corresponds to — see below
  state: unknown;     // game-specific public state after applying through this point
};
```

#### Which events get a history row?

The signed **`events`** log includes **every** host-emitted row (domain moves, lifecycle, `host/accepted_submission`, `framework/*`, …). **`gameStateHistory` does not mirror every row.**

**Invariant:**

- **`gameStateHistory` contains exactly one row per persisted `gameStatePublic` snapshot** — i.e. whenever the host writes the live public state during a host-loop pass.
- **`GameStateHistoryRow.seq` equals `events.seq` for the host-emitted event whose application produced that snapshot.** In typical batches (ack + domain events + optional framework lifecycle), multiple events may share one public-state write; **`seq` on the history row points at the canonical “step” whose completion matches that snapshot** — by convention the **`seq` of the last framework or domain event in that batch that commits the new `gameStatePublic`**, not the ack-only line when the ack is the only new event.
- **Bookkeeping-only events** (`host/accepted_submission`, or any future kind that does not commit a new `gameStatePublic`) **do not** get their own history row.

**Verification:** when replaying with `applyEvent`, advance state only on events that affect game meaning; **compare** the running state to **`gameStateHistory`** only at **`seq`s present in the history table** (or after each event if you store a row per snapshot-producing event — same thing). Do not expect a history row for every raw `events.seq` if that row was pure bookkeeping.

**UI (`HistoryScrubber`, etc.):** scrub along **history seq** (snapshot boundaries), not necessarily every raw event index.

Paired with the signed `events` log and the room's `seed` / `gameType` / `gameConfig`, this is a complete authoritative record of every game played — exportable as JSON for offline replay, audit, or reproduction in another implementation. A consumer can verify event signatures, re-run the engine over the events, and confirm each state snapshot.

Required, not optional. Archive shape:

```ts
type GameArchive = {
  room: { id; gameType; gameConfig; seed; hostPublicKey };
  players: Array<{ id; displayName; signingPubKey }>;  // identity but no encryption keys
  events: ReadonlyArray<RoomEvent>;                    // signed
  stateHistory: ReadonlyArray<GameStateHistoryRow>;
  meta: {
    engineVersion: string;       // engine.version — author-controlled stamp, bumped when game logic changes.
    frameworkBuild: string;      // build id (commit SHA) of platform/web at export time.
    schemaVersion: number;       // archive format revision.
    exportedAt: number;          // wall-clock at export time.
  };
};
```

`exportGameArchive` is a **framework-level function**, not a `RoomStore` method:

```ts
function exportGameArchive(store: RoomStore, engine: AnyGameEngine): GameArchive;
```

It composes data from existing `RoomStore` reads (`getRoom`, `getPlayers`, `getEvents`, `getGameStateHistory`), pulls `engineVersion` off the engine that's currently registered for the room's `gameType`, and stamps **`meta.frameworkBuild`** from a **single build-time constant** (e.g. Vite `import.meta.env` / CI-injected `VITE_GIT_SHA` or equivalent — choose one name for the repo and document it next to the export helper so local and CI archives stay comparable).

Alternative transports (Trystero, server-mediated, anything) get archive export "for free" once they implement the same primitives — no per-transport reimplementation.

Any client (host, player, observer) can pull the archive. The format is portable — re-running the registered engine on `events[]` from the archived `gameConfig` and `seed` should regenerate `stateHistory` exactly. Mismatch = engine drift, corruption, or tampering (host-signature check should catch tampering first).

Neither `engineVersion` nor `frameworkBuild` are migration fields. We don't preserve compatibility with old code. They're there so a verifier reading an archive 6 months from now can answer "what produced this?" — and if today's engine doesn't reproduce the state, the answer might be "the engine changed since v1.2.0," not "the archive is bad."

---

## 5. Active Game Metadata (status bar / chrome)

The framework chrome needs *just enough* info from state to render itself. Engines provide a single adapter:

```ts
type ActiveGameMetadata = {
  phase: 'active' | 'finished';

  // Who is eligible/expected to act next. Empty when game is finished, or
  // mid-game during a host-driven phase (animations, AI think). Today, all
  // four games return at most one entry. Cardinal-N is reserved for future
  // turn-based games with structured multi-actor phases (e.g. a "voting" turn
  // where multiple players each submit one ballot before the phase resolves).
  // It is NOT a path to real-time simultaneous-action gameplay — those are
  // out of scope (§3 Scope). The shell still serializes through the host loop;
  // multi-eligible just means more than one player can submit during a single
  // turn, with the host applying their submissions one at a time.
  eligiblePlayerIds: PlayerId[];

  turnSummary?: string;                  // "X's turn" | "Calling…" | "Voting…"
  badges?: Array<{                        // free-form chips for the status bar
    label: string;                        // "Deck" | "Wrong" | "Called"
    value: string;                        // "38 cards" | "3 / 6" | "12 / 75"
    tone?: 'info' | 'warn' | 'good';
  }>;
  outcome?: {                             // when phase === 'finished'
    kind: 'won' | 'draw';                  // matches StepOutcome.kind for consistency
    winnerPlayerIds: PlayerId[];          // empty for 'draw'
    summary: string;                      // "X wins" | "Out of guesses — word was …"
  };
  perPlayer?: ReadonlyArray<{             // for the players list
    playerId: PlayerId;
    isCurrent?: boolean;                  // derived from eligiblePlayerIds
    isEliminated?: boolean;               // visual treatment for out-of-play participants
    secondary?: string;                   // "✋ 7  📚 1" | "23/25"
    badge?: string;                       // "BINGO" | "(out)"
  }>;
};

interface GameEngine<TConfig, TState = unknown> {
  getActiveGameMetadata(input: {
    state: TState;
    players: ReadonlyArray<Player>;
    selfPlayerId: PlayerId;
  }): ActiveGameMetadata;
}
```

The framework renders:

- Top **status bar**: game title, `turnSummary`, badges. Outcome banner overrides when finished.
- **Players list**: from `perPlayer` (highlight `isCurrent` from `eligiblePlayerIds`, dim if `isEliminated`, show secondary text/badge per row).
- **Game-over panel**: from `outcome`.
- **Auto-play button**: enabled iff `selfPlayerId ∈ eligiblePlayerIds`.
- **"Your turn" prompt**: shown iff `selfPlayerId ∈ eligiblePlayerIds`.

`eligiblePlayerIds` is cardinal-N, not a single `turnPlayerId`. All four current games return `[turnPlayerId]`; future *turn-based* games with multi-actor phases (e.g. a vote turn) may return multiple. Real-time simultaneous-action games remain out of scope (§3 Scope) — multi-eligible doesn't open that door. Empty means no one is expected to act right now (animation, host-driven phase, finished game).

**Multi-eligible authoring:** when more than one player can submit during a phase, the host still assigns **one `seq` at a time** in arrival order (or transport-defined FIFO). Engines must define semantics so **different orderings either cannot change the outcome** or are **explicitly ruled out** by state (e.g. phase closes after N ballots). Do not rely on wall-clock tie-breaking.

The engine's `PlayerUI` becomes the **playing surface only** — board/cards/word/figure. Everything else is framework chrome.

---

## 6. Lobby / Configuration

Move per-game lobby config out of `room.$roomId.play.tsx` and into engines. Properly type `ConfigUI`:

```ts
interface GameEngine<TConfig, TState = unknown> {
  // Replaces today's `ComponentType` (no props).
  ConfigUI: ComponentType<{
    config: TConfig;
    onChange: (next: TConfig) => void;
    isHost: boolean;
  }>;

  // Player-count thresholds for lobby readiness and the "Start" button.
  minPlayers: number;
  maxPlayers: number;

  // Used when the host first selects this game type, or resets.
  defaultConfig: TConfig;
}
```

Concrete behavioural changes:

- **Game type `<select>`** is generated from `listGameEngines()`, not hardcoded.
- **Switching games** writes `{ gameType, gameConfig: engine.defaultConfig, maxPlayers: engine.maxPlayers }` so the new engine starts from a valid config.
- **`ConfigUI`** is rendered in a uniform card. Non-hosts get the same component but with `isHost: false` (engine decides what to disable / read-only-ify).
- **Start button** uses `engine.minPlayers` instead of a hardcoded 2.
- **Bingo** uses **`engine.maxPlayers: 8`** as the single authority for lobby join cap (`room.maxPlayers`) and any `ConfigUI` validation. Do **not** duplicate a second `maxPlayers` inside `defaultConfig` for Bingo — see §10 Bingo.

### Config mutation lifecycle

`gameConfig`, `gameType`, and `maxPlayers` are mutable only while `room.status ∈ { 'waiting', 'starting' }`. Once the host triggers Start and the room transitions to `'active'`, the config is **locked** for the duration of that match:

- `engine.ConfigUI` renders read-only when status ≥ `'active'` (the engine decides how — typically by disabling inputs).
- The room store rejects `updateRoomAsHost({ gameConfig | gameType | maxPlayers | seed })` from anyone, including the host, when status ≥ `'active'`.
- Mid-match config changes are not supported. To change config mid-game, the host clicks "New Game" / "Reset" — that flow creates a new match (fresh seed, fresh state, fresh log) under the new config.

Why: determinism and archive reproducibility. Engines derive everything from `gameConfig` + `seed` + the ordered event log. A mid-match config mutation would silently invalidate the archive's reproducibility — re-running the engine wouldn't reach the same state. Rather than introduce versioned "config history," we lock it.

Lobby-time changes are unconstrained: the host can flip variants, swap games, change player caps freely until the game starts.

The host's room patches (display name, players row updates, chat) remain mutable during active play — only the determinism inputs are locked.

### Seed: the reproducibility knob

`room.seed` is a stable, framework-owned **series seed**. Set once when the room is created, never changes for the lifetime of the room. Stamped into every `GameArchive`.

Every match within the room derives its own match seed:

```ts
matchSeed = `${room.seed}|${room.id}|${gameType}|${matchIndex}`
```

`matchIndex` is a `number` on the room row that increments each time a new match starts within the same room. Today: always `0`, since "New Game" creates a new room. The composition is in place for future multi-round series support without changing the seed contract.

Engines mix the match seed with per-purpose tags for each random draw:

```ts
makeRng(`${matchSeed}|deal_v1`)
makeRng(`${matchSeed}|board|${playerId}`)
makeRng(`${matchSeed}|call_order`)
```

This composition guarantees:

- **Replay is deterministic** from `room.seed` + `room.id` + `gameType` + `matchIndex` + `gameConfig` + the events log alone. No wall-clock, no host-local state.
- **Two rooms with the same `room.seed` produce different randomness** — `room.id` is mixed in, so seed isn't a privacy leak across rooms.
- **Multi-round series is plumbed in advance.** When we add it (deferred — see §12), engines just read `matchIndex` from the room row; their `startGame` semantics don't change.

"New Game" creates a fresh room with a fresh `room.seed` and `matchIndex = 0`. Re-using a seed across rooms is intentionally not the default. (Same room with `matchIndex` incrementing is the "best of N" path — parked for now.)

### Observer role

Distinct from "player." Players are recorded in the room and participate; observers connect to watch only.

The lobby shows two entry actions for non-hosts:

- **Join game** — the existing path. Records you in the `players` table. Eligible for turns, submits intents, can be auto-played.
- **Watch** — local-only mode. No `players` row, no submissions, no host record. Reads public state, events, and chat. Sees the same chrome and `engine.PlayerUI` as players.

Observers:

- Are **not recorded by the host.** No `players` row, no events from them, no submissions accepted. The host doesn't track who's observing.
- Can pull the `GameArchive` like anyone else (read-only access to public state and events).
- Cannot mark themselves ready, cannot submit, cannot trigger auto-play, cannot create new games unless they switch role to host (a separate flow).
- Don't appear in turn order, player lists, scores, or game-over outcomes.

Implementation: a `selfRole: 'observer'` flag held client-side only. The room store skips the `setSelfReady` upsert and rejects local `submit` calls when `selfRole === 'observer'`. Engines need no awareness — `PlayerUI` already handles "no `me` in the player list" via the existing observer-notice path (Go Fish does this today).

Switching from observer → player is allowed mid-room (clicks "Join game"), and player → observer is allowed before joining; once you've joined, you're a player for the rest of that room (or until the host kicks you).

**Security model**: observer enforcement is *state-based*, not UX-based. The shell's submission acceptance rule (§3) drops any submission whose `fromPlayerId` is not in the room's `players` table — and observers, by definition, are not in that table. A malicious client that patches out the local "disable submit for observers" guard, or a transport (like Trystero) that lets non-participants send messages at the wire level, both fail the same way: the host loop never accepts the submission.

The client-side guards (`selfRole !== 'observer'` gating in the room store, hiding the "Join game" button, the "Observing" notice) are ergonomics — they make the experience clean and prevent honest mistakes. They are not the boundary.

This is also why "switching from observer → player" needs to actually upsert into the `players` table: that's the move that makes the host start accepting your submissions. Until then, no amount of local state-flipping does anything from the shell's perspective.

---

## 7. UI Composition (slot model)

Today the play route renders one chunk per game (full takeover via `engine.PlayerUI`). The new model:

```
ConnectedRoom
├── RoomMetadata          (framework, unchanged)
├── HostControls          (framework, unchanged + reads engine.minPlayers/defaultConfig)
├── LobbyConfigSection
│    └── engine.ConfigUI  ← rendered uniformly with proper props
├── PlayersList           (framework, augmented by engine.getActiveGameMetadata.perPlayer)
├── ActiveGameSection     (NEW — only when room.status ∈ {active, finished})
│   ├── GameStatusBar     (framework, from engine.getActiveGameMetadata)
│   ├── engine.PlayerUI   ← playing surface only (board / cards / word / figure)
│   ├── ActivityFeed      (framework, calls engine.formatStep over events)
│   └── GameOverPanel     (framework, from engine.getActiveGameMetadata.outcome)
├── AutoPlayPanel         (framework, calls engine.autoPlay — already exists)
└── LobbyChat             (framework, unchanged)
```

`PlayerUI` props are **only** play-surface inputs — **no route `search` bag.** Engines stay free of router coupling.

```ts
type PlayerUIProps<TConfig> = {
  store: RoomStore;
  room: Room;
  selfPlayerId: PlayerId;
  players: ReadonlyArray<Player>;
  config: TConfig;
};
```

**Dev-only URL flags** (e.g. `?godot=stub`) are read inside **`<GodotPlayerSurface>`** (or other framework chrome), not passed through `PlayerUI`. If we need typed optional query keys later, add an optional **`playerUiSearchSchema`** (zod) on the engine for the framework to validate against — still parsed in chrome, not in `PlayerUI`.

`engine.PlayerUI` responsibility:

- Render the play surface.
- Submit player intents via `store.submit`.
- Subscribe to `gameStatePublic` and (if needed) own `gameStatePrivate`.

It does **not** re-render: the status bar, the activity feed, the players list with turn indicator, the game-over panel.

### Godot iframe surfaces

Godot rendering is a **per-game opt-in**, available to any engine — not a TicTacToe-specific feature. Any engine can ship a Godot HTML5 export as one of its playing surfaces (or as the only surface). TicTacToe is currently the only game using it, with `cfg.ui = 'godot' | 'react'` to switch at runtime; future games may be Godot-only, React-only, or expose a similar choice. Go Fish, Hangman, and Bingo could each opt in later if a Godot version is built.

The framework provides the iframe + bridge mechanics so engines don't reimplement them:

- `<GodotPlayerSurface>` — a generic React component that loads the Godot export, manages iframe lifecycle, listens for `postMessage`, performs the `godot_ready` handshake, pushes state updates down, and translates Godot intents up to `store.submit`.
- A standard envelope: `{ bfg: true, v: 1, game: GameType, type: BridgeEventType, payload: string }` (already in `shared-types/core/bridge` — currently underused).
- Standard event types, framework-owned: `godot_ready`, `state_init`, `state_public`, `intent`. The current per-game `EVT_BRIDGE_*` constants in `tictactoe/bridge-events.ts` move into shared core.
- A standard `?godot=stub` dev flag handled by `<GodotPlayerSurface>`, not by the engine.

Engines plug in via a `godot` adapter on the engine declaration (see §8). The engine's `PlayerUI` is responsible only for *which* surface to render (e.g. `cfg.ui === 'godot' ? <GodotPlayerSurface … /> : <ReactBoard … />`); the framework owns the bridge plumbing inside `<GodotPlayerSurface>`.

Per-game payload schemas (the shapes of `state_init.payload`, `intent.payload`, etc.) stay in per-game files since they're game-specific. They're typed via the engine's `GodotBridgeAdapter`.

#### Boundary: chrome is pure data shuttling, no game logic

`<GodotPlayerSurface>` contains **zero game logic**. It is a transport-shaped pipe between the iframe and the room store:

- It calls `engine.godot.buildStateInit` and `buildStatePublic` to construct outbound payloads — pure serializers; the chrome doesn't inspect state shape.
- It calls `engine.godot.parseIntent` on inbound messages — purely a syntactic shape coercion. `parseIntent` is restricted to "is this a recognizable intent payload?" and must **not** validate game rules (turn order, move legality, etc.). Game-rule validation belongs to the host's `applySubmission` (§3 submission acceptance rule). Returning `null` from `parseIntent` means "malformed / unknown shape, drop"; the chrome obeys without further inspection.
- It submits via `store.submit`, which handles signing / encryption / transport.
- It reads public state for serialization but never writes back into the room store other than via `submit`.

This boundary is what makes the bridge transport-clean. Whether the underlying sync provider is `WsRoomSyncProvider` (TinyBase + DO) or `P2PRoomSyncProvider` (Trystero), the engine's `parseIntent` callback runs the same; the framework handles the rest. Game-specific logic stays on the host side of `applySubmission`; transport-specific concerns stay below the room store.

---

## 8. Engine API — Final Shape

```ts
interface GameEngine<TConfig, TState = unknown, THostGameState = unknown> {
  // Identity
  gameType: GameType;                    // stable string id, e.g. 'tictactoe'. Matches room.gameType.
  displayName: string;
  version: string;                       // NEW — engine-author-controlled version stamp.
                                         // Bumped when game logic changes in a way that affects state shape, rules, or replay.
                                         // Stamped into every GameArchive so future readers know exactly what produced the data.

  // Schemas
  configSchema: ZodType<TConfig>;
  stateSchema: ZodType<TState>;          // NEW — used by framework to safeParse public state
  hostGameStateSchema?: ZodType<THostGameState>; // NEW — optional. Engines that hold host-private
                                         // authoritative data (Go Fish deck, Hangman word, etc.)
                                         // declare its shape; framework provides a host-only
                                         // typed store for it (see §3 Host game store).
                                         // Engines without host-private state omit it (TTT, Bingo).

  // Lobby / config
  defaultConfig: TConfig;                // NEW
  minPlayers: number;                    // NEW
  maxPlayers: number;                    // NEW
  ConfigUI: ComponentType<{              // CHANGED — gets real props
    config: TConfig;
    onChange: (next: TConfig) => void;
    isHost: boolean;
  }>;

  // Host loop
  startGame(input: StartGameInput<TConfig>): Promise<HostLoopAction[]>;
  applySubmission(input: ApplySubmissionInput<TConfig>): Promise<ApplySubmissionResult | null>;
  autoPlay(input: AutoPlayInput<TConfig>): Promise<AutoPlayResult>;

  // Chrome adapters (NEW)
  getActiveGameMetadata(input: {
    state: TState;
    players: ReadonlyArray<Player>;
    selfPlayerId: PlayerId;
  }): ActiveGameMetadata;

  formatStep(input: {
    step: GameStep;
    players: ReadonlyArray<Player>;
    currentState: TState | null;
  }): StepView | null;

  // Playing surface — props: store, room, selfPlayerId, players, config (no route search; see §7)
  PlayerUI: ComponentType<PlayerUIProps<TConfig>>;

  // Optional Godot iframe integration. Per-game opt-in — any engine can declare a
  // `godot` adapter, not just TicTacToe. Engines without a Godot export simply omit it.
  godot?: GodotBridgeAdapter<TConfig, TState>;
}
```

### `version` — per-engine version stamp

Each engine declares its own `version: string` (semver, build hash, integer counter — engine author's choice; the framework treats it as opaque). It's stamped into every `GameArchive` produced while that engine is active, alongside the framework build id. A future reader of an archive can answer:

- **Which game produced this?** → `room.gameType`
- **Which version of that game's logic?** → `meta.engineVersion` (lifted from `engine.version`)
- **Which framework build hosted it?** → `meta.frameworkBuild` (build id of `platform/web` at export time)

Bump `version` whenever you change game logic, state shape, submission shape, or anything else that would make an archive produced by an old version unreplayable on the new one. We don't preserve compatibility — but we do want traceability.

### `hostGameStateSchema` and the `HostGameStore` accessor

Engines that hold authoritative host-private state (Go Fish: `{ deck, handsByPlayerId }`; Hangman: `{ word }`) declare a zod schema:

```ts
const zGoFishHostGameState = z.object({
  deck: z.array(zGoFishRank),
  handsByPlayerId: z.record(zPlayerId, z.array(zGoFishRank))
});
```

The framework exposes a typed accessor on the `applySubmission` and `startGame` contexts:

```ts
type HostGameStoreAccessor<T> = {
  get(): T | null;       // null before startGame populates it, or after game-over clears it
  set(state: T): void;   // writes new authoritative state (host-only, never synced)
};

type StartGameInput<TConfig, THost> = {
  ctx: {
    store: RoomStore;
    hostGameStore: HostGameStoreAccessor<THost>;   // present iff engine declared hostGameStateSchema
    selfPlayerId: PlayerId;
  };
  room: Room;
  readyPlayers: ReadonlyArray<Player>;
  config: TConfig;
};

type ApplySubmissionInput<TConfig, THost> = {
  ctx: {
    store: RoomStore;
    hostGameStore: HostGameStoreAccessor<THost>;
    selfPlayerId: PlayerId;
  };
  submission: Submission;
  plaintext: Uint8Array;
  room: Room;
  config: TConfig;
};
```

For engines without `hostGameStateSchema` (TTT, Bingo today), `ctx.hostGameStore` is typed as `HostGameStoreAccessor<never>` and engines simply don't reach for it.

What goes in the host game store: anything the host needs to derive future events that **shouldn't** be published — a shuffled deck, the secret word, full hands by player id, an unrevealed pool. What does **not** go there: anything that should appear in `gameStatePublic`, `gameStatePrivate` (encrypted to specific players), or events. `gameStatePrivate` is still how a player's *own* private state reaches them; `hostGameStore` is for state only the host needs.

**Lifecycle invariants** (enforced by the framework, not the engine):

- Cleared and re-initialized empty when `framework/game_started` fires; `engine.startGame` populates it via `ctx.hostGameStore.set(...)`.
- Cleared on `framework/game_over`. The engine cannot "remember across matches" via this store — that's by design (no leak from finished match into a new one).
- Persisted to the host's local IndexedDB (TinyBase persister) for tab-reload survival.
- Never appears in `GameArchive`, `gameStateHistory`, the `events` log, or any sync transport.

### `applySubmission` — `ApplySubmissionResult` and `StepOutcome`

`applySubmission` now returns a structured result instead of a raw action list. The result tells the shell both *what to apply* (events, state writes) and *what just happened to the game lifecycle* (continue / elimination / win / draw).

```ts
type ApplySubmissionResult = {
  actions: HostLoopAction[];     // events + gameStatePublic / gameStatePrivate writes (as today)
  outcome: StepOutcome;
};

type StepOutcome =
  | { kind: 'continue' }
  | { kind: 'eliminated'; playerIds: PlayerId[]; publicPayload?: unknown }
  | { kind: 'won'; winnerPlayerIds: PlayerId[]; publicPayload?: unknown }
  | { kind: 'draw'; publicPayload?: unknown };
```

The optional `publicPayload` is the engine's hook to attach domain-specific end-of-game (or end-of-life) information that's not derivable from the final public state alone. Examples:

- **Hangman**: the revealed word, so the activity feed and game-over panel can show "The word was `MUSTARD`."
- **Go Fish**: a final score breakdown by rank, if the engine wants to surface it richer than what `gameStatePublic` carries.
- **Future elimination games**: the *reason* a player was eliminated ("ran out of lives", "voted out").

The principle: **shell owns lifecycle transitions, engine owns domain semantics**. The shell decides *that* the game ended; the engine decides *what story to tell* about it.

Engines no longer emit their own custom `*_GAME_OVER` events or `{ kind: 'updateRoom', patch: { status: 'finished' } }` actions. The shell derives both from `outcome.kind`:

- On `won` / `draw`, the shell:
  - Emits a canonical `framework/game_over` event with `{ kind: 'won' | 'draw', winnerPlayerIds, payload: outcome.publicPayload }`.
  - Updates `room.status = 'finished'`.
  - Stops accepting submissions.
- On `eliminated`, the shell:
  - Emits a canonical `framework/players_eliminated` event with `{ playerIds, payload: outcome.publicPayload }`.
  - Game continues; eliminated players are excluded from `eligiblePlayerIds` (the engine's `getActiveGameMetadata` is responsible for this).
- On `continue`, no extra events.

Engines still emit their *domain* events (`tictactoe/move_made`, `gofish/transferred`, etc.) — they just don't synthesize game-over markers. That's the shell's job, but the *content* still comes from the engine via `publicPayload`.

#### Host-loop emission order

**At game start** (host transitions room from `'starting'` to `'active'`):

1. **`framework/game_started`** — shell-emitted with `{ playerIds, matchIndex, seed, gameType }`. Always seq-first for the match.
2. **Engine `startGame` actions**, in order: domain `event` rows (e.g. `tictactoe/started`, `gofish/dealt`), then `gameStatePublic` / `gameStatePrivate` writes.
3. **`updateRoom`** patches the shell owns (e.g. `status: 'active'`).
4. **`gameStateHistory`** — one row for the initial `gameStatePublic`, seq aligned per §4.

**Per accepted submission**, the host applies actions in this order so the activity feed and snapshots stay intuitive (**final move appears before "game over"**):

1. **`host/accepted_submission`** — prepended by the room store / host loop (bookkeeping; no `gameStateHistory` row by itself).
2. **Engine `actions`**, in array order: `event` rows, then **`gameStatePublic`** / **`gameStatePrivate`** as emitted by the engine (domain state after the move).
3. **Shell lifecycle** (only if `outcome` is not `continue`): append **`framework/players_eliminated`** or **`framework/game_over`** as appropriate, then **`updateRoom`** patches the shell owns (e.g. `status: 'finished'`). These run **after** engine actions so the last domain event and public snapshot reflect the winning move before the terminal framework lines.
4. **`gameStateHistory`** — one row for the **final `gameStatePublic`** committed in this turn; **`seq`** aligns with the framework convention in §4 (typically the last event in the batch that commits that snapshot).

The exact merge into `HostLoopAction[]` is an implementation detail, but **domain events and state writes precede shell-emitted `framework/*` and room status flips** in the emitted sequence.

The shell-emitted `framework/game_over` and `framework/players_eliminated` events show up in the step log like any other step. Engines' `formatStep` can opt in to handle them and render the domain payload (Hangman renders "The word was X" when it sees `framework/game_over` with its expected payload shape); if `formatStep` returns null, the framework supplies a generic fallback rendering.

Engines that need their `publicPayload` to be type-safe can declare a zod schema for it in their shared-types module — the shell treats `publicPayload` as `unknown` and engines parse on read.

### GodotBridgeAdapter

When an engine ships a Godot HTML5 export as one of its playing surfaces, it declares a `godot` adapter. The framework's `<GodotPlayerSurface>` component (see §7) consumes the adapter to wire the iframe in/out without the engine touching `postMessage`, iframe lifecycle, or the standard envelope.

```ts
type GodotBridgeAdapter<TConfig, TState> = {
  // Path to the Godot export (relative to public root, e.g. '/godot/tictactoe/index.html').
  // The framework loads this in an iframe and runs the bridge protocol against it.
  exportPath: string;

  // Built once after the iframe sends 'godot_ready'. Carries everything Godot needs
  // to render the initial scene: who I am, am I a player or observer, current public
  // state, plus any config-derived rendering hints.
  buildStateInit(input: {
    state: TState;
    selfPlayerId: PlayerId;
    players: ReadonlyArray<Player>;
    config: TConfig;
    isObserver: boolean;
  }): unknown;

  // Built on every public state change. Just the public state (or a delta-friendly view).
  buildStatePublic(input: {
    state: TState;
    config: TConfig;
  }): unknown;

  // Parse an intent payload from Godot into a submission for `store.submit`. Strictly a
  // shape coercion: malformed payload / unknown intent kind → return null. Do NOT validate
  // game rules here (turn order, move legality, etc.) — that belongs to the host's
  // applySubmission per the submission acceptance rule (§3). This keeps `<GodotPlayerSurface>`
  // free of any game logic.
  parseIntent(input: {
    payload: unknown;
    selfPlayerId: PlayerId;
    config: TConfig;
  }): { kind: string; plaintext: Uint8Array } | null;
};
```

The bridge envelope (`{ bfg: true, v: 1, game, type, payload }`) and event names (`godot_ready`, `state_init`, `state_public`, `intent`) are framework constants in `shared-types/core/bridge`. The adapter only deals with the inner `payload` shapes, which remain game-specific.

Adapter contract: **pure data serialization only**. `<GodotPlayerSurface>` does no game-logic interpretation — it shuttles bytes between the iframe and `store.submit`, deferring shape transformation to the adapter and validation/auth to the host loop's submission acceptance rule (§3). See §7 for the chrome-side boundary statement.

Every method except `PlayerUI` and `ConfigUI` is pure (no React, no store reads beyond the inputs). That lets us unit test engines without spinning up the room store. The `GodotBridgeAdapter` methods are also pure — they're plain serializers/parsers.

`formatStep` returning `ReactNode` is a deliberate web/React choice for this iteration — it's an implicit "engines are React-aware" assumption. If a non-React client (CLI replay, mobile native) shows up later, we'd split it into a transport-agnostic `describeStep → StepTokens` (pure data) plus a `renderStepDescription(StepTokens) → ReactNode` adapter on the web side. Out of scope until there's a concrete non-React consumer.

---

## 9. Implementation Plan

**Single integration, logical chapters.** The work below lands as one consistent change — no compatibility shims, no in-flight versioning between phases — but it's organized as readable chapters rather than an undifferentiated mass. The "Suggested review sequencing" subsection at the end of this section orders the chapters for review; this list groups the work by what each chapter touches.

1. **Framework types**
   - Update `GameEngine<TConfig, TState>` in `platform/web/src/games/types.ts`: add `version`, `minPlayers`, `maxPlayers`, `defaultConfig`, `stateSchema`, `getActiveGameMetadata`, `formatStep`. Optional: `godot` (per-game opt-in). Make non-optional fields required.
   - Fix `ConfigUI` signature to `ComponentType<{ config; onChange; isHost }>`.
   - Change `applySubmission` return type from `HostLoopAction[] | null` to `ApplySubmissionResult | null` (`{ actions, outcome }`).
   - Add `ActiveGameMetadata`, `StepView`, `GameStep`, `StepOutcome`, `ApplySubmissionResult`, `GodotBridgeAdapter` type definitions.

2. **Framework chrome components** (new, in `platform/web/src/games/chrome/`)
   - `GameStatusBar` (reads `getActiveGameMetadata`).
   - `ActivityFeed` (reads `store.getEvents()`, maps through `formatStep`).
   - `GameOverPanel` (reads `getActiveGameMetadata.outcome`).
   - `LobbyConfigCard` (renders `engine.ConfigUI` with proper props).

3. **Play route refactor** (`room.$roomId.play.tsx`)
   - Generate the game-type `<select>` from `listGameEngines()`. No more hardcoded list.
   - On game-type switch, write `engine.defaultConfig` and `engine.maxPlayers`.
   - `HostControls` uses `engine.minPlayers` for the start gate.
   - `ConnectedRoom` renders the new chrome components alongside `engine.PlayerUI`.
   - Delete `TicTacToeLobbyConfig` from the route — it moves into the TTT engine.
   - Drop `search` from `PlayerUIProps` and the play route. **`?godot=stub`** is handled inside **`<GodotPlayerSurface>`** (framework reads the URL). Optional later: **`playerUiSearchSchema`** on an engine for typed dev flags — validated in chrome, not passed into `PlayerUI`.

4. **Per-engine refactor** (one PR per game is fine, or all at once — no compat to preserve)
   - Add `version`, `minPlayers`, `maxPlayers`, `defaultConfig`, `stateSchema`.
   - Convert `applySubmission` to return `{ actions, outcome: StepOutcome }`. Drop the engine's custom `*_GAME_OVER` event emission and the `{ kind: 'updateRoom', patch: { status: 'finished' } }` action — the shell handles both from `StepOutcome.kind`.
   - Implement `getActiveGameMetadata` returning `eligiblePlayerIds: PlayerId[]` (currently `[turnPlayerId]` for all four games) and `formatStep` (lift from existing `formatEvent` helpers in each `PlayerUI`).
   - Implement `ConfigUI` (TTT moves the existing inline form; others stay null/empty for now).
   - Strip status bar / activity feed / players list / game-over panel from `PlayerUI` — those come from the framework now. Keep the playing surface only.

4b. **Shell emits framework lifecycle events**
   - **At game start** (status transitions `'starting'` → `'active'`, before invoking `engine.startGame`): emit `framework/game_started` with `{ playerIds, matchIndex, seed, gameType }`. This is the canonical record of who-played-with-what-inputs; engines must not duplicate it in their own start events. The verifier (§3 Verifier input shape) reads this to recover `engine.startGame` inputs.
   - **After `engine.applySubmission`**, inspect `result.outcome`:
     - `won` / `draw` → emit `framework/game_over` event with `{ kind: 'won' | 'draw', winnerPlayerIds, payload: outcome.publicPayload }`, append `{ kind: 'updateRoom', patch: { status: 'finished' } }`, stop the host loop.
     - `eliminated` → emit `framework/players_eliminated` event with `{ playerIds, payload: outcome.publicPayload }`.
     - `continue` → no-op.
   - Default `formatStep` rendering for `framework/*` events lives in framework chrome; engines may opt in to handle them when they want to render the domain `payload`.

4c. **Config-mutation lock + match seed composition**
   - Add `matchIndex: z.number().int().min(0).default(0)` to the `room` schema.
   - In the room store, reject `updateRoomAsHost` patches that touch `gameType`, `gameConfig`, `maxPlayers`, `seed`, or `matchIndex` when `room.status ∈ { 'active', 'finished' }`. Lobby chat, player ready toggles, etc. remain mutable.
   - Engines build their per-purpose RNG from the composed match seed: `${room.seed}|${room.id}|${gameType}|${matchIndex}|<purpose tag>`. Update the existing TTT / Go Fish / Hangman / Bingo seed strings to use this composition. Today every match has `matchIndex = 0`, but the plumbing is in place.
   - "New Game" creates a fresh room (fresh `room.seed`, `matchIndex = 0`); multi-round series within one room (incrementing `matchIndex`) stays deferred.

4d. **Host game store**
   - Add a host-only TinyBase store (one per hosted room), persisted to IndexedDB via TinyBase's persister. Schema is engine-declared via `engine.hostGameStateSchema`.
   - Implement the `HostGameStoreAccessor<T>` (`get` / `set`) and thread it onto `ctx.hostGameStore` for `engine.startGame` and `engine.applySubmission`. For engines without `hostGameStateSchema`, the accessor is typed `never` and engines don't touch it.
   - Lifecycle: clear-and-init on `framework/game_started`, clear on `framework/game_over` and on room reset. Clearing happens in the host loop, not the engine.
   - **Migrate Go Fish off the synced `host: {...}` slot**: Go Fish today encodes `{ deck, handsByPlayerId }` inside the host's own `gameStatePrivate` row. Move that data into the host game store; remove the `host` slot from `zGoFishPrivateState` schema.
   - **Migrate Hangman off `gameStatePrivate` for the host**: Hangman today stores `{ word }` in the host's `gameStatePrivate`. Move it to the host game store; the host's `gameStatePrivate` row goes away entirely (Hangman has no per-player private state for non-hosts either, so no synced private state at all after the move).
   - Update each engine's `applySubmission` and `startGame` to read/write via `ctx.hostGameStore` instead of decrypting the host's own `gameStatePrivate` row.

5. **Game step model + state history**
   - Treat the existing `events` row as the `GameStep` envelope. Drop wall-clock from canonical identity (the events table can keep `receivedAt` as a UI hint, but it's not part of the step's identity or the engine's input).
   - Add a `gameStateHistory` table: `{ seq, state }` rows. The host writes **one row per persisted `gameStatePublic` snapshot** (see §4), in the same host-loop pass that commits that snapshot — not necessarily one row per raw `events` row.
   - **New `RoomStore` capabilities** (these don't exist on the typed accessor today; add them in `multiplayer-tinybase`): `getGameStateHistory(): GameStateHistoryRow[]`, `onGameStateHistoryChanged(cb)`, and the host-side `writeGameStateHistory(row)`.
   - Add a **framework-level** `exportGameArchive(store, engine): GameArchive` function (not a `RoomStore` method) that composes `room`, `players` (id/displayName/signingPubKey only), `events`, and `gameStateHistory`, plus `meta.engineVersion` (lifted from `engine.version`) and `meta.frameworkBuild` (commit SHA injected at build time).
   - Wire a "Download archive" button into the play route, available to anyone (player, host, observer) once the room is loaded.

6. **Observer role**
   - Confirm/strengthen the shell's submission acceptance rule (§3): the host loop drops submissions whose `fromPlayerId` is not in `players` — this is the security boundary; observer guards are UX layered on top.
   - Add a client-side `selfRole: 'observer' | 'player' | 'host'` flag and a "Watch" button alongside "Join game" in the lobby.
   - In the room store: gate `setSelfReady` and `submit` on `selfRole !== 'observer'`. Don't write a `players` row for observers (they connect to the WS sync but never upsert).
   - In the play route: hide the join/ready controls for observers; show an "Observing" notice; disable the Auto Play button.
   - No engine changes needed — `PlayerUI` already handles the no-self-in-players case.

7. **Godot bridge framework**
   - Move the iframe + `postMessage` wiring out of `tictactoe/PlayerUI.tsx` into a generic `<GodotPlayerSurface>` component in `platform/web/src/games/chrome/`. It loads `engine.godot.exportPath` in an iframe, performs the `godot_ready` handshake, pushes `state_init` once and `state_public` on every state change, and translates inbound `intent` messages through `engine.godot.parseIntent` into `store.submit`.
   - Promote the bridge envelope and event-name constants (`godot_ready`, `state_init`, `state_public`, `intent`) from `tictactoe/bridge-events.ts` into `shared-types/core/bridge`. Per-game payload shapes stay per-game.
   - Add `engine.godot?: GodotBridgeAdapter` to the engine API. Per-game opt-in for any engine.
   - TicTacToe declares its `godot` adapter (lifting `buildStateInit` / `buildStatePublic` / `parseIntent` from the current `PlayerUI` body). Its `PlayerUI` shrinks to a switch on `cfg.ui` between `<GodotPlayerSurface>` and the React board.
   - `?godot=stub` becomes a generic dev flag handled by `<GodotPlayerSurface>` (renders a stub iframe replacement that simulates the bridge for testing), not a TTT-specific concern.

8. **Storage / sync layer split (light cleanup)**
   - Document the existing two-store model (local TinyBase + synced room TinyBase) explicitly in `multiplayer-tinybase`'s top-level README/comment. Make sure shell, engines, and chrome only reach into the room store via the typed `RoomStore` accessor, never into TinyBase APIs directly outside of the implementation file.
   - Define a `RoomSyncProvider` interface that wraps a TinyBase synchronizer and exposes `connect(opts) / disconnect() / status` to the room store. Today's implementation: `WsRoomSyncProvider` (TinyBase `WsSynchronizer` to a DO). Future: `P2PRoomSyncProvider` (TinyBase synchronizer over a P2P channel). The room store accepts a sync provider on connect.
   - Move WS-specific concerns (URL building, reconnect strategy, DO heartbeat) out of `TinyBaseRoomStoreClient` and into `WsRoomSyncProvider`. Audit for any transport-specific leaks; current code is mostly clean but should be verified during the refactor.
   - This is *cleanup*, not a feature. The current single-transport setup works; this step makes the seam explicit so a future P2P provider can plug in without touching shell or engines.

All chapters land together. The new API is required, the chrome is replaced, archives are recorded, observers can watch, the host game store is separated from the synced room store, the Godot bridge is generalized, the storage/sync seam is named, and the per-game `PlayerUI`s shrink — one integration, organized as logical chapters (see "Suggested review sequencing" below).

### Bonus features once the framework lands

- `HistoryScrubber` UI over the `gameStateHistory` table — step through a finished game inside the play route.
- Archive verifier: a small CLI / test that imports a `GameArchive`, runs the engine over `events[]` from the recorded `seed` / `gameConfig` per the verifier input shape (§3 Engine purity contract → Verifier input shape), and asserts `stateHistory` matches step-for-step. Requires adding `engine.applyEvent` to each engine.
- Engine unit tests for `applySubmission` / `getActiveGameMetadata` / `formatStep` (the pure adapters make this trivial).
- Move auto-play description formatting into `formatStep` so engines stop building their own description string.

### Suggested review sequencing

The work above lands as one coherent change (no compat to preserve), but the doc and the diff are easier to read in roughly this order. A reviewer can take them as logical chapters rather than separate PRs:

1. **Types & contracts first.** Step 1 (framework types) + the new type definitions (`StepOutcome`, `ApplySubmissionResult`, `GodotBridgeAdapter`, `GameStateHistoryRow`, `HostGameStoreAccessor`, `THostGameState` engine generic). Compile-only at this stage; no runtime yet.
2. **Host-loop wiring.** Step 4b (shell derives lifecycle from `StepOutcome` + emits `framework/game_started`) + step 4c (config lock + match seed plumbing) + step 4d (host game store lifecycle and accessor threading) + step 5 RoomStore capability additions (`gameStateHistory` reads/writes). The host loop becomes the place where outcome interpretation, history persistence, and host-private state ownership happen.
3. **Per-engine refactor.** Step 4 — each engine's `applySubmission` returns `{ actions, outcome }`; engines drop their custom game-over events; engines that need host-private data declare `hostGameStateSchema` and migrate off the synced `host: {...}` slot; engines add `getActiveGameMetadata`/`formatStep`. Engines compile against the new types from step 1.
4. **Chrome components.** Step 2 — build the framework-side rendering of status bar, activity feed, players list, game-over panel, etc. They consume the new engine adapters.
5. **Play route refactor.** Step 3 — wire chrome components in; delete `TicTacToeLobbyConfig`; generate game `<select>` from `listGameEngines()`.
6. **Archive + observer + Godot framework.** Steps 5 (archive download), 6 (observer role), 7 (Godot bridge framework). These are independent enough to land in any order, but logically follow the chrome refactor.
7. **Sync-layer extraction.** Step 8 — purely structural; safe to do last because it doesn't change behavior.

This sequencing also matches what a code reviewer should look for: contracts → host-side enforcement → engine compliance → UI consumption → polish.

---

## 10. Per-Game Migration Checklist

For each existing game, what changes:

### TicTacToe
- Add `version: '1.0.0'`, `minPlayers: 2`, `maxPlayers: 2`, `defaultConfig: { symbolPair: 'xo', ui: 'godot' }`, `stateSchema: zTicTacToeState`. **No `hostGameStateSchema`** — TTT has no host-private game data; everything is public.
- `ConfigUI`: move `TicTacToeLobbyConfig` from the route into the engine module, take `{ config; onChange; isHost }`.
- `getActiveGameMetadata`: `eligiblePlayerIds: state.currentPlayerId ? [state.currentPlayerId] : []`, no badges (TTT is simple), outcome from `winnerId` / `isDraw`.
- `applySubmission`: return `{ actions, outcome }`. `outcome` = `{ kind: 'won', winnerPlayerIds: [winnerId] }` on win, `{ kind: 'draw' }` on draw, `{ kind: 'continue' }` otherwise. Drop the manual `tictactoe/game_over` (if any) and `updateRoom: 'finished'` action — shell derives both.
- `formatStep`: handle `tictactoe/started` (mark-assignment payload only — `playerIds` come from `framework/game_started`), `tictactoe/move_made`. System events return null. The shell renders `framework/game_started` / `framework/game_over` by default unless TTT opts in.
- `godot`: provide a `GodotBridgeAdapter` with `exportPath: '/godot/tictactoe/'`, `buildStateInit` (lift `state_init` payload — `symbolPair` / `symbolByMark`), `buildStatePublic`, `parseIntent` (currently `{ kind: 'tictactoe/move', cellIndex }`).
- `PlayerUI`: thin switch on `cfg.ui` — `<GodotPlayerSurface engine={TicTacToeGameEngine} {…props} />` when `'godot'`, the React board when `'react'`. Drop iframe / postMessage code, status bar, game-over panel.

### Go Fish
- Add `version: '1.0.0'`, `minPlayers: 2`, `maxPlayers: 4`, `defaultConfig: zGoFishConfig.parse({})`, `stateSchema: zGoFishPublicState`.
- Add **`hostGameStateSchema: zGoFishHostGameState`** = `z.object({ deck: z.array(zGoFishRank), handsByPlayerId: z.record(zPlayerId, z.array(zGoFishRank)) })`. **Remove** the `host: {...}` slot from `zGoFishPrivateState` — non-host players' hands stay in `gameStatePrivate`, but the deck and full-hands map move to the host game store.
- `ConfigUI`: empty for now (returns null). No `godot` adapter.
- `getActiveGameMetadata`: `eligiblePlayerIds: state.turnPlayerId ? [state.turnPlayerId] : []`, badges `[{ label: 'Deck', value: '38 cards' }]`, `perPlayer` with `secondary: '✋ 7  📚 1'` and `isCurrent`.
- `applySubmission`: read deck and all-hands via `ctx.hostGameStore.get()`, write updated state via `ctx.hostGameStore.set(...)`. No more decrypting the host's own private row to recover host-private data. Return `outcome: { kind: 'won', winnerPlayerIds: [...] }` when a player empties their hand (matches the new win condition); `{ kind: 'continue' }` otherwise. Drop the engine's `gofish/game_over` event and the `updateRoom: 'finished'` action.
- `formatStep`: lift the existing `formatEvent` from `PlayerUI.tsx`.
- `PlayerUI`: drop status bar, players list, activity feed, game-over panel. Keep hand chips and action area.

### Hangman
- Add `version: '1.0.0'`, `minPlayers: 2`, `maxPlayers: 8`, `defaultConfig: { maxWrongGuesses: 6 }`, `stateSchema: zHangmanPublicState`.
- Add **`hostGameStateSchema: zHangmanHostGameState`** = `z.object({ word: z.string() })`. The word lives in the host game store (host-only, plaintext). **Remove** the existing `gameStatePrivate` write that stuffs the word into the host's own private slot — Hangman has no per-player private state for non-hosts either, so after this migration Hangman writes nothing at all to `gameStatePrivate`.
- `getActiveGameMetadata`: `eligiblePlayerIds: state.turnPlayerId ? [state.turnPlayerId] : []`, badges `[{ label: 'Wrong', value: '3 / 6', tone: wrongGuesses > 4 ? 'warn' : 'info' }]`, outcome derived from the public state — `summary` text uses the revealed word from the `framework/game_over` payload (see below).
- `applySubmission`: read the word via `ctx.hostGameStore.get().word`. At game end, attach the revealed word to `outcome.publicPayload`:
  - Win: `{ kind: 'won', winnerPlayerIds: state.playerIds, publicPayload: { word } }`
  - Loss: `{ kind: 'draw', publicPayload: { word } }` (no human winner — the word "won")
  - Otherwise: `{ kind: 'continue' }`.
  Define a zod schema `zHangmanGameOverPayload = z.object({ word: z.string() })` in shared-types so the engine and `formatStep` parse the same shape.
- `formatStep`: handle `framework/game_over` and read `payload.word` for the reveal text. Plus the existing per-step events.
- `PlayerUI`: keep figure + masked word + letter grid only. No `godot` adapter.

### Bingo
- Add `version: '1.0.0'`, `minPlayers: 2`, `maxPlayers: 8`, `defaultConfig: zBingoConfig.parse({})`, `stateSchema: zBingoPublicState`. **No `hostGameStateSchema`** — Bingo's "deck" is the called-numbers list, which is already public state. Boards are public per the existing design. Nothing host-private to hold.
- **Single cap source:** remove **`maxPlayers` from `zBingoConfig`** in shared-types (today it duplicates the engine). Lobby join cap = **`room.maxPlayers`**, set from **`engine.maxPlayers`** when the host picks Bingo — **not** a second field inside `gameConfig`. After the schema change, `defaultConfig` has no player-cap key.
- `getActiveGameMetadata`: `eligiblePlayerIds: state.turnPlayerId ? [state.turnPlayerId] : []`, badges `[{ label: 'Called', value: '12 / 75' }, { label: 'Last', value: 'B7' }]`, `perPlayer.secondary: '23/25'`, `perPlayer.badge: 'BINGO'` when applicable.
- `applySubmission`: return `outcome: { kind: 'won', winnerPlayerIds: winners }` when bingo detected, `{ kind: 'continue' }` otherwise.
- `formatStep`: lift from `PlayerUI`.
- `PlayerUI`: keep board + called-numbers tracker + call section + other-boards. Drop status bar, players list, activity feed. No `godot` adapter (yet — could opt in later if a Godot board export is built).

---

## 11. Adding a New Game (target workflow)

Once the framework refactor lands, the work for a new game is:

1. **Schemas** — `platform/shared-types/src/games/<name>/schemas.ts`: config, public state, private state (if needed), submissions, event payloads. Add to `shared-types` barrel.
2. **Engine** — `platform/web/src/games/<name>/engine.ts`:
   - `startGame` — derive initial state from `room.seed` + ready players. If your game has host-private authoritative data (a deck, a secret, a hidden pool), populate `ctx.hostGameStore.set(...)` here.
   - `applySubmission` — validate, advance state, return `{ actions, outcome: StepOutcome }` (`actions` are `event` + `gameStatePublic` + `gameStatePrivate` writes; `outcome` is `'continue'` / `'eliminated'` / `'won'` / `'draw'`). Read/write host-private data via `ctx.hostGameStore` if you declared a schema. Don't emit your own game-over events — the shell does that.
   - `autoPlay` — pick a default move.
   - `getActiveGameMetadata` — adapter (~20 lines). Return `eligiblePlayerIds: PlayerId[]` (often `[turnPlayerId]`).
   - `formatStep` — adapter (~30 lines, switch on event kind).
   - Constants: `version` (semver / hash / counter — author choice), `minPlayers`, `maxPlayers`, `defaultConfig`.
   - **Optional**: `hostGameStateSchema` — only if your game has authoritative host-private data the host needs to derive future events (deck, secret word, hidden pool). Engines without host-private data omit it. `gameStatePrivate` is for player-private data, not host-private — don't conflate them.
3. **`PlayerUI`** — render the play surface. Subscribe to public state (and own private state if any). Submit intents via `store.submit`. For Godot-backed games, render `<GodotPlayerSurface engine={MyEngine} {…props} />`.
4. **`ConfigUI`** — usually trivial or null.
5. **(Optional) Godot bridge** — Godot is a per-game opt-in, available to *any* engine, not just TTT. If the playing surface is a Godot HTML5 export, declare `engine.godot: GodotBridgeAdapter` with `exportPath`, `buildStateInit`, `buildStatePublic`, `parseIntent`. Per-game payload zod schemas live in `shared-types/games/<name>/bridge-events.ts`; the envelope and event names are already shared.
6. **Register** — one line in `registry.ts` (stable sort `listGameEngines()` by `displayName` for the game `<select>`).

That's it. No route edits. No chrome plumbing. No copy/pasted status bar or activity feed. No iframe or `postMessage` glue.

---

## 12. Open Questions

- **Engine code packaging.** Engines live in `platform/web` only. If we add a server-side host (DO) or a P2P transport, engines need to be reachable from the new runtime — either moved to a shared package or distributed via the same channel as game code. Worth thinking about *before* a second transport lands.
- **Multi-round / series.** "New Game" creates a fresh room with a fresh seed; we don't have a "best of 3" within one room. Deferred — revisit per-game when a specific game wants it.
- **Real-time / simultaneous-action games.** Out of scope for this framework. The turn-based + per-player-slot model in §3 explicitly doesn't address inputs that need to be merged in the same tick.
- **Step token format for non-React clients.** `formatStep` returns React nodes today. Splitting into `describeStep → tokens` + `renderTokens → React` is straightforward but unmotivated until there's a non-React consumer.
