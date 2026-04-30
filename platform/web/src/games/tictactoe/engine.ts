import {
  WIN_LINES,
  zTicTacToeConfig,
  zTicTacToeMove,
  zTicTacToeState,
  type TicTacToeConfig,
  type TicTacToeState
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
  StepView,
  StartGameInput
} from '../types';

import { TicTacToePlayerUI } from './PlayerUI';
import { TicTacToeConfigUI } from './ConfigUI';

const TTT_GAME_TYPE = 'tictactoe';
const TTT_KIND_MOVE = 'tictactoe/move';
const TTT_KIND_RESTART = 'tictactoe/restart';
const TTT_EVENT_STARTED = 'tictactoe/started';
const TTT_EVENT_MOVE_MADE = 'tictactoe/move_made';

const ConfigUI = TicTacToeConfigUI;

async function startGame(opts: StartGameInput<TicTacToeConfig>): Promise<HostLoopAction[]> {
  const [p1, p2] = opts.readyPlayers;
  if (!p1 || !p2) return [];

  const initial: TicTacToeState = zTicTacToeState.parse({
    board: Array(9).fill(null),
    currentPlayerId: p1.id,
    playerX: p1.id,
    playerO: p2.id,
    winnerId: null,
    isDraw: false,
    moveCount: 0
  });

  return [
    {
      kind: 'event',
      eventKind: TTT_EVENT_STARTED,
      publicPayload: {
        playerX: p1.id,
        playerO: p2.id,
        firstPlayerId: p1.id
      },
      fromPlayerId: opts.ctx.selfPlayerId
    },
    { kind: 'gameStatePublic', state: initial }
  ];
}

async function applySubmission(
  opts: ApplySubmissionInput<TicTacToeConfig>
): Promise<ApplySubmissionResult | null> {
  const { submission, plaintext, ctx } = opts;

  if (submission.kind === TTT_KIND_RESTART) {
    const snapshot = ctx.store.getGameStatePublicOrNull();
    const parsedState = snapshot ? zTicTacToeState.safeParse(snapshot.state) : null;
    if (!parsedState?.success) return null;
    const prev = parsedState.data;
    // Swap X and O so each round the loser goes first.
    const nextState = zTicTacToeState.parse({
      board: Array(9).fill(null),
      currentPlayerId: prev.playerO,
      playerX: prev.playerO,
      playerO: prev.playerX,
      winnerId: null,
      isDraw: false,
      moveCount: 0
    });
    return { actions: [{ kind: 'gameStatePublic', state: nextState }], outcome: { kind: 'continue' } };
  }

  if (submission.kind !== TTT_KIND_MOVE) return null;

  let move: { playerId: PlayerId; cellIndex: number } | null = null;
  try {
    const decoded = JSON.parse(new TextDecoder().decode(plaintext));
    const parsed = zTicTacToeMove.safeParse(decoded);
    if (parsed.success) move = parsed.data;
  } catch {
    // invalid JSON → drop
  }
  if (!move) return null;

  const snapshot = ctx.store.getGameStatePublicOrNull();
  const parsedState = snapshot ? zTicTacToeState.safeParse(snapshot.state) : null;
  if (!parsedState || !parsedState.success) return null;

  const state = parsedState.data;
  if (state.winnerId || state.isDraw) return null;
  if (state.currentPlayerId !== move.playerId) return null;
  if (state.board[move.cellIndex] != null) return null;

  const mark =
    move.playerId === state.playerX
      ? 'X'
      : move.playerId === state.playerO
        ? 'O'
        : null;
  if (!mark) return null;

  const nextBoard = state.board.slice() as typeof state.board;
  nextBoard[move.cellIndex] = mark;

  const hasWin = WIN_LINES.some((line) => {
    const [a, b, c] = line;
    const v = nextBoard[a];
    return v != null && v === nextBoard[b] && v === nextBoard[c];
  });

  const winnerId = hasWin ? move.playerId : null;
  const moveCount = state.moveCount + 1;
  const isDraw = !winnerId && moveCount >= 9;
  const currentPlayerId =
    winnerId || isDraw
      ? null
      : state.currentPlayerId === state.playerX
        ? state.playerO
        : state.playerX;

  const nextState = zTicTacToeState.parse({
    ...state,
    board: nextBoard,
    winnerId,
    isDraw,
    moveCount,
    currentPlayerId
  });

  const terminal = winnerId != null || isDraw;
  const actions: HostLoopAction[] = [
    {
      kind: 'event',
      eventKind: TTT_EVENT_MOVE_MADE,
      publicPayload: {
        cellIndex: move.cellIndex,
        playerId: move.playerId,
        mark
      },
      fromPlayerId: submission.fromPlayerId
    },
    { kind: 'gameStatePublic', state: nextState }
  ];

  if (terminal) {
    if (winnerId) return { actions, outcome: { kind: 'won', winnerPlayerIds: [winnerId] } };
    return { actions, outcome: { kind: 'draw', publicPayload: undefined } };
  }
  return { actions, outcome: { kind: 'continue' } };
}

async function autoPlay(opts: AutoPlayInput<TicTacToeConfig>): Promise<AutoPlayResult> {
  const { store, selfPlayerId } = opts;
  const snap = store.getGameStatePublicOrNull();
  if (!snap) return null;
  const parsed = zTicTacToeState.safeParse(snap.state);
  if (!parsed.success) return null;
  const state = parsed.data;
  if (state.currentPlayerId !== selfPlayerId) return null;
  if (state.winnerId || state.isDraw) return null;
  const cellIndex = state.board.findIndex((c) => c === null);
  if (cellIndex === -1) return null;
  const row = Math.floor(cellIndex / 3) + 1;
  const col = (cellIndex % 3) + 1;
  return {
    submission: {
      kind: TTT_KIND_MOVE,
      plaintext: new TextEncoder().encode(
        JSON.stringify({ kind: TTT_KIND_MOVE, playerId: selfPlayerId, cellIndex })
      )
    },
    description: `Played cell ${cellIndex} (row ${row}, col ${col})`
  };
}

function getActiveGameMetadata(input: { state: TicTacToeState }): ActiveGameMetadata {
  const { state } = input;
  const eligiblePlayerIds = state.currentPlayerId ? [state.currentPlayerId] : [];
  const phase: ActiveGameMetadata['phase'] = state.winnerId || state.isDraw ? 'finished' : 'active';

  const meta: ActiveGameMetadata = { phase, eligiblePlayerIds };
  if (phase === 'active') meta.turnSummary = 'Your move';

  if (phase === 'finished') {
    meta.outcome = state.winnerId
      ? { kind: 'won', winnerPlayerIds: [state.winnerId], summary: 'Win' }
      : { kind: 'draw', winnerPlayerIds: [], summary: 'Draw' };
  }

  meta.perPlayer = [
    { playerId: state.playerX, isCurrent: state.currentPlayerId === state.playerX },
    { playerId: state.playerO, isCurrent: state.currentPlayerId === state.playerO }
  ];

  return meta;
}

function formatStep(input: { step: GameStep; players: ReadonlyArray<{ id: string; displayName: string }>; currentState: TicTacToeState | null }): StepView | null {
  const { step } = input;
  if (step.kind === TTT_EVENT_STARTED) {
    return { summary: 'Game started', tone: 'system' };
  }
  if (step.kind === TTT_EVENT_MOVE_MADE) {
    const p = step.publicPayload as { cellIndex?: unknown; mark?: unknown; playerId?: unknown } | null;
    const cellIndex = p && typeof p.cellIndex === 'number' ? p.cellIndex : null;
    const mark = p && typeof p.mark === 'string' ? p.mark : null;
    return { summary: `${mark ?? '?'} moved${cellIndex != null ? ` to ${cellIndex}` : ''}` };
  }
  return null;
}

export const TicTacToeGameEngine = defineGameEngine({
  gameType: TTT_GAME_TYPE,
  displayName: 'TicTacToe',
  version: '1.0.0',
  configSchema: zTicTacToeConfig,
  stateSchema: zTicTacToeState,
  defaultConfig: zTicTacToeConfig.parse({}),
  minPlayers: 2,
  maxPlayers: 2,
  ConfigUI,
  startGame,
  applySubmission,
  getActiveGameMetadata,
  formatStep,
  PlayerUI: TicTacToePlayerUI,
  autoPlay
} satisfies GameEngine<TicTacToeConfig, TicTacToeState>);
