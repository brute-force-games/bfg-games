import { z } from 'zod';

import { zPlayerId } from '../../core/ids';

// A single alphabetic character used as a guess or in the masked word display
export const zLetter = z.string().length(1).brand<'Letter'>();
export type Letter = z.infer<typeof zLetter>;

// A single character in the masked word — either a revealed letter or a blank marker
export const zMaskedChar = z.string().length(1);
export type MaskedChar = z.infer<typeof zMaskedChar>;

// The secret word chosen by the host
export const zHangmanWord = z.string().min(1).brand<'HangmanWord'>();
export type HangmanWord = z.infer<typeof zHangmanWord>;

export const zHangmanConfig = z.object({
  maxWrongGuesses: z.number().int().min(1).max(10)
});
export type HangmanConfig = z.infer<typeof zHangmanConfig>;

export const zHangmanPublicState = z.object({
  phase: z.enum(['active', 'finished']),
  turnPlayerId: zPlayerId.nullable(),
  maskedWord: z.array(zMaskedChar),
  guessedLetters: z.array(zLetter),
  wrongGuesses: z.number().int().min(0),
  maxWrongGuesses: z.number().int().min(1),
  wordLength: z.number().int().min(1),
  outcome: z.enum(['win', 'lose']).nullable(),
  playerIds: z.array(zPlayerId)
});
export type HangmanPublicState = z.infer<typeof zHangmanPublicState>;

export const zHangmanHostPrivateState = z.object({
  word: zHangmanWord
});
export type HangmanHostPrivateState = z.infer<typeof zHangmanHostPrivateState>;

// ─── Submissions ─────────────────────────────────────────────────────────────

export const HANGMAN_SUBMIT_GUESS = 'hangman/guess' as const;

export const zHangmanGuessSubmission = z.object({
  kind: z.literal(HANGMAN_SUBMIT_GUESS),
  letter: zLetter
});
export type HangmanGuessSubmission = z.infer<typeof zHangmanGuessSubmission>;

export const zHangmanSubmission = z.discriminatedUnion('kind', [zHangmanGuessSubmission]);
export type HangmanSubmission = z.infer<typeof zHangmanSubmission>;

// ─── Events ──────────────────────────────────────────────────────────────────

export const HANGMAN_EVT_STARTED = 'hangman/started' as const;
export const HANGMAN_EVT_GUESSED = 'hangman/guessed' as const;
export const HANGMAN_EVT_GAME_OVER = 'hangman/game_over' as const;

export const zHangmanStartedPublic = z.object({
  kind: z.literal(HANGMAN_EVT_STARTED),
  wordLength: z.number().int().min(1),
  maxWrongGuesses: z.number().int().min(1),
  firstTurnPlayerId: zPlayerId
});

export const zHangmanGuessedPublic = z.object({
  kind: z.literal(HANGMAN_EVT_GUESSED),
  playerId: zPlayerId,
  letter: zLetter,
  correct: z.boolean(),
  wrongGuesses: z.number().int().min(0),
  maskedWord: z.array(zMaskedChar)
});

export const zHangmanGameOverPublic = z.object({
  kind: z.literal(HANGMAN_EVT_GAME_OVER),
  outcome: z.enum(['win', 'lose']),
  word: zHangmanWord
});

export const zHangmanEventPublicPayload = z.discriminatedUnion('kind', [
  zHangmanStartedPublic,
  zHangmanGuessedPublic,
  zHangmanGameOverPublic
]);
export type HangmanEventPublicPayload = z.infer<typeof zHangmanEventPublicPayload>;
