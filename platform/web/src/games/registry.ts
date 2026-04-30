import type { ComponentType, ReactElement } from 'react';
import { createElement } from 'react';

import type { AnyGameEngine, PlayerUIProps, RenderPlayerUIArgs } from './types';
import { TicTacToeGameEngine } from './tictactoe/engine';
import { GoFishGameEngine } from './gofish/engine';
import { HangmanGameEngine } from './hangman/engine';
import { BingoGameEngine } from './bingo/engine';

// Each entry is a fully-typed `GameEngine`. Cast to `AnyGameEngine` for
// registry-level operations that don't know the config shape.
const ENGINES: ReadonlyArray<AnyGameEngine> = [
  TicTacToeGameEngine as unknown as AnyGameEngine,
  GoFishGameEngine as unknown as AnyGameEngine,
  HangmanGameEngine as unknown as AnyGameEngine,
  BingoGameEngine as unknown as AnyGameEngine
];

const ENGINE_BY_TYPE = new Map<string, AnyGameEngine>(ENGINES.map((e) => [e.gameType, e]));

/** Returns the engine for `gameType`, or null if unknown. */
export function getGameEngine(gameType: string): AnyGameEngine | null {
  return ENGINE_BY_TYPE.get(gameType) ?? null;
}

export function listGameEngines(): ReadonlyArray<AnyGameEngine> {
  return ENGINES.slice().sort((a, b) => a.displayName.localeCompare(b.displayName));
}

/**
 * Resolve and render the active engine's PlayerUI for a given game type.
 * Returns null if no engine is registered for `gameType`. Engines are
 * responsible for their own state subscriptions.
 */
export function renderPlayerUI(args: RenderPlayerUIArgs): ReactElement | null {
  const engine = getGameEngine(args.gameType);
  if (!engine) return null;
  const parsed = engine.configSchema.safeParse(args.room.gameConfig);
  const config = parsed.success ? parsed.data : ({} as unknown);
  const PlayerUI = engine.PlayerUI as ComponentType<PlayerUIProps<unknown>>;
  const props: PlayerUIProps<unknown> = {
    store: args.store,
    room: args.room,
    selfPlayerId: args.selfPlayerId,
    players: args.players,
    config
  };
  return createElement(PlayerUI, props);
}

// Backwards-compat: some older imports still reference GAME_REGISTRY.
// Engines extend GameDefinition, so this keeps callers pointing at a shape
// with `displayName`, `configSchema`, and `ConfigUI`.
export const GAME_REGISTRY = {
  tictactoe: TicTacToeGameEngine,
  gofish: GoFishGameEngine,
  hangman: HangmanGameEngine,
  bingo: BingoGameEngine
} as const;
