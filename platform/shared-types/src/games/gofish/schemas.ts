import { z } from 'zod';

import { zPlayerId } from '../../core/ids';

// ─────────────────────────────────────────────────────────────────────────────
// Go Fish (v1) — classic books-of-4, 2–4 players
// Public state is counts + turn; private state is each player's hand.
// Submissions are encrypted to host; host emits signed canonical events.
// ─────────────────────────────────────────────────────────────────────────────

export const zGoFishRank = z.enum(['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K']);
export type GoFishRank = z.infer<typeof zGoFishRank>;

export const GOFISH_RANKS = zGoFishRank.options as ReadonlyArray<GoFishRank>;

export const zGoFishConfig = z.object({
  minPlayers: z.number().int().min(2).max(4).default(2),
  maxPlayers: z.number().int().min(2).max(4).default(4),
  // Go Fish classic uses 7 cards for 2 players, 5 for 3–4.
  // We still keep it configurable for later experiments.
  startingHandSize2p: z.number().int().min(1).max(13).default(7),
  startingHandSize3pPlus: z.number().int().min(1).max(13).default(5),
  mustHaveRankToAsk: z.literal(true).default(true)
});
export type GoFishConfig = z.infer<typeof zGoFishConfig>;

export const zGoFishPhase = z.enum(['lobby', 'dealing', 'active', 'finished']);
export type GoFishPhase = z.infer<typeof zGoFishPhase>;

export const zGoFishPublicPlayer = z.object({
  playerId: zPlayerId,
  handCount: z.number().int().min(0),
  bookCount: z.number().int().min(0)
});
export type GoFishPublicPlayer = z.infer<typeof zGoFishPublicPlayer>;

export const zGoFishPublicState = z.object({
  phase: zGoFishPhase,
  turnPlayerId: zPlayerId.nullable(),
  deckCount: z.number().int().min(0),
  players: z.array(zGoFishPublicPlayer),
  winnerPlayerIds: z.array(zPlayerId).default([])
});
export type GoFishPublicState = z.infer<typeof zGoFishPublicState>;

export const zGoFishPrivateState = z.object({
  hand: z.array(zGoFishRank),
  /**
   * Host-only plaintext reference, encrypted to the host player's key.
   * Enables rule validation without publishing other players' hands.
   */
  host: z
    .object({
      deck: z.array(zGoFishRank),
      handsByPlayerId: z.record(zPlayerId, z.array(zGoFishRank))
    })
    .optional()
});
export type GoFishPrivateState = z.infer<typeof zGoFishPrivateState>;

// ─── Player → host submission payloads (plaintext; encrypted in store) ───────

export const GOFISH_SUBMIT_ASK = 'gofish/ask' as const;

export const zGoFishAskSubmission = z.object({
  kind: z.literal(GOFISH_SUBMIT_ASK),
  targetPlayerId: zPlayerId,
  rank: zGoFishRank
});
export type GoFishAskSubmission = z.infer<typeof zGoFishAskSubmission>;

export const GOFISH_SUBMIT_DRAW = 'gofish/draw' as const;

export const zGoFishDrawSubmission = z.object({ kind: z.literal(GOFISH_SUBMIT_DRAW) });
export type GoFishDrawSubmission = z.infer<typeof zGoFishDrawSubmission>;

export const zGoFishSubmission = z.discriminatedUnion('kind', [
  zGoFishAskSubmission,
  zGoFishDrawSubmission
]);
export type GoFishSubmission = z.infer<typeof zGoFishSubmission>;

// ─── Host → everyone canonical events (publicPayload) ───────────────────────

export const GOFISH_EVT_DEALT = 'gofish/dealt' as const;
export const GOFISH_EVT_ASKED = 'gofish/asked' as const;
export const GOFISH_EVT_TRANSFERRED = 'gofish/transferred' as const;
export const GOFISH_EVT_GO_FISH = 'gofish/go_fish' as const;
export const GOFISH_EVT_BOOK_MADE = 'gofish/book_made' as const;
export const GOFISH_EVT_GAME_OVER = 'gofish/game_over' as const;
export const GOFISH_EVT_DREW = 'gofish/drew' as const;

export const zGoFishDealtPublic = z.object({
  kind: z.literal(GOFISH_EVT_DEALT),
  startingHandCounts: z.record(zPlayerId, z.number().int().min(0)),
  deckCount: z.number().int().min(0),
  firstTurnPlayerId: zPlayerId
});

export const zGoFishAskedPublic = z.object({
  kind: z.literal(GOFISH_EVT_ASKED),
  askingPlayerId: zPlayerId,
  targetPlayerId: zPlayerId,
  rank: zGoFishRank
});

export const zGoFishTransferredPublic = z.object({
  kind: z.literal(GOFISH_EVT_TRANSFERRED),
  fromPlayerId: zPlayerId,
  toPlayerId: zPlayerId,
  rank: zGoFishRank,
  count: z.number().int().min(1)
});

export const zGoFishGoFishPublic = z.object({
  kind: z.literal(GOFISH_EVT_GO_FISH),
  playerId: zPlayerId,
  deckCount: z.number().int().min(0),
  drewCard: z.boolean()
});

export const zGoFishBookMadePublic = z.object({
  kind: z.literal(GOFISH_EVT_BOOK_MADE),
  playerId: zPlayerId,
  rank: zGoFishRank,
  newBookCount: z.number().int().min(0)
});

export const zGoFishGameOverPublic = z.object({
  kind: z.literal(GOFISH_EVT_GAME_OVER),
  winnerPlayerIds: z.array(zPlayerId),
  bookCounts: z.record(zPlayerId, z.number().int().min(0))
});

export const zGoFishDrewPublic = z.object({
  kind: z.literal(GOFISH_EVT_DREW),
  playerId: zPlayerId,
  deckCount: z.number().int().min(0)
});

export const zGoFishEventPublicPayload = z.discriminatedUnion('kind', [
  zGoFishDealtPublic,
  zGoFishAskedPublic,
  zGoFishTransferredPublic,
  zGoFishGoFishPublic,
  zGoFishBookMadePublic,
  zGoFishGameOverPublic,
  zGoFishDrewPublic
]);
export type GoFishEventPublicPayload = z.infer<typeof zGoFishEventPublicPayload>;

