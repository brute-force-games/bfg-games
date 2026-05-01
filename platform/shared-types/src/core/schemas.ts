import { z } from 'zod';
import {
  zEncryptedPayload,
  zGameEncPubKeyBytes,
  zPlayerEncPubKeyBytes,
  zSecretMessageIv,
  zSigningPubKeyBytes
} from './keys';
import { zGameId, zInviteCode, zPlayerId, zRoomId, zSecretPoolItemId } from './ids';

export const zRoomStatus = z.enum(['waiting', 'starting', 'active', 'finished']);
export type RoomStatus = z.infer<typeof zRoomStatus>;

export const zDropBehavior = z.enum(['pause', 'skip', 'autoplay']);
export type DropBehavior = z.infer<typeof zDropBehavior>;

export const zGameType = z.string().min(1).brand<'GameType'>();
export type GameType = z.infer<typeof zGameType>;

// Unix epoch milliseconds — for timestamps (createdAt, joinedAt, lastSeen, etc.)
export const zUnixMs = z.number().int().min(0).brand<'UnixMs'>();
export type UnixMs = z.infer<typeof zUnixMs>;

// Millisecond duration — for timeouts and grace periods
export const zDurationMs = z.number().int().min(0).brand<'DurationMs'>();
export type DurationMs = z.infer<typeof zDurationMs>;

// CSS hex color, exactly #rrggbb
export const zAvatarColor = z.string().regex(/^#[0-9a-fA-F]{6}$/).brand<'AvatarColor'>();
export type AvatarColor = z.infer<typeof zAvatarColor>;

// Human-readable display name — freeform but bounded
export const zDisplayName = z.string().min(1).max(40);
export type DisplayName = z.infer<typeof zDisplayName>;

// Opaque seed string used for deterministic RNG derivation
export const zRoomSeed = z.string().min(1).brand<'RoomSeed'>();
export type RoomSeed = z.infer<typeof zRoomSeed>;

export function generateRoomSeed(): RoomSeed {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('') as RoomSeed;
}

// Core Room schema (game-specific config is validated at call sites via GameDefinition)
export const zRoom = z.object({
  id: zRoomId,
  inviteCode: zInviteCode,
  hostPlayerId: zPlayerId,
  hostEncPubKey: zGameEncPubKeyBytes, // unused in Phase 1 but reserved
  status: zRoomStatus,
  maxPlayers: z.number().int().min(1).max(8),
  seed: zRoomSeed,
  gameType: zGameType,
  gameConfig: z.unknown(),

  // Autoplay / connectivity policy
  dropBehavior: zDropBehavior,
  disconnectGraceMs: zDurationMs,
  turnTimeoutMs: zDurationMs
});
export type Room = z.infer<typeof zRoom>;

export const zPlayerRole = z.enum(['host', 'player', 'observer']);
export type PlayerRole = z.infer<typeof zPlayerRole>;

export const zAutoplayMode = z.enum(['off', 'assist', 'do']);
export type AutoplayMode = z.infer<typeof zAutoplayMode>;

export const zPlayer = z.object({
  id: zPlayerId,
  displayName: zDisplayName,
  avatarColor: zAvatarColor,
  role: zPlayerRole,
  score: z.number().int(),
  isConnected: z.boolean(),
  isReady: z.boolean(),
  joinedAt: zUnixMs,
  lastSeen: zUnixMs,
  signingPubKey: zSigningPubKeyBytes,
  encPubKey: zPlayerEncPubKeyBytes,

  autoplayMode: zAutoplayMode,
  autoplaySince: zUnixMs.nullable()
});
export type Player = z.infer<typeof zPlayer>;

export const zSecretPoolItem = z.object({
  id: zSecretPoolItemId,
  ciphertext: zEncryptedPayload,
  iv: zSecretMessageIv,
  assignedTo: zPlayerId
});
export type SecretPoolItem = z.infer<typeof zSecretPoolItem>;

export const zGameConfigJson = z.unknown();
export type GameConfigJson = z.infer<typeof zGameConfigJson>;

export const zConnectOptions = z.object({
  roomId: zRoomId,
  wsUrl: z.string().url()
});
export type ConnectOptions = z.infer<typeof zConnectOptions>;

