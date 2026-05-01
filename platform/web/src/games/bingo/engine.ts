import {
  BINGO_EVT_CALLED,
  BINGO_EVT_GAME_OVER,
  BINGO_EVT_STARTED,
  BINGO_SUBMIT_CALL,
  BINGO_SUBMIT_CALL_SPECIFIC,
  BINGO_WIN_LINES,
  zBingoConfig,
  zBingoHostPrivateState,
  zBingoPublicState,
  zBingoSubmission,
  type BingoConfig,
  type BingoPublicState
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

import { BingoPlayerUI } from './PlayerUI';

const BINGO_GAME_TYPE = 'bingo';
export const BINGO_PRIVATE_KIND = 'bingo/state_private_v1' as const;

// ─── RNG helpers ─────────────────────────────────────────────────────────────

function hashSeedToU32(seed: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function seededShuffle<T>(seed: string, items: T[]): T[] {
  const rng = mulberry32(hashSeedToU32(seed));
  const a = items.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = a[i]!;
    a[i] = a[j]!;
    a[j] = tmp;
  }
  return a;
}

// Pick `count` values from [min, max] without replacement, seeded.
function pickN(rng: () => number, min: number, max: number, count: number): number[] {
  const pool: number[] = [];
  for (let n = min; n <= max; n++) pool.push(n);
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = pool[i]!;
    pool[i] = pool[j]!;
    pool[j] = tmp;
  }
  return pool.slice(0, count);
}

// ─── Board generation ─────────────────────────────────────────────────────────

// Traditional BINGO board: 5x5, stored row-major.
// B column (indices 0,5,10,15,20): numbers 1–15
// I column (indices 1,6,11,16,21): numbers 16–30
// N column (indices 2,7,12,17,22): numbers 31–45
// G column (indices 3,8,13,18,23): numbers 46–60
// O column (indices 4,9,14,19,24): numbers 61–75
// Center (index 12): 0 = FREE

function generateBoard(roomSeed: string, playerId: string): number[] {
  const seed = `${roomSeed}|bingo|board|${playerId}`;
  const rng = mulberry32(hashSeedToU32(seed));
  const board = new Array<number>(25).fill(0);

  const columns: [number, number, number[]][] = [
    [1, 15, [0, 5, 10, 15, 20]],
    [16, 30, [1, 6, 11, 16, 21]],
    [31, 45, [2, 7, 12, 17, 22]],
    [46, 60, [3, 8, 13, 18, 23]],
    [61, 75, [4, 9, 14, 19, 24]]
  ];

  for (const [min, max, cells] of columns) {
    const nums = pickN(rng, min, max, 5);
    for (let i = 0; i < cells.length; i++) {
      board[cells[i]!] = nums[i]!;
    }
  }

  board[12] = 0; // FREE space
  return board;
}

// ─── Game logic helpers ───────────────────────────────────────────────────────

function checkBingo(board: number[], calledSet: Set<number>): boolean {
  return BINGO_WIN_LINES.some((line) =>
    line.every((idx) => board[idx] === 0 || calledSet.has(board[idx]!))
  );
}

function countMarked(board: number[], calledSet: Set<number>): number {
  return board.filter((n) => n === 0 || calledSet.has(n)).length;
}

function ConfigUI() {
  return null;
}

// ─── Start game ───────────────────────────────────────────────────────────────

async function startGame(opts: StartGameInput<BingoConfig>): Promise<HostLoopAction[]> {
  const { readyPlayers, room, ctx } = opts;
  if (readyPlayers.length < 2) return [];

  const playerIds = readyPlayers.map((p) => p.id as PlayerId);

  // Generate one board per player using a per-player seed
  const boards = Object.fromEntries(
    playerIds.map((pid) => [pid, generateBoard(room.seed, pid)])
  );

  // Shuffle all 75 numbers for the call order
  const allNumbers: number[] = [];
  for (let n = 1; n <= 75; n++) allNumbers.push(n);
  const shuffled = seededShuffle(`${room.seed}|bingo|call_order`, allNumbers);

  const firstPlayer = playerIds[0]!;

  const players = playerIds.map((pid) => ({
    playerId: pid,
    board: boards[pid]!,
    markedCount: 1, // free space
    hasBingo: false
  }));

  const publicState = zBingoPublicState.parse({
    phase: 'active',
    calledNumbers: [],
    lastCalledNumber: null,
    turnPlayerId: firstPlayer,
    players,
    winnerPlayerIds: []
  });

  return [
    {
      kind: 'event',
      eventKind: BINGO_EVT_STARTED,
      publicPayload: {
        kind: BINGO_EVT_STARTED,
        playerCount: playerIds.length,
        firstTurnPlayerId: firstPlayer
      },
      fromPlayerId: ctx.selfPlayerId
    },
    {
      kind: 'gameStatePrivate',
      perPlayer: [
        {
          playerId: ctx.selfPlayerId,
          kind: BINGO_PRIVATE_KIND,
          value: zBingoHostPrivateState.parse({ uncalledNumbers: shuffled })
        }
      ]
    },
    { kind: 'gameStatePublic', state: publicState },
    { kind: 'updateRoom', patch: { status: 'active' } }
  ];
}

// ─── Apply submission ─────────────────────────────────────────────────────────

async function applySubmissionV1(
  opts: ApplySubmissionInput<BingoConfig>
): Promise<HostLoopAction[] | null> {
  const { submission: s, plaintext, room, ctx } = opts;

  const decoded = new TextDecoder().decode(plaintext);
  let sub: { kind: string; number?: number } | null = null;
  try {
    const json = JSON.parse(decoded);
    const parsed = zBingoSubmission.safeParse(json);
    if (parsed.success) sub = parsed.data;
  } catch {
    // invalid JSON
  }
  if (!sub) return null;
  if (sub.kind !== BINGO_SUBMIT_CALL && sub.kind !== BINGO_SUBMIT_CALL_SPECIFIC) return null;

  const snap = ctx.store.getGameStatePublicOrNull();
  const parsedPublic = snap ? zBingoPublicState.safeParse(snap.state) : null;
  if (!parsedPublic?.success) return null;
  const state = parsedPublic.data;

  if (state.phase !== 'active') return null;
  if (state.turnPlayerId !== s.fromPlayerId) return null;

  // Decrypt host private state to get uncalled numbers
  const hostRow = ctx.store.getGameStatePrivateOrNull(ctx.selfPlayerId);
  if (!hostRow) return null;
  const hostUnknown = await ctx.store.decryptJsonForSelfFromGameStatePrivate({
    row: hostRow,
    seq: hostRow.seq,
    gameType: room.gameType,
    kind: BINGO_PRIVATE_KIND
  });
  const hostParsed = zBingoHostPrivateState.safeParse(hostUnknown);
  if (!hostParsed.success) return null;

  const uncalled = hostParsed.data.uncalledNumbers.slice();
  if (uncalled.length === 0) return null;

  let number: number;
  if (sub.kind === BINGO_SUBMIT_CALL_SPECIFIC) {
    const requested = sub.number!;
    const idx = uncalled.indexOf(requested);
    if (idx === -1) return null; // already called or invalid
    uncalled.splice(idx, 1);
    number = requested;
  } else {
    number = uncalled.shift()!;
  }
  const calledNumbers = [...state.calledNumbers, number];
  const calledSet = new Set(calledNumbers);

  // Update all players
  const updatedPlayers = state.players.map((p) => ({
    ...p,
    markedCount: countMarked(p.board, calledSet),
    hasBingo: checkBingo(p.board, calledSet)
  }));

  const newBingoPlayerIds = updatedPlayers
    .filter((p) => p.hasBingo && !state.players.find((op) => op.playerId === p.playerId)?.hasBingo)
    .map((p) => p.playerId);

  const winners = updatedPlayers.filter((p) => p.hasBingo).map((p) => p.playerId);
  const isOver = winners.length > 0;

  // Advance turn to next player
  const idx = state.players.findIndex((p) => p.playerId === s.fromPlayerId);
  const nextTurnPlayerId = isOver
    ? null
    : state.players[(idx + 1) % state.players.length]!.playerId;

  const nextPublic = zBingoPublicState.parse({
    ...state,
    calledNumbers,
    lastCalledNumber: number,
    turnPlayerId: nextTurnPlayerId,
    players: updatedPlayers,
    winnerPlayerIds: winners,
    phase: isOver ? 'finished' : 'active'
  });

  const actions: HostLoopAction[] = [
    {
      kind: 'event',
      eventKind: BINGO_EVT_CALLED,
      publicPayload: {
        kind: BINGO_EVT_CALLED,
        calledBy: s.fromPlayerId,
        number,
        totalCalled: calledNumbers.length,
        newBingoPlayerIds
      },
      fromPlayerId: s.fromPlayerId
    },
    {
      kind: 'gameStatePrivate',
      perPlayer: [
        {
          playerId: ctx.selfPlayerId,
          kind: BINGO_PRIVATE_KIND,
          value: zBingoHostPrivateState.parse({ uncalledNumbers: uncalled })
        }
      ]
    },
    { kind: 'gameStatePublic', state: nextPublic }
  ];

  if (isOver) {
    actions.push({
      kind: 'event',
      eventKind: BINGO_EVT_GAME_OVER,
      publicPayload: { kind: BINGO_EVT_GAME_OVER, winnerPlayerIds: winners },
      fromPlayerId: s.fromPlayerId
    });
    actions.push({ kind: 'updateRoom', patch: { status: 'finished' } });
  }

  return actions;
}

async function applySubmission(opts: ApplySubmissionInput<BingoConfig>): Promise<ApplySubmissionResult | null> {
  const actionsV1 = await applySubmissionV1(opts);
  if (!actionsV1) return null;

  const actions = actionsV1.filter(
    (a) => !(a.kind === 'updateRoom' && (a.patch as { status?: unknown } | undefined)?.status === 'finished')
  );

  const lastPublic = [...actions].reverse().find((a) => a.kind === 'gameStatePublic');
  const parsed =
    lastPublic && lastPublic.kind === 'gameStatePublic'
      ? zBingoPublicState.safeParse(lastPublic.state)
      : null;

  if (parsed?.success && parsed.data.phase === 'finished') {
    return { actions, outcome: { kind: 'won', winnerPlayerIds: parsed.data.winnerPlayerIds ?? [] } };
  }

  return { actions, outcome: { kind: 'continue' } };
}

function getActiveGameMetadata(input: {
  state: BingoPublicState;
  players: ReadonlyArray<{ id: string; displayName: string }>;
  selfPlayerId: string;
}): ActiveGameMetadata {
  const { state } = input;
  const called = state.calledNumbers.length;
  const last = state.lastCalledNumber;
  const meta: ActiveGameMetadata = {
    phase: state.phase === 'finished' ? 'finished' : 'active',
    eligiblePlayerIds: state.turnPlayerId ? [state.turnPlayerId] : [],
    badges: [
      { label: 'Called', value: `${called} / 75` },
      ...(last != null ? [{ label: 'Last', value: String(last) }] : [])
    ],
    perPlayer: state.players.map((p) => ({
      playerId: p.playerId,
      isCurrent: state.turnPlayerId === p.playerId,
      secondary: `${p.markedCount}/25`,
      ...(p.hasBingo ? { badge: 'BINGO' } : {})
    }))
  };
  if (state.phase === 'finished') {
    meta.outcome = {
      kind: 'won',
      winnerPlayerIds: state.winnerPlayerIds,
      summary: state.winnerPlayerIds.length === 1 ? 'Bingo' : 'Bingo winners'
    };
  }
  return meta;
}

function formatStep(input: {
  step: GameStep;
  players: ReadonlyArray<{ id: string; displayName: string }>;
  currentState: BingoPublicState | null;
}): { summary: string } | null {
  const { step } = input;
  if (step.kind.startsWith('host/')) return null;
  if (!step.kind.startsWith('bingo/') && !step.kind.startsWith('framework/')) return null;
  return { summary: step.kind };
}

// ─── Auto play ────────────────────────────────────────────────────────────────

async function autoPlay(opts: AutoPlayInput<BingoConfig>): Promise<AutoPlayResult> {
  const { store, selfPlayerId } = opts;

  const snap = store.getGameStatePublicOrNull();
  if (!snap) return null;
  const parsed = zBingoPublicState.safeParse(snap.state);
  if (!parsed.success) return null;
  const state = parsed.data;

  if (state.phase !== 'active') return null;
  if (state.turnPlayerId !== selfPlayerId) return null;

  return {
    submission: {
      kind: BINGO_SUBMIT_CALL,
      plaintext: new TextEncoder().encode(JSON.stringify({ kind: BINGO_SUBMIT_CALL }))
    },
    description: 'Called next number'
  };
}

export const BingoGameEngine = defineGameEngine({
  gameType: BINGO_GAME_TYPE,
  displayName: 'Bingo',
  version: '1.0.0',
  configSchema: zBingoConfig,
  stateSchema: zBingoPublicState,
  defaultConfig: { maxPlayers: 8 },
  minPlayers: 2,
  // Absolute ceiling; Bingo config may further constrain within this.
  maxPlayers: 8,
  ConfigUI,
  startGame,
  applySubmission,
  getActiveGameMetadata,
  formatStep,
  autoPlay,
  PlayerUI: BingoPlayerUI
} satisfies GameEngine<BingoConfig, BingoPublicState>);
