# Shared States Plan — History, Events, and Information Access

This document defines how game actions and game state are represented in the **shared object** (the synchronized room store), including **history**, **event logs**, and **public vs per-player private information**. It is written to be implementable with our current stack:

- Shared schemas: `platform/shared-types` (Zod)
- Multiplayer backends: `platform/multiplayer-*` (TinyBase now; others later)
- Web host client: authoritative rules + validation (Phase 9 will enforce on the server)

---

## Goals

- **Host-authoritative shared state**: only the host is allowed (by convention today) to mutate shared game state.
- **Encrypted player moves**: players submit moves encrypted to the host, via the shared object.
- **Host decrypts + validates**: host turns submissions into canonical events, updates state, and publishes.
- **Information access/sharing**:
  - publish a **public** state for all clients
  - publish **per-player private** state (encrypted to that player)
- **Replayable history**:
  - keep an append-only event log
  - allow a player to decrypt their own private event/history later (not just rely on local plaintext)

Non-goals (for now):
- Perfect adversarial security with untrusted server: until Phase 9, demo server accepts all writes.
- Client-side secrecy against a malicious host: host necessarily sees submissions and can publish anything.

---

## Shared object write conventions (pre-Phase 9 enforcement)

### Host-only writable regions (convention)
- `room` shared fields: status / game selection / policy fields
- `gameStatePublic` (public game state)
- `gameStatePrivate` (per-player private state blobs)
- `events` append-only canonical event log
- `eventsPrivate` (per-event per-player encrypted payloads) **or** `privateLogByPlayer` (see below)

### Player self-writable regions
- `players[self]` presence fields (`lastSeen`, `isConnected`) and local intent flags (`isReady`, `autoplayMode`)

### Player-authored submission region
- `submissions` append-only encrypted move submissions, authored by the submitting player

---

## Core data model (tables)

These are logical tables; TinyBase tables map 1:1.

### 1) `submissions` (player → host, encrypted)
**Purpose**: carry a player’s intended move in ciphertext so only host can read it, while everyone can transport it.

- Row ID: `sub_<...>`
- Fields:
  - `fromPlayerId: PlayerId`
  - `toHostCiphertext: string` (opaque)
  - `iv: string` (nonce/iv)
  - `createdAt: number` (epoch ms)
  - `gameType: GameType` (for routing)
  - `kind: string` (eg `ttt_move`)

**Write rule**: player writes only their own submissions.

### 2) `events` (host → everyone, canonical history)
**Purpose**: canonical, replayable, append-only log of validated actions.

- Row ID: `evt_<...>`
- Fields:
  - `seq: number` (monotonic per room; required for deterministic replay)
  - `createdAt: number`
  - `gameType: GameType`
  - `kind: string` (eg `ttt_move_applied`)
  - `publicPayload: unknown` (JSON; must be safe for all clients)
  - `fromPlayerId: PlayerId | null` (optional, for attribution)

**Write rule**: host-only.

### 3) Private history / private state (host → each player)
We need a per-player encrypted channel for history and/or private state.

**v1 decision (locked, CHECKPOINT 3):** Option A (`eventsPrivate`) is the chosen shape. Option B (`privateLogByPlayer`) is dropped for v1 — it's documented below for historical reference but is not implemented in schemas.

#### Option A — `eventsPrivate` (chosen for v1)
**Purpose**: per-event per-player encrypted payloads that the player can decrypt later.

- Row ID: `epvt_<evtId>_<playerId>` (or a composite encoded id)
- Fields:
  - `evtId: string`
  - `playerId: PlayerId`
  - `ciphertextToPlayer: string`
  - `iv: string`

Write rule: host-only.

#### Option B — `privateLogByPlayer` (DROPPED for v1)
**Purpose**: per-player rolling encrypted log blob (append-only by replacement).

- Row ID: `playerId`
- Fields:
  - `ciphertext: string`
  - `iv: string`
  - `lastSeq: number`

Write rule: host-only.

### 4) Public + private “current state” snapshots

Event logs support replay, but clients also benefit from a latest-state snapshot to render quickly.

#### `gameStatePublic`
- Row ID: singleton per game (eg `state_public`)
- Fields:
  - `seq: number` (the last applied event sequence)
  - `state: unknown` (public state JSON, validated by per-game Zod)

Write rule: host-only.

#### `gameStatePrivate`
- Row ID: `playerId` (one row per player)
- Fields:
  - `seq: number`
  - `state: unknown` (private state JSON, encrypted or plaintext depending on the game)
  - If encrypted: `ciphertext`, `iv` instead of `state`

Write rule: host-only.

---

## Encryption & keys

### Key publication
- The host publishes a room encryption public key in `room.hostEncPubKey`.
- Clients treat `room.hostEncPubKey` as the **current** key. If host changes, it must rotate the key and bump a `keyVersion` (recommended addition) to avoid ambiguity.

Recommended fields (future-proofing):
- `room.hostEncPubKey: string` (already exists)
- `room.hostKeyVersion: number` (add later)

### Submission encryption
Players encrypt move payloads using the host’s public key and write to `submissions.toHostCiphertext`.

We want:
- Random nonce/iv per message
- Authenticated encryption (detect tampering)

Implementation choice:
- Use WebCrypto:
  - ECDH (X25519) to derive a shared secret
  - HKDF to derive an AES-GCM key
  - AES-GCM for encryption

### Private history encryption
For **history_decrypt** semantics, the host must provide the moving player (and/or every player) a decryptable record later:
- If using `eventsPrivate`: host encrypts a per-player payload for each event and writes those rows.
- If using `privateLogByPlayer`: host appends to that player’s private log and republishes the encrypted blob.

---

## Canonical processing pipeline (host)

1) Observe new `submissions` rows.
2) Decrypt using host private key.
3) Validate payload:
   - schema (Zod)
   - game rules (turn ownership, legal move, etc.)
   - dedupe (don’t apply the same submission twice)
4) Emit canonical `events` entry with next `seq`.
5) Update `gameStatePublic` snapshot (and `gameStatePrivate` snapshots as needed).
6) Publish private history for relevant players (`eventsPrivate` rows or `privateLogByPlayer`).

---

## Replay semantics

Clients reconstruct state as:
- Start from empty (or initial config)
- Apply `events` in `seq` order
- Optionally short-circuit by loading `gameStatePublic` and applying only events after that snapshot’s `seq`

Private replay:
- If the game has private info, each player uses their private channel (`eventsPrivate` or `privateLogByPlayer`) to reconstruct the private view.

---

## Access & leakage notes

- **Transport visibility**: everyone can see ciphertext in the shared object. This is okay; confidentiality comes from encryption.
- **Metadata leakage**: even with encryption, timing, sender, and event counts leak. If needed, batch/cover traffic later.
- **Host visibility**: host can decrypt submissions and can publish any public/private state it chooses. This is inherent to “host authority”.

---

## Mapping to implementation packages (current repo)

- Zod schemas for these tables should live in `platform/shared-types/src/core/schemas.ts` (and/or `core/store.ts` if we keep interfaces there), plus per-game schemas under `platform/shared-types/src/games/<game>/...`.
- TinyBase table schema + codec mappings live in `platform/multiplayer-tinybase/src/schema.ts`.
- Host authority pipeline lives in `platform/web` (until Phase 9 moves enforcement server-side).
