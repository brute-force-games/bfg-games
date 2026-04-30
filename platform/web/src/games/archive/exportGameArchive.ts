import type { RoomStore } from '@brute-force-games/multiplayer-types';

import type { AnyGameEngine } from '../types';

export type GameArchive = {
  room: {
    id: string;
    gameType: string;
    gameConfig: unknown;
    seed: string;
    hostPublicKey: string;
  };
  players: Array<{ id: string; displayName: string; signingPubKey: string }>;
  events: ReadonlyArray<unknown>;
  stateHistory: ReadonlyArray<{ seq: number; state: unknown }>;
  meta: {
    engineVersion: string;
    frameworkBuild: string;
    schemaVersion: number;
    exportedAt: number;
  };
};

function getFrameworkBuild(): string {
  // Prefer a single Vite-injected build stamp.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const v = (import.meta as any).env?.VITE_GIT_SHA;
  return typeof v === 'string' && v.length > 0 ? v : 'dev';
}

export function exportGameArchive(store: RoomStore, engine: AnyGameEngine): GameArchive {
  const room = store.getRoom();
  const players = store.getPlayers().map((p) => ({
    id: p.id,
    displayName: p.displayName,
    signingPubKey: p.signingPubKey
  }));

  return {
    room: {
      id: room.id,
      gameType: room.gameType,
      gameConfig: room.gameConfig,
      seed: room.seed,
      hostPublicKey: room.hostEncPubKey
    },
    players,
    events: store.getEvents(),
    stateHistory: store.getGameStateHistory().map((r) => ({ seq: r.seq, state: r.state })),
    meta: {
      engineVersion: engine.version,
      frameworkBuild: getFrameworkBuild(),
      schemaVersion: 1,
      exportedAt: Date.now()
    }
  };
}

