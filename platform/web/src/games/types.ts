import type { ComponentType, ReactNode } from 'react';
import type { ZodType } from 'zod';

import type {
  GameType,
  HostLoopAction,
  Player,
  PlayerId,
  Room,
  RoomEvent,
  RoomStore,
  Submission
} from '@brute-force-games/multiplayer-types';

export type GameStep = RoomEvent;

export type StepView = {
  icon?: string;
  summary: ReactNode;
  detail?: ReactNode;
  tone?: 'info' | 'good' | 'warn' | 'system';
};

export type ActiveGameMetadata = {
  phase: 'active' | 'finished';
  eligiblePlayerIds: PlayerId[];
  turnSummary?: string;
  badges?: Array<{
    label: string;
    value: string;
    tone?: 'info' | 'warn' | 'good';
  }>;
  outcome?: {
    kind: 'won' | 'draw';
    winnerPlayerIds: PlayerId[];
    summary: string;
  };
  perPlayer?: ReadonlyArray<{
    playerId: PlayerId;
    isCurrent?: boolean;
    isEliminated?: boolean;
    secondary?: string;
    badge?: string;
  }>;
};

export type AutoPlayInput<TConfig> = {
  store: RoomStore;
  selfPlayerId: PlayerId;
  room: Room;
  config: TConfig;
  players: ReadonlyArray<Player>;
};

export type AutoPlayResult = {
  submission: { kind: string; plaintext: Uint8Array };
  description: string;
} | null;

export type StepOutcome =
  | { kind: 'continue' }
  | { kind: 'eliminated'; playerIds: PlayerId[]; publicPayload?: unknown }
  | { kind: 'won'; winnerPlayerIds: PlayerId[]; publicPayload?: unknown }
  | { kind: 'draw'; publicPayload?: unknown };

export type ApplySubmissionResult = {
  actions: HostLoopAction[];
  outcome: StepOutcome;
};

// ─── GameDefinition (lobby-time metadata) ───────────────────────────────────
//
// The minimal shape needed to render the lobby/config screens for a game,
// without any host or play-time behavior. Kept as a separate concept so a
// future game-picker can show a list before the engine module is loaded.
export interface GameDefinition<TConfig> {
  gameType: string;
  displayName: string;
  configSchema: ZodType<TConfig>;
  ConfigUI: ComponentType<{
    config: TConfig;
    onChange: (next: TConfig) => void;
    isHost: boolean;
  }>;
}

// ─── GameEngine (host + play-time plugin) ───────────────────────────────────
//
// Each game registers a `GameEngine` that the host loop and the play route
// delegate to. Engines are pure with respect to TinyBase (no transport
// imports); they consume the abstract `RoomStore` interface from
// `@brute-force-games/multiplayer-types`.
//
// Engines own:
//   - Game start: how to deal/initialize state when `room.status` flips to
//     `'active'` (returns a batch of `HostLoopAction`s to apply).
//   - Submission processing: validate decrypted player submissions and
//     compute the resulting events + state snapshots.
//   - Player UI: the React surface a player sees while the game is active
//     (boards, controls, iframes, etc.).

export type GameEngineHostContext = {
  store: RoomStore;
  /** The host's own player id (used for self-private-state reads). */
  selfPlayerId: PlayerId;
};

export type StartGameInput<TConfig> = {
  ctx: GameEngineHostContext;
  room: Room;
  /** Players who marked themselves "joined" (`isReady === true`). */
  readyPlayers: ReadonlyArray<Player>;
  config: TConfig;
};

export type ApplySubmissionInput<TConfig> = {
  ctx: GameEngineHostContext;
  submission: Submission;
  plaintext: Uint8Array;
  room: Room;
  config: TConfig;
};

export type PlayerUIProps<TConfig> = {
  store: RoomStore;
  room: Room;
  selfPlayerId: PlayerId;
  players: ReadonlyArray<Player>;
  config: TConfig;
};

export type GodotBridgeAdapter<TConfig, TState> = {
  exportPath: string;
  buildStateInit(input: {
    state: TState;
    selfPlayerId: PlayerId;
    players: ReadonlyArray<Player>;
    config: TConfig;
    isObserver: boolean;
  }): unknown;
  buildStatePublic(input: { state: TState; config: TConfig }): unknown;
  parseIntent(input: {
    payload: unknown;
    selfPlayerId: PlayerId;
    config: TConfig;
  }): { kind: string; plaintext: Uint8Array } | null;
};

export interface GameEngine<TConfig, TState = unknown> extends GameDefinition<TConfig> {
  /**
   * Asserted at registration time so router/engine lookups can use the
   * branded `GameType` interchangeably with the raw `gameType` string.
   */
  gameType: string;

  version: string;

  stateSchema: ZodType<TState>;

  defaultConfig: TConfig;
  minPlayers: number;
  maxPlayers: number;

  getActiveGameMetadata(input: {
    state: TState;
    players: ReadonlyArray<Player>;
    selfPlayerId: PlayerId;
  }): ActiveGameMetadata;

  formatStep(input: {
    step: GameStep;
    players: ReadonlyArray<Player>;
    currentState: TState | null;
  }): StepView | null;

  /**
   * Build the initial state when the host hits "Start". Returns the actions
   * to apply (events, snapshots, room updates including `status: 'active'`).
   * Returning an empty array means "start was rejected" (e.g. not enough
   * players); the host-side caller should not flip room status.
   */
  startGame(input: StartGameInput<TConfig>): Promise<HostLoopAction[]>;

  /**
   * Process a single decrypted submission. Return null to drop silently.
   * The host loop wraps this with replay protection, decryption, and a
   * standard `host/accepted_submission` ack event, so engines only need to
   * compute the game-specific actions.
   */
  applySubmission(input: ApplySubmissionInput<TConfig>): Promise<ApplySubmissionResult | null>;

  /**
   * React component rendering the in-game player UI. Receives subscriptions
   * via `props.store`. Engines should subscribe inside the component for
   * proper cleanup.
   */
  PlayerUI: ComponentType<PlayerUIProps<TConfig>>;

  /**
   * Compute and return a default move for the local player. The play route
   * renders an "Auto Play" button outside the game view that calls this and
   * submits the result. Return null when no move is available (not your turn,
   * game over, hand empty with no deck, etc.).
   */
  autoPlay(input: AutoPlayInput<TConfig>): Promise<AutoPlayResult>;

  godot?: GodotBridgeAdapter<TConfig, TState>;
}

// ─── Registry helpers ───────────────────────────────────────────────────────
//
// The registry is keyed by `GameType` (the branded string in `Room.gameType`).
// Lookups go through `getGameEngine(type)` to keep typing tight and to give a
// single error point if an unknown game shows up in shared state.

export type AnyGameEngine = GameEngine<unknown, unknown>;

export function defineGameEngine<TConfig, TState>(
  engine: GameEngine<TConfig, TState>
): GameEngine<TConfig, TState> {
  return engine;
}

export type GameTypeKey = GameType | string;

/**
 * Wrapper component used by the play route to render the right engine's
 * PlayerUI by `gameType`. Returns `fallback` when the game type isn't known.
 */
export type RenderPlayerUIArgs = {
  gameType: GameTypeKey;
  store: RoomStore;
  room: Room;
  selfPlayerId: PlayerId;
  players: ReadonlyArray<Player>;
  fallback?: ReactNode;
};
