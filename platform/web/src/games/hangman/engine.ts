import {
  HANGMAN_EVT_GAME_OVER,
  HANGMAN_EVT_GUESSED,
  HANGMAN_EVT_STARTED,
  HANGMAN_SUBMIT_GUESS,
  zHangmanConfig,
  zHangmanGuessSubmission,
  zHangmanHostPrivateState,
  zHangmanPublicState,
  type HangmanConfig,
  type HangmanPublicState,
  type Letter
} from '@brute-force-games/shared-types';

import type { HostLoopAction, PlayerId } from '@brute-force-games/multiplayer-types';

import { defineGameEngine } from '../types';
import type {
  ActiveGameMetadata,
  ApplySubmissionInput,
  ApplySubmissionResult,
  AutoPlayInput,
  AutoPlayResult,
  GameEngine,
  GameStep,
  StartGameInput
} from '../types';

import { HangmanPlayerUI } from './PlayerUI';

const HANGMAN_GAME_TYPE = 'hangman';
export const HANGMAN_PRIVATE_KIND = 'hangman/state_private_v1' as const;

// Frequency-ordered letters for autoPlay
const LETTER_FREQUENCY = 'ETAOINSRHLDCUMFPGWYBVKXJQZ'.split('') as Letter[];

const WORD_LIST = [
  'APPLE', 'BEACH', 'CLOUD', 'DANCE', 'EAGLE',
  'FLAME', 'GHOST', 'HONEY', 'ISLAND', 'JEWEL',
  'KNIFE', 'LEMON', 'MAGIC', 'NIGHT', 'OCEAN',
  'PIANO', 'QUEEN', 'RIVER', 'STORM', 'TIGER',
  'UMBRELLA', 'VIOLET', 'WATER', 'YELLOW', 'ZEBRA',
  'ANGEL', 'BRAVE', 'CANDY', 'DAISY', 'EMBER',
  'FROST', 'GRAND', 'HIPPO', 'IVORY', 'JUNGLE',
  'KARMA', 'LUNAR', 'MANGO', 'NINJA', 'OLIVE',
  'PANDA', 'QUIET', 'SNAKE', 'TRUCK', 'VIVID',
  'WRIST', 'YOUTH', 'BASKET', 'BRIDGE', 'CASTLE',
  'DRAGON', 'ENGINE', 'FOREST', 'GARDEN', 'HAMMER',
  'JACKET', 'KITTEN', 'MIRROR', 'NOODLE', 'ORANGE',
  'PLANET', 'RABBIT', 'SILVER', 'TEMPLE', 'VIOLIN',
  'WALLET', 'WINDOW', 'TURTLE', 'ROCKET', 'PUZZLE',
  'ANCHOR', 'THUNDER', 'SPARROW', 'PYRAMID', 'CRYSTAL',
  'BALLOON', 'VOLCANO', 'TROPHY', 'SHADOW', 'COMPASS',
  'DOLPHIN', 'GIRAFFE', 'JOURNEY', 'MONSTER', 'PENGUIN',
  'TORNADO', 'UNICORN', 'VAMPIRE', 'WARRIOR', 'FORTUNE',
  'LANTERN', 'MUSTARD', 'BLIZZARD', 'SCARECROW', 'KEYBOARD',
] as const;

function hashSeedToU32(seed: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

function pickWord(seed: string): string {
  const idx = hashSeedToU32(seed) % WORD_LIST.length;
  return WORD_LIST[idx]!;
}

function maskWord(word: string, guessedLetters: string[]): string[] {
  return word.split('').map((l) => (guessedLetters.includes(l) ? l : '_'));
}

function ConfigUI() {
  return null;
}

// ─── Start game ──────────────────────────────────────────────────────────────

async function startGame(opts: StartGameInput<HangmanConfig>): Promise<HostLoopAction[]> {
  const { readyPlayers, room, ctx, config } = opts;
  if (readyPlayers.length < 2) return [];

  const wordSeed = `${room.seed}|${room.id}|hangman|word_v1`;
  const word = pickWord(wordSeed);
  const playerIds = readyPlayers.map((p) => p.id as PlayerId);
  const firstPlayer = playerIds[0]!;
  const maxWrongGuesses = config.maxWrongGuesses;

  const publicState = zHangmanPublicState.parse({
    phase: 'active',
    turnPlayerId: firstPlayer,
    maskedWord: Array(word.length).fill('_'),
    guessedLetters: [],
    wrongGuesses: 0,
    maxWrongGuesses,
    wordLength: word.length,
    outcome: null,
    playerIds
  });

  return [
    {
      kind: 'event',
      eventKind: HANGMAN_EVT_STARTED,
      publicPayload: {
        kind: HANGMAN_EVT_STARTED,
        wordLength: word.length,
        maxWrongGuesses,
        firstTurnPlayerId: firstPlayer
      },
      fromPlayerId: ctx.selfPlayerId
    },
    {
      kind: 'gameStatePrivate',
      perPlayer: [
        {
          playerId: ctx.selfPlayerId,
          kind: HANGMAN_PRIVATE_KIND,
          value: zHangmanHostPrivateState.parse({ word })
        }
      ]
    },
    { kind: 'gameStatePublic', state: publicState },
    { kind: 'updateRoom', patch: { status: 'active' } }
  ];
}

// ─── Apply submission ─────────────────────────────────────────────────────────

async function applySubmissionV1(
  opts: ApplySubmissionInput<HangmanConfig>
): Promise<HostLoopAction[] | null> {
  const { submission: s, plaintext, room, ctx } = opts;

  const decoded = new TextDecoder().decode(plaintext);
  let submission: { kind: string; letter?: string } | null = null;
  try {
    const json = JSON.parse(decoded);
    const parsed = zHangmanGuessSubmission.safeParse(json);
    if (parsed.success) submission = parsed.data;
  } catch {
    // invalid JSON
  }
  if (!submission || submission.kind !== HANGMAN_SUBMIT_GUESS) return null;

  const letterRaw = submission.letter?.toUpperCase();
  if (!letterRaw || !/^[A-Z]$/.test(letterRaw)) return null;
  const letter = letterRaw as Letter;

  const snap = ctx.store.getGameStatePublicOrNull();
  const parsedPublic = snap ? zHangmanPublicState.safeParse(snap.state) : null;
  if (!parsedPublic?.success) return null;
  const state = parsedPublic.data;

  if (state.phase !== 'active') return null;
  if (state.turnPlayerId !== s.fromPlayerId) return null;
  if (state.guessedLetters.includes(letter)) return null;

  // Decrypt word from host private state
  const hostPrivateRow = ctx.store.getGameStatePrivateOrNull(ctx.selfPlayerId);
  if (!hostPrivateRow) return null;
  const hostPrivateUnknown = await ctx.store.decryptJsonForSelfFromGameStatePrivate({
    row: hostPrivateRow,
    seq: hostPrivateRow.seq,
    gameType: room.gameType,
    kind: HANGMAN_PRIVATE_KIND
  });
  const hostPrivateParsed = zHangmanHostPrivateState.safeParse(hostPrivateUnknown);
  if (!hostPrivateParsed.success) return null;
  const { word } = hostPrivateParsed.data;

  const guessedLetters = [...state.guessedLetters, letter];
  const correct = word.includes(letter);
  const wrongGuesses = correct ? state.wrongGuesses : state.wrongGuesses + 1;
  const nextMasked = maskWord(word, guessedLetters);

  const isWin = nextMasked.every((l) => l !== '_');
  const isLose = wrongGuesses >= state.maxWrongGuesses;
  const isOver = isWin || isLose;
  const outcome = isWin ? 'win' : isLose ? 'lose' : null;

  // Turn advances to next player on wrong guess; correct guess keeps the turn.
  let nextTurnPlayerId: PlayerId | null = null;
  if (!isOver) {
    if (correct) {
      nextTurnPlayerId = s.fromPlayerId as PlayerId;
    } else {
      const idx = state.playerIds.indexOf(s.fromPlayerId as PlayerId);
      nextTurnPlayerId = state.playerIds[(idx + 1) % state.playerIds.length]!;
    }
  }

  const nextPublic = zHangmanPublicState.parse({
    ...state,
    turnPlayerId: nextTurnPlayerId,
    maskedWord: nextMasked,
    guessedLetters,
    wrongGuesses,
    phase: isOver ? 'finished' : 'active',
    outcome
  });

  const actions: HostLoopAction[] = [
    {
      kind: 'event',
      eventKind: HANGMAN_EVT_GUESSED,
      publicPayload: {
        kind: HANGMAN_EVT_GUESSED,
        playerId: s.fromPlayerId,
        letter,
        correct,
        wrongGuesses,
        maskedWord: nextMasked
      },
      fromPlayerId: s.fromPlayerId
    },
    { kind: 'gameStatePublic', state: nextPublic }
  ];

  if (isOver) {
    actions.push({
      kind: 'event',
      eventKind: HANGMAN_EVT_GAME_OVER,
      publicPayload: {
        kind: HANGMAN_EVT_GAME_OVER,
        outcome: outcome!,
        word
      },
      fromPlayerId: s.fromPlayerId
    });
    actions.push({ kind: 'updateRoom', patch: { status: 'finished' } });
  }

  return actions;
}

async function applySubmission(opts: ApplySubmissionInput<HangmanConfig>): Promise<ApplySubmissionResult | null> {
  const actionsV1 = await applySubmissionV1(opts);
  if (!actionsV1) return null;

  const actions = actionsV1.filter(
    (a) => !(a.kind === 'updateRoom' && (a.patch as { status?: unknown } | undefined)?.status === 'finished')
  );

  const lastPublic = [...actions].reverse().find((a) => a.kind === 'gameStatePublic');
  const parsed =
    lastPublic && lastPublic.kind === 'gameStatePublic'
      ? zHangmanPublicState.safeParse(lastPublic.state)
      : null;

  if (parsed?.success && parsed.data.phase === 'finished') {
    const winners = parsed.data.outcome === 'win' ? parsed.data.playerIds : [];
    if (winners.length > 0) return { actions, outcome: { kind: 'won', winnerPlayerIds: winners } };
    return { actions, outcome: { kind: 'draw' } };
  }

  return { actions, outcome: { kind: 'continue' } };
}

function getActiveGameMetadata(input: {
  state: HangmanPublicState;
  players: ReadonlyArray<{ id: string; displayName: string }>;
  selfPlayerId: string;
}): ActiveGameMetadata {
  const { state } = input;
  const wrong = state.wrongGuesses;
  const meta: ActiveGameMetadata = {
    phase: state.phase === 'finished' ? 'finished' : 'active',
    eligiblePlayerIds: state.turnPlayerId ? [state.turnPlayerId] : [],
    badges: [
      {
        label: 'Wrong',
        value: `${wrong} / ${state.maxWrongGuesses}`,
        tone: wrong >= state.maxWrongGuesses - 1 ? 'warn' : 'info'
      }
    ]
  };
  if (state.phase === 'finished') {
    const winners = state.outcome === 'win' ? state.playerIds : [];
    meta.outcome = {
      kind: winners.length > 0 ? 'won' : 'draw',
      winnerPlayerIds: winners,
      summary: winners.length > 0 ? 'Solved' : 'Out of guesses'
    };
  }
  return meta;
}

function formatStep(input: {
  step: GameStep;
  players: ReadonlyArray<{ id: string; displayName: string }>;
  currentState: HangmanPublicState | null;
}): { summary: string } | null {
  const { step } = input;
  if (step.kind.startsWith('host/')) return null;
  if (!step.kind.startsWith('hangman/') && !step.kind.startsWith('framework/')) return null;
  return { summary: step.kind };
}

// ─── Auto play ────────────────────────────────────────────────────────────────

async function autoPlay(opts: AutoPlayInput<HangmanConfig>): Promise<AutoPlayResult> {
  const { store, selfPlayerId } = opts;

  const snap = store.getGameStatePublicOrNull();
  if (!snap) return null;
  const parsed = zHangmanPublicState.safeParse(snap.state);
  if (!parsed.success) return null;
  const state = parsed.data;

  if (state.phase !== 'active') return null;
  if (state.turnPlayerId !== selfPlayerId) return null;

  const letter = LETTER_FREQUENCY.find((l) => !state.guessedLetters.includes(l));
  if (!letter) return null;

  return {
    submission: {
      kind: HANGMAN_SUBMIT_GUESS,
      plaintext: new TextEncoder().encode(
        JSON.stringify({ kind: HANGMAN_SUBMIT_GUESS, letter })
      )
    },
    description: `Guessed letter ${letter}`
  };
}

export const HangmanGameEngine = defineGameEngine({
  gameType: HANGMAN_GAME_TYPE,
  displayName: 'Hangman',
  version: '1.0.0',
  configSchema: zHangmanConfig,
  stateSchema: zHangmanPublicState,
  defaultConfig: { maxWrongGuesses: 6 },
  minPlayers: 2,
  maxPlayers: 8,
  ConfigUI,
  startGame,
  applySubmission,
  getActiveGameMetadata,
  formatStep,
  autoPlay,
  PlayerUI: HangmanPlayerUI
} satisfies GameEngine<HangmanConfig, HangmanPublicState>);
