# CHECKPOINT 3 — Real Keypairs + Shared-States Planning

Date: 2026-04-25

This checkpoint is a delta from `old-plans/CHECKPOINT-2.md`.

## What changed since CHECKPOINT 2

### Shared-states plan authored (SHARED-STATES-PLAN.md, repo root)
A new design document defining how game actions and state are represented in
the synchronized room store, including:
- public vs per-player private state
- append-only event log + per-player encrypted history
- player → host encrypted submissions
- host-authoritative processing pipeline (decrypt → validate → emit event → snapshot)

This plan was reviewed by Opus and several gaps were identified (still open,
not yet implemented):
- no sender authentication on `submissions` (Ed25519 signing key exists in
  the schema but isn't applied to submissions)
- no host signatures on `events` / `gameStatePublic` for client-side
  verification of host authority pre-Phase 9
- replay/dedupe protection is hand-waved (needs explicit per-player nonces)
- `seq` allocation rule under TinyBase CRDT is undefined
- `gameStatePrivate` plain-vs-encrypted shape needs a discriminated union
- `submissions.kind` / `events.kind` are bare `string` — no per-game registry
- no genesis-event rule for replay
- `eventsPrivate` row IDs leak per-player metadata
- one private-channel option (A `eventsPrivate`) should be picked for v1;
  drop Option B (`privateLogByPlayer`)

### Real player keypairs (was: random bytes)
The biggest follow-on from the plan review: previously
`TinyBaseRoomStoreClient` generated 32 random bytes and called them
"keys" — there were no private halves anywhere, so the plan's
"history decrypt later" semantics were impossible to implement.

This is now fixed end-to-end using **WebCrypto Ed25519 + X25519** (no new
dependencies; relies on browser support: Chrome 124+, Safari 17+,
Firefox 130+).

#### New: `platform/shared-types/src/core/identity.ts`
- **Persisted (Zod-branded)** types:
  - `zPlayerIdentity` → `PlayerIdentity` — `{ playerId, signing: { pub, privJwk }, enc: { pub, privJwk } }`
  - `zGameHostKeypair` → `GameHostKeypair` — per-room X25519 key the host mints
- **Loaded (runtime, TS-branded via `unique symbol`)** types holding `CryptoKey` objects:
  - `LoadedPlayerIdentity`
  - `LoadedGameHostKeypair`
- Async generators using WebCrypto:
  - `generatePlayerIdentity()`
  - `generateGameHostKeypair()`
- Async loaders that import JWK → `CryptoKey`:
  - `loadPlayerIdentity(serialized)`
  - `loadGameHostKeypair(serialized)`

#### Tightened: `platform/shared-types/src/core/keys.ts`
- `*PrivKeyJwk` (loose `min(1)` strings) replaced with structured Zod
  objects: `zEd25519PrivJwk` and `zX25519PrivJwk` — literal `kty`/`crv`,
  b64url-validated `x`/`d`, each `.brand()`-ed.
- DRY'd the 32-byte b64url regex into `zKey32B64Url` and reused for the
  three pubkey brands + `zChallengeNonce`.
- Added comments documenting the byte→char math behind the regex magic
  numbers (43 chars = 32 bytes, 86 = 64, 16 = 12).

#### Typed `LocalStore`
- `platform/shared-types/src/core/store.ts`: `getIdentity()` /
  `saveIdentity()` are now `PlayerIdentity`, not `unknown`.
- `platform/multiplayer-types/src/index.ts`: deduplicated — its
  `LocalStore` interface is now a re-export of the canonical one in
  `shared-types`.

#### New: `platform/web/src/sync/localStore.ts`
- `WebLocalStore implements LocalStore`, backed by `localStorage`.
- Storage keys: `bfg.identity.v1`, `bfg.preferences.v1`.
- Validates on read with `zPlayerIdentity.safeParse` — corrupt blob is
  treated as missing, prompting regeneration.
- `ensureIdentity()` convenience: returns persisted identity, or
  generates + saves a fresh one.

#### `TinyBaseRoomStoreClient` now identity-driven
- Constructor takes `LoadedPlayerIdentity` instead of self-generating
  random bytes for player id / signing pub / enc pub.
- The room's host encryption key (`hostEncPubKey`) is now a real X25519
  public key, generated via `generateGameHostKeypair()` on `connect()`
  when this client is creating the room.

#### `SyncContext` async bootstrap
- On mount: `ensureIdentity()` (persists to localStorage if first run)
  → `loadPlayerIdentity()` (imports JWKs to `CryptoKey`s) → constructs
  `TinyBaseRoomStoreClient`.
- Renders a "Loading identity…" placeholder until ready.
- `useSync()` now also exposes the loaded `identity`.

### Memory: per-game versioning recorded in lobby
Saved as project memory: game state types and actions are expected to
differ across game implementations AND across versions of the same game.
The room/lobby is the source of truth for which implementation+version
is active. Game-specific schemas live in per-game folders (already true
for `platform/shared-types/src/games/tictactoe/`).

This implies a pending room-schema addition: `gameVersion` alongside
`gameType`. **Not yet implemented** in `zRoom`.

## Plan deviations (explicit)

### Phase 1 (identity) is now partially in-place ahead of schedule
`BUILD-PLAN.md` originally placed identity / signing / encryption work
in Phase 1. It was deferred during Phase 4 (CHECKPOINT 2 used
placeholder strings). Real player identity has now landed because the
SHARED-STATES-PLAN review made it clear that everything downstream
(submissions, eventsPrivate, history-decrypt) is impossible without
persistent keypairs. Identity persistence + WebCrypto generation is
done; **signing of submissions and host-side verification are not
implemented yet** — that's still Phase 1 work.

### Schema additions still pending
- `room.gameVersion` — implied by per-game-versioning architectural
  decision; not yet added.
- `room.hostKeyVersion` — flagged in SHARED-STATES-PLAN as future-proofing
  for host handover; intentionally deferred until handover exists.
- New tables from SHARED-STATES-PLAN (`submissions`, `events`,
  `eventsPrivate`, `gameStatePublic`, `gameStatePrivate`) — none added
  to `ROOM_TABLES_SCHEMA` yet.

### Crypto choice locked: WebCrypto, not noble
We considered `@noble/curves` (zero browser-availability concerns) but
chose WebCrypto Ed25519/X25519 because:
- the existing 32-byte (43-char b64url) key brands match exactly
- the existing `*PrivKeyJwk` brand naming becomes literally what we store
- no new dependencies
- the user explicitly opted into a recent-browsers floor

## How to run what exists now

Same as CHECKPOINT 2:
```bash
npm -w @brute-force-games/web run dev
```

What's new in the runtime behavior:
- On first page load, the app generates a real Ed25519 + X25519 keypair
  via WebCrypto and persists it to `localStorage` under `bfg.identity.v1`.
- Reload preserves the identity (same `playerId`, same pub keys).
- Two browser tabs (same origin, same storage) share an identity. To
  simulate two distinct players, use two different browsers or a
  private/incognito window.
- The host's per-room `hostEncPubKey` in the `room` row is now a real
  X25519 public key (regenerated each time a fresh room is created — it
  isn't persisted across sessions yet).
- The "Loading identity…" placeholder is shown briefly on first load
  while WebCrypto generates the keypair.

Typecheck across all workspaces is clean (`npm run typecheck`, exit 0).

## What's next (suggested)

The Opus review enumerated must-fix items for SHARED-STATES-PLAN. With
real keypairs in place, the natural next step is **submission signing**:
- player signs `(fromPlayerId, iv, ciphertext, createdAt, nonce)` with
  their Ed25519 priv key before writing to `submissions`
- host verifies the signature using the player's `signingPubKey` from
  the `players` row before processing
- adds replay protection via player-local monotonic nonce
