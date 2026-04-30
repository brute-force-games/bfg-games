import { z } from 'zod';
import type { Cell, Row, Store, TablesSchema } from 'tinybase';

// TinyBase cells are primitives only: string | number | boolean | null.
// Non-primitive domain fields are JSON-encoded in TinyBase string cells.

export const ROOM_TABLES_SCHEMA = {
  room: {
    inviteCode: { type: 'string', default: '' },
    hostPlayerId: { type: 'string', default: '' },
    hostEncPubKey: { type: 'string', default: '' },
    status: { type: 'string', default: 'waiting' },
    maxPlayers: { type: 'number', default: 8 },
    seed: { type: 'string', default: '' },
    gameType: { type: 'string', default: '' },
    gameConfig: { type: 'string', default: 'null' }, // JSON: unknown
    dropBehavior: { type: 'string', default: 'pause' },
    disconnectGraceMs: { type: 'number', default: 15_000 },
    turnTimeoutMs: { type: 'number', default: 0 }
  },
  players: {
    displayName: { type: 'string', default: '' },
    avatarColor: { type: 'string', default: '' },
    role: { type: 'string', default: 'player' },
    score: { type: 'number', default: 0 },
    isConnected: { type: 'boolean', default: false },
    isReady: { type: 'boolean', default: false },
    joinedAt: { type: 'number', default: 0 },
    lastSeen: { type: 'number', default: 0 },
    signingPubKey: { type: 'string', default: '' },
    encPubKey: { type: 'string', default: '' },
    autoplayMode: { type: 'string', default: 'off' },
    autoplaySince: { type: 'string', default: 'null' } // JSON: number | null
  },
  secretPool: {
    ciphertext: { type: 'string', default: '' },
    iv: { type: 'string', default: '' },
    assignedTo: { type: 'string', default: '' }
  },
  tictactoe: {
    board: { type: 'string', default: 'null' }, // JSON: TicTacToeBoard
    currentPlayerId: { type: 'string', default: 'null' }, // JSON: PlayerId | null
    playerX: { type: 'string', default: '' },
    playerO: { type: 'string', default: '' },
    winnerId: { type: 'string', default: 'null' }, // JSON: PlayerId | null
    isDraw: { type: 'boolean', default: false },
    moveCount: { type: 'number', default: 0 }
  },

  // ── Shared-state v1 (see platform/shared-types/src/core/shared-state.ts) ──
  submissions: {
    fromPlayerId: { type: 'string', default: '' },
    toHostCiphertext: { type: 'string', default: '' },
    iv: { type: 'string', default: '' },
    signature: { type: 'string', default: '' },
    nonce: { type: 'number', default: 0 },
    createdAt: { type: 'number', default: 0 },
    gameType: { type: 'string', default: '' },
    kind: { type: 'string', default: '' }
  },
  events: {
    seq: { type: 'number', default: 0 },
    createdAt: { type: 'number', default: 0 },
    gameType: { type: 'string', default: '' },
    kind: { type: 'string', default: '' },
    publicPayload: { type: 'string', default: 'null' }, // JSON: unknown
    fromPlayerId: { type: 'string', default: 'null' }, // JSON: PlayerId | null
    hostSignature: { type: 'string', default: '' }
  },
  eventsPrivate: {
    evtId: { type: 'string', default: '' },
    playerId: { type: 'string', default: '' },
    ciphertextToPlayer: { type: 'string', default: '' },
    iv: { type: 'string', default: '' }
  },
  gameStatePublic: {
    seq: { type: 'number', default: 0 },
    state: { type: 'string', default: 'null' }, // JSON: unknown
    hostSignature: { type: 'string', default: '' }
  },
  gameStateHistory: {
    seq: { type: 'number', default: 0 },
    state: { type: 'string', default: 'null' } // JSON: unknown
  },
  gameStatePrivate: {
    // Discriminator: 'plain' | 'encrypted'. Only the columns matching `kind`
    // are read; the others sit at default and are stripped by Zod.
    kind: { type: 'string', default: 'plain' },
    seq: { type: 'number', default: 0 },
    state: { type: 'string', default: 'null' }, // JSON: unknown (kind=plain)
    ciphertext: { type: 'string', default: '' }, // (kind=encrypted)
    iv: { type: 'string', default: '' } // (kind=encrypted)
  },
  // ── Lobby chat (host-authenticated, see platform/shared-types/src/core/lobby-chat.ts) ──
  chatSubmissions: {
    fromPlayerId: { type: 'string', default: '' },
    toHostCiphertext: { type: 'string', default: '' },
    iv: { type: 'string', default: '' },
    signature: { type: 'string', default: '' },
    nonce: { type: 'number', default: 0 },
    createdAt: { type: 'number', default: 0 }
  },
  chatEvents: {
    seq: { type: 'number', default: 0 },
    createdAt: { type: 'number', default: 0 },
    fromPlayerId: { type: 'string', default: '' },
    text: { type: 'string', default: '' },
    hostSignature: { type: 'string', default: '' }
  }
} as const satisfies TablesSchema;

const JSON_FIELDS: Record<string, Set<string>> = {
  room: new Set(['gameConfig']),
  players: new Set(['autoplaySince']),
  tictactoe: new Set(['board', 'currentPlayerId', 'winnerId']),
  events: new Set(['publicPayload', 'fromPlayerId']),
  gameStatePublic: new Set(['state']),
  gameStateHistory: new Set(['state']),
  gameStatePrivate: new Set(['state'])
};

function decodeRow(tableId: string, row: Row): Record<string, unknown> {
  const jsonFields = JSON_FIELDS[tableId] ?? new Set<string>();
  return Object.fromEntries(
    Object.entries(row).map(([k, v]) => (jsonFields.has(k) ? [k, JSON.parse(v as string)] : [k, v]))
  );
}

function encodeRow(tableId: string, obj: Record<string, unknown>): Row {
  const jsonFields = JSON_FIELDS[tableId] ?? new Set<string>();
  return Object.fromEntries(
    Object.entries(obj).map(([k, v]) => (jsonFields.has(k) ? [k, JSON.stringify(v)] : [k, v]))
  ) as Record<string, Cell>;
}

export function readRow<T>(zodSchema: z.ZodSchema<T>, store: Store, tableId: string, rowId: string): T | null {
  const raw = store.getRow(tableId, rowId);
  if (!raw || Object.keys(raw).length === 0) return null;
  return zodSchema.parse({ id: rowId, ...decodeRow(tableId, raw) });
}

export function writeRow<T extends { id: unknown }>(store: Store, tableId: string, value: T): void {
  const { id, ...rest } = value as Record<string, unknown>;
  store.setRow(tableId, String(id), encodeRow(tableId, rest));
}

export function readAllRows<T>(zodSchema: z.ZodSchema<T>, store: Store, tableId: string): T[] {
  return Object.keys(store.getTable(tableId)).flatMap((rowId) => {
    const row = readRow(zodSchema, store, tableId, rowId);
    return row ? [row] : [];
  });
}

