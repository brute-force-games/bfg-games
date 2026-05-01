import { z } from 'zod';
import type { Cell, Store, TablesSchema } from 'tinybase';

// TinyBase v8+ stores objects and arrays as native cell values, serializing
// them internally. No manual JSON encode/decode is needed for complex fields.

export const ROOM_TABLES_SCHEMA = {
  room: {
    inviteCode: { type: 'string', default: '' },
    hostPlayerId: { type: 'string', default: '' },
    hostEncPubKey: { type: 'string', default: '' },
    status: { type: 'string', default: 'waiting' },
    maxPlayers: { type: 'number', default: 8 },
    seed: { type: 'string', default: '' },
    gameType: { type: 'string', default: '' },
    gameConfig: { type: 'object', default: {} },
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
    autoplaySince: { type: 'number', default: null, allowNull: true }
  },
  secretPool: {
    ciphertext: { type: 'string', default: '' },
    iv: { type: 'string', default: '' },
    assignedTo: { type: 'string', default: '' }
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
    kind: { type: 'string', default: '' },
    publicPayload: { type: 'object', default: {} },
    fromPlayerId: { type: 'string', default: null, allowNull: true },
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
    state: { type: 'object', default: {} },
    hostSignature: { type: 'string', default: '' }
  },
  gameStateHistory: {
    seq: { type: 'number', default: 0 },
    state: { type: 'object', default: {} },
    hostSignature: { type: 'string', default: '' }
  },
  gameStatePrivate: {
    // Discriminator: 'plain' | 'encrypted'. Only the columns matching `kind`
    // are read; the others sit at default and are stripped by Zod.
    kind: { type: 'string', default: 'plain' },
    seq: { type: 'number', default: 0 },
    state: { type: 'object', default: {} }, // (kind=plain)
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

export function readRow<T>(zodSchema: z.ZodSchema<T>, store: Store, tableId: string, rowId: string): T | null {
  const raw = store.getRow(tableId, rowId);
  if (!raw || Object.keys(raw).length === 0) return null;
  return zodSchema.parse({ id: rowId, ...raw });
}

export function writeRow<T extends { id: unknown }>(store: Store, tableId: string, value: T): void {
  const { id, ...rest } = value as Record<string, unknown>;
  store.setRow(tableId, String(id), rest as Record<string, Cell>);
}

export function readAllRows<T>(zodSchema: z.ZodSchema<T>, store: Store, tableId: string): T[] {
  return Object.keys(store.getTable(tableId)).flatMap((rowId) => {
    const row = readRow(zodSchema, store, tableId, rowId);
    return row ? [row] : [];
  });
}
