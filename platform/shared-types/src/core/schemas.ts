import { z } from 'zod';
import {
  zEncryptedPayload,
  zGameEncPubKeyBytes,
  zPlayerEncPubKeyBytes,
  zSecretMessageIv,
  zSigningPubKeyBytes
} from './keys';
import { zGameId, zPlayerId, zRoomId, zSecretPoolItemId } from './ids';

export const zRoomStatus = z.enum(['waiting', 'starting', 'active', 'finished']);
export type RoomStatus = z.infer<typeof zRoomStatus>;

export const zDropBehavior = z.enum(['pause', 'skip', 'autoplay']).default('pause');
export type DropBehavior = z.infer<typeof zDropBehavior>;

export const zGameType = z.string().min(1).brand<'GameType'>();
export type GameType = z.infer<typeof zGameType>;

// Core Room schema (game-specific config is validated at call sites via GameDefinition)
export const zRoom = z.object({
  id: zRoomId,
  inviteCode: z.string(),
  hostPlayerId: zPlayerId,
  hostEncPubKey: zGameEncPubKeyBytes, // unused in Phase 1 but reserved
  status: zRoomStatus,
  maxPlayers: z.number().int().min(1).max(8),
  seed: z.string(),
  gameType: zGameType,
  gameConfig: z.unknown(),

  // Autoplay / connectivity policy
  dropBehavior: zDropBehavior,
  disconnectGraceMs: z.number().int().min(0).default(15_000),
  turnTimeoutMs: z.number().int().min(0).default(0)
});
export type Room = z.infer<typeof zRoom>;

export const zPlayerRole = z.enum(['host', 'player', 'observer']);
export type PlayerRole = z.infer<typeof zPlayerRole>;

export const zAutoplayMode = z.enum(['off', 'assist', 'do']).default('off');
export type AutoplayMode = z.infer<typeof zAutoplayMode>;

export const zPlayer = z.object({
  id: zPlayerId,
  displayName: z.string(),
  avatarColor: z.string(),
  role: zPlayerRole,
  score: z.number(),
  isConnected: z.boolean(),
  isReady: z.boolean(),
  joinedAt: z.number(),
  lastSeen: z.number().int().min(0),
  signingPubKey: zSigningPubKeyBytes,
  encPubKey: zPlayerEncPubKeyBytes,

  autoplayMode: zAutoplayMode,
  autoplaySince: z.number().nullable().default(null)
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

