import { z } from 'zod';
import { zPlayerId } from '../../core/ids';

export const zTicTacToeSymbolPair = z.enum(['xo', 'lion_lamb', 'red_blue']);
export type TicTacToeSymbolPair = z.infer<typeof zTicTacToeSymbolPair>;

export const zTicTacToeUiImplementation = z.enum(['godot', 'react']);
export type TicTacToeUiImplementation = z.infer<typeof zTicTacToeUiImplementation>;

export const zTicTacToeConfig = z.object({
  symbolPair: zTicTacToeSymbolPair,
  ui: zTicTacToeUiImplementation
});
export type TicTacToeConfig = z.infer<typeof zTicTacToeConfig>;

export const zCellIndex = z.number().int().min(0).max(8);
export type CellIndex = z.infer<typeof zCellIndex>;

export const zMark = z.enum(['X', 'O']);
export type Mark = z.infer<typeof zMark>;

export const zCellValue = zMark.nullable();
export type CellValue = z.infer<typeof zCellValue>;

export const zTicTacToeBoard = z.tuple([
  zCellValue,
  zCellValue,
  zCellValue,
  zCellValue,
  zCellValue,
  zCellValue,
  zCellValue,
  zCellValue,
  zCellValue
]);
export type TicTacToeBoard = z.infer<typeof zTicTacToeBoard>;

export const zTicTacToeState = z.object({
  board: zTicTacToeBoard,
  currentPlayerId: zPlayerId.nullable(),
  playerX: zPlayerId,
  playerO: zPlayerId,
  winnerId: zPlayerId.nullable(),
  isDraw: z.boolean(),
  moveCount: z.number().int().min(0)
});
export type TicTacToeState = z.infer<typeof zTicTacToeState>;

export const zTicTacToeMove = z.object({
  playerId: zPlayerId,
  cellIndex: zCellIndex
});
export type TicTacToeMove = z.infer<typeof zTicTacToeMove>;

export const WIN_LINES = [
  [0, 1, 2],
  [3, 4, 5],
  [6, 7, 8],
  [0, 3, 6],
  [1, 4, 7],
  [2, 5, 8],
  [0, 4, 8],
  [2, 4, 6]
] as const;

