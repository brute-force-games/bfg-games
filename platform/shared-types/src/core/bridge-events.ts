import { z } from 'zod';
import { zPlayerId, zRoomId } from './ids';
import { zGameType } from './schemas';

export const EVT_LOBBY_INIT = 'lobby_init' as const;
export const EVT_PLAYER_JOINED = 'player_joined' as const;
export const EVT_PLAYER_LEFT = 'player_left' as const;
export const EVT_PLAYER_READY = 'player_ready' as const;
export const EVT_PLAYER_CONNECTIVITY_CHANGED = 'player_connectivity_changed' as const;
export const EVT_GAME_CHANGED = 'game_changed' as const;
export const EVT_GAME_CONFIG_UPDATED = 'game_config_updated' as const;
export const EVT_LOBBY_STARTING = 'lobby_starting' as const;
export const EVT_GAME_ACTIVE = 'game_active' as const;

export const EVT_GODOT_READY = 'godot_ready' as const;

export const zLobbyInitPayload = z.object({
  roomId: zRoomId,
  hostPlayerId: zPlayerId,
  maxPlayers: z.number().int().min(1).max(8),
  observerMode: z.boolean(),
  gameType: zGameType,
  gameConfig: z.unknown()
});
export type LobbyInitPayload = z.infer<typeof zLobbyInitPayload>;

export const zPlayerJoinedPayload = z.object({
  playerId: zPlayerId,
  displayName: z.string(),
  avatarColor: z.string(),
  role: z.enum(['host', 'player', 'observer'])
});
export type PlayerJoinedPayload = z.infer<typeof zPlayerJoinedPayload>;

export const zPlayerLeftPayload = z.object({ playerId: zPlayerId });
export type PlayerLeftPayload = z.infer<typeof zPlayerLeftPayload>;

export const zPlayerReadyPayload = z.object({ playerId: zPlayerId });
export type PlayerReadyPayload = z.infer<typeof zPlayerReadyPayload>;

export const zPlayerConnectivityChangedPayload = z.object({
  playerId: zPlayerId,
  isConnected: z.boolean(),
  autoplayMode: z.enum(['off', 'assist', 'do']),
  autoplaySince: z.number().nullable()
});
export type PlayerConnectivityChangedPayload = z.infer<typeof zPlayerConnectivityChangedPayload>;

export const zGameChangedPayload = z.object({
  gameType: zGameType,
  gameConfig: z.unknown()
});
export type GameChangedPayload = z.infer<typeof zGameChangedPayload>;

export const zGameConfigUpdatedPayload = z.object({
  gameConfig: z.unknown()
});
export type GameConfigUpdatedPayload = z.infer<typeof zGameConfigUpdatedPayload>;

export const zLobbyStartingPayload = z.object({});
export type LobbyStartingPayload = z.infer<typeof zLobbyStartingPayload>;

export const zGameActivePayload = z.object({
  gameType: zGameType,
  gameConfig: z.unknown()
});
export type GameActivePayload = z.infer<typeof zGameActivePayload>;

export const zGodotReadyPayload = z.object({});
export type GodotReadyPayload = z.infer<typeof zGodotReadyPayload>;

