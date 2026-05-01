import { z } from 'zod';

import { zPlayerId, zRoomId } from './ids';
import { zGameHostKeypair } from './identity';
import { zGameType, zRoomSeed, zUnixMs } from './schemas';

// ─── LocalRoomRole — the per-room "what role am I in this room?" record ────
//
// LocalRoomRole records are local-only and never synced. Their presence is
// the authoritative signal for "am I host of this room?"; the multiplayer
// adapter never derives host status from the synced `room.hostPlayerId`,
// which is racy across CRDT merges.
//
// The shape is a discriminated union, designed to grow:
//   - `host`: I created this room. Carries the host keypair (for decryption
//     and host-only signing) and bootstrap defaults consumed the first time
//     the room row is written.
//   - (future) `player` / `observer`: explicit local note that I'm in a room
//     that I didn't create. For v1 we don't need a record for these — joining
//     is implicit in navigating to the URL.
//
// The record is the *only* thing the adapter needs from the local layer to
// behave correctly as host on connect. See `RoomRoleTracker` in
// `@brute-force-games/multiplayer-types` for the abstract storage interface.

export const zHostRoomBootstrap = z.object({
  gameType: zGameType,
  gameConfig: z.unknown().optional(),
  maxPlayers: z.number().int().min(1).max(8).optional(),
  /**
   * Optional deterministic seed for the room. If provided, the host will write
   * this into `room.seed` when bootstrapping so any game randomness can be
   * derived reproducibly.
   */
  seed: zRoomSeed.optional()
});
export type HostRoomBootstrap = z.infer<typeof zHostRoomBootstrap>;

export const zLocalRoomRoleHost = z.object({
  kind: z.literal('host'),
  version: z.literal(1),
  roomId: zRoomId,
  hostPlayerId: zPlayerId,
  hostKeypair: zGameHostKeypair,
  bootstrap: zHostRoomBootstrap.nullable(),
  createdAt: zUnixMs
});
export type LocalRoomRoleHost = z.infer<typeof zLocalRoomRoleHost>;

export const zLocalRoomRole = z.discriminatedUnion('kind', [zLocalRoomRoleHost]);
export type LocalRoomRole = z.infer<typeof zLocalRoomRole>;
