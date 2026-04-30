import { z } from 'zod';
import { zPlayerId } from '../../core/ids';
import { zGameType } from '../../core/schemas';
import { zCellIndex, zMark, zTicTacToeBoard } from './schemas';

// Web → Godot
export const EVT_TTT_STATE_INIT = 'ttt_state_init' as const;
export const EVT_TTT_MOVE_MADE = 'ttt_move_made' as const;
export const EVT_TTT_GAME_OVER = 'ttt_game_over' as const;

// Godot → Web
export const EVT_TTT_PLAYER_MOVE = 'ttt_player_move' as const;

// ─── Bridge v1 (enveloped) ──────────────────────────────────────────────────
//
// These names are game-agnostic; the per-game meaning lives in `payload`.
// They travel inside the shared bridge envelope:
//   { bfg: true, v: 1, game: 'tictactoe', type: EVT_BRIDGE_*, payload: '...' }
export const BRIDGE_GAME_TICTACTOE = zGameType.parse('tictactoe');
export const EVT_BRIDGE_GODOT_READY = 'godot_ready' as const;
export const EVT_BRIDGE_STATE_INIT = 'state_init' as const;
export const EVT_BRIDGE_STATE_PUBLIC = 'state_public' as const;
export const EVT_BRIDGE_INTENT = 'intent' as const;

export const zTttBridgeGodotReadyPayload = z.object({
  exportVersion: z.string().optional(),
  capabilities: z.array(z.string()).optional()
});
export type TttBridgeGodotReadyPayload = z.infer<typeof zTttBridgeGodotReadyPayload>;

export const zTttBridgeStateInitPayload = z.object({
  localPlayerId: zPlayerId,
  view: z.enum(['player', 'observer']),
  publicState: z.object({
    board: zTicTacToeBoard,
    currentPlayerId: zPlayerId.nullable(),
    playerX: zPlayerId,
    playerO: zPlayerId,
    winnerId: zPlayerId.nullable(),
    isDraw: z.boolean(),
    moveCount: z.number().int().min(0)
  }),
  symbolByMark: z.object({ X: z.string(), O: z.string() }).optional(),
  symbolPair: z.enum(['xo', 'red_blue', 'lion_lamb']).optional()
});
export type TttBridgeStateInitPayload = z.infer<typeof zTttBridgeStateInitPayload>;

export const zTttBridgeStatePublicPayload = z.object({
  publicState: zTttBridgeStateInitPayload.shape.publicState
});
export type TttBridgeStatePublicPayload = z.infer<typeof zTttBridgeStatePublicPayload>;

export const zTttBridgeIntentPayload = z.object({
  kind: z.literal('tictactoe/move'),
  cellIndex: zCellIndex
});
export type TttBridgeIntentPayload = z.infer<typeof zTttBridgeIntentPayload>;

export const zTttStateInitPayload = z.object({
  board: zTicTacToeBoard,
  currentPlayerId: zPlayerId.nullable(),
  playerX: zPlayerId,
  playerO: zPlayerId,
  localPlayerId: zPlayerId,
  // Optional UI sugar: lets web decide how marks should be rendered.
  symbolByMark: z
    .object({ X: z.string(), O: z.string() })
    .optional()
});
export type TttStateInitPayload = z.infer<typeof zTttStateInitPayload>;

export const zTttMoveMadePayload = z.object({
  cellIndex: zCellIndex,
  mark: zMark,
  playerId: zPlayerId
});
export type TttMoveMadePayload = z.infer<typeof zTttMoveMadePayload>;

export const zTttGameOverPayload = z.object({
  winnerId: zPlayerId.nullable(),
  isDraw: z.boolean()
});
export type TttGameOverPayload = z.infer<typeof zTttGameOverPayload>;

export const zTttPlayerMovePayload = z.object({
  cellIndex: zCellIndex
});
export type TttPlayerMovePayload = z.infer<typeof zTttPlayerMovePayload>;

