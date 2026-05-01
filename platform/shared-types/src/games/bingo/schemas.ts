import { z } from 'zod';

import { zPlayerId } from '../../core/ids';

// Board is 25 cells, row-major. 0 = FREE space (always at index 12).
// Traditional columns: B(1-15), I(16-30), N(31-45), G(46-60), O(61-75)
// Column cell indices: B=[0,5,10,15,20] I=[1,6,11,16,21] N=[2,7,12,17,22] G=[3,8,13,18,23] O=[4,9,14,19,24]

export const BINGO_WIN_LINES: readonly (readonly number[])[] = [
  // Rows
  [0, 1, 2, 3, 4],
  [5, 6, 7, 8, 9],
  [10, 11, 12, 13, 14],
  [15, 16, 17, 18, 19],
  [20, 21, 22, 23, 24],
  // Columns B I N G O
  [0, 5, 10, 15, 20],
  [1, 6, 11, 16, 21],
  [2, 7, 12, 17, 22],
  [3, 8, 13, 18, 23],
  [4, 9, 14, 19, 24],
  // Diagonals
  [0, 6, 12, 18, 24],
  [4, 8, 12, 16, 20]
];

export const zBingoConfig = z.object({
  maxPlayers: z.number().int().min(2).max(8)
});
export type BingoConfig = z.infer<typeof zBingoConfig>;

export const zBingoPublicPlayer = z.object({
  playerId: zPlayerId,
  board: z.array(z.number().int().min(0).max(75)).length(25),
  markedCount: z.number().int().min(0).max(25),
  hasBingo: z.boolean()
});
export type BingoPublicPlayer = z.infer<typeof zBingoPublicPlayer>;

export const zBingoPublicState = z.object({
  phase: z.enum(['active', 'finished']),
  calledNumbers: z.array(z.number().int().min(1).max(75)),
  lastCalledNumber: z.number().int().min(1).max(75).nullable(),
  turnPlayerId: zPlayerId.nullable(),
  players: z.array(zBingoPublicPlayer),
  winnerPlayerIds: z.array(zPlayerId)
});
export type BingoPublicState = z.infer<typeof zBingoPublicState>;

export const zBingoHostPrivateState = z.object({
  uncalledNumbers: z.array(z.number().int().min(1).max(75))
});
export type BingoHostPrivateState = z.infer<typeof zBingoHostPrivateState>;

// ─── Submissions ─────────────────────────────────────────────────────────────

export const BINGO_SUBMIT_CALL = 'bingo/call' as const;
export const BINGO_SUBMIT_CALL_SPECIFIC = 'bingo/call_specific' as const;

export const zBingoCallSubmission = z.object({ kind: z.literal(BINGO_SUBMIT_CALL) });
export type BingoCallSubmission = z.infer<typeof zBingoCallSubmission>;

export const zBingoCallSpecificSubmission = z.object({
  kind: z.literal(BINGO_SUBMIT_CALL_SPECIFIC),
  number: z.number().int().min(1).max(75)
});
export type BingoCallSpecificSubmission = z.infer<typeof zBingoCallSpecificSubmission>;

export const zBingoSubmission = z.discriminatedUnion('kind', [
  zBingoCallSubmission,
  zBingoCallSpecificSubmission
]);
export type BingoSubmission = z.infer<typeof zBingoSubmission>;

// ─── Events ──────────────────────────────────────────────────────────────────

export const BINGO_EVT_STARTED = 'bingo/started' as const;
export const BINGO_EVT_CALLED = 'bingo/called' as const;
export const BINGO_EVT_GAME_OVER = 'bingo/game_over' as const;

export const zBingoStartedPublic = z.object({
  kind: z.literal(BINGO_EVT_STARTED),
  playerCount: z.number().int().min(2),
  firstTurnPlayerId: zPlayerId
});

export const zBingoCalledPublic = z.object({
  kind: z.literal(BINGO_EVT_CALLED),
  calledBy: zPlayerId,
  number: z.number().int().min(1).max(75),
  totalCalled: z.number().int().min(1),
  newBingoPlayerIds: z.array(zPlayerId)
});

export const zBingoGameOverPublic = z.object({
  kind: z.literal(BINGO_EVT_GAME_OVER),
  winnerPlayerIds: z.array(zPlayerId)
});

export const zBingoEventPublicPayload = z.discriminatedUnion('kind', [
  zBingoStartedPublic,
  zBingoCalledPublic,
  zBingoGameOverPublic
]);
export type BingoEventPublicPayload = z.infer<typeof zBingoEventPublicPayload>;
