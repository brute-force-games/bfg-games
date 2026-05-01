import { z } from 'zod';

import {
  zEventId,
  zEventsPrivateRowId,
  zPlayerId,
  zSubmissionId,
  type EventId,
  type EventsPrivateRowId,
  type PlayerId
} from './ids';
import {
  zEncryptedPayload,
  zSecretMessageIv,
  zSignature
} from './keys';
import { zGameType, zUnixMs } from './schemas';

// Monotonic per-room event sequence counter
export const zEventSeq = z.number().int().min(0).brand<'EventSeq'>();
export type EventSeq = z.infer<typeof zEventSeq>;

// Monotonic per-player submission nonce for replay protection
export const zSubmissionNonce = z.number().int().min(0).brand<'SubmissionNonce'>();
export type SubmissionNonce = z.infer<typeof zSubmissionNonce>;

// ─── submissions: player → host (encrypted) ─────────────────────────────────
// A player's intended move, encrypted to the host's per-room X25519 pubkey.
// `signature` is the player's Ed25519 signature over the canonical bytes
// (`fromPlayerId || nonce || iv || ciphertext || createdAt || gameType || kind`)
// — this is what authenticates the *sender*; AES-GCM only authenticates the
// ciphertext. `nonce` is a player-local monotonic counter used by the host
// to drop replays.
export const zSubmission = z.object({
  id: zSubmissionId,
  fromPlayerId: zPlayerId,
  toHostCiphertext: zEncryptedPayload,
  iv: zSecretMessageIv,
  signature: zSignature,
  nonce: zSubmissionNonce,
  createdAt: zUnixMs,
  gameType: zGameType,
  // Per-game submission discriminator. Per-game packages refine the decrypted
  // plaintext via their own discriminated unions keyed on `kind`.
  kind: z.string().min(1)
});
export type Submission = z.infer<typeof zSubmission>;

// ─── events: host → everyone (canonical history) ────────────────────────────
// Append-only log of host-validated actions. `seq` is monotonic per room and
// drives deterministic replay. `hostSignature` is the host's Ed25519 signature
// over the canonical bytes (`id || seq || createdAt || kind ||
// JSON(publicPayload) || fromPlayerId`) so clients can verify host authority
// without server enforcement (pre-Phase 9).
//
// `publicPayload` is `unknown` here; per-game packages validate it against
// their own per-`kind` schemas.
export const zEvent = z.object({
  id: zEventId,
  seq: zEventSeq,
  createdAt: zUnixMs,
  kind: z.string().min(1),
  publicPayload: z.unknown(),
  fromPlayerId: zPlayerId.nullable(),
  hostSignature: zSignature
});
export type Event = z.infer<typeof zEvent>;

// ─── eventsPrivate: host → individual player (encrypted per event) ──────────
// Per-event per-player encrypted payload that lets a recipient reconstruct
// the private slice of history later (e.g. cards dealt, secret roles).
// Row-id format: `epvt_<evtId>|<playerId>` — see `makeEventsPrivateRowId`.
//
// Known v1 leak (Opus review): the row-id structure exposes which players
// received private payloads for which events. Acceptable for now; a future
// version can opaque-hash these IDs.
export const zEventsPrivate = z.object({
  id: zEventsPrivateRowId,
  evtId: zEventId,
  playerId: zPlayerId,
  ciphertextToPlayer: zEncryptedPayload,
  iv: zSecretMessageIv
});
export type EventsPrivate = z.infer<typeof zEventsPrivate>;

export function makeEventsPrivateRowId(
  evtId: EventId,
  playerId: PlayerId
): EventsPrivateRowId {
  return zEventsPrivateRowId.parse(`epvt_${evtId}|${playerId}`);
}

// ─── gameStatePublic: singleton snapshot ────────────────────────────────────
// Lets fresh clients render without replaying every event. `seq` is the last
// applied event's seq; clients reconcile by replaying only events with
// seq > snapshot.seq. Host-signed.
export const SINGLETON_PUBLIC_STATE_ID = 'state_public' as const;
export type SingletonPublicStateId = typeof SINGLETON_PUBLIC_STATE_ID;

export const zGameStatePublic = z.object({
  id: z.literal(SINGLETON_PUBLIC_STATE_ID),
  seq: zEventSeq,
  state: z.unknown(),
  hostSignature: zSignature
});
export type GameStatePublic = z.infer<typeof zGameStatePublic>;

// ─── gameStateHistory: per-snapshot public archive ──────────────────────────
// One row per persisted public snapshot, keyed by the seq it corresponds to.
// Unlike `events`, this table does not necessarily contain an entry for every
// raw event row; it contains an entry for each committed public snapshot.
export const zGameStateHistoryRow = z.object({
  // Row id is the seq encoded as a string (TinyBase row ids are strings).
  id: z.string().min(1),
  seq: zEventSeq,
  state: z.unknown(),
  // Host Ed25519 signature over (domain || id || seq || JSON(state)).
  // Optional so rows written before this field was added still parse cleanly;
  // the verifier treats absent/empty as unverified.
  hostSignature: zSignature.optional()
});
export type GameStateHistoryRow = z.infer<typeof zGameStateHistoryRow>;

// ─── gameStatePrivate: per-player snapshot (plain or encrypted) ─────────────
// One row per player (id == playerId). Discriminated on `kind`:
//   - 'plain':     `state` is plaintext (used by games whose private info is
//                  only sensitive to other peers, not to the host)
//   - 'encrypted': `ciphertext`+`iv` (host-encrypted to the player)
//
// We pick exactly one variant per game/session; the storage row carries
// columns for both variants but only the variant matching `kind` is read.
export const zGameStatePrivatePlain = z.object({
  id: zPlayerId,
  kind: z.literal('plain'),
  seq: zEventSeq,
  state: z.unknown()
});
export type GameStatePrivatePlain = z.infer<typeof zGameStatePrivatePlain>;

export const zGameStatePrivateEncrypted = z.object({
  id: zPlayerId,
  kind: z.literal('encrypted'),
  seq: zEventSeq,
  ciphertext: zEncryptedPayload,
  iv: zSecretMessageIv
});
export type GameStatePrivateEncrypted = z.infer<typeof zGameStatePrivateEncrypted>;

export const zGameStatePrivate = z.discriminatedUnion('kind', [
  zGameStatePrivatePlain,
  zGameStatePrivateEncrypted
]);
export type GameStatePrivate = z.infer<typeof zGameStatePrivate>;

// ─── Framework finalization event ────────────────────────────────────────────
// Emitted by the host immediately after the last game event when the room
// transitions to `finished`. Its presence + valid signature is the canonical
// end-of-record marker for the event log.
export const GAME_FINALIZED_KIND = 'game/finalized' as const;

export const zGameFinalizedPayload = z.object({
  kind: z.literal(GAME_FINALIZED_KIND),
  outcome: z.enum(['win', 'draw', 'abandoned']),
  winnerPlayerIds: z.array(zPlayerId)
});
export type GameFinalizedPayload = z.infer<typeof zGameFinalizedPayload>;
