# Immutable Game Records — Plan

Games transition through `waiting → starting → active → finished`. This document covers what "finished" should mean structurally: the room becomes a sealed, verifiable record; the host can export it as a portable bundle; and any player (or observer) can replay and review the game later.

---

## What we already have

The groundwork is already in place:

- **Host Ed25519 signatures** on every event (`events.hostSignature`) with `canonicalEventBytes` for deterministic serialization.
- **Full event log** — the `events` table is an append-only sequence of signed events. This is the canonical record; state at any point is derived from it.
- **Partial write gating** — `updateRoomAsHost` in `tinybase-room-store.ts` already rejects changes to `seed`, `gameType`, and `gameConfig` once status is `active` or `finished`.
- **Room status enum** — `waiting | starting | active | finished`. `finished` is the natural sealing point.

The gaps are: broader write enforcement when `finished`, a finalization event, an export format, and a review UI.

### On state snapshots

`gameStateHistory` and `gameStatePublic` exist as live conveniences — they let clients render current state without replaying the full event log. They are **not** the record; the event log is. For export and review purposes we rely on events only. This also means we don't need to sign `gameStateHistory` rows or worry about snapshot density — the event log is complete by definition.

---

## 1. Sealing the room on finish

### 1a. Finalization event

When the host writes the last game event (win, draw, forfeit, etc.), it immediately appends a `game/finalized` event:

```ts
{
  kind: 'game/finalized',
  publicPayload: {
    finishedAt: number,       // unix ms
    outcome: 'win' | 'draw' | 'abandoned',
    winnerPlayerId?: PlayerId
  },
  hostSignature: string       // Ed25519 over canonical bytes, same as all events
}
```

This event is the canonical end-of-record marker. Its presence + valid signature means the host intentionally closed the game. Its `seq` is the last seq in the record.

### 1b. Status transition to `finished`

The host writes `room.status = 'finished'` atomically alongside the `game/finalized` event (same `applyHostActions` call). After this, the DO enforces:

- **All game-table writes rejected** (events, submissions, gameStatePublic, gameStatePrivate, game-specific tables like `tictactoe`).
- **Room-table writes rejected** except `players.isConnected` / `players.lastSeen` (presence is still fine).
- **chatEvents** still allowed — post-game chat is useful.

This is straightforward to add in the DO's `webSocketMessage` handler: check `room.status === 'finished'` before accepting a merge op for a gated table.


---

## 2. Export format

The export is a single self-contained JSON file. It contains everything needed to verify and replay the game offline — no server required after export.

```ts
// gameType is on the export, not on individual events — events live in a single-game room context.
interface GameEvent {
  id: EventId;
  seq: number;
  createdAt: number;          // unix ms
  kind: string;
  publicPayload: unknown;
  fromPlayerId: PlayerId | null;
  hostSignature: string;      // Ed25519 over canonical bytes, verifiable against hostSigningPubKey
}

interface GameExportV1 {
  exportVersion: 1;
  exportedAt: number;         // unix ms

  platform: {
    version: string;          // app version (from package.json or a build-time constant)
    gameType: GameType;
    gameVersion: string;      // per-game version string — bumped when rules/event schema change
  };

  room: {
    roomId: RoomId;
    gameConfig: unknown;
    seed: string;
    startedAt: number;
    finishedAt: number;
    outcome: 'win' | 'draw' | 'abandoned';
    winnerPlayerId?: PlayerId;
  };

  players: Array<{
    playerId: PlayerId;
    displayName: string;
    avatarColor: string;
    role: 'host' | 'player' | 'observer';
    signingPubKey: string;    // base64url Ed25519 pub — for verifying player-sourced data
    encPubKey: string;        // for verifying encrypted submission assignment
  }>;

  hostSigningPubKey: string;  // base64url Ed25519 pub
  events: GameEvent[];        // ordered by seq ascending

  // exportSignature covers the canonical bytes of (platform + room + players + events)
  // signed by the host — proves the bundle was assembled by the host, not tampered post-export.
  exportSignature: string;
}
```

### Platform and game version fields

`platform.version` is the app version at export time — useful for debugging and understanding what code produced the record. `platform.gameVersion` is a per-game version string (e.g. `"tictactoe@1"`) that should be bumped whenever the event schema or game rules change in a breaking way. A review tool can use this to decide whether it knows how to render a given export, and warn the user if the game version is newer than what it understands.

### Export signature

The export signature covers a canonical serialization of the entire bundle (minus `exportSignature` itself). Simple approach: `JSON.stringify` with sorted keys over `{ platform, room, players, events }`, UTF-8 encoded, signed with Ed25519.

This lets anyone verify:
1. Each event has a valid host signature.
2. The bundle as a whole was assembled by the same host key (export signature).

Private data (encrypted submissions, `eventsPrivate`) is intentionally excluded from the export — it contains player secrets. The export is a public record of what happened, not a dump of all store data.

### Export as a file download

The host clicks "Export game record" in the finished-room UI. The browser calls `exportGameRecord()` on the `RoomStore`, which:

1. Reads `events`, `stateHistory`, `room`, `players` from the local TinyBase store.
2. Signs the bundle with the host's Ed25519 signing key (already in memory as `LoadedPlayerIdentity`).
3. Returns `GameExportV1` JSON.
4. The UI triggers a `<a download="game-<roomId>.json">` download.

No server involvement — the export happens entirely in the browser.

---

## 3. Review UI

### Route

`/review` — a standalone route that accepts a game export bundle and lets you step through it.

Loading options:
- **File drop / file picker**: drag a `.json` export onto the page or click to pick a file.
- **URL param**: `/review?bundle=<url>` loads a bundle from a URL (e.g. if a player hosts their export somewhere). Only allow this for same-origin or explicitly trusted URLs — don't blindly fetch arbitrary URLs.

### Verification step

Before rendering anything, run a verification pass:
1. Check `exportVersion === 1`.
2. Verify `exportSignature` over the bundle using `hostSigningPubKey`.
3. Verify each event's `hostSignature`.
4. Verify each history snapshot's `hostSignature`.
5. Check that event `seq` values are contiguous and the last event is `game/finalized`.

Show a clear badge: ✓ Verified / ✗ Signature invalid. Don't block rendering on failure, but make it prominent. An invalid signature could mean tampering or a truncated export.

### Replay UI

Two complementary views:

**Event log view** (always available, no Godot required):
- Scrollable list of events in seq order.
- Each event shows: seq, timestamp, kind, `fromPlayerId` display name, and a formatted `publicPayload`.
- Useful for any game type, even without a Godot renderer.

**Board replay view** (Godot-powered, game-type specific):
- Renders the Godot iframe in "review mode" — no live input, no bridge submissions.
- A scrubber/slider maps to `stateHistory` seq values.
- Selecting a seq feeds `stateHistory[seq].state` to Godot via the existing bridge (`ttt_state_init` or equivalent) as a one-shot state push.
- Prev/Next buttons step through snapshots. Auto-play mode steps forward every N seconds.

The Godot game needs no changes for step-through replay — it already accepts state pushes. The web layer just controls which snapshot it sends and disables move input.

### Sharing a review

If a player wants to share a game for others to view, they:
1. Export the `.json` from the finished room.
2. Host it anywhere (GitHub Gist, their own server, etc.).
3. Share `/review?bundle=<url>`.

No server required on our side for storage or serving reviews. We could optionally add a "share to BFG" upload endpoint later, but the local-first approach works fine initially and preserves player control over their game records.

---

## 4. Open questions

**Q: Should the DO refuse to serve the room store after `finished`?**
The DO could mark itself as sealed and return the export bundle directly instead of a live sync connection. Simpler for late joiners (they'd get a redirect to `/review?bundle=...`) but more complex to implement. Probably not worth it in Phase 2 — just enforce no writes and let the existing sync work.

**Q: Should exports be stored server-side?**
A server-side export registry (`/exports/<roomId>`) would allow permanent shareable links without players self-hosting the bundle. This is a Phase 3+ concern — the host-download approach works for now and keeps the server stateless.

**Q: What about encrypted private data in the export?**
A player could optionally export a richer bundle that includes their own private data (their decrypted game state, their plaintext submissions) for personal records. This is a separate "personal export" feature — not the public game record export described here.

**Q: Godot review mode — what if state history is sparse?**
`gameStateHistory` only has snapshots at the points the host chose to write them. If snapshots are coarse (e.g. only on game end), the scrubber has nothing to show mid-game. The fix is to write a history snapshot after every event, not just on game-over. This is cheap in TinyBase and should be the default.

---

## Implementation order

1. **Write `gameStateHistory` signatures** — low effort, closes the verification gap on existing history rows. Add `hostSignature` to the schema and to `writeGameStatePublic`.
2. **Finalization event + DO write gating** — add `game/finalized` event kind; enforce read-only on `finished` rooms in the DO.
3. **`exportGameRecord()` on `RoomStore`** — assembles and signs the `GameExportV1` bundle; wire to a download button in the finished-room UI.
4. **Verification utility** — `verifyGameExport(bundle: GameExportV1): Promise<VerificationResult>` in `shared-types`. Used by review UI and testable in isolation.
5. **`/review` route** — event log view first (no Godot dependency), then add board replay with scrubber.
6. **Snapshot density** — ensure the host writes a history snapshot after every event, not just on game-over.
