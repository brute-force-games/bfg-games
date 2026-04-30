# Lobby Flow Plan

---

## Overview

Creating a game immediately launches the Godot canvas. The lobby IS the game view — Godot runs from the moment the room exists, showing a pre-game visualization (players joining, waiting state) while the web app chrome handles room management, sharing, and secret assignment. When the host starts the game, the lobby phase ends and Godot transitions to gameplay — no page navigation required.

---

## Route

```
/room/:roomId/play
```

Single route for both lobby and gameplay. `room.status` in the room store drives what Godot renders and which host controls the web chrome shows. The room store is accessed via the `RoomStore` interface — the backing implementation (TinyBase/DO, Trystero, etc.) is transparent to lobby code.

Joining players who follow the invite URL land here directly.

---

## Room status state machine

```
'waiting'  ──[host starts]──▶  'starting'  ──[all clients confirm]──▶  'active'
                                                                             │
                                                                'finished' ◀─┘
```

| Status | Meaning |
|---|---|
| `waiting` | Lobby open — players joining, secrets being assigned |
| `starting` | Host clicked Start — Godot plays intro, clients confirm readiness |
| `active` | Game in progress |
| `finished` | Game over, results shown |

Only the host can write `room.status` (enforced by DO).

---

## Registration — first visit identity setup

Before a player can create or join a game, they need a persistent identity. This happens automatically on first visit and is transparent to the user.

### Flow

```
Player visits site for the first time
  │
  ├── local TinyBase store checked for existing identity row
  │
  ├── [no identity found]
  │     ├── generate Ed25519 keypair (signing / PlayerId derivation)
  │     ├── generate X25519 keypair (encryption / secret messages)
  │     ├── derive PlayerId = "plyr_" + base64url(Ed25519PubKeyBytes)
  │     ├── prompt user for display name + avatar color
  │     │     (shown as a modal or inline form on the home page)
  │     └── save to local TinyBase store:
  │           identity { playerId, signingPubKey, signingPrivKey,
  │                      encPubKey, encPrivKey, displayName, avatarColor }
  │
  └── [identity found] → proceed directly, no prompt
```

### Local store — identity schema

```
identity {                          ← singleton row, keyed by playerId
  playerId:          PlayerId       // "plyr_<base64url Ed25519 pubkey>"
  signingPubKey:     SigningPubKeyBytes    // Ed25519 — public, base64url
  signingPrivKey:    SigningPrivKeyJwk     // Ed25519 — private, JWK string
  encPubKey:         PlayerEncPubKeyBytes  // X25519 — public, base64url
  encPrivKey:        PlayerEncPrivKeyJwk   // X25519 — private, JWK string
  displayName:       string
  avatarColor:       string
}

preferences {                       ← singleton row
  soundEnabled:  boolean
  theme:         string
}
```

Keys are stored as extractable JWK strings in TinyBase → localStorage. Private keys never leave the browser.

### Returning player

Identity is loaded from the local store on every visit. The player has the same `PlayerId` across sessions and devices only if they export/import their identity (future feature — not in scope now). By default, a new device = new identity.

### Settings page (`/settings`)

Allows the player to update `displayName` and `avatarColor`. These changes are picked up automatically on next room join — the player row in the room store is written from the local identity on connect.

---

## Host flow

### 1. Create game (home page)

```
Host on home page "/"
  ├── clicks "New Game"
  ├── selects a game from the available games list (populated from GAME_REGISTRY)
  │     → sets initial gameType + defaultConfig for that game
  ├── POST /api/rooms { gameType } → { roomId: RoomId, inviteCode: string }
  ├── generates per-game X25519 keypair:
  │     GameEncPrivKeyJwk  → local store (gameKeys table, keyed by gameId)
  │     GameEncPubKeyBytes → written to room.hostEncPubKey on connect
  ├── POST /api/rooms/:id/auth → { nonce: ChallengeNonce }
  ├── sign nonce with SigningPrivKey → Signature
  ├── POST /api/rooms/:id/auth/verify → { sessionToken }
  ├── connect WebSocket /api/rooms/:id/ws?token=<sessionToken>
  ├── TinyBase MergeableStore sync begins
  ├── write initial room row:
  │     { id, inviteCode, hostPlayerId, status: 'waiting', maxPlayers: 8,
  │       hostEncPubKey, gameType, gameConfig: defaultConfig(gameType) }
  ├── write self to players table:
  │     { id: playerId, displayName, avatarColor, role: 'host',
  │       signingPubKey, encPubKey, isReady: true, joinedAt }
  └── navigate to /room/:roomId/play
```

### 2. Lobby management (status = 'waiting')

The web chrome around the Godot canvas shows the host panel:

- **Game selector**: dropdown of available games from `GAME_REGISTRY`; host can switch game while in `waiting` state
- **Game config panel**: game-specific options rendered by `GameDefinition.ConfigUI`; updates live as host edits
- **Invite section**: full URL + QR code
- **Player list**: each player's display name, avatar, and secret-assigned indicator
- **Start Game button**: enabled only when every connected player has a secret assigned

### 3. Switch game type (while status = 'waiting')

Host selects a different game from the dropdown:

```
Host selects new game
  ├── gameType updated in room store
  ├── gameConfig reset to defaultConfig(newGameType)
  ├── secretPool table cleared (secrets were for the previous game's deck)
  ├── all players[id].isReady reset to false
  ├── sync patch propagates to all clients
  ├── EVT_GAME_CHANGED { gameType, gameConfig } sent to Godot
  ├── Godot loads game-specific lobby preview scene
  └── host reloads deck and re-deals secrets to all current players
```

Switching game type after players have already joined is allowed — players' identities and connections are unaffected. Only the game context and secrets reset.

### 4. Configure game (while status = 'waiting')

Host edits options in the `ConfigUI` panel (rendered from `GameDefinition.ConfigUI`):

```
Host changes a config option
  ├── validated client-side against game's configSchema (Zod)
  ├── room.gameConfig updated (serialized GameConfigJson)
  ├── DO validates gameConfig against game's schema before accepting write
  ├── sync patch propagates to all clients
  └── EVT_GAME_CONFIG_UPDATED { gameConfig } sent to Godot
```

Config changes do not reset secrets or player ready states.

### 3. Assign secrets (automatic)

Secret assignment requires no manual intervention from host or player. When a new player's row appears in the room store, the host's client automatically deals the next available secret from the deck:

1. `roomStore.onPlayerJoined(player => dealSecret(player))` subscription fires on host client
2. Pop next plaintext secret from local `secretPool` deck
3. Derive `sharedKey = ECDH(GameEncPrivKey, player.PlayerEncPubKey)` → HKDF → AES-GCM key
4. Encrypt → `{ ciphertext: EncryptedPayload, iv: SecretMessageIv }`
5. `roomStore.assignSecret({ assignedTo: playerId, ciphertext, iv })` writes the pool row
6. Store plaintext in local `secretPool` for host reference

The host must have pre-loaded a deck before the first player joins. The host is treated as a normal player and receives a secret from the same deck — no special host-as-player logic path.

### 4. Start game

```
Host clicks "Start Game"
  ├── DO validates: every player row has a matching secretPool row with assignedTo set
  ├── write room.status = 'starting'
  ├── all clients receive sync patch
  ├── web app sends EVT_LOBBY_STARTING to Godot
  ├── Godot plays transition animation
  ├── Godot fires EVT_GODOT_READY when animation complete
  ├── once all clients fire EVT_GODOT_READY (or timeout):
  │     write room.status = 'active'
  └── Godot receives EVT_GAME_ACTIVE → gameplay begins
```

---

## Player (non-host) flow

### 1. Join via invite URL

```
Player follows https://<app>/room/:roomId/play?invite=<inviteCode>
  │
  ├── [no local identity] → registration flow (see above) → continue
  │
  ├── POST /api/rooms/:id/auth with { playerId, signingPubKey, inviteCode }
  │     → DO checks: room exists, status = 'waiting', not full, inviteCode valid
  │     → { nonce: ChallengeNonce }
  │
  ├── sign nonce → POST /api/rooms/:id/auth/verify → { sessionToken }
  │
  ├── connect WebSocket /api/rooms/:id/ws?token=<sessionToken>
  │
  ├── TinyBase MergeableStore sync begins
  │     player receives full current room state
  │
  ├── write self to players table:
  │     { id: playerId, displayName, avatarColor, role: 'player',
  │       signingPubKey, encPubKey, isReady: false, joinedAt }
  │
  └── player appears in host's player list
      Godot receives EVT_PLAYER_JOINED
```

### 2. Receive and acknowledge secret

When a `secretPool` row appears with `assignedTo = this.playerId`:

```
roomStore.onSecretAssigned(item => {
  if (item.assignedTo !== localPlayerId) return;
  derive sharedKey = ECDH(PlayerEncPrivKey, room.hostEncPubKey) → HKDF
  decrypt → plaintext secret
  display secret in web chrome ("Your secret: ELEPHANT")
  send EVT_SECRET_ASSIGNED to Godot: { secret }   ← web chrome only, not Godot
  player clicks "Got it" (or auto-acknowledge after N seconds)
  roomStore.setReady(localPlayerId, true)
})
```

### 3. Wait for host to start

Godot shows lobby visualization. Player sees other players appear. `isReady` state updates visible in Godot and web chrome. When `room.status → 'starting'`, Godot transitions automatically.

---

## Room store schema (lobby additions)

Core tables — defined in `platform/shared-types/src/core/schemas.ts`, present for all games:

```
room {
  id:               RoomId
  inviteCode:       string
  hostPlayerId:     PlayerId
  hostEncPubKey:    GameEncPubKeyBytes
  status:           'waiting' | 'starting' | 'active' | 'finished'
  maxPlayers:       number               ← 1–8
  seed:             string               ← set at room creation; derives per-game/per-round RNG seeds
  gameType:         GameType             ← e.g. "acronym"; mutable during 'waiting'
  gameConfig:       GameConfigJson       ← JSON string; reset when gameType changes
}

players {
  id:               PlayerId
  displayName:      string
  avatarColor:      string
  role:             'host' | 'player' | 'observer'
  signingPubKey:    SigningPubKeyBytes
  encPubKey:        PlayerEncPubKeyBytes
  score:            number
  isConnected:      boolean
  isReady:          boolean
  joinedAt:         number
  lastSeen:         number               ← epoch ms; client writes every 5 s as heartbeat
  autoplayMode:     'off' | 'assist' | 'do'
  autoplaySince:    number | null        ← set by host when takeover begins
}

secretPool {
  id:               SecretPoolItemId     ← "spol_<ulid>"
  ciphertext:       EncryptedPayload
  iv:               SecretMessageIv
  assignedTo:       PlayerId             ← cleared when game type switches
}
```

Host local store additions:

```
gameKeys {                              ← one row per hosted game
  gameId:           GameId
  encPubKey:        GameEncPubKeyBytes
  encPrivKey:       GameEncPrivKeyJwk
}

secretPool {                            ← host plaintext reference
  id:               SecretPoolItemId
  gameId:           GameId
  secret:           string              ← plaintext
  assignedTo:       PlayerId
}
```

`SecretPoolItemId` is derived from `zSecretPoolItemId = z.string().refine(s => s.startsWith(PREFIX.secretPool + '_'), ...).brand<'SecretPoolItemId'>()` — `'spol'` is already in the `PREFIX` registry.

---

## Invite URL and QR code

```
https://<app>/room/:roomId/play?invite=<inviteCode>
```

- QR code generated client-side from this URL using `react-qr-code`
- Displayed in the host panel in web chrome during `status = 'waiting'`
- `inviteCode` validated by DO on auth request — rejects if room is full, already active, or code is wrong
- QR code also visible to players in their view so they can share with others

---

## Web chrome layout

```
┌──────────────────────────────────────────────────────────────┐
│  Navbar: [room code]  [N/8 players]  [● connected]           │
├─────────────────────────────┬────────────────────────────────┤
│                             │  ── HOST PANEL (waiting) ──    │
│                             │  Game: [Acronym ▾]  ← selector │
│                             │  ┌─ game config (ConfigUI) ─┐  │
│   Godot Canvas              │  │  Rounds: [5]  Timer: [60] │  │
│                             │  └───────────────────────────┘  │
│   lobby visualization       │  ──────────────────────────     │
│   (game preview scene       │  https://…/room/abc/play        │
│    for active gameType)     │  [QR code]                      │
│                             │  ──────────────────────────     │
│   gameplay during           │  Players                        │
│   'active'                  │  ├─ Alice  🟢  ✓ secret         │
│                             │  ├─ Bob    🟢  ✗ no secret      │
│                             │  └─ Carol  🟡  connecting…      │
│                             │                                  │
│                             │  [Start Game ▶]  (greyed out    │
│                             │   until all ✓ secret)           │
├─────────────────────────────┴─────────────────────────────────┤
│  PLAYER VIEW (waiting): Your secret: ██████  [Got it ✓]       │
│  PLAYER VIEW (active):  [game HUD elements]                   │
└───────────────────────────────────────────────────────────────┘
```

Host panel collapses once `status = 'active'`. Game selector and config are hidden once `status` leaves `'waiting'`.

---

## Godot UI expectations (lobby phase)

The Godot canvas is visible from the moment the room is created. The web app sends state via the bridge; Godot is responsible for all visual rendering. Godot should implement the following:

### Lobby scene requirements

| Requirement | Detail |
|---|---|
| **Player avatar display** | Show each player's `displayName` and `avatarColor` as they join. Animate entry. |
| **Player count indicator** | Display current / max (e.g. "3 / 8") |
| **Waiting state animation** | Idle loop while `status = 'waiting'` — something lively, not a static screen |
| **Transition animation** | Play a distinct animation when `EVT_LOBBY_STARTING` is received. Fire `EVT_GODOT_READY` when complete. |
| **Connected / disconnected states** | Grey out or animate players who drop (`isConnected = false`) |

### Events Godot must handle (Web → Godot)

Payload schemas live in `platform/shared-types/src/core/bridge-events.ts`. All payloads are validated via Zod at the bridge boundary before being forwarded to Godot.

| Event constant | Payload schema | Godot action |
|---|---|---|
| `EVT_LOBBY_INIT` | `zLobbyInitPayload` | Initialize lobby scene with active game; includes full player list with connectivity state |
| `EVT_PLAYER_JOINED` | `zPlayerJoinedPayload` | Add player avatar to scene |
| `EVT_PLAYER_LEFT` | `zPlayerLeftPayload` | Remove or grey out avatar |
| `EVT_PLAYER_READY` | `zPlayerReadyPayload` | Mark player as ready (visual indicator) |
| `EVT_PLAYER_CONNECTIVITY_CHANGED` | `zPlayerConnectivityChangedPayload` | Update connectivity/autoplay display for a player |
| `EVT_SECRET_ASSIGNED` | — | Not sent to Godot; secret display is web chrome only |
| `EVT_GAME_CHANGED` | `zGameChangedPayload` | Handled by web app only — unmounts current Godot instance, mounts new game's export, sends `EVT_LOBBY_INIT` to new instance |
| `EVT_GAME_CONFIG_UPDATED` | `zGameConfigUpdatedPayload` | Host changed config — update any in-lobby visualization |
| `EVT_LOBBY_STARTING` | `zLobbyStartingPayload` | Play transition animation; fire `EVT_GODOT_READY` when done |
| `EVT_GAME_ACTIVE` | `zGameActivePayload` | Switch to game scene; pass final config |

`EVT_PLAYER_CONNECTIVITY_CHANGED` fires whenever `isConnected`, `autoplayMode`, or `autoplaySince` changes for any player. This includes:
- Player disconnects mid-game (`isConnected → false`)
- Player reconnects (`isConnected → true`)
- Host initiates or stops autoplay takeover (`autoplayMode` changes)

`EVT_LOBBY_INIT` includes a snapshot of all current players (with connectivity state) so Godot can initialize correctly when late-joining or remounting.

```ts
// platform/shared-types/src/core/bridge-events.ts

export const EVT_LOBBY_INIT                  = 'lobby_init'                  as const;
export const EVT_PLAYER_JOINED               = 'player_joined'               as const;
export const EVT_PLAYER_LEFT                 = 'player_left'                 as const;
export const EVT_PLAYER_READY                = 'player_ready'                as const;
export const EVT_PLAYER_CONNECTIVITY_CHANGED = 'player_connectivity_changed' as const;
export const EVT_GAME_CHANGED                = 'game_changed'                as const;
export const EVT_GAME_CONFIG_UPDATED         = 'game_config_updated'         as const;
export const EVT_LOBBY_STARTING              = 'lobby_starting'              as const;
export const EVT_GAME_ACTIVE                 = 'game_active'                 as const;
export const EVT_GODOT_READY                 = 'godot_ready'                 as const;

// Connectivity state included in every player snapshot
const zPlayerConnectivitySnapshot = z.object({
  isConnected:   z.boolean(),
  autoplayMode:  zAutoplayMode,
  autoplaySince: z.number().nullable(),
});

export const zLobbyInitPayload = z.object({
  roomId:        zRoomId,
  hostPlayerId:  zPlayerId,
  maxPlayers:    z.number().int().min(1).max(8),
  observerMode:  z.boolean(),
  gameType:      zGameType,
  gameConfig:    z.unknown(),  // narrowed by game's configSchema at call site
  players:       z.array(z.object({
    playerId:      zPlayerId,
    displayName:   z.string(),
    avatarColor:   z.string(),
    role:          z.enum(['host', 'player', 'observer']),
    isReady:       z.boolean(),
  }).merge(zPlayerConnectivitySnapshot)),
});
export type LobbyInitPayload = z.infer<typeof zLobbyInitPayload>;

export const zPlayerJoinedPayload = z.object({
  playerId:      zPlayerId,
  displayName:   z.string(),
  avatarColor:   z.string(),
  role:          z.enum(['host', 'player', 'observer']),
  isReady:       z.boolean(),
}).merge(zPlayerConnectivitySnapshot);
export type PlayerJoinedPayload = z.infer<typeof zPlayerJoinedPayload>;

export const zPlayerLeftPayload = z.object({ playerId: zPlayerId });
export type PlayerLeftPayload = z.infer<typeof zPlayerLeftPayload>;

export const zPlayerReadyPayload = z.object({ playerId: zPlayerId });
export type PlayerReadyPayload = z.infer<typeof zPlayerReadyPayload>;

export const zPlayerConnectivityChangedPayload = z.object({
  playerId: zPlayerId,
}).merge(zPlayerConnectivitySnapshot);
export type PlayerConnectivityChangedPayload = z.infer<typeof zPlayerConnectivityChangedPayload>;

export const zGameChangedPayload = z.object({
  gameType:   zGameType,
  gameConfig: z.unknown(),
});
export type GameChangedPayload = z.infer<typeof zGameChangedPayload>;

export const zGameConfigUpdatedPayload = z.object({ gameConfig: z.unknown() });
export type GameConfigUpdatedPayload = z.infer<typeof zGameConfigUpdatedPayload>;

export const zLobbyStartingPayload = z.object({});
export type LobbyStartingPayload = z.infer<typeof zLobbyStartingPayload>;

export const zGameActivePayload = z.object({
  gameType:   zGameType,
  gameConfig: z.unknown(),
});
export type GameActivePayload = z.infer<typeof zGameActivePayload>;

export const zGodotReadyPayload = z.object({});
export type GodotReadyPayload = z.infer<typeof zGodotReadyPayload>;
```

### Events Godot must emit (Godot → Web)

| Event constant | Payload schema | Trigger |
|---|---|---|
| `EVT_GODOT_READY` | `zGodotReadyPayload` | Transition animation complete |

### Godot scene structure (suggested)

Each game is a separate Godot project — there is no shared Godot lobby across games. Each Godot project implements its own lobby scene and gameplay scene internally.

```
Node: LobbyRoot                ← game's own lobby scene
  ├── PlayerGrid               ← arranges player avatars; receives PLAYER_JOINED/LEFT
  │     └── PlayerCard × N
  ├── GameInfoDisplay          ← shows game-specific config (round count, timer, etc.)
  │                               updated on EVT_GAME_CONFIG_UPDATED
  ├── StatusLabel              ← "Waiting for players…" / "Starting!"
  ├── TransitionAnimator       ← plays on LOBBY_STARTING; emits done → bridge
  └── BackgroundLoop           ← idle ambient animation
```

When the host switches game type, `GodotCanvas.tsx` unmounts the current Godot instance and remounts with the new game's export artifacts. `EVT_GAME_CHANGED` is sent to the newly loaded Godot instance as part of its `EVT_LOBBY_INIT`.

### Bridge from Godot side (GDScript)

Lobby-phase bridge calls use `BridgeProtocol.gd` constants. Game-specific constants come from `BridgeProtocol<Name>.gd`:

```gdscript
func _ready():
    window.__godotBridge.receive = _on_bridge_event

func _on_bridge_event(event: String, payload: Dictionary):
    match event:
        BridgeProtocol.EVT_LOBBY_INIT:
            _init_lobby(payload)           # payload includes players[] with connectivity state
        BridgeProtocol.EVT_PLAYER_JOINED:
            _add_player(payload)           # includes isConnected, autoplayMode, autoplaySince
        BridgeProtocol.EVT_PLAYER_LEFT:
            _remove_player(payload)
        BridgeProtocol.EVT_PLAYER_CONNECTIVITY_CHANGED:
            _update_player_connectivity(payload)   # isConnected, autoplayMode, autoplaySince
        BridgeProtocol.EVT_GAME_CONFIG_UPDATED:
            _update_game_info(payload.gameConfig)
        BridgeProtocol.EVT_LOBBY_STARTING:
            _play_transition()
        BridgeProtocol.EVT_GAME_ACTIVE:
            _start_game(payload.gameConfig)

# EVT_GAME_CHANGED is NOT handled here — GodotCanvas unmounts/remounts
# the entire Godot instance when gameType changes. The new instance receives
# EVT_LOBBY_INIT with the new game's config.

func _on_transition_done():
    JavaScriptBridge.eval(
        "window.__acronymApp.onGodotEvent('%s', {})" % BridgeProtocol.EVT_GODOT_READY
    )
```

---

## Observer role

Any person with the room URL can watch the game in a read-only context without an invite code or identity. Observers see the same Godot visualization and public game state as players, but receive no secret messages and have no controls.

### Observer URL

```
https://<app>/room/:roomId/play          ← no invite code = observer mode
https://<app>/room/:roomId/play?observe  ← explicit observer flag (optional, same behaviour)
```

If a visitor arrives at the room URL without a valid `invite` param and without an existing session token for that room, they are connected as an observer automatically.

### Observer connection flow

```
Visitor arrives at /room/:roomId/play (no invite code)
  ├── GET /api/rooms/:id → { status, playerCount } (room exists check)
  ├── connect WebSocket /api/rooms/:id/ws?observe=true
  │     ← no auth, no challenge-response
  ├── DO marks connection as role: 'observer' (read-only, no PlayerId)
  ├── TinyBase MergeableStore sync begins (receive only)
  └── Godot receives EVT_LOBBY_INIT with { observerMode: true }
```

No session token, no keypair, no player row written to the store.

### What observers see

| Element | Observer sees |
|---|---|
| Godot canvas | Full visualization — identical to player view |
| Player list | Display names, avatars, ready states |
| Room status / round state | Yes |
| Secret messages | No — `secretPool` rows are visible but ciphertext is opaque; no decryption key |
| Host controls | Hidden |
| Own secret display | Hidden |
| Player HUD (score, etc.) | Yes (public game state) |

### DO enforcement for observers

The DO rejects all merge write operations from observer connections before they reach `WsServerDurableObject`. Observers receive patches but can never send them. This is enforced in the `webSocketMessage` override — any inbound message from an observer connection is dropped.

### Observer in the room store

Observers are **not** written to the `players` table. They are invisible to other participants. The DO tracks observer connections in memory only (not persisted, not synced).

### Godot observer mode

When `EVT_LOBBY_INIT` arrives with `{ observerMode: true }`, Godot:
- Renders identically to a normal player view
- Does not render any player-specific HUD (no "your turn" indicators, no secret prompt)
- May optionally show an "observer" watermark or badge

No additional bridge events are needed — observers receive the same public state events as players.

---

## DO write authorization — lobby tables

| Table / field | Who can write | Enforced |
|---|---|---|
| `room.status` | host only | DO `webSocketMessage` intercept |
| `room.gameType` | host only; only during `'waiting'` | DO intercept |
| `room.gameConfig` | host only; validated against game's Zod schema | DO intercept |
| `room.*` (all other fields) | host only | DO intercept |
| `players[id].*` (most fields) | that player only (matched by session PlayerId) | DO intercept |
| `players[id].isConnected` | DO only — set on WS open/close; no client may write another player's value | DO intercept |
| `players[id].autoplayMode`, `players[id].autoplaySince` | self (opt-in) or host (on disconnect takeover/reconnect) | DO intercept |
| `secretPool` (any write) | host only | DO intercept |
| game-specific tables | host only (or validated per-game rules) | DO intercept |
| anything | observer: no writes at all | DO drops all inbound messages from observer connections |

---

## Resolved decisions

| Question | Decision |
|---|---|
| `EVT_SECRET_ASSIGNED` in Godot? | No — secret display is web chrome only; Godot is not aware |
| Minimum players to start? | 1 — solo host can start |
| Mid-game join? | No — lobby is the only entry point; `status = 'active'` rejects new auth |
| Secret assignment mode? | Fully automatic — host client deals on player join, no UI intervention |
| Host as player? | Yes — host receives a secret from the same deck; no special logic path |
