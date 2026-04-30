# Acronym Game — Final Plan

> Ready for implementation review. Open questions marked ❓.

---

## Library versions (latest stable as of plan date)

| Package | Version |
|---|---|
| `tinybase` | 8.2.0 |
| `react` / `react-dom` | 19.2.5 |
| `vite` | 8.0.10 |
| `@tanstack/react-router` | 1.168.24 |
| `@tanstack/router-devtools` | 1.166.13 |
| `zod` | 4.3.6 |
| `typescript` | 6.0.3 |
| `wrangler` | 4.85.0 |
| `@cloudflare/workers-types` | 4.20260425.1 |
| Godot | 4.6.2 |

TinyBase's DO synchronizer (`tinybase/synchronizers/synchronizer-ws-server-durable-object`) and SQL storage persister (`tinybase/persisters/persister-durable-object-sql-storage`) are included in the main `tinybase` package — no separate installs.

---

## Repository layout

```
<repo-root>/
├── package.json                      ← npm workspaces: ["platform/*"]
├── tsconfig.base.json                ← shared TS settings (strict, path aliases)
├── platform/
│   ├── web/                          ← Vite + React SPA (Cloudflare Pages)
│   ├── edge/                         ← Cloudflare Worker + Durable Objects
│   └── shared-types/                 ← single npm workspace package
│       └── src/
│           ├── core/
│           │   ├── brand.ts          ← Brand<T,B> utility + z.brand() helpers
│           │   ├── ids.ts            ← PREFIX registry, make/parse/is/strip; zId schemas
│           │   ├── keys.ts           ← zSigningPubKey, zPlayerEncPubKey, etc. — types inferred
│           │   ├── schemas.ts        ← zRoom, zPlayer, zSecretPoolItem, zGameType, etc.
│           │   │                        all domain types inferred: type Room = z.infer<typeof zRoom>
│           │   ├── store.ts          ← RoomStore + LocalStore interfaces (use inferred types)
│           │   └── bridge-events.ts  ← lobby-phase event name constants + zod payload schemas
│           └── games/
│               └── acronym/
│                   ├── schemas.ts       ← zRound, zSubmission, zAcronymConfig
│                   │                      types inferred: type Round = z.infer<typeof zRound>
│                   └── bridge-events.ts ← game-phase event constants + payload schemas
├── games/
│   └── acronym/                      ← Godot 4.6.2 project (acronym game)
└── scripts/
    ├── godot-export.sh               ← headless Godot exports → platform/web/public/godot/
    └── gen-gdscript-types.ts         ← codegen: core + per-game → games/<name>/autoloads/BridgeProtocol.gd
```

`platform/shared-types/` is one npm package consumed by both `platform/web/` and `platform/edge/`. Godot projects under `games/` consume it only via generated `.gd` autoloads — never TypeScript directly.

Adding a new game:
1. Create `games/<name>/` Godot project
2. Add `platform/shared-types/src/games/<name>/` types + config schema
3. Register `GameDefinition` in `platform/web/src/games/registry.ts`
4. Add `godot:export:<name>` script in root `package.json`

---

## Sync abstraction layer

Game mechanics, lobby logic, and bridge event triggers must not depend on TinyBase directly. A `SyncProvider` abstraction sits between them and the underlying transport so the backend can be swapped (e.g. TinyBase + Durable Objects → Trystero P2P → BitSocial) without touching game or lobby code.

### Interfaces (`platform/shared-types/src/core/store.ts`)

```ts
// Read + subscribe
interface RoomStore {
  // State access
  getRoom(): Room
  getPlayers(): Player[]
  getSecretPool(): SecretPoolItem[]

  // Subscriptions — return unsubscribe fn
  onRoomChange(cb: (room: Room) => void): () => void
  onPlayerJoined(cb: (player: Player) => void): () => void
  onPlayerLeft(cb: (playerId: PlayerId) => void): () => void
  onPlayerChanged(cb: (player: Player) => void): () => void
  onSecretAssigned(cb: (item: SecretPoolItem) => void): () => void
  onGameConfigChanged(cb: (type: GameType, config: GameConfigJson) => void): () => void
  onStatusChanged(cb: (status: RoomStatus) => void): () => void

  // Intents — validated and applied by the authority (DO or host peer)
  setReady(playerId: PlayerId, ready: boolean): void
  setStatus(status: RoomStatus): void          // host only
  setGameType(gameType: GameType): void        // host only
  setGameConfig(config: GameConfigJson): void  // host only
  assignSecret(item: SecretPoolItem): void     // host only

  // Lifecycle
  connect(opts: ConnectOptions): Promise<void>
  disconnect(): void
}

// Local (never synced)
interface LocalStore {
  getIdentity(): PlayerIdentity | null
  saveIdentity(identity: PlayerIdentity): void
  getPreferences(): Preferences
  savePreferences(prefs: Preferences): void
  getGameKeys(gameId: GameId): GameKeys | null
  saveGameKeys(keys: GameKeys): void
  getSecretDeck(gameId: GameId): string[]
  saveSecretDeck(gameId: GameId, deck: string[]): void
}
```

### Implementations (`platform/web/src/sync/`)

```
platform/web/src/sync/
  tinybase/
    RoomStore.ts      ← createMergeableStore + createWsSynchronizer + adapter
    LocalStore.ts     ← createLocalPersister + adapter
  trystero/           ← future P2P implementation
    RoomStore.ts
```

`tinybase/RoomStore` is the default. Swapping to Trystero means providing a `trystero/RoomStore` that satisfies the same interface — no changes to lobby, game, or bridge code.

### React context

```ts
// platform/web/src/sync/SyncContext.tsx
const SyncContext = createContext<{ room: RoomStore; local: LocalStore } | null>(null);
export const useRoomStore = () => useContext(SyncContext)!.room;
export const useLocalStore = () => useContext(SyncContext)!.local;
```

All lobby components, game mechanics, and bridge event triggers consume `useRoomStore()` — never TinyBase APIs directly.

### Authority model per backend

| Backend | Authority | Host enforcement |
|---|---|---|
| TinyBase + DO | Durable Object | DO intercepts merge ops in `webSocketMessage` |
| Trystero / P2P | Host peer | Host's `RoomStore` rejects invalid intents before re-broadcasting |
| BitSocial | TBD | Same host-peer model |

For P2P backends, `platform/edge/` is not used. The host's `RoomStore` implementation takes on the validation role that the DO handles in the TinyBase backend.

### What is NOT abstracted

- `platform/edge/` is TinyBase-specific — it only exists for the DO backend
- The local store is always TinyBase (no reason to swap persistent local storage)
- Godot bridge events are transport-agnostic already — they fire from `RoomStore` subscriptions

---

## Branded type system

**Principle: Zod schemas are the single source of truth. All domain types are inferred from Zod schemas via `z.infer`. Branded types use Zod's `.brand()` — never a separate `type Foo = Brand<string, 'Foo'>` declaration alongside a schema.**

```
Zod schema (.brand(), .transform(), .refine())
  └── z.infer<typeof zFoo>  →  TypeScript type (branded)
                                  ↕
                          Backend adapter
                          (serialize/deserialize per backend)
```

This gives one definition per type, runtime validation at all boundaries, and compile-time safety through inference.

### IDs (`core/ids.ts`)

All entity IDs use `"<prefix>_<ulid>"`. The Zod schema validates the prefix and produces the branded type.

```ts
export const PREFIX = {
  player:     'plyr',
  room:       'room',
  game:       'game',
  round:      'rnd',
  submission: 'sub',
  secretPool: 'spol',
} as const;

// Pattern for every ID type:
export const zPlayerId = z.string()
  .refine(s => s.startsWith(PREFIX.player + '_'), 'Invalid PlayerId')
  .brand<'PlayerId'>();
export type PlayerId = z.infer<typeof zPlayerId>; // string & z.BRAND<'PlayerId'>

export const zRoomId          = z.string().refine(s => s.startsWith(PREFIX.room + '_')).brand<'RoomId'>();
export const zGameId          = z.string().refine(s => s.startsWith(PREFIX.game + '_')).brand<'GameId'>();
export const zRoundId         = z.string().refine(s => s.startsWith(PREFIX.round + '_')).brand<'RoundId'>();
export const zSubmissionId    = z.string().refine(s => s.startsWith(PREFIX.submission + '_')).brand<'SubmissionId'>();
export const zSecretPoolItemId = z.string().refine(s => s.startsWith(PREFIX.secretPool + '_')).brand<'SecretPoolItemId'>();

export type RoomId           = z.infer<typeof zRoomId>;
export type GameId           = z.infer<typeof zGameId>;
export type RoundId          = z.infer<typeof zRoundId>;
export type SubmissionId     = z.infer<typeof zSubmissionId>;
export type SecretPoolItemId = z.infer<typeof zSecretPoolItemId>;

// Utility — make/strip work with any branded ID
make<K extends keyof typeof PREFIX>(kind: K): BrandFor<K>   // generates + validates
strip<T extends z.BRAND<string>>(id: T): string             // unwrap to plain string
```

### Cryptographic keys (`core/keys.ts`)

Same pattern — Zod schema + `.brand()` + inferred type. Format constraints are encoded in the schema.

```ts
// Ed25519 signing keys
export const zSigningPubKeyBytes = z.string().regex(/^[A-Za-z0-9_-]{43}$/).brand<'SigningPubKeyBytes'>();
export const zSigningPrivKeyJwk  = z.string().min(1).brand<'SigningPrivKeyJwk'>();
export type SigningPubKeyBytes = z.infer<typeof zSigningPubKeyBytes>;
export type SigningPrivKeyJwk  = z.infer<typeof zSigningPrivKeyJwk>;

// X25519 player encryption keys
export const zPlayerEncPubKeyBytes = z.string().regex(/^[A-Za-z0-9_-]{43}$/).brand<'PlayerEncPubKeyBytes'>();
export const zPlayerEncPrivKeyJwk  = z.string().min(1).brand<'PlayerEncPrivKeyJwk'>();
export type PlayerEncPubKeyBytes = z.infer<typeof zPlayerEncPubKeyBytes>;
export type PlayerEncPrivKeyJwk  = z.infer<typeof zPlayerEncPrivKeyJwk>;

// X25519 host per-game encryption keys
export const zGameEncPubKeyBytes = z.string().regex(/^[A-Za-z0-9_-]{43}$/).brand<'GameEncPubKeyBytes'>();
export const zGameEncPrivKeyJwk  = z.string().min(1).brand<'GameEncPrivKeyJwk'>();
export type GameEncPubKeyBytes = z.infer<typeof zGameEncPubKeyBytes>;
export type GameEncPrivKeyJwk  = z.infer<typeof zGameEncPrivKeyJwk>;

// Crypto operation values
export const zChallengeNonce   = z.string().regex(/^[A-Za-z0-9_-]{43}$/).brand<'ChallengeNonce'>();
export const zSignature        = z.string().regex(/^[A-Za-z0-9_-]{86}$/).brand<'Signature'>();
export const zEncryptedPayload = z.string().min(1).brand<'EncryptedPayload'>();
export const zSecretMessageIv  = z.string().regex(/^[A-Za-z0-9_-]{16}$/).brand<'SecretMessageIv'>();

export type ChallengeNonce   = z.infer<typeof zChallengeNonce>;
export type Signature        = z.infer<typeof zSignature>;
export type EncryptedPayload = z.infer<typeof zEncryptedPayload>;
export type SecretMessageIv  = z.infer<typeof zSecretMessageIv>;
```

### Domain types (`core/schemas.ts`)

All domain types inferred from Zod schemas. No separate `interface` or `type` declarations.

```ts
export const zRoomStatus = z.enum(['waiting', 'starting', 'active', 'finished']);
export type RoomStatus = z.infer<typeof zRoomStatus>;

export const zGameType = z.string().min(1).brand<'GameType'>();
export type GameType = z.infer<typeof zGameType>;

export const zDropBehavior = z.enum(['pause', 'skip', 'autoplay']);
export type DropBehavior = z.infer<typeof zDropBehavior>;

export const zRoom = z.object({
  id:                 zRoomId,
  inviteCode:         z.string(),
  hostPlayerId:       zPlayerId,
  hostEncPubKey:      zGameEncPubKeyBytes,
  status:             zRoomStatus,
  maxPlayers:         z.number().int().min(1).max(8),
  seed:               z.string(),   // used to derive per-game/per-round RNG seeds
  gameType:           zGameType,
  gameConfig:         z.unknown(),  // typed TConfig at call sites via GameDefinition<TConfig>
  dropBehavior:       zDropBehavior.default('pause'),
  disconnectGraceMs:  z.number().int().min(0).default(15_000),
  turnTimeoutMs:      z.number().int().min(0).default(0),  // 0 = no timeout
});
export type Room = z.infer<typeof zRoom>;

export const zAutoplayMode = z.enum(['off', 'assist', 'do']);
export type AutoplayMode = z.infer<typeof zAutoplayMode>;

export const zPlayer = z.object({
  id:             zPlayerId,
  displayName:    z.string(),
  avatarColor:    z.string(),
  role:           z.enum(['host', 'player', 'observer']),
  score:          z.number(),
  isConnected:    z.boolean(),
  isReady:        z.boolean(),
  joinedAt:       z.number(),
  lastSeen:       z.number(),  // epoch ms; client writes every HEARTBEAT_INTERVAL_MS
  signingPubKey:  zSigningPubKeyBytes,
  encPubKey:      zPlayerEncPubKeyBytes,
  autoplayMode:   zAutoplayMode.default('off'),
  autoplaySince:  z.number().nullable().default(null),  // epoch ms; set by host on takeover
});
export type Player = z.infer<typeof zPlayer>;

export const zSecretPoolItem = z.object({
  id:          zSecretPoolItemId,
  ciphertext:  zEncryptedPayload,
  iv:          zSecretMessageIv,
  assignedTo:  zPlayerId,
});
export type SecretPoolItem = z.infer<typeof zSecretPoolItem>;
```

`gameConfig` is `z.unknown()` at the core level. Game-specific call sites narrow it via `GameDefinition<TConfig>.configSchema.parse(room.gameConfig)`. No core schema needs to know the game-specific config shape.

### Bridge event payloads

Event payload schemas live alongside the event constants. Every payload crossing the bridge is validated with Zod on both sides.

```ts
// core/bridge-events.ts
export const EVT_PLAYER_JOINED = 'player_joined' as const;
export const zPlayerJoinedPayload = z.object({
  playerId:    zPlayerId,
  displayName: z.string(),
  avatarColor: z.string(),
  role:        z.enum(['host', 'player', 'observer']),
});
export type PlayerJoinedPayload = z.infer<typeof zPlayerJoinedPayload>;

// Pattern repeated for every event — schema + inferred type, co-located with constant
```

### Per-game schemas (`games/<name>/schemas.ts`)

Same pattern extended for game-specific entities:

```ts
// games/acronym/schemas.ts
export const zAcronymConfig = z.object({
  roundCount: z.number().int().min(1).max(20),
  timerSecs:  z.number().int().min(10).max(300),
});
export type AcronymConfig = z.infer<typeof zAcronymConfig>;

export const zRound = z.object({
  id:        zRoundId,
  acronym:   z.string(),
  status:    z.enum(['pending', 'active', 'voting', 'complete']),
  startedAt: z.number(),
  endedAt:   z.number(),
});
export type Round = z.infer<typeof zRound>;
```

### Backend adapter boundary

Backends receive and emit untyped data. The adapter calls `.parse()` on the appropriate schema before handing anything to domain code — never after.

```ts
// Example: TinyBase adapter receives a raw row
const player = zPlayer.parse(rawTinyBaseRow);  // throws if invalid; returns typed Player

// Example: bridge.ts receives a raw postMessage payload
const payload = zPlayerJoinedPayload.parse(rawPayload);  // typed PlayerJoinedPayload
```

No domain code or game logic ever calls `.parse()` directly — that happens exclusively at adapter and bridge boundaries.

### Cryptographic keys

All key material stored as strings — private keys as JWK, public keys as base64url raw bytes. Branded types enforce that keys of different algorithms and roles cannot be mixed.

```ts
// keys.ts

// Ed25519 — signing / identity
type SigningPubKeyBytes   = Brand<string, 'SigningPubKeyBytes'>;   // base64url 32-byte Ed25519 pubkey
type SigningPrivKeyJwk    = Brand<string, 'SigningPrivKeyJwk'>;    // JWK Ed25519 privkey

// X25519 — player encryption (persistent, part of identity)
type PlayerEncPubKeyBytes = Brand<string, 'PlayerEncPubKeyBytes'>; // base64url 32-byte X25519 pubkey
type PlayerEncPrivKeyJwk  = Brand<string, 'PlayerEncPrivKeyJwk'>;  // JWK X25519 privkey

// X25519 — host per-game encryption (ephemeral, one keypair per game)
type GameEncPubKeyBytes   = Brand<string, 'GameEncPubKeyBytes'>;   // base64url 32-byte X25519 pubkey
type GameEncPrivKeyJwk    = Brand<string, 'GameEncPrivKeyJwk'>;    // JWK X25519 privkey

// Crypto operation values
type ChallengeNonce       = Brand<string, 'ChallengeNonce'>;       // base64url 32 random bytes
type Signature            = Brand<string, 'Signature'>;            // base64url 64-byte Ed25519 sig
type EncryptedPayload     = Brand<string, 'EncryptedPayload'>;     // base64url AES-GCM ciphertext
type SecretMessageIv      = Brand<string, 'SecretMessageIv'>;      // base64url 12-byte AES-GCM nonce
```

`PlayerId` is derived deterministically from `SigningPubKeyBytes`:

```
PlayerId = "plyr_" + base64url(rawEd25519PubKeyBytes)
```

Same player always gets the same `PlayerId` from the same keypair. Derivation runs identically in browser and Cloudflare Worker (both have `crypto.subtle`).

---

## Player identity

Each player has two keypairs generated on first visit, stored in the **local TinyBase store** as extractable JWK strings:

| Keypair | Algorithm | Purpose |
|---|---|---|
| Signing | Ed25519 | Identity, `PlayerId` derivation, DO challenge-response |
| Encryption | X25519 | Receiving host-assigned secret messages |

```ts
// identity module (platform/shared-types/src/core/identity.ts)
generateIdentity(): Promise<PlayerIdentity>
loadIdentity(): Promise<PlayerIdentity | null>     // from local TinyBase store
saveIdentity(id: PlayerIdentity): Promise<void>    // to local TinyBase store

derivePlayerId(key: SigningPubKeyBytes): PlayerId
signChallenge(nonce: ChallengeNonce, privKey: SigningPrivKeyJwk): Promise<Signature>
verifySignature(nonce: ChallengeNonce, sig: Signature, pubKey: SigningPubKeyBytes): Promise<boolean>
```

---

## State — two TinyBase stores

### Local store (each player's browser, `localStorage`)

Persisted via TinyBase `createLocalPersister`. Never synced.

```
identity {                        ← singleton row
  playerId:          PlayerId
  signingPubKey:     SigningPubKeyBytes
  signingPrivKey:    SigningPrivKeyJwk
  encPubKey:         PlayerEncPubKeyBytes
  encPrivKey:        PlayerEncPrivKeyJwk
  displayName:       string
  avatarColor:       string
}

preferences {                     ← singleton row
  soundEnabled:  boolean
  theme:         string
}

gameKeys {                        ← host only; one row per hosted game
  gameId:        GameId
  encPubKey:     GameEncPubKeyBytes
  encPrivKey:    GameEncPrivKeyJwk
}

playerSecrets {                   ← host only; plaintext reference
  playerId:      PlayerId
  gameId:        GameId
  secret:        string
}
```

### Room store (in-memory, synced via DO WebSocket)

`createMergeableStore()` — CRDT merge handles concurrent writes and reconnection automatically.

Core tables (all games — defined in `shared-types/core/schemas.ts`):

```
room {                            ← singleton row
  id:               RoomId
  inviteCode:       string        ← short shareable code (e.g. "XK4F2A")
  hostPlayerId:     PlayerId
  hostEncPubKey:    GameEncPubKeyBytes   ← per-game pubkey; set on room create
  status:           'waiting' | 'starting' | 'active' | 'finished'
  maxPlayers:       number        ← 1–8
  gameType:         GameType      ← e.g. "acronym"; host can change during 'waiting'
  gameConfig:       GameConfigJson ← JSON string; validated per gameType; reset on game switch
}

players {                         ← one row per connected player
  id:               PlayerId
  displayName:      string
  avatarColor:      string
  role:             'host' | 'player' | 'observer'
  score:            number
  isConnected:      boolean
  isReady:          boolean
  joinedAt:         number
  signingPubKey:    SigningPubKeyBytes
  encPubKey:        PlayerEncPubKeyBytes
}

secretPool {                      ← host writes; only assignedTo player can decrypt
  id:               SecretPoolItemId   ← "spol_<ulid>"
  ciphertext:       EncryptedPayload
  iv:               SecretMessageIv
  assignedTo:       PlayerId
}
```

Game-specific tables (defined per-game in `shared-types/games/<name>/schemas.ts`):

```
← acronym game example, TBD with mechanics
rounds      { id, acronym, status, startedAt, endedAt }
submissions { id, roundId, playerId, text, votes }
```

---

## Multiplayer — Cloudflare Durable Objects

### Topology

```
Browser (MergeableStore) ←── WebSocket ──→ RoomDO (MergeableStore) ←── WebSocket ──→ Browser (MergeableStore)
```

The DO is an always-on peer. TinyBase's built-in `WsServerDurableObject` handles all WebSocket lifecycle and MergeableStore sync — no custom protocol implementation needed.

### TinyBase DO sync

**Client:** `createWsSynchronizer` from `tinybase/synchronizers/synchronizer-ws-client`

**DO:** extend `WsServerDurableObject` from `tinybase/synchronizers/synchronizer-ws-server-durable-object`

```ts
export class RoomDO extends WsServerDurableObject {
  createPersister() {
    return createDurableObjectSqlStoragePersister(this.store, this.ctx.storage);
  }

  // override to inject auth + host-authority checks
  async fetch(request: Request): Promise<Response> {
    const authed = await this.authenticate(request);
    if (!authed) return new Response('Unauthorized', { status: 401 });
    return super.fetch(request);
  }

  async webSocketMessage(ws: WebSocket, message: string) {
    const playerId = this.connectionMap.get(ws);
    if (this.isPrivilegedWrite(message) && !this.isHost(playerId)) {
      ws.close(1008, 'Forbidden');
      return;
    }
    return super.webSocketMessage(ws, message);
  }
}
```

**Persistence:** `createDurableObjectSqlStoragePersister` (SQL storage, fragmented mode) from `tinybase/persisters/persister-durable-object-sql-storage`. Requires `[[migrations]]` with `new_sqlite_classes` in `wrangler.toml`.

**Store type:** `createMergeableStore()` on both client and DO — required by the synchronizer.

### Authentication (challenge-response, compatible with WsServerDurableObject)

TinyBase's DO sync takes over the WebSocket after the HTTP upgrade, so challenge-response happens via a **separate HTTP endpoint before the WS connection**:

```
Client                              Worker (HTTP)            RoomDO
  │                                      │                      │
  ├── POST /api/rooms/:id/auth ─────────▶│                      │
  │   { playerId, signingPubKey,         │  validates inviteCode│
  │     inviteCode }                     │  forwards to DO      │
  │                                      ├─────────────────────▶│
  │◀── { nonce: ChallengeNonce } ────────┤◀─────────────────────┤
  │                                      │                      │
  ├── POST /api/rooms/:id/auth/verify ──▶│                      │
  │   { nonce, signature }               │  forwards to DO      │
  │                                      ├─────────────────────▶│ verifySignature(nonce, sig, pubKey)
  │◀── { sessionToken } ─────────────────┤◀─────────────────────┤ issues short-lived token
  │                                      │                      │
  ├── WS /api/rooms/:id/ws               │                      │
  │   ?token=<sessionToken> ────────────────────────────────────▶│ DO validates token in fetch()
  │                                                              │ → passes to super.fetch() → sync begins
```

The session token is short-lived, room-scoped, and encodes the `PlayerId`. The DO validates it in its overridden `fetch()` before passing control to `WsServerDurableObject`.

### Host authority

`WsServerDurableObject` has no built-in per-row/cell write authorization. The DO subclass overrides `webSocketMessage` to intercept merge operations before calling `super.webSocketMessage`. Privileged tables (`secretPool`, `room.status`, `room.gameType`, `room.gameConfig`, and all game-specific tables) are checked against the sender's role. The DO resolves roles from its in-memory `connectionMap` (populated at WS connect from the validated session token). When `room.gameType` changes, the DO also validates `room.gameConfig` against the new game's Zod config schema before accepting the write.

### Host assignment

- First player to connect after `POST /api/rooms` is host.
- If host disconnects, `webSocketClose` reassigns host to the next oldest authenticated connection via a merge write to `players[id].role`.
- The role change propagates to all clients via normal MergeableStore sync.

### Room lifecycle

- `POST /api/rooms` → `{ roomId: RoomId, inviteCode: string }`. Invite code is a short shareable string — identity is proved by keypair challenge-response, not the code.
- DO sets an alarm on creation (24h TTL). Alarm resets on any authenticated activity.
- On alarm fire with no live connections: DO clears SQL storage and terminates.
- `room.status = 'finished'` triggers cleanup after a grace period.

### Reconnection

`MergeableStore` + `createWsSynchronizer` handle reconnection natively. Client re-runs the auth flow (reuses existing keypair, gets a new session token), reconnects WebSocket, and syncs from the DO's persisted SQL state. No custom reconnection logic needed.

### Edge API

```
POST /api/rooms                → { roomId: RoomId, inviteCode: string }
POST /api/rooms/:id/auth       → { nonce: ChallengeNonce }
POST /api/rooms/:id/auth/verify → { sessionToken: string }
WS   /api/rooms/:id/ws?token=  → TinyBase WsServerDurableObject sync
```

---

## Secret message system

### Design

The host assigns per-player secrets (e.g. a role, a word) that only the host and the recipient can read. Everything flows through TinyBase — no separate channels.

**Key material ownership:**

| Key | Stored in | Visible to |
|---|---|---|
| `GameEncPrivKeyJwk` | host's local store (`gameKeys`) | host only |
| `GameEncPubKeyBytes` | synced room store (`room.hostEncPubKey`) | everyone |
| `PlayerEncPrivKeyJwk` | player's local store (`identity`) | that player only |
| `PlayerEncPubKeyBytes` | synced room store (`players[id].encPubKey`) | everyone |
| `EncryptedPayload` + `SecretMessageIv` | synced room store (`secretMessages`) | everyone (opaque) |
| Plaintext secret | host's local store (`playerSecrets`) | host only |

### Flow

1. Host generates a per-game X25519 keypair on game start; stores `GameEncPrivKeyJwk` locally, writes `GameEncPubKeyBytes` to `room.hostEncPubKey` in room store.
2. To assign secret `"ELEPHANT"` to Alice:
   - Host derives `sharedKey = ECDH(GameEncPrivKey, alice.PlayerEncPubKey)` → HKDF → AES-GCM key
   - Encrypts: `{ ciphertext, iv } = AES-GCM(sharedKey, "ELEPHANT")`
   - Writes `secretMessages` row: `{ recipientId: aliceId, ciphertext, iv }`
   - Stores plaintext in own local store: `playerSecrets[aliceId] = "ELEPHANT"`
3. Alice decrypts on receiving the sync patch:
   - `sharedKey = ECDH(alice.PlayerEncPrivKey, room.hostEncPubKey)` → HKDF → same AES-GCM key
   - `plaintext = AES-GCM-decrypt(sharedKey, ciphertext, iv)` → `"ELEPHANT"`

### Crypto utilities (`platform/shared-types/src/core/secret-messages.ts`)

```ts
deriveSharedKey(myPrivJwk: GameEncPrivKeyJwk | PlayerEncPrivKeyJwk,
                theirPubBytes: PlayerEncPubKeyBytes | GameEncPubKeyBytes): Promise<CryptoKey>

encryptSecret(sharedKey: CryptoKey, plaintext: string):
  Promise<{ ciphertext: EncryptedPayload; iv: SecretMessageIv }>

decryptSecret(sharedKey: CryptoKey,
              ciphertext: EncryptedPayload,
              iv: SecretMessageIv): Promise<string>
```

ECDH output is passed through HKDF before use as an AES-GCM key.

---

## Game registry

The lobby is game-agnostic. Each game implementation registers itself via a `GameDefinition`. The registry lives in `site-acronym-game/` (it references React components) while the types and schemas live in `shared-types/games/<name>/`.

### Branded game types (`core/game-types.ts`)

```ts
type GameType       = Brand<string, 'GameType'>;       // e.g. "acronym"
type GameConfigJson = Brand<string, 'GameConfigJson'>; // JSON string, validated per gameType
```

No prefix needed for `GameType` — it is a well-known slug, not a generated ID.

### GameDefinition interface (`platform/web/src/games/types.ts`)

```ts
interface GameDefinition<TConfig = unknown> {
  gameType:      GameType
  displayName:   string
  minPlayers:    number
  maxPlayers:    number
  configSchema:  z.ZodSchema<TConfig>    // from shared-types/games/<name>/config.ts
  defaultConfig: TConfig
  ConfigUI:      React.ComponentType<{   // rendered in host lobby panel
    config: TConfig
    onChange: (c: TConfig) => void
  }>
  godotAssetsPath: string                // path under public/godot/ e.g. "acronym"
                                         // GodotCanvas loads from public/godot/<path>/
}
```

### Registry (`platform/web/src/games/registry.ts`)

```ts
export const GAME_REGISTRY: Record<GameType, GameDefinition> = {
  ['acronym' as GameType]: acronymGameDefinition,
  // additional games registered here
}
```

The DO uses `platform/shared-types/src/games/<name>/schemas.ts` (no React) to validate game-specific table writes. `platform/web` uses the full `GameDefinition` (including `ConfigUI`) for rendering.

### Godot bridge

The web app decrypts before crossing the bridge. Godot receives plaintext only — it has no awareness of the crypto layer.

```ts
sendToGodot('secret_assigned', { recipientId: PlayerId, secret: string })
```

---

## Godot type sharing (codegen)

GDScript has no compatible type system. TypeScript in `shared-types/` is the single source of truth. A codegen script reads source files and emits a single `BridgeProtocol.gd` autoload **per Godot project**, combining core lobby constants and game-specific constants for that game.

```
scripts/gen-gdscript-types.ts
  platform/shared-types/src/core/ + games/acronym/   →  games/acronym/autoloads/BridgeProtocol.gd
  platform/shared-types/src/core/ + games/<other>/   →  games/<other>/autoloads/BridgeProtocol.gd
```

Each `BridgeProtocol.gd` contains everything that Godot project needs:
- Core lobby event constants (`EVT_LOBBY_INIT`, `EVT_GAME_CHANGED`, `EVT_PLAYER_JOINED`, …)
- Game-specific event constants (`EVT_ROUND_START`, …)
- ID prefix constants + helper functions
- Game type slug (`const GAME_TYPE = "acronym"`)

Generated files are committed. `npm run gen:gdscript` runs once per Godot project as part of `npm run build`.

---

## Web app (`platform/web/`)

### Stack

| Concern | Choice |
|---|---|
| Build | Vite |
| Framework | React 19 |
| Routing | TanStack Router |
| State | TinyBase (`createLocalPersister` + `createMergeableStore`) |
| Schemas | Zod (via `platform/shared-types`) |
| Types | TypeScript strict + branded types |
| Deployment | Cloudflare Pages |

No TanStack Query — TinyBase reactive subscriptions cover all data access; one-off HTTP calls use plain `fetch`.

### Routes

```
/                       ← home: create or join a room
/room/:roomId           ← lobby: player list, host controls, ready-up
/room/:roomId/play      ← game: React chrome (navbar/HUD) + <GodotCanvas />
/settings               ← local prefs (local TinyBase store)
```

### Godot integration

Each game has its own Godot export, copied into a game-specific subfolder under `public/godot/`:

```
platform/web/
  public/godot/
    acronym/            ← games/acronym/ export artifacts (.wasm, .pck, .js, .html)
    <other>/            ← future game exports land here
  src/godot/
    GodotCanvas.tsx     ← mounts canvas; accepts gameType prop; loads from public/godot/<gameType>/
    bridge.ts           ← sendToGodot / onGodotEvent, Zod-validated both directions
```

`GodotCanvas` unmounts and remounts with the correct artifacts when `room.gameType` changes during lobby. Each game's Godot build handles both the lobby phase and gameplay internally — no shared Godot code across games.

Bridge globals:
- `window.__godotBridge.receive(event, payload)` — Web → Godot
- `window.__acronymApp.onGodotEvent(event, payload)` — Godot → Web

All payloads validated with `platform/shared-types` Zod schemas at the bridge boundary.

---

## Build pipeline

```bash
npm run gen:gdscript           # platform/shared-types → games/*/autoloads/BridgeProtocol.gd
npm run godot:export           # exports all games/* → platform/web/public/godot/<name>/
npm run godot:export:acronym   # export only games/acronym/ (faster for iteration)
npm run dev                    # Vite dev server in platform/web/ (Godot artifacts must be pre-built)
npm run build                  # gen:gdscript + godot:export (all) + vite build
```

Adding a new game:
1. Create `games/<name>/` Godot project
2. Add `platform/shared-types/src/games/<name>/` (schemas, config, bridge-events)
3. Register `GameDefinition` in `platform/web/src/games/registry.ts`
4. Add `godot:export:<name>` script

---

## Deployment

```
platform/edge   → wrangler deploy (Worker + Durable Objects)
platform/web    → Cloudflare Pages (vite build output)
                  _routes.json proxies /api/* to platform/edge
```

---

## Open questions (deferred — game mechanics)

- ❓ Core rules / gameplay loop
- ❓ Round timer — countdown or host-advanced?
- ❓ Acronym source — random, curated deck, or host-entered?
- ❓ `rounds` and `submissions` table details (depend on mechanics)

---

## Phased roadmap

| Phase | Deliverable |
|---|---|
| **0 — Scaffold** | Monorepo, `platform/shared-types` with `core/` + `games/acronym/`, branded ID + key + game types, Zod schemas, `GameDefinition` interface, `GAME_REGISTRY`, `gen:gdscript` script |
| **1 — Identity** | Local TinyBase store, keypair generation/persistence, `PlayerId` derivation |
| **2 — Web shell** | `platform/web` routes, room store shape, invite flow (create/join) |
| **3 — Edge** | `platform/edge` Worker + `RoomDO` extending `WsServerDurableObject`, SQL storage persister, auth endpoints, host assignment, DO alarm |
| **4 — Sync** | `createWsSynchronizer` wired on client; room store reactive in UI; host-authority intercept in `webSocketMessage`; reconnection verified |
| **5 — Secret messages** | Per-game host keypair, `secretPool` table, encrypt/decrypt utilities |
| **6 — Godot** | Godot skeleton, Web export at `/room/:roomId/play`, bridge round-trip event working |
| **7 — Game loop** | Mechanics (deferred) |
| **8 — Polish** | Deployment live, error handling, edge cases |
