# CHECKPOINT 4 — Shared-State v1 Schemas + Write Policy + Submission Signing

Date: 2026-04-25

This checkpoint is a delta from `old-plans/CHECKPOINT-3.md`.

## What changed since CHECKPOINT 3

### Shared-state v1 shape locked in schemas
The five tables described in `SHARED-STATES-PLAN.md` now have concrete Zod
schemas + TinyBase storage, addressing the must-fix items from the Opus
review (where addressable in the schema layer).

#### New: `platform/shared-types/src/core/shared-state.ts`
- **`zSubmission`** — player-authored encrypted move row. Includes
  `signature` (Ed25519 over canonical bytes — see signing below) and
  `nonce` (player-local monotonic) so the schema *requires* both replay
  protection and sender authentication.
- **`zEvent`** — host-authored canonical log entry. `seq: number ≥ 0`,
  `publicPayload: unknown` (per-game refines), nullable `fromPlayerId`,
  and `hostSignature` so clients can verify host authority pre-Phase 9.
- **`zEventsPrivate`** — per-event per-player encrypted payload, plus
  `makeEventsPrivateRowId(evtId, playerId)` helper using `epvt_<evtId>|<playerId>`
  (the `|` separator avoids ambiguity with base64url chars).
- **`zGameStatePublic`** — singleton snapshot keyed at
  `SINGLETON_PUBLIC_STATE_ID = 'state_public'`, host-signed.
- **`zGameStatePrivate`** — Zod **discriminated union** on `kind: 'plain' | 'encrypted'`
  (the discriminator the Opus review specifically called out).

#### New ID brands in `core/ids.ts`
- `EventId` (prefix `evt_`)
- `EventsPrivateRowId` (prefix `epvt_`)
- `PREFIX` extended with `event` / `eventsPrivate`

#### TinyBase tables added in `multiplayer-tinybase/src/schema.ts`
- `submissions`, `events`, `eventsPrivate`, `gameStatePublic`,
  `gameStatePrivate` — primitive-only cells with documented JSON-encoded
  fields registered in `JSON_FIELDS`:
  - `events`: `publicPayload`, `fromPlayerId` (nullable preservation)
  - `gameStatePublic`: `state`
  - `gameStatePrivate`: `state`

#### Plan locked
`SHARED-STATES-PLAN.md` updated: Option A (`eventsPrivate`) is "chosen for
v1"; Option B (`privateLogByPlayer`) is **DROPPED for v1** — kept in the
doc only for historical reference.

### "Host-only writes" enforced as code guardrails

#### New: `platform/shared-types/src/core/write-policy.ts`
- `isHost(selfPlayerId, hostPlayerId): boolean`
- `requireHost(self, host, context)` — throws `HostOnlyWriteError`
  (carries `selfPlayerId`, `hostPlayerId`, `context`)
- Documented ownership constants: `HOST_OWNED_TABLES = ['room', 'events',
  'eventsPrivate', 'gameStatePublic', 'gameStatePrivate']` and
  `PLAYER_OWNED_TABLES = ['players', 'submissions']`

#### Wired into `TinyBaseRoomStoreClient`
- New host-only write methods: `writeEvent`, `writeEventsPrivate`,
  `writeGameStatePublic`, `writeGameStatePrivate`, `createHostValidator`
  — each calls `this.requireHostForWrite(context)`, which reads the
  current `room.hostPlayerId` and delegates to `requireHost`.
- The bootstrap exception (writing the room row when no row exists) is
  isolated in `initializeAsHost()` and runs only on the create path.
- `connect()` now also remembers `connectedRoomId` so policy checks have
  a stable room reference.

### Submission signing + host verification + replay protection

#### New: `platform/shared-types/src/core/submissions.ts`
- **`canonicalSubmissionBytes(fields)`** — deterministic encoding using
  length-prefixed UTF-8 (4-byte BE length + bytes per field), with
  domain prefix `submission_v1`. Field order:
  `fromPlayerId, createdAt, nonce, iv, toHostCiphertext, gameType, kind, hostEncPubKey`.
  Binding the host pubkey means a submission signed for one host
  pubkey is invalid after rotation (rotation safety today; once
  `hostKeyVersion` lands, that gets included too).
- **`signSubmission(identity, fields)`** — `subtle.sign('Ed25519', ...)`,
  asserts `fields.fromPlayerId === identity.playerId`.
- **`verifySubmissionSignature(submission, hostEncPubKey, playerSigningPubKey)`**
  — imports the player's pub via `subtle.importKey('raw', ...)` and runs
  `subtle.verify('Ed25519', ...)`.
- **`HostSubmissionValidator`** class — combines signature check with
  per-player monotonic nonce tracking (`Map<PlayerId, number>`,
  in-memory). Typed reject reasons: `'unknown_player' | 'bad_signature' |
  'replay_or_old_nonce'`. Includes `primeNonce()` for restart/handover
  replay (no caller wired yet — events don't carry source-nonce).

#### New: `platform/shared-types/src/core/encoding.ts`
- `bytesToB64Url` / `b64UrlToBytes` extracted from `identity.ts` to share
  with submissions/encryption code. `b64UrlToBytes` returns
  `Uint8Array<ArrayBuffer>` (not `<ArrayBufferLike>`) so the result
  satisfies WebCrypto's narrowed `BufferSource` parameter under TS 6.

#### Player-side `submit()` on `TinyBaseRoomStoreClient`
- Signature: `submit({ iv, toHostCiphertext, kind, gameType? }) → Promise<SubmissionId>`
- Pulls the next monotonic nonce from a caller-provided
  `getNextSubmissionNonce` (persistent in web; in-memory fallback for
  other environments), reads `room.hostEncPubKey`, signs, writes the row.

#### Persistent nonce provider in `WebLocalStore`
- `makeSubmissionNonceProvider(playerId)` returns a closure that
  increments `localStorage[bfg.submission-nonce.v1.<playerId>]` per call.
- Wired into `SyncContext` so reloads keep the host's replay window
  consistent with the client.

## Plan deviations (explicit)

### Encryption is deferred (not yet a cornerstone)
`submit()` accepts pre-encrypted `iv` + `toHostCiphertext` for now —
the AES-GCM/HKDF over X25519 ECDH layer is the natural next cornerstone.
The signing layer doesn't care what the bytes are: the canonical
encoding length-prefixes them, so swapping in real encryption later
doesn't change any signing/verification code.

### `seq` allocation rule still TBD
The schema enforces `seq ≥ 0` only. The actual monotonic-allocation
rule under TinyBase CRDT remains the host pipeline's job and isn't
written yet. CHECKPOINT 3's recommendation (sortable ULID + host-id
tiebreak) is still the leading proposal.

### Host-restart nonce recovery is a known gap
`HostSubmissionValidator.primeNonce()` is in place but nothing calls it
because `events` rows don't yet carry source-nonce. On host restart
today, the validator starts empty — replays from before the restart
would be accepted once. Acceptable for v1 demos; the fix is to add
`sourceNonce: number | null` to `zEvent` and replay events on host
boot to prime nonces.

### `room.hostKeyVersion` still not added
Canonical bytes bind to `hostEncPubKey` directly; rotation invalidates
all prior signatures, which is the intended behavior until host
handover exists.

### `room.gameVersion` still not added
The per-game-versioning architectural decision (CHECKPOINT 3 memory)
hasn't been wired into `zRoom` yet. It's a small follow-up that
unblocks per-game schema dispatch.

## How to run what exists now

Same as CHECKPOINT 3:
```bash
npm -w @brute-force-games/web run dev
```

What's new in runtime behavior:
- The room store now has both player-side `submit()` and host-only
  write methods; calling a host-only method as a non-host throws
  `HostOnlyWriteError` synchronously after the `requireHost` check.
- Each player has a persistent `localStorage` nonce counter at
  `bfg.submission-nonce.v1.<playerId>` — open the app's storage panel
  to see it advance per `submit()` call.
- Nothing in the UI calls `submit()` yet; the API is in place but
  awaits the encryption cornerstone and per-game submission types
  before actual game moves flow through it.

Typecheck across all workspaces is clean (`npm run typecheck`, exit 0).

## What's next (suggested)

In priority order:

1. **AES-GCM submission encryption** — derive shared secret via
   `subtle.deriveBits({name:'X25519', public: hostEncPub}, playerEncPriv, 256)`,
   HKDF to AES-GCM-256, encrypt move plaintext. Add inverse on host.
   Lives next to `submissions.ts`; the `HostSubmissionValidator` only
   needs to call it after sig+nonce checks pass.
2. **Per-game submission/event `kind` registry** — per-game
   discriminated unions in `platform/shared-types/src/games/<game>/`.
3. **Genesis event** — define `'game_started'` with seed + initial
   roles so replay can reconstruct mid-game state.
4. **Add `sourceNonce` to `zEvent`** — closes the host-restart replay
   window.
5. **Add `room.gameVersion`** — small schema bump per the per-game
   versioning memory.
