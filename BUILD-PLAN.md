# Build Plan — TicTacToe Phase 1

> Root handoff document. Start here. Refers to source plans for depth; where source plans conflict, this document is authoritative.

---

## What "done" looks like

Two players open the site in separate browsers, create a room, join via invite link, and play a complete game of TicTacToe — including a disconnected player being advanced via autoplay (player client by default; host takeover only on disconnect/timeout). The full stack is exercised: identity, lobby, WebSocket sync, Godot bridge, game loop, autoplay. No secret messages, no encryption, no acronym game logic — those are deferred.

---

## Source documents

| Document | What it covers |
|---|---|
| `PROJECT-PLAN.md` | Library versions, monorepo layout, type system, TinyBase stores, Cloudflare DO, auth, secret messages, game registry, build pipeline |
| `LOBBY-PLAN.md` | Registration, host/player/observer flows, room store schema, bridge events (with Zod schemas), DO write-auth rules |
| `GAMES-PLAN.md` | Multi-game architecture, visibility model, privacy implementation, `GameDefinition`, RNG utilities |
| `AUTOPLAY-PLAN.md` | Autoplay UX + disconnect/timeout handling, client autoplay with host takeover fallback, per-game autoplay interface, room policy fields |

---

## Corrections to source plans

These inconsistencies exist across the source plans. BUILD-PLAN.md resolves them.

### 1. Route structure
**PROJECT-PLAN.md** shows two routes: `/room/:roomId` (lobby) and `/room/:roomId/play` (game). **LOBBY-PLAN.md** says single route `/room/:roomId/play` for both phases. **Resolution**: single route. Godot canvas is present from room creation; `room.status` drives what Godot renders and which host controls appear in the web chrome.

```
/                       ← home: create or join
/room/:roomId/play      ← single route for lobby + gameplay
/settings               ← local preferences
```

### 2. Bridge global naming
**PROJECT-PLAN.md** uses `window.__acronymApp.onGodotEvent` (game-specific). **Resolution**: standardize to `window.__gameApp.onGodotEvent` across all games. `GodotCanvas.tsx` sets this up on mount; Godot GDScript always calls `window.__gameApp.onGodotEvent(...)`.

### 3. Folder paths — Phase 1 is TicTacToe
Source plans reference `games/acronym/` and `platform/shared-types/src/games/acronym/`. **Resolution**: Phase 1 uses `tictactoe`. Acronym remains the project name but is a deferred game implementation.

### 4. Stale room store prose
The prose table in PROJECT-PLAN.md (room/players rows) predates the schema additions from AUTOPLAY-PLAN.md. The Zod schemas in PROJECT-PLAN.md are correct. Use `zRoom` and `zPlayer` as the authoritative field list — they include `seed`, `dropBehavior`, `disconnectGraceMs`, `turnTimeoutMs`, `autoplayMode`, `autoplaySince`.

### 5. `autoplaySince` comment
The `zPlayer` schema has a comment "set by DO on takeover" — this is wrong per AUTOPLAY-PLAN.md. The host client sets it; DO enforces the write permission.

### 6. Secret message system
Not needed for TicTacToe (fully public game). Entire `secretPool` table, encryption utilities, and `gameKeys` / `playerSecrets` local store tables are deferred. `room.hostEncPubKey` remains in `zRoom` but is unused until secrets are needed.

---

## Repository structure (Phase 1)

```
<repo-root>/
├── package.json                       ← npm workspaces: ["platform/*"]
├── tsconfig.base.json
├── platform/
│   ├── web/                           ← Vite + React SPA
│   │   ├── package.json
│   │   ├── vite.config.ts
│   │   ├── public/
│   │   │   └── godot/
│   │   │       └── tictactoe/         ← Godot web export artifacts
│   │   └── src/
│   │       ├── main.tsx
│   │       ├── router.tsx             ← TanStack Router
│   │       ├── routes/
│   │       │   ├── index.tsx          ← home (create/join)
│   │       │   ├── room.$roomId.play.tsx  ← lobby + game (single route)
│   │       │   └── settings.tsx
│   │       ├── sync/
│   │       │   ├── SyncContext.tsx    ← useRoomStore / useLocalStore
│   │       │   └── tinybase/
│   │       │       ├── schema.ts      ← ROOM_TABLES_SCHEMA + readRow/writeRow codecs
│   │       │       ├── RoomStore.ts   ← MergeableStore + WsSynchronizer + RoomStore adapter
│   │       │       └── LocalStore.ts  ← LocalPersister + LocalStore adapter
│   │       ├── games/
│   │       │   ├── registry.ts        ← GAME_REGISTRY
│   │       │   ├── types.ts           ← GameDefinition<TConfig>
│   │       │   └── tictactoe/
│   │       │       ├── definition.ts  ← TicTacToe GameDefinition
│   │       │       ├── ConfigUI.tsx   ← (empty — no config options)
│   │       │       └── autoplay.ts    ← getAutoplayTriggers, chooseIntent
│   │       ├── godot/
│   │       │   ├── GodotCanvas.tsx
│   │       │   └── bridge.ts
│   │       └── components/
│   │           ├── lobby/
│   │           └── hud/
│   ├── edge/                          ← Cloudflare Worker + DO
│   │   ├── package.json
│   │   ├── wrangler.toml
│   │   └── src/
│   │       ├── index.ts               ← Worker (routes /api/*)
│   │       └── RoomDO.ts              ← extends WsServerDurableObject
│   └── shared-types/
│       ├── package.json
│       └── src/
│           ├── index.ts               ← re-exports core + games
│           ├── core/
│           │   ├── brand.ts
│           │   ├── ids.ts             ← PREFIX, zPlayerId, zRoomId, etc.
│           │   ├── keys.ts            ← zSigningPubKeyBytes, zPlayerEncPubKey, etc.
│           │   ├── schemas.ts         ← zRoom, zPlayer, zSecretPoolItem, zGameType
│           │   ├── store.ts           ← RoomStore + LocalStore interfaces
│           │   └── bridge-events.ts   ← lobby-phase event constants + Zod payload schemas
│           └── games/
│               └── tictactoe/
│                   ├── schemas.ts     ← zTicTacToeConfig, zTicTacToeState, zTicTacToeMove
│                   └── bridge-events.ts  ← game-phase event constants + payload schemas
├── games/
│   └── tictactoe/                     ← Godot 4.6.2-stable project (latest stable as of 2026-04-25)
│       ├── project.godot
│       ├── autoloads/
│       │   └── BridgeProtocol.gd      ← generated by gen:gdscript
│       └── scenes/
│           ├── Lobby.tscn
│           └── Game.tscn
└── scripts/
    ├── godot-export.sh
    └── gen-gdscript-types.ts
```

---

## Technology stack

| Package | Version |
|---|---|
| `tinybase` | 8.2.0 |
| `react` / `react-dom` | 19.2.5 |
| `vite` | 8.0.10 |
| `@tanstack/react-router` | 1.168.24 |
| `zod` | 4.3.6 |
| `typescript` | 6.0.3 |
| `wrangler` | 4.85.0 |
| `@cloudflare/workers-types` | 4.20260425.1 |
| Godot | 4.6.2-stable |

TinyBase's DO synchronizer and SQL storage persister are included in the main `tinybase` package — no separate installs.

**Godot version policy**: use the latest **stable** 4.x maintenance release (not RC/dev). As of 2026-04-25 this is **4.6.2-stable** (see Godot builds releases: `https://github.com/godotengine/godot-builds/releases`).

---

## TicTacToe game specification

### Rules
- Exactly 2 players. `minPlayers: 2`, `maxPlayers: 2`.
- Players are assigned marks at game start: first player connected = X, second = O. Host is X when playing.
- Players alternate turns. X goes first.
- Win: 3 marks in a row (row, column, or diagonal). Draw: all 9 cells filled with no winner.
- Game ends immediately on win or draw → `room.status = 'finished'`.
- No game config options (empty config object).

### Game-specific room store table

```
tictactoe {            ← singleton row; host-only writes
  board:           string   ← JSON: [null|'X'|'O', ...] length 9, row-major (index 0–8)
  currentPlayerId: string   ← PlayerId of whose turn; null before active / after finished
  playerX:         string   ← PlayerId assigned mark 'X'
  playerO:         string   ← PlayerId assigned mark 'O'
  winnerId:        string   ← PlayerId of winner; null if draw or in progress
  isDraw:          boolean
  moveCount:       number
}
```

### Schemas (`platform/shared-types/src/games/tictactoe/schemas.ts`)

```ts
import { z } from 'zod';
import { zPlayerId } from '../../core/ids';

export const zTicTacToeConfig = z.object({});
export type TicTacToeConfig = z.infer<typeof zTicTacToeConfig>;

export const zCellIndex = z.number().int().min(0).max(8);
export type CellIndex = z.infer<typeof zCellIndex>;

export const zMark = z.enum(['X', 'O']);
export type Mark = z.infer<typeof zMark>;

export const zCellValue = zMark.nullable();
export type CellValue = z.infer<typeof zCellValue>;

export const zTicTacToeBoard = z.tuple([
  zCellValue, zCellValue, zCellValue,
  zCellValue, zCellValue, zCellValue,
  zCellValue, zCellValue, zCellValue,
]);
export type TicTacToeBoard = z.infer<typeof zTicTacToeBoard>;

export const zTicTacToeState = z.object({
  board:           zTicTacToeBoard,
  currentPlayerId: zPlayerId.nullable(),
  playerX:         zPlayerId,
  playerO:         zPlayerId,
  winnerId:        zPlayerId.nullable(),
  isDraw:          z.boolean(),
  moveCount:       z.number().int().min(0),
});
export type TicTacToeState = z.infer<typeof zTicTacToeState>;

export const zTicTacToeMove = z.object({
  playerId:  zPlayerId,
  cellIndex: zCellIndex,
});
export type TicTacToeMove = z.infer<typeof zTicTacToeMove>;

// Shared between host game logic and autoplay
export const WIN_LINES = [
  [0, 1, 2], [3, 4, 5], [6, 7, 8],  // rows
  [0, 3, 6], [1, 4, 7], [2, 5, 8],  // columns
  [0, 4, 8], [2, 4, 6],              // diagonals
] as const;
```

### Bridge events (`platform/shared-types/src/games/tictactoe/bridge-events.ts`)

```ts
import { z } from 'zod';
import { zPlayerId } from '../../core/ids';
import { zTicTacToeBoard, zCellIndex, zMark } from './schemas';

// Web → Godot
export const EVT_TTT_STATE_INIT  = 'ttt_state_init'  as const;
export const EVT_TTT_MOVE_MADE   = 'ttt_move_made'   as const;
export const EVT_TTT_GAME_OVER   = 'ttt_game_over'   as const;

// Godot → Web
export const EVT_TTT_PLAYER_MOVE = 'ttt_player_move' as const;

export const zTttStateInitPayload = z.object({
  board:           zTicTacToeBoard,
  currentPlayerId: zPlayerId.nullable(),
  playerX:         zPlayerId,
  playerO:         zPlayerId,
  localPlayerId:   zPlayerId,
});
export type TttStateInitPayload = z.infer<typeof zTttStateInitPayload>;

export const zTttMoveMadePayload = z.object({
  playerId:     zPlayerId,
  mark:         zMark,
  cellIndex:    zCellIndex,
  board:        zTicTacToeBoard,
  nextPlayerId: zPlayerId.nullable(),
});
export type TttMoveMadePayload = z.infer<typeof zTttMoveMadePayload>;

export const zTttGameOverPayload = z.object({
  winnerId:   zPlayerId.nullable(),
  winnerMark: zMark.nullable(),
  isDraw:     z.boolean(),
  board:      zTicTacToeBoard,
});
export type TttGameOverPayload = z.infer<typeof zTttGameOverPayload>;

export const zTttPlayerMovePayload = z.object({
  cellIndex: zCellIndex,
});
export type TttPlayerMovePayload = z.infer<typeof zTttPlayerMovePayload>;
```

### Autoplay strategy

Deterministic, seeded. Seed derived from `room.seed + gameId + moveCount`.

1. Find all empty cells where placing this player's mark would win → play first one.
2. Find all empty cells where opponent's next move would win → block first one.
3. If center (index 4) is empty → take it.
4. Otherwise pick uniformly from remaining empty cells using seeded RNG.

Implemented in `platform/web/src/games/tictactoe/autoplay.ts`. Uses `WIN_LINES` from `shared-types`.

---

## Zod ↔ TinyBase schema mapping

TinyBase cells are primitives only (`string | number | boolean`). Zod schemas are the source of truth for every table shape. A single codec layer in `platform/web/src/sync/tinybase/schema.ts` bridges the two — all reads and writes go through it. **No domain code or game logic ever touches TinyBase APIs directly.**

### Mapping rules

| Zod type | TinyBase cell type | Notes |
|---|---|---|
| `z.string()` / branded string / `z.enum()` | `string` | Pass through as-is |
| `z.number()` | `number` | Pass through as-is |
| `z.boolean()` | `boolean` | Pass through as-is |
| `z.number().nullable()` | `string` | JSON-encoded: `'null'` or `'1714000000000'` |
| `z.unknown()` / `z.tuple()` / `z.array()` / `z.object()` | `string` | JSON-encoded |
| Row ID (`entity.id`) | TinyBase row key | **Not** stored as a cell — injected on read |

### `schema.ts` — TinyBase schema derived from Zod tables

```ts
// platform/web/src/sync/tinybase/schema.ts
import type { TablesSchema } from 'tinybase';

// Each entry mirrors its Zod schema. Row ID (entity.id) is the TinyBase row key.
// Non-primitive fields use type: 'string' and are JSON-encoded at the codec boundary.

export const ROOM_TABLES_SCHEMA = {
  room: {
    inviteCode:         { type: 'string',  default: '' },
    hostPlayerId:       { type: 'string',  default: '' },
    hostEncPubKey:      { type: 'string',  default: '' },
    status:             { type: 'string',  default: 'waiting' },
    maxPlayers:         { type: 'number',  default: 8 },
    seed:               { type: 'string',  default: '' },
    gameType:           { type: 'string',  default: '' },
    gameConfig:         { type: 'string',  default: 'null' },   // JSON: unknown
    dropBehavior:       { type: 'string',  default: 'pause' },
    disconnectGraceMs:  { type: 'number',  default: 15_000 },
    turnTimeoutMs:      { type: 'number',  default: 0 },
  },
  players: {
    displayName:   { type: 'string',  default: '' },
    avatarColor:   { type: 'string',  default: '' },
    role:          { type: 'string',  default: 'player' },
    score:         { type: 'number',  default: 0 },
    isConnected:   { type: 'boolean', default: false },
    isReady:       { type: 'boolean', default: false },
    joinedAt:      { type: 'number',  default: 0 },
    lastSeen:      { type: 'number',  default: 0 },             // epoch ms heartbeat
    signingPubKey: { type: 'string',  default: '' },
    encPubKey:     { type: 'string',  default: '' },
    autoplayMode:  { type: 'string',  default: 'off' },
    autoplaySince: { type: 'string',  default: 'null' },        // JSON: number | null
  },
  secretPool: {
    ciphertext: { type: 'string', default: '' },
    iv:         { type: 'string', default: '' },
    assignedTo: { type: 'string', default: '' },
  },
  tictactoe: {
    board:           { type: 'string',  default: 'null' },      // JSON: TicTacToeBoard
    currentPlayerId: { type: 'string',  default: 'null' },      // JSON: PlayerId | null
    playerX:         { type: 'string',  default: '' },
    playerO:         { type: 'string',  default: '' },
    winnerId:        { type: 'string',  default: 'null' },      // JSON: PlayerId | null
    isDraw:          { type: 'boolean', default: false },
    moveCount:       { type: 'number',  default: 0 },
  },
} as const satisfies TablesSchema;
```

### Row codecs — read and write helpers

```ts
// platform/web/src/sync/tinybase/schema.ts (continued)
import { z } from 'zod';
import type { Store } from 'tinybase';

// JSON-encoded field names per table — must match the 'string' cells above that hold non-string values
const JSON_FIELDS: Record<string, Set<string>> = {
  room:      new Set(['gameConfig']),
  players:   new Set(['autoplaySince']),
  tictactoe: new Set(['board', 'currentPlayerId', 'winnerId']),
};

function decodeRow(tableId: string, row: Record<string, string | number | boolean>) {
  const jsonFields = JSON_FIELDS[tableId] ?? new Set();
  return Object.fromEntries(
    Object.entries(row).map(([k, v]) =>
      jsonFields.has(k) ? [k, JSON.parse(v as string)] : [k, v]
    )
  );
}

function encodeRow(tableId: string, obj: Record<string, unknown>) {
  const jsonFields = JSON_FIELDS[tableId] ?? new Set();
  return Object.fromEntries(
    Object.entries(obj).map(([k, v]) =>
      jsonFields.has(k) ? [k, JSON.stringify(v)] : [k, v]
    )
  ) as Record<string, string | number | boolean>;
}

// Read: inject rowId as 'id', decode JSON fields, validate through Zod schema
export function readRow<T>(
  zodSchema: z.ZodSchema<T>,
  store: Store,
  tableId: string,
  rowId: string,
): T | null {
  const raw = store.getRow(tableId, rowId);
  if (!raw || Object.keys(raw).length === 0) return null;
  return zodSchema.parse({ id: rowId, ...decodeRow(tableId, raw) });
}

// Write: JSON-encode non-primitive fields, strip 'id' (becomes row key)
export function writeRow<T extends { id: unknown }>(
  store: Store,
  tableId: string,
  value: T,
): void {
  const { id, ...rest } = value as Record<string, unknown>;
  store.setRow(tableId, String(id), encodeRow(tableId, rest));
}

// Convenience: read all rows in a table as validated domain objects
export function readAllRows<T>(
  zodSchema: z.ZodSchema<T>,
  store: Store,
  tableId: string,
): T[] {
  return Object.keys(store.getRowIds(tableId)).flatMap(rowId => {
    const row = readRow(zodSchema, store, tableId, rowId);
    return row ? [row] : [];
  });
}
```

### Usage in `RoomStore.ts` (TinyBase adapter)

```ts
import { readRow, writeRow, readAllRows, ROOM_TABLES_SCHEMA } from './schema';
import { zPlayer, zRoom } from '@brute-force-games/shared-types';

// On store creation — set schema so TinyBase enforces cell types + defaults
store.setTablesSchema(ROOM_TABLES_SCHEMA);

// Read — Zod validates, JSON fields decoded automatically
const player = readRow(zPlayer, store, 'players', playerId);

// Write — JSON fields encoded automatically, id becomes row key
writeRow(store, 'players', playerDomainObject);

// Subscribe — callback receives validated domain type
store.addRowListener('players', null, (_, tableId, rowId) => {
  const player = readRow(zPlayer, store, tableId, rowId);
  if (player) cb(player);
});
```

This is the only place in the codebase where TinyBase's `getRow` / `setRow` / `addRowListener` are called. Everything above this layer works with `Player`, `Room`, `TicTacToeState` — never raw TinyBase primitives.

---

## Implementation phases

Complete each phase fully before starting the next. Phases 0–5 build the platform; 6–8 deliver the working game.

---

### Phase 0 — Monorepo scaffold

**Goal**: empty repo compiles, workspaces resolve, codegen runs.

- [ ] Root `package.json` — workspaces: `["platform/*"]`, shared dev scripts
- [ ] `tsconfig.base.json` — strict, path alias `@brute-force-games/shared-types → platform/shared-types/src`
- [ ] `platform/shared-types/` — `package.json`, `tsconfig.json`
- [ ] `platform/web/` — `package.json`, `vite.config.ts`, `tsconfig.json`
- [ ] `platform/edge/` — `package.json`, `wrangler.toml`, `tsconfig.json`
- [ ] All of `platform/shared-types/src/core/` — `brand.ts`, `ids.ts`, `keys.ts`, `schemas.ts`, `store.ts`, `bridge-events.ts`
- [ ] `platform/shared-types/src/games/tictactoe/schemas.ts` + `bridge-events.ts`
- [ ] `platform/web/src/sync/tinybase/schema.ts` — `ROOM_TABLES_SCHEMA`, `readRow`, `writeRow`, `readAllRows`, `JSON_FIELDS` (add `tictactoe` entry here; all future game tables added here too)
- [ ] `platform/shared-types/src/index.ts`
- [ ] `scripts/gen-gdscript-types.ts` — emits `games/tictactoe/autoloads/BridgeProtocol.gd` from core + tictactoe sources
- [ ] `games/tictactoe/` — Godot project skeleton, empty `autoloads/BridgeProtocol.gd`
- [ ] `npm run gen:gdscript` wired in root `package.json`
- [ ] Verify: `tsc --noEmit` passes in all three packages

---

### Phase 1 — Player identity

**Goal**: first-visit keypair generation and persistence; returning visitor reuses identity.

- [ ] `platform/web/src/sync/tinybase/LocalStore.ts`
  - `createLocalPersister` → `localStorage`; tables: `identity`, `preferences`
  - `LocalStore` interface adapter
- [ ] `platform/shared-types/src/core/identity.ts`
  - `generateIdentity()` — Ed25519 + X25519 via `crypto.subtle`
  - `derivePlayerId(signingPubKey)` → `"plyr_" + base64url(rawBytes)`
  - `signChallenge(nonce, privKey)` → `Signature`
  - `verifySignature(nonce, sig, pubKey)` → `boolean`
- [ ] `platform/web/src/sync/SyncContext.tsx` — provides `useLocalStore()`
- [ ] First-visit onboarding UI — display name + avatar color modal on `/`; writes to local store

---

### Phase 2 — Web shell + routing

**Goal**: navigable app; create/join home page; room URL resolves; invite link carries code.

- [ ] TanStack Router in `platform/web/src/router.tsx`
- [ ] Route `/` — "New Game" → generate `roomId` + `inviteCode` client-side → navigate to `/room/:roomId/play?invite=<code>`; join input accepts full invite URL or room code
- [ ] Route `/room/:roomId/play` — shell only (no sync yet); reads `?invite=<code>`
- [ ] Route `/settings` — display name + avatar editor
- [ ] `platform/web/src/games/types.ts` — `GameDefinition<TConfig>` interface
- [ ] `platform/web/src/games/registry.ts` — `GAME_REGISTRY` with TicTacToe
- [ ] `platform/web/src/games/tictactoe/definition.ts` — `TicTacToeGameDefinition` (empty `ConfigUI`)

---

### Phase 3 — Edge: deferred

`platform/edge/` is scaffolded (package.json, wrangler.toml, empty src/) but not implemented in Phase 1. Phase 1 uses the **TinyBase public demo DO server** directly — no self-hosted Worker or Durable Object needed.

The self-hosted DO (with SQL persister, `isConnected` tracking, auth, and write-auth) is implemented in Phase 9. The client-side `RoomStore` adapter requires no changes when switching — only the `wsUrl` changes.

- [ ] Create `platform/edge/` scaffold (package.json, wrangler.toml stub, empty `src/`) so the workspace compiles
- [ ] Document the Phase 9 DO implementation plan in `platform/edge/src/RoomDO.ts` as comments/stubs

---

### Phase 4 — Sync layer

**Goal**: two browser tabs connect to the public demo server and see each other's player rows live.

Room IDs are generated client-side — no server round-trip needed.

```ts
// Room creation (client-side, no POST /api/rooms)
const roomId = makeId('room');         // e.g. "room_01HX..."
const inviteCode = generateShortCode(); // e.g. "XK4F2A"
navigate(`/room/${roomId}/play?invite=${inviteCode}`);

// WebSocket URL — TinyBase public demo DO server
// Verify current URL in TinyBase docs: https://tinybase.org/guides/synchronization/
// As of 2026-04-25, the public demo server base URL is: wss://todo.demo.tinybase.org/
const wsUrl = `wss://todo.demo.tinybase.org/${roomId}`;
```

- [ ] `platform/web/src/sync/tinybase/RoomStore.ts`
  - `createMergeableStore()` — call `store.setTablesSchema(ROOM_TABLES_SCHEMA)` immediately after creation
  - `createWsSynchronizer(store, new WebSocket(wsUrl))`
  - All reads via `readRow` / `readAllRows` — never raw `store.getRow()`
  - All writes via `writeRow` — never raw `store.setRow()`
  - `RoomStore` interface adapter: subscriptions use `store.addRowListener` internally, emit validated domain types to callers
- [ ] Wire `SyncContext.tsx` to provide `useRoomStore()`
- [ ] On connect: write `isConnected: true`, `lastSeen: Date.now()` to own player row
- [ ] Heartbeat loop: `setInterval(() => writeRow(store, 'players', { ...self, lastSeen: Date.now() }), HEARTBEAT_INTERVAL_MS)` — `HEARTBEAT_INTERVAL_MS = 5_000`
- [ ] On synchronizer disconnect event: write `isConnected: false` to own player row (best-effort; may not reach server if connection is fully dead)
- [ ] `isConnected` on the public demo server is best-effort — `lastSeen` staleness is the authoritative signal for autoplay decisions
- [ ] Smoke test: player rows appear across tabs; `lastSeen` ticks every 5 s; validated `Player` objects log correctly

---

### Phase 5 — Full lobby flow

**Goal**: host creates, player joins, both see each other, host starts — all status transitions working.

- [ ] Host flow on connect: write `room` row (status `'waiting'`, seed, `dropBehavior`), write self to `players` with full `zPlayer` fields including `signingPubKey` and `encPubKey` from local identity (`role: 'host'`, `isConnected: true`)
- [ ] Invite URL + QR code (`react-qr-code`) in host panel
- [ ] Player join: connect → write self to `players` with full `zPlayer` fields including keys (`role: 'player'`, `isConnected: true`); `isReady` acknowledgement
- [ ] Observer: arrive at room URL without joining → just don't write a `players` row; read-only by convention (no enforcement in Phase 1 — deferred to Phase 9)
- [ ] "Start Game" button — enabled when exactly 2 players connected and both `isReady`; host writes `status = 'starting'`
- [ ] `status` machine: `waiting → starting → active → finished`
  - `starting`: `EVT_LOBBY_STARTING` to Godot → `EVT_GODOT_READY` back → host writes `status = 'active'`
- [ ] Host reassignment: client-side only for Phase 1 — host client monitors its own connection; if host disconnects and reconnects, it reclaims host role by checking `players` table on sync resume. DO-level host reassignment is deferred to Phase 9.

---

### Phase 6 — Godot bridge + TicTacToe skeleton

**Goal**: Godot canvas mounts; lobby events reach Godot; Godot can send a move back.

- [ ] `platform/web/src/godot/bridge.ts`
  - `sendToGodot(event, payload)` — Zod-validates then calls `window.__godotBridge.receive(event, JSON.stringify(payload))`
  - Sets `window.__gameApp = { onGodotEvent }` — inbound events Zod-validated here
- [ ] `platform/web/src/godot/GodotCanvas.tsx`
  - Loads from `public/godot/<gameType>/`; sets up `window.__gameApp` on mount
  - Sends `EVT_LOBBY_INIT` with full player snapshot (including connectivity state) on mount
  - Subscribes to `onPlayerJoined`, `onPlayerLeft`, `onPlayerChanged` → forwards as bridge events
- [ ] `npm run gen:gdscript` → generates `games/tictactoe/autoloads/BridgeProtocol.gd`
- [ ] Godot `Lobby.tscn`
  - Handles `EVT_LOBBY_INIT`, `EVT_PLAYER_JOINED`, `EVT_PLAYER_LEFT`, `EVT_PLAYER_CONNECTIVITY_CHANGED`
  - Handles `EVT_LOBBY_STARTING` → transition animation → `window.__gameApp.onGodotEvent('godot_ready', {})`
- [ ] Godot `Game.tscn`
  - Handles `EVT_TTT_STATE_INIT` → renders board + marks
  - Handles `EVT_TTT_MOVE_MADE` → animates mark
  - Handles `EVT_TTT_GAME_OVER` → result screen
  - Fires `EVT_TTT_PLAYER_MOVE { cellIndex }` when local player taps a cell
- [ ] Export (Godot 4.6.2-stable editor + matching 4.6.2 export templates): `npm run godot:export:tictactoe` → `platform/web/public/godot/tictactoe/`
- [ ] Verify bridge round-trip end-to-end

---

### Phase 7 — TicTacToe game loop

**Goal**: complete game plays out correctly; win and draw detection; game over state.

**Move authority**: each player writes their own move directly to the `tictactoe` table (Option A). Validation is client-side only in Phase 1 — the demo DO accepts all writes. Host detects the write via `roomStore` subscription, checks for win/draw, and writes the resulting game state. DO-level turn enforcement is deferred to Phase 9.

- [ ] Game start (host, on `status → 'active'`)
  - Assign `playerX` (first connected), `playerO` (second)
  - Write initial `tictactoe` row: empty board, `currentPlayerId = playerX`, `moveCount = 0`
  - Send `EVT_TTT_STATE_INIT` to Godot (each client gets `localPlayerId` injected by React before sending)
- [ ] Move submission (each player's client)
  - Godot fires `EVT_TTT_PLAYER_MOVE { cellIndex }`
  - React validates locally: `room.status === 'active'`, `currentPlayerId === localPlayerId`, cell is null
  - Writes move to `tictactoe` table (client-side validation only; DO accepts all writes in Phase 1)
- [ ] Post-move update (host client, via `roomStore` subscription on `tictactoe` changes)
  - Check `WIN_LINES` — if winner: write `winnerId`, `winnerMark`, `room.status = 'finished'`
  - If `moveCount === 9` with no winner: write `isDraw = true`, `room.status = 'finished'`
  - Otherwise: advance `currentPlayerId`, increment `moveCount`
  - Send `EVT_TTT_MOVE_MADE` to Godot after each confirmed move
  - Send `EVT_TTT_GAME_OVER` on finish
- [ ] Rematch: host writes `room.status = 'waiting'`; clears `tictactoe` row; resets `players[id].isReady`

---

### Phase 8 — Autoplay (disconnect handling)

**Goal**: disconnected player's seat continues without stalling the game.

- [ ] `platform/web/src/games/tictactoe/autoplay.ts`
  - `getAutoplayTriggers(state)` → `['turnStart']`
  - `chooseIntent(ctx)` → win → block → center → seeded random empty cell
- [ ] **Per-game Autoplay button**
  - Current player can click **Autoplay** to advance their turn with a valid intent (single-step), rather than deciding manually.
- [ ] `platform/web/src/sync/autoplay/DisconnectMonitor.ts`
  - Polls `roomStore.getPlayers()` on an interval (or subscribes to `onPlayerChanged`)
  - A seat is considered **disconnected** when `Date.now() - player.lastSeen > STALE_THRESHOLD_MS` where `STALE_THRESHOLD_MS = HEARTBEAT_INTERVAL_MS * 3` (15 s) — three missed heartbeats
  - `isConnected` is also watched, but `lastSeen` staleness is the primary signal (catches zombie connections)
  - On stale detection: starts `disconnectGraceMs` timer; cancels if `lastSeen` refreshes within grace window
  - **Normal case (preferred)**: player client runs autoplay for self (button or enabled mode) and submits intents normally
  - **Fallback (only when stale/disconnected past grace)**: host takes over
    - writes `players[id].autoplayMode = 'do'`, `autoplaySince = now`
    - calls `chooseIntent` on each turn trigger on behalf of the dropped seat
    - writes moves to room store tagged with `targetPlayerId`
  - On `lastSeen` refresh (reconnect): writes `autoplayMode = 'off'`, `autoplaySince = null`
- [ ] `EVT_PLAYER_CONNECTIVITY_CHANGED` sent to Godot on every `isConnected` / `autoplayMode` / `autoplaySince` change
- [ ] **Phase 9 note**: replace `lastSeen` polling with server-side DO ping/pong; `isConnected` becomes authoritative; `DisconnectMonitor` logic unchanged, only the trigger source changes

---

## Phase 9 — Own Durable Object server (deferred)

Set up after Phase 1 is validated end-to-end. The client-side `RoomStore` adapter requires **no changes** — only `wsUrl` switches from the public demo server to the self-hosted Worker endpoint.

- **Self-hosted `RoomDO`**: `WsServerDurableObject` + `createDurableObjectSqlStoragePersister` + `webSocketClose` override for reliable `isConnected` tracking
- **Worker routing**: `POST /api/rooms` (server-generated roomId/inviteCode), WebSocket upgrade handler
- **Challenge-response auth**: `POST /api/rooms/:id/auth` + `/auth/verify`; DO validates sessionToken in `fetch()`
- **DO write-auth enforcement**: `webSocketMessage()` override checking the write-auth table (host-only fields, turn ownership, per-player rows, observer drop)
- **Host reassignment**: DO-level `webSocketClose` writing `role = 'host'` to next oldest connection
- **Secret message system**: `secretPool`, ECDH encryption, `gameKeys` / `playerSecrets` local store tables

---

## Deferred

- Acronym game mechanics and Godot project
- Hangman, Bingo, GoFish
- `turnTimeoutMs` hard deadline (`dropBehavior: 'skip'` / `'autoplay'` on timeout)
- P2P sync backends (Trystero, BitSocial)
- Host-configurable game config (TicTacToe has none; wire up `ConfigUI` when a game needs it)
- `@tanstack/router-devtools` (add after routes are stable)

---

## Open questions

- **`room.seed` init**: generate with CSPRNG at `POST /api/rooms` (recommended) vs host-settable. Use CSPRNG for Phase 1.
- **Rematch flow**: `status = 'waiting'` as rematch trigger is simplest; verify it's sufficient before adding a distinct state.
- **`connectionMap` availability** (Phase 9): when building the self-hosted DO, the `webSocketClose` override needs to resolve `playerId` from the closing WebSocket. Confirm `this.connectionMap` is accessible on `WsServerDurableObject`, or track the mapping in the subclass directly.
