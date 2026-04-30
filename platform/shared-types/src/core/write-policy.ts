import type { PlayerId } from './ids';

// ─── Table ownership constants ──────────────────────────────────────────────
// These are the room-store tables a backend client may write. Host-owned
// tables can only be mutated by the room's host; player-owned tables may be
// mutated by individual players (`players` only `players[self]`,
// `submissions` only authored by the submitting player).
//
// Pre-Phase-9 these are *convention* enforced client-side (see
// `requireHost` below). Phase 9 will move enforcement to the server.

export const HOST_OWNED_TABLES = [
  'room',
  'events',
  'eventsPrivate',
  'gameStatePublic',
  'gameStatePrivate'
] as const;
export type HostOwnedTable = (typeof HOST_OWNED_TABLES)[number];

export const PLAYER_OWNED_TABLES = ['players', 'submissions'] as const;
export type PlayerOwnedTable = (typeof PLAYER_OWNED_TABLES)[number];

// ─── Policy helpers ─────────────────────────────────────────────────────────

export function isHost(
  selfPlayerId: PlayerId,
  hostPlayerId: PlayerId | null
): boolean {
  if (hostPlayerId === null) return false;
  return selfPlayerId === hostPlayerId;
}

export class HostOnlyWriteError extends Error {
  readonly selfPlayerId: PlayerId;
  readonly hostPlayerId: PlayerId | null;
  readonly context: string;
  constructor(opts: {
    selfPlayerId: PlayerId;
    hostPlayerId: PlayerId | null;
    context: string;
  }) {
    super(
      `host-only write '${opts.context}' rejected: self=${opts.selfPlayerId}, host=${opts.hostPlayerId ?? '<none>'}`
    );
    this.name = 'HostOnlyWriteError';
    this.selfPlayerId = opts.selfPlayerId;
    this.hostPlayerId = opts.hostPlayerId;
    this.context = opts.context;
  }
}

export function requireHost(
  selfPlayerId: PlayerId,
  hostPlayerId: PlayerId | null,
  context: string
): void {
  if (!isHost(selfPlayerId, hostPlayerId)) {
    throw new HostOnlyWriteError({ selfPlayerId, hostPlayerId, context });
  }
}
