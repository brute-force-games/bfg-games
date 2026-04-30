# Acronym Game — Project Plan

> Status: DRAFT — open questions marked ❓

---

## Overview

Two projects in this monorepo:

| Project | Purpose |
|---|---|
| `acronym-game-app/` | Vite + React SPA — game shell, UI, all state via TinyBase |
| `acronym-game-web/` | Godot 4.6.2 — in-game visuals & interactivity, exported to Web |

The web app owns all state. The Godot export is mounted as a component inside a React route (so the web app's navbar/chrome wraps it). Multiplayer state is synced via Cloudflare Durable Objects over WebSocket.

---

## Open Questions

- ❓ **Game mechanics** — deferred; revisit before Phase 4
- ❓ **Round timer** — countdown per round, or host-advanced?
- ❓ **Acronym source** — random, curated deck, or host-entered?

---

## Repository Layout

```
acronym-game/
├── PLAN.md
├── package.json                  ← npm workspaces root
├── tsconfig.base.json            ← shared TS compiler settings
├── acronym-game-app/             ← Vite + React SPA (Cloudflare Pages)
├── acronym-game-edge/            ← Cloudflare Worker + Durable Objects
├── acronym-game-web/             ← Godot 4.6.2 project
├── shared-types/
│   ├── shared/                   ← branded IDs, utility types — no runtime deps, TS only
│   └── protocol/                 ← Zod schemas, wire message types
└── scripts/
    └── godot-export.sh           ← headless export → acronym-game-app/public/godot/
```

---

## Branded ID System (`shared-types/shared`)

### String format

```
"<prefix>_<ulid>"

PlayerId      →  "plyr_<ulid>"
RoomId        →  "room_<ulid>"
GameId        →  "game_<ulid>"
RoundId       →  "rnd_<ulid>"
SubmissionId  →  "sub_<ulid>"
```

Plain strings in Godot (GDScript has no branded types); branded at compile-time in TypeScript only.

### TypeScript (`brand.ts`)

```ts
declare const __brand: unique symbol;
export type Brand<T, B extends string> = T & { readonly [__brand]: B };

export type PlayerId      = Brand<string, 'PlayerId'>;
export type RoomId        = Brand<string, 'RoomId'>;
export type GameId        = Brand<string, 'GameId'>;
export type RoundId       = Brand<string, 'RoundId'>;
export type SubmissionId  = Brand<string, 'SubmissionId'>;
export type AnyId         = PlayerId | RoomId | GameId | RoundId | SubmissionId;
```

### ID utilities (`ids.ts`)

```ts
export const PREFIX = {
  player:     'plyr',
  room:       'room',
  game:       'game',
  round:      'rnd',
  submission: 'sub',
} as const;

make<K extends keyof typeof PREFIX>(kind: K): BrandFor<K>       // generates new ID
parse<K extends keyof typeof PREFIX>(kind: K, s: string): BrandFor<K> | null
is<K extends keyof typeof PREFIX>(kind: K, s: string): s is BrandFor<K>
strip(id: AnyId): string                                         // to plain string
```

### Zod integration (`shared-types/protocol`)

```ts
export const zPlayerId = z.string()
  .refine(s => is('player', s))
  .transform(s => s as PlayerId);
// every entity ID has a matching z<Type> schema
```

All Zod schemas use `.transform()` so inferred types are always branded — no manual casting at call sites.

---

## State Architecture — Two TinyBase Stores

### 1. Local store (browser-only, persisted to `localStorage`)

Holds user identity and preferences. Loaded before any lobby interaction. Applied when the player joins a room.

```
Tables:
  localPlayer  { id: PlayerId, displayName, avatarColor, ... }  ← singleton row
  preferences  { soundEnabled, theme, ... }                     ← singleton row
```

No sync — persisted locally via TinyBase's `createLocalPersister`.

### 2. Room store (synced via Durable Object WebSocket)

Holds live game state for the active room. Created fresh on room join, torn down on leave.

```
Tables:
  room         { id, code, hostPlayerId, status, maxPlayers(8), ... }
  players      { id, roomId, displayName, avatarColor, role, score, isConnected }
  rounds       { id, roomId, acronym, status, startedAt, endedAt }         ← ❓ details TBD
  submissions  { id, roundId, playerId, text, votes }                      ← ❓ details TBD
```

Authority lives in the Durable Object. The local TinyBase store is a read replica + intent queue.

---

## Multiplayer Architecture

### Data flow

```
┌─────────────────────────────────────────────┐
│  Browser                                    │
│                                             │
│  Local Store (localStorage)                 │
│    └── localPlayer, preferences             │
│                                             │
│  Room Store (in-memory TinyBase)            │
│    └── room, players, rounds, submissions   │
│         ↕  intent/patch WebSocket           │
└─────────────────────────────────────────────┘
                      │
          ┌───────────┴───────────┐
          │  Cloudflare DO        │
          │  RoomDO (per RoomId)  │
          │  authoritative state  │
          │  role enforcement     │
          └───────────────────────┘
```

### Host assignment

- First player to create/join a room is assigned `role: 'host'`.
- If the host disconnects, the DO reassigns host to the next oldest connection.
- Host-only actions are enforced in the DO (never trusted from client claims).

### Sync protocol (custom — not TinyBase built-in synchronizer)

TinyBase's built-in WsSynchronizer doesn't map to Durable Objects cleanly, so a lightweight custom layer:

1. Client sends **intent** messages (Zod-validated) to DO over WebSocket.
2. DO validates (role check + business rules), applies to authoritative state.
3. DO broadcasts **patch** events to all connected clients.
4. Clients apply patches to their local room TinyBase store.

All message shapes defined in `shared-types/protocol` and validated with Zod on both sides.

### Cloudflare Worker routes (`acronym-game-edge`)

```
POST /api/rooms            → create room → { roomId, joinToken }
GET  /api/rooms/:id/ws     → WebSocket upgrade → RoomDO
```

---

## `acronym-game-app` — React App

### Stack

| Concern | Choice | Reason |
|---|---|---|
| Build | Vite | — |
| Framework | React 19 | — |
| Routing | TanStack Router | type-safe routes |
| All state | TinyBase (local + room stores) | sole data layer |
| Schemas | Zod via `shared-types/protocol` | — |
| Types | TypeScript strict + branded types | — |
| Deployment | Cloudflare Pages | — |

TanStack Query is not needed — TinyBase's reactive subscriptions cover all data access patterns; one-off HTTP calls (create room) use plain `fetch`.

### Route tree

```
/                     ← Home: create or join a room
/room/:roomId         ← Lobby: player list, host controls, ready-up
/room/:roomId/play    ← Game: navbar layout + GodotCanvas component
/settings             ← Local prefs (reads/writes local TinyBase store)
```

### Godot integration

The `/room/:roomId/play` route renders a React layout (navbar, HUD) with `<GodotCanvas />` mounted inside it — not a raw iframe. The Godot Web export artifacts live in `public/godot/` and are loaded by the component.

```
acronym-game-app/
  public/
    godot/              ← export artifacts: .wasm, .pck, .js, .html
  src/
    godot/
      GodotCanvas.tsx   ← mounts Godot, owns lifecycle
      bridge.ts         ← sendToGodot / onGodotEvent, Zod-validated both ways
```

### Godot ↔ Web message flow

```
Web → Godot:   window.__godotBridge.receive(event, payload)   (called from bridge.ts)
Godot → Web:   JavaScriptBridge.eval("window.__acronymApp.onGodotEvent(...)")
```

All payloads validated against `shared-types/protocol` schemas in both directions.

---

## `acronym-game-web` — Godot Project

- **Godot version**: 4.6.2
- **Export target**: Web (HTML5/WASM)
- **Bridge layer** (GDScript): registers `window.__godotBridge.receive`, calls `window.__acronymApp.onGodotEvent` for outbound events
- **ID format**: plain prefixed strings (e.g. `"plyr_01HX..."`) — GDScript treats them as opaque strings

---

## Build Pipeline

```bash
npm run godot:export   # headless Godot export → acronym-game-app/public/godot/
npm run dev            # Vite dev server (requires pre-built Godot artifacts)
npm run build          # godot:export then vite build
```

Godot re-export only needed when Godot source changes; normal web iteration skips it.

---

## Deployment

```
acronym-game-edge  → wrangler deploy (Cloudflare Worker + Durable Objects)
acronym-game-app   → Cloudflare Pages (vite build output)
                     _routes.json proxies /api/* to the Worker
```

---

## Phased Roadmap

| Phase | Deliverable |
|---|---|
| **0 — Scaffold** | Monorepo, `shared-types/shared` (branded IDs + utils), `shared-types/protocol` (Zod schemas) |
| **1 — Web shell** | `acronym-game-app` routes, local TinyBase store (player profile/prefs), room TinyBase store shape |
| **2 — Edge** | `acronym-game-edge` Worker + `RoomDO`, WebSocket lifecycle, host assignment, intent/patch cycle |
| **3 — Sync** | Full web ↔ DO round-trip wired; room store reactive in UI |
| **4 — Godot** | Godot skeleton, Web export served at `/play`, bridge round-trip event working |
| **5 — Game loop** | Mechanics implemented (deferred until Phase 5) |
| **6 — Polish** | Deployment live, settings, error handling, reconnect logic |

---

## Definition of Done (Phases 0–3)

- `npm install` at root succeeds, workspaces resolve
- Local store loads/persists player profile and prefs in localStorage
- `acronym-game-app` can create a room and navigate to `/room/:roomId`
- `acronym-game-edge` (`wrangler dev`) accepts WebSocket connections, assigns host, echoes patches
- Branded `PlayerId` / `RoomId` strings flow end-to-end through Zod validation
- At least one intent→patch cycle observable in the browser
