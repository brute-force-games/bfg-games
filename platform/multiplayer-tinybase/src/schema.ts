import { z } from 'zod';
import type { Cell, Store, TablesSchema } from 'tinybase';
import { createZodSchematizer } from 'tinybase/schematizers/schematizer-zod';
import {
  zAutoplayMode,
  zDropBehavior,
  zPlayerRole,
  zRoomStatus
} from '@brute-force-games/shared-types';

/** JSON-serializable object cell — TinyBase stores plain objects; Zod schematizer maps `z.record` to `object`. */
const zJsonObjectCell = () => z.record(z.string(), z.unknown()).default({});

const zGameStatePrivateKind = z.enum(['plain', 'encrypted']);

const zRoomRow = z.object({
  inviteCode: z.string().default(''),
  hostPlayerId: z.string().default(''),
  hostEncPubKey: z.string().default(''),
  status: zRoomStatus.default('waiting'),
  maxPlayers: z.number().default(8),
  seed: z.string().default(''),
  gameType: z.string().default(''),
  gameConfig: zJsonObjectCell(),
  dropBehavior: zDropBehavior.default('pause'),
  disconnectGraceMs: z.number().default(15_000),
  turnTimeoutMs: z.number().default(0)
});

const zPlayersRow = z.object({
  displayName: z.string().default(''),
  avatarColor: z.string().default(''),
  role: zPlayerRole.default('player'),
  score: z.number().default(0),
  isConnected: z.boolean().default(false),
  isReady: z.boolean().default(false),
  joinedAt: z.number().default(0),
  lastSeen: z.number().default(0),
  signingPubKey: z.string().default(''),
  encPubKey: z.string().default(''),
  autoplayMode: zAutoplayMode.default('off'),
  autoplaySince: z.number().nullable().default(null)
});

const zSecretPoolRow = z.object({
  ciphertext: z.string().default(''),
  iv: z.string().default(''),
  assignedTo: z.string().default('')
});

const zSubmissionsRow = z.object({
  fromPlayerId: z.string().default(''),
  toHostCiphertext: z.string().default(''),
  iv: z.string().default(''),
  signature: z.string().default(''),
  nonce: z.number().default(0),
  createdAt: z.number().default(0),
  gameType: z.string().default(''),
  kind: z.string().default('')
});

const zEventsRow = z.object({
  seq: z.number().default(0),
  createdAt: z.number().default(0),
  kind: z.string().default(''),
  publicPayload: zJsonObjectCell(),
  fromPlayerId: z.string().nullable().default(null),
  hostSignature: z.string().default('')
});

const zEventsPrivateRow = z.object({
  evtId: z.string().default(''),
  playerId: z.string().default(''),
  ciphertextToPlayer: z.string().default(''),
  iv: z.string().default('')
});

const zGameStatePublicRow = z.object({
  seq: z.number().default(0),
  state: zJsonObjectCell(),
  hostSignature: z.string().default('')
});

const zGameStateHistoryRow = z.object({
  seq: z.number().default(0),
  state: zJsonObjectCell(),
  hostSignature: z.string().default('')
});

const zGameStatePrivateRow = z.object({
  kind: zGameStatePrivateKind.default('plain'),
  seq: z.number().default(0),
  state: zJsonObjectCell(),
  ciphertext: z.string().default(''),
  iv: z.string().default('')
});

const zChatSubmissionsRow = z.object({
  fromPlayerId: z.string().default(''),
  toHostCiphertext: z.string().default(''),
  iv: z.string().default(''),
  signature: z.string().default(''),
  nonce: z.number().default(0),
  createdAt: z.number().default(0)
});

const zChatEventsRow = z.object({
  seq: z.number().default(0),
  createdAt: z.number().default(0),
  fromPlayerId: z.string().default(''),
  text: z.string().default(''),
  hostSignature: z.string().default('')
});

export const ROOM_TABLES_SCHEMA: TablesSchema = createZodSchematizer().toTablesSchema({
  room: zRoomRow,
  players: zPlayersRow,
  secretPool: zSecretPoolRow,
  submissions: zSubmissionsRow,
  events: zEventsRow,
  eventsPrivate: zEventsPrivateRow,
  gameStatePublic: zGameStatePublicRow,
  gameStateHistory: zGameStateHistoryRow,
  gameStatePrivate: zGameStatePrivateRow,
  chatSubmissions: zChatSubmissionsRow,
  chatEvents: zChatEventsRow
});

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
