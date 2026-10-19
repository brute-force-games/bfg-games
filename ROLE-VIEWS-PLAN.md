# Role-Scoped Debug Views

> **Note on citations.** Line numbers like `tinybase-room-store.ts:777` are
> hints to find the right place at the time of writing — they will rot.
> Prefer the surrounding symbol or function name when implementing or
> reviewing.

## TL;DR

- **Goal:** a per-role text/debug view of a live room — what data each
  `UserGameRole` sees, with encryption boundaries explicit.
- **Model:** every connected client holds every row; what differs by role is
  which *keys* decrypt which ciphertext.
- **Route:** new `/room/:roomId/monitor[?role=...]`. Connects with the
  most-privileged credentials the local client owns and *simulates*
  lower-privilege roles by withholding keys at the render layer.
- **Two views per encrypted row:** wire (always shown — iv, ciphertext,
  AAD) and decrypted (role-scoped). Opaque rows expose a per-row "peek"
  disclosure when the local client could decrypt — bounded by reality, not
  the simulated role.
- **`host_player` shows a player's view, not the host's.** The
  host_moderator tab is the explicit "show me everything the host can
  decrypt" simulation; peek covers the gap on individual rows.
- **The biggest framework wins** that would simplify implementation:
  `tryDecrypt(row, keyset)` in shared-types, an `onEventsChanged`
  subscription, and a submission-plaintext cache. See "Framework friction
  & opportunities" below.
- **Caveat — no passive-connect mode:** the monitor's client appears in
  the players list (or as a moderator) like any other connection.

---

**Goal.** Make it possible to monitor a live game while *seeing exactly the
information each role has access to*. Today the only views we have are the
gameplay surfaces in `-roomRoutePage.tsx` (lobby, host-active, host-finished,
shared spectator) and the kitchen-sink dump at `room.$roomId.archive.tsx`.
Neither answers "what does an `anonymous_spectator` see right now vs. what
does a `host_moderator` see?" — and neither makes the *encryption boundaries*
visible, which is the whole point of the role distinction.

We need text-first, role-scoped readouts of every store subscription, framed
as "everyone sees every row; the question is which keys they hold."

## What "role" means here

Two enums collide. Both come from `platform/shared-types/src/core/user-game-role.ts`:

- `RoomSessionRole` — transport tier (`pending | player | observer | moderator`).
  Decided by the store from the connect options (host claim / `joinAsObserver` /
  `hostParticipatesAsPlayer`). Affects what host-side validators *accept* from
  this client (submissions, chat, ready-flags), not what rows the client can
  see — every connected client receives the same synced rows.
- `UserGameRole` — UI role (`anonymous_spectator | host_moderator | host_player
  | player | participant_observer`). Derived in `deriveUserGameRole(...)` from
  the session tier plus URL segment plus host-claim presence.

The debug views need to be parameterized by `UserGameRole` (it's the richer
distinction) but must also surface the underlying `RoomSessionRole` so we can
spot when the two disagree.

## The model: every row is visible to every participant

This is the load-bearing fact for this plan. The CRDT/sync layer has no
row-level access control — once you're connected to a room, your local
TinyBase store contains every row in every table. What changes by role is
**which rows you can decrypt**, and (for write paths) which writes the host
will accept.

There are two encryption directions in play, both built on the per-identity
encryption keypairs and the per-room host keypair (see `tinybase-room-store.ts`):

1. **Player → host** (submissions). `submissions[*].toHostCiphertext` is
   sealed to `room.hostEncPubKey`. Only a client holding the host keypair
   can decrypt. Players keep their *own* plaintext locally before sending,
   so they have a transient window where they know their own move; everyone
   else's submissions are opaque to them forever.
2. **Host → one specific player** (per-player private state).
   `gameStatePrivate[*]` is sealed to *that player's* `encPubKey` via
   `encryptHostMessageToPlayer` (see `tinybase-room-store.ts:777`). The
   recipient decrypts with their player privkey via
   `decryptJsonForSelfFromGameStatePrivate` (`tinybase-room-store.ts:799`).
   Crucially, **the host cannot re-decrypt these rows after writing them** —
   the host wrote with the player's pubkey and does not hold the player's
   privkey. The plaintext exists only in the host process for the moment
   between computing it and sealing it.

Plaintext rows that have no encryption at all (and are visible to everyone):
`room`, `players`, `events` (public payloads), `gameStatePublic`,
`gameStateHistory`, `lobbyChatEvents`. Lobby chat *submissions* are encrypted
to the host like game submissions; lobby chat *events* are the host's
plaintext rebroadcast.

### What that means per role

Same rows, different keys:

| Source | `anonymous_spectator` | `participant_observer` | `player` | `host_player` | `host_moderator` |
|---|---|---|---|---|---|
| `getRoom()` | plaintext | plaintext | plaintext | plaintext | plaintext |
| `getPlayers()` | plaintext | plaintext | plaintext | plaintext | plaintext |
| `getEvents()` (public payloads) | plaintext | plaintext | plaintext | plaintext | plaintext |
| `getGameStatePublicOrNull()` | plaintext | plaintext | plaintext | plaintext | plaintext |
| `getGameStateHistory()` | plaintext | plaintext | plaintext | plaintext | plaintext |
| `getLobbyChatEvents()` (host rebroadcasts) | plaintext, no send | plaintext, no send | plaintext, can send | plaintext, can send | plaintext, can send |
| `getSubmissions()` rows | rows visible, ciphertext opaque | same | rows visible, ciphertext opaque | rows visible, ciphertext opaque (player view) | rows visible, host privkey decrypts all |
| `getGameStatePrivateOrNull(p)` for `p === self` | n/a (no seat) | row visible; player privkey decrypts | row visible; player privkey decrypts | row visible; player privkey decrypts | n/a (no seat) |
| `getGameStatePrivateOrNull(p)` for other players | row visible; opaque | row visible; opaque | row visible; opaque | row visible; opaque | row visible; opaque (sealed to player pubkey, not host's) |
| Local host bootstrap (`LocalRoomRole`) | not held | not held | not held | held (peek only) | held |

Three callouts:

1. **Hosts cannot read other players' private state.** I had this wrong in
   the first draft of the plan. The encryption is host→player, not host→host.
   Even host_moderator's privileged decrypt is *submissions only* — they
   cannot decrypt other players' private state (sealed to that player's
   pubkey). If we want a "host can see all private state for debugging" mode
   in the future, that's a deliberate engine-level change (e.g. an additional
   row encrypted host→host alongside the host→player row); it's not free.
2. **`participant_observer` and `player` are key-equivalent.** Same identity,
   same keys, same rows, same decryption capability. The only difference is
   which URL segment they entered through and the resulting UI chrome. The
   debug view should show both panels with identical data and an explicit
   banner saying so.
3. **`host_player` shows a *player's* view, not a host's.** The technical
   capability of a host_player client is a strict superset of host_moderator
   plus a player seat — they run the host loop, so they decrypt every
   submission in real life. But the monitor models *intended visibility per
   role*, not raw technical reach. The whole point of distinguishing
   host_player from host_moderator is that one is sitting at the table as a
   player; that role should see only their own player data decrypted.
   host_moderator is the "I'm running the game, show me everything the host
   role can decrypt" simulation. The local client's actual host privkey is
   still available via per-row peek (see Encrypted-vs-decrypted dual view
   below) — that's the escape hatch when you need to verify what's really in
   a row a host_player simulation has marked opaque.

## Proposed file layout

Add one new flat route plus a small set of presentation pieces. Don't fold
this into `-roomRoutePage.tsx` — that file is already 1.2k lines and conflates
gameplay chrome with role logic.

```
platform/web/src/routes/
  room.$roomId.monitor.tsx          ← NEW route. /room/:roomId/monitor[?role=...]
platform/web/src/games/monitor/     ← NEW dir, sibling of games/chrome/
  RoleMonitorPanel.tsx              ← one role's full readout
  RoleSelector.tsx                  ← tab/segmented control across roles
  sections/
    RoomSection.tsx                 ← Room row + connection state + key inventory
    PlayersSection.tsx              ← Players[], session role, identity
    EventsSection.tsx               ← getEvents() with engine.formatStep fallback to raw JSON
    PublicStateSection.tsx          ← latest public snapshot, with diff vs. previous seq
    PrivateStateSection.tsx         ← walks every row; dual-view: ciphertext header + decrypted/peek body
    EventsPrivateSection.tsx        ← per-event per-player ciphertext (eventsPrivate table); same dual-view
    SubmissionsSection.tsx          ← walks every row; same dual-view
    MoveTraceSection.tsx            ← cross-table: submission ↔ accepted_submission event ↔ derived events ↔ snapshot delta
    LobbyChatSection.tsx            ← events + read/write capability indicator
    StateHistorySection.tsx         ← seq-indexed snapshots
  decryptForActiveRole.ts           ← given (row, role, keys), return { decrypted | opaqueReason }
```

`RoleMonitorPanel` takes `(roomStore, userGameRole, sessionRole, identity)` and
renders the sections. The route is responsible for the connect lifecycle
(mirrors what `-roomRoutePage.tsx` already does) but reads-only — never starts
the host loop, never sends submissions, never heartbeats as ready. We just
want a passive observer that *also* knows the host keypair when the local
client legitimately holds one.

## Route behavior

`/room/:roomId/monitor` connects with the same options the role-specific
routes use today, with one twist: the underlying client always connects with
the most-privileged credentials it actually owns (host claim if present,
otherwise the player identity), and the monitor *simulates* less-privileged
roles by withholding keys at the rendering layer.

So the connect step doesn't depend on `?role`; only the rendering does:

- If the client has a `LocalRoomRoleHost`, connect with the host claim. The
  panel can then render any of the five roles: for non-host roles, it withholds
  the host keypair from `decryptForActiveRole` and (for `anonymous_spectator`
  and the host roles when there's no seat) withholds the player keys too.
- If the client has no host claim, connect as a normal participant. The panel
  can render `player`, `participant_observer`, `anonymous_spectator`. It
  *cannot* honestly render the host roles — we'd be showing decrypted
  submissions we don't actually possess. Selector hides those tabs.

The route accepts `?role=<UserGameRoleKind>` to pick the active panel. Default
to whatever `deriveUserGameRole` returns for the actual session: opening
`/monitor` from a host tab lands on `host_moderator`; from a player tab lands
on `player`.

We can later add `?multi=1` for a vertical stack of all reachable roles
side-by-side; start with the single-role tab.

**There is no explicit "passive connect" mode — be deliberate about session
role side effects.** Not calling `setSelfReady(true)` is enough to stay out
of the ready-players list, but the player row is still written on connect,
so the monitor client is visible to other participants. For a host client
connecting with `hostParticipatesAsPlayer: false` the session role becomes
`moderator` and no player row is written — that's the cleanest option when
the monitor is opened from a host tab. For non-host clients the monitor
connects as `pending`/`player` and will appear in the players list. Both
are honest representations of what that client actually is, but it's worth
knowing rather than assuming the monitor is invisible.

## Per-row decryption rules

`decryptForActiveRole` is the load-bearing function. Inputs:

- The row (`Submission` or `GameStatePrivate`).
- The role being simulated.
- The keys the *simulated* role would hold (intended visibility, not raw
  technical capability — see the host_player callout above):
  - `anonymous_spectator`: `{}` — no identity, no host claim.
  - `participant_observer` / `player`: `{ playerPriv: identity.enc.priv }`.
  - `host_player`: `{ playerPriv: identity.enc.priv }` — same as player. The
    host privkey is deliberately withheld from this simulation; if you want
    host-level submission decrypts, switch to the `host_moderator` tab or
    use peek on a specific row.
  - `host_moderator`: `{ hostPriv: hostKeypair.priv }` — no seat → no player
    priv → no own private state to decrypt; submissions are decrypted via
    `hostPriv`.

Output is a tagged union:

```
type DecryptOutcome =
  | { kind: 'decrypted'; via: 'playerPriv' | 'hostPriv' | 'plaintext'; value: unknown }
  | { kind: 'opaque'; reason: 'no-key' | 'aad-mismatch' | 'wrong-recipient' }
```

Note: `GameStatePrivate` rows with `kind === 'plain'` (see `tinybase-room-store.ts:806`)
are already plaintext — they return `decrypted/via: 'plaintext'`, not an opaque outcome.
There is no `plain-row` opaque reason.

**`decryptForActiveRole` is async; lean on React Query rather than raw
`useEffect`.** The underlying crypto primitives are all `async`. The
codebase already has `@tanstack/react-query` configured globally
(`__root.tsx:10`) and uses `useSuspenseQuery` for the archive route's
connect lifecycle (`room.$roomId.archive.tsx:142`). The same pattern fits
here:

- Per-row decrypt: `useQuery({ queryKey: ['decrypt', table, rowId,
  simulatedRole], queryFn: () => tryDecrypt(row, keysetForRole(...)) })`.
  Rows are immutable once signed (signatures pin them), so the query key
  is naturally content-addressable — no stale-cache concerns. Dedup across
  tabs (host_player and host_moderator decrypt the same submission once)
  comes for free. This subsumes the `(rowId, seqOrNonce, role)` cache the
  plan originally hand-rolled.
- Connect lifecycle: `useSuspenseQuery` for the initial connect (with host
  claim if available), mirroring the archive route exactly.
- Peek disclosure: a `useQuery` that's `enabled: false` until clicked,
  then resolves with a Suspense fallback inside the expanded panel.

Where Suspense doesn't fit: streaming row lists. You don't want each of N
rows suspending the parent section — that'd remount on every new
submission. Reactive store data (`onSubmissionsChanged` and friends) stays
in `useEffect` → `setState` for "what rows exist right now"; per-row
async decrypts move into queries downstream. Render the wire view
synchronously (it's already in the store) and let the decrypted view
populate as queries resolve, with a per-row placeholder rather than a
section-wide fallback.

**No "local plaintext" side-channel for player submissions.** The plan
originally floated showing own submissions' plaintext because the player had
it locally before encrypting. In practice `submit()` encrypts and writes the
ciphertext row but does not cache the plaintext afterward. Without adding
that cache the monitor cannot recover it. Skip for v1: own submissions are
as opaque as anyone else's from the player role's perspective.

**This case maps to `opaque/no-key`, not a new reason.** From the simulated
role's keyset, a submission is sealed to `hostPriv` and the player simulation
has no `hostPriv` — that's exactly `no-key`. Don't invent a parallel taxonomy
like `no-local-cache`; that confuses implementers into thinking it's a
distinct decrypt outcome when it's the same one with extra context. The "we
*could* have shown this if `submit()` cached plaintext" observation belongs
in section copy ("ⓘ this is your own submission — peek to see it"), not in
the `DecryptOutcome` union. If/when framework item 2 (submission-plaintext
cache) lands, those rows will resolve to
`decrypted/via: 'localPlaintext'` and the union picks up that variant
exactly once.

Section components render from the `DecryptOutcome` union and never see raw
private keys. Every row's annotation makes the encryption boundary visible —
that's the whole pedagogical point of the monitor.

## Encrypted-vs-decrypted dual view (player-scoped rows)

For every player-scoped row (`Submission`, `GameStatePrivate`,
`EventsPrivate`) — across *every* simulated role — the section renders two
stacked views:

1. **Wire view** (always shown). The on-the-wire payload as it actually exists
   in the row: `iv`, `ciphertext` (truncated hex), `aad` fields, byte length,
   and any plaintext metadata (`fromPlayerId`, `kind`, `createdAt`, `seq`).
   For signed rows, surface the signature bytes too:
   - `Submission.signature` — Ed25519 by `fromPlayerId` over the canonical
     submission bytes (player-signed authentication of the move).
   - `Event.hostSignature` — Ed25519 by the host over the canonical event
     bytes (host-signed authority).
   - `gameStatePublic.hostSignature` and `gameStateHistory.hostSignature` —
     same.
   Show the signing pubkey and a `verify ✓/✗` badge so the wire view is
   self-auditing, not just "here are some bytes."
   This is what *every participant* sees in their store regardless of role.
   Plain rows still get this header for consistency, with the ciphertext
   block replaced by a `(plain — no encryption)` marker.

2. **Decrypted view** (role-scoped). What `decryptForActiveRole(row,
   simulatedRole, simulatedKeys)` returned:
   - `decrypted` → the JSON value pretty-printed.
   - `opaque` → an "🔒 encrypted" placeholder with the reason
     (`no-key` / `wrong-recipient` / `aad-mismatch`).

The wire view is non-negotiable — it's what makes the encryption boundary
visible. A simulated `anonymous_spectator` should be looking at the actual
ciphertext blob, not at "🔒 encrypted" alone, so the bytes are real to them.

### Peek (ground-truth disclosure)

Inside every `opaque` row, when the *local client* (not the simulated role)
holds a key that *would* decrypt it, render a collapsed `▸ peek` disclosure.
Expanding it runs `decryptWithLocalKeys(row)` — a sibling function to
`decryptForActiveRole` that uses *all* keys the local client actually holds —
and shows the plaintext alongside a yellow "ground truth — outside the
simulated role's view" warning.

This is the debug escape hatch the user asked for. It exists because the
whole point of monitoring is to verify behavior, and verification sometimes
needs to compare "what the simulated role sees" against "what's actually in
that row." Without peek, when something looks wrong in a player simulation
you have to switch roles to investigate, losing your spot.

Rules for peek:

- Peek is bounded by **what the local client actually holds**, not what any
  role *could* hold. A non-host monitor never peeks at a submission's
  plaintext — the host privkey isn't on the device, so there's nothing to
  reveal. Same for other players' private state regardless of who's
  simulating: the peeker would need that player's privkey, and no one has
  it but the player.
- Peek is collapsed by default and per-row. There is no "peek everything"
  button — making each disclosure deliberate keeps the screenshot honest by
  default.
- Peek output is visually distinct (yellow border, "ground truth" label) so
  it can never be mistaken for the simulated role's actual view.
- Peek availability is itself information: showing a `▸ peek` affordance on
  an opaque row tells you "the local client has the key for this." Showing
  no affordance tells you "even reality can't decrypt this here." Both are
  useful diagnostic signals.

### Implementation shape

```
type RowView = {
  wire: WireView;             // always populated
  roleScoped: DecryptOutcome; // what simulatedRole sees
  peek?: PeekHandle;          // present iff local client could decrypt
};

type PeekHandle = {
  // Async. Lazily decrypts the first time peek is opened; cached after.
  reveal: () => Promise<DecryptOutcome>;
  via: 'playerPriv' | 'hostPriv';  // which local key would be used
};
```

`PeekHandle` is built by the monitor route at the same level as
`decryptForActiveRole`, with access to the local client's full key set.
Section components close over the union but never directly hold key
material.

## Move trace (cross-section correlation)

The Submissions, Events, and snapshot sections each show one table. But a
single *move* spans them: a player's signed submission becomes the host's
signed acceptance event, which becomes one or more game-specific events,
which advance the public snapshot and possibly write per-player private
state. Understanding "what happened on this move" means following that
chain across tables.

`MoveTraceSection` makes this explicit. For each submission (newest first),
render a card containing:

1. **Submission row** (player-signed). Wire view + decrypted view as
   defined above. Shows `fromPlayerId`, `nonce`, `kind`, the player's
   `signature` with verify badge, the ciphertext.
2. **Acceptance event** — the `host/accepted_submission` event whose
   `publicPayload.submissionId` matches. Host-signed. Shows host signature
   with verify badge. Absent if the host hasn't processed this submission
   yet (legitimate state — call it out so debugging stalled submissions is
   easy).
3. **Derived events.** Events the host emitted in response to the
   submission, identified by their position relative to the acceptance
   event (between this submission's accepted_submission and the next one
   in seq order). Each shows host signature.
4. **Snapshot delta** — `seq` of the public snapshot before vs. after
   this move, and which `gameStatePrivate` rows were rewritten (one per
   affected player). Both are host-signed; per-player private payloads
   apply the same dual encrypted/decrypted view.

This is the "show me both sides of one move" view. The player-signed and
host-signed versions sit next to each other, with verify badges on each,
so it's immediately obvious which authority signed what.

The correlation logic uses only public fields:
`event.publicPayload.submissionId === submission.id`. No keys involved —
trace assembly is the same for every role. What differs by role is what
*plaintext* is visible inside each step.

A future enhancement could traverse the chain backward from a snapshot
delta: "this snapshot at seq 42 was caused by event 41, which was caused
by submission X." Out of scope for v1; submission-forward is enough to
diagnose live games.

## Update cadence and feel

Debug-y, terminal-y. No game-specific UI (no boards, no cards). Each section
is a heading + a JSON pretty-print or a short table. Auto-updates on every
relevant subscription (`onRoomChanged`, `onPlayersChanged`,
`onGameStatePublicChanged`, `onGameStatePrivateChanged(playerId)` for each
player the simulated role might have a key for, `onLobbyChatEventsChanged`,
and refreshes events whenever the public-state seq advances — the same trick
`ActivityFeed` already uses).

**Private state subscriptions must walk all players and rebuild on roster
changes.** `onGameStatePrivateChanged` takes a `playerId` argument, so you
call it once per player. Because the player list can change (new joiner,
reset), the subscription set must be torn down and rebuilt whenever
`onPlayersChanged` fires. Forgetting this means new players' rows are never
watched.

Cache decrypts by `(rowId, seqOrNonce, simulatedRole)` so we don't redo work
on every render.

Add a "freeze" toggle at the top of each section that pauses auto-refresh —
useful when something interesting just happened and you want to read it
without it scrolling away.

## Navigation hooks

- Add a "Monitor" link to `RoomRouteNav` in `-roomRoutePage.tsx:718`,
  alongside Play / Host / Observe / Spectate. Show it always; the destination
  view handles role-availability.
- The Monitor view's own header gets back-links to the four canonical routes
  so you can hop between "what does this look like in real chrome?" and
  "what's the data underneath?"
- `routeTree.gen.ts` regenerates from the route file; nothing to hand-edit.

## Implementation order

1. `decryptForActiveRole` + unit tests against a hand-built fixture covering
   every (row-type × role) cell of the table. This is the load-bearing piece
   — get it right before any UI. Tests must include:
   - "host_player simulation, own submission row" → `opaque/no-key` (the
     simulation does not hold hostPriv, even though the local client does).
   - "host_player simulation, own private state row" → `decrypted/playerPriv`.
   - "host_moderator simulation, any submission row" → `decrypted/hostPriv`.
   - "host_moderator simulation, any private state row" → `opaque/wrong-recipient`.
   - "any player simulation, other player's private state row" →
     `opaque/wrong-recipient`.
2. `RoleMonitorPanel` skeleton with section stubs that just dump the
   per-row decrypt outcomes as JSON.
3. Section components, in this order: Room, Players, Events, PublicState,
   PrivateState, Submissions, LobbyChat, StateHistory.
4. `room.$roomId.monitor.tsx` route + connect lifecycle.
5. `RoleSelector` + URL `?role=` plumbing, with availability based on which
   keys the local client actually holds.
6. Add the `Monitor` nav link.
7. Manual smoke pass: open four browser tabs (host, player, observer,
   spectate) on the same room, run a tic-tac-toe game, confirm each role's
   monitor view shows what it should:
   - On the host tab, `host_player` panel shows submissions as opaque (and
     a peek affordance is present on each), while `host_moderator` panel
     shows them all decrypted.
   - On a player tab, switching to the `host_moderator` tab is unavailable
     (no host keypair → no peek either).
   - Other players' private state is opaque under every role.

## Framework friction & opportunities

Reviewing the plan against the existing `RoomStore` interface and
`tinybase-room-store.ts`, several pieces of this are awkward today and would
collapse to near-trivial if the framework gave us the right primitives.
Listed in priority order: the first three are wins big enough that landing
them *first* would meaningfully shrink the rest of the plan; the others are
nice-to-haves.

### High impact

**1. A non-throwing `tryDecrypt(row, keyset): Promise<DecryptOutcome>` in
`shared-types`.** This is the deepest single improvement. Today the bare
primitives `decryptSubmissionFromPlayer` and `decryptHostMessageFromHost` are
exported from `shared-types/core/encryption.ts:244` and `:168`, but they
throw on key/AAD mismatch and require the caller to reconstruct the AAD
fields from scattered sources (the row + the room + sometimes the player
list). The store has its own wrappers (`decryptSubmissionForHost` at
`tinybase-room-store.ts:970`, `decryptJsonForSelfFromGameStatePrivate` at
`:799`) but each gates on a session role that the monitor's role-simulation
doesn't fit.

What we want: a tagged-union, exception-free decrypt that takes a row and a
keyset and returns the same `DecryptOutcome` the plan defines. Used by the
monitor *and* by future tools (replay, export verification, dev panels). If
this lands, `decryptForActiveRole` becomes:

```
function decryptForActiveRole(row, role, ownedKeys) {
  return tryDecrypt(row, keysetForSimulatedRole(role, ownedKeys));
}
```

— a 6-line file plus the role-to-keys table, instead of a wrapper around
two private store methods plus an AAD-reconstruction layer.

**2. A submission-plaintext cache in the store, keyed by `submissionId`.**
The plan currently calls "no local plaintext side-channel" out as a v1
limitation. The fix is small: in `submit()` (`tinybase-room-store.ts:633`),
when the caller passed `plaintext`, stash `(submissionId → plaintext)` in a
Map alongside the row write. Add `getSubmissionPlaintextOrNull(id)` to the
`RoomStore` interface.

This turns "🔒 encrypted (you sent this but we don't have the bytes)" in the
player monitor view into "decrypted/via: 'localPlaintext'" — accurate and
useful. It also helps the existing player UIs render their own pending moves
without engine-specific caching, which several engines currently do
themselves. Zero security implications: the plaintext was already in process
memory at submit time.

**3. `onEventsChanged(cb)` on `RoomStore`.** The current
`RoomStore` interface has subscriptions for every other table but not
`events`. Both `room.$roomId.archive.tsx:48-55` and
`games/chrome/ActivityFeed.tsx:23-29` work around this by re-reading
`getEvents()` whenever `gameStatePublic` advances — relying on the host's
write-order of "event row, then snapshot" to make the trick work. The
monitor would be the third place doing this. Adding the subscription is a
two-line change in `tinybase-room-store.ts` (the table listener pattern is
already used for every other table); cleaning up the workarounds is an
afternoon.

### Medium impact

**4. A "passive" connect mode.** The plan has a paragraph explaining that
non-host monitor clients still appear in the players list because there's no
way to "just watch as my real identity." Today's options: `joinAsObserver:
true` makes you anonymous (loses the identity → loses your player keys → 
breaks the `player`-role simulation), or `hostParticipatesAsPlayer: false`
gives you `moderator` (host-only). A `passive: true` flag that connects with
your real identity but doesn't write a player row or heartbeat would let the
monitor be honestly invisible. This is the single biggest reason the current
plan has caveats about side effects.

**5. `onGameStatePrivateTableChanged(cb)` — a per-table variant.** Today
`onGameStatePrivateChanged(playerId, cb)` is per-player, so the monitor
maintains N subscriptions and tears them down on roster changes (called out
in the plan). A single per-table subscription that fires on any change and
hands back the full row set would replace that machinery with one
subscription. Same shape as `onPlayersChanged` already has.

**6. AAD-reconstruction helpers exported from `shared-types`.**
`canonicalSubmissionAadBytes` (`encryption.ts:50`) and
`canonicalHostMessageAadBytes` (`:102`) exist but take an already-assembled
`SubmissionAadFields` / `HostMessageAadFields` object. The actual
reconstruction logic — "given this `Submission` row and the live `Room`,
build the AAD that was used to encrypt it" — lives inline in the store at
`:651` and `:780`. Move that into `submissionAadFromRow(row, room)` and
`privateStateAadFromRow(row, room, seq, kind, gameType)` and the monitor's
wire-view section can render canonical AAD bytes alongside the ciphertext
without copying logic.

**7. `roleCapabilities(role): RoleCapabilities` in `shared-types`.** The
plan reverse-engineers each role's intended visibility from prose plus a
table. If `user-game-role.ts` exported a structured descriptor —
`{ canDecryptOwnSubmission, canDecryptOwnPrivateState,
canDecryptAllSubmissions, hasPlayerSeat, ... }` — both the monitor's
key-mapping function and any future engine that wants to branch on role
would consume the same source of truth. Today the role-checking helpers
(`canSubmitGameMoves`, `shouldUseSpectatorChrome`, etc.) each encode one
small predicate; this would generalize them.

### Smaller / cleanup

**8. Pull the archive route's "read-only connect" wrapper into `useSync`.**
`room.$roomId.archive.tsx:21-34` has a `connectRoomStore` helper that the
monitor would copy verbatim. Move it to `SyncContext` as
`getReadOnlyRoomStore(roomId)` so both routes share one connect path with
identical key-loading semantics.

**9. `useSync().getRoomKeyset(roomId): { playerPriv, hostPriv? }` as a
single reactive value.** Today the monitor (and the existing routes)
assemble this from two sources: `identity` for the player keys,
`loadHostKeypairForRoom(roomId)` for the host keypair if any. A combined
typed accessor would let `RoleMonitorPanel` close over one well-shaped
object instead of juggling sources, and would centralize the "do I have
host privileges for this room?" check that `-roomRoutePage.tsx` currently
duplicates.

**10. Memoized decrypt cache.** Largely handled by React Query at the
consumer side (see "lean on React Query" note in the per-row rules
section): row id + simulated role makes a natural content-addressable
query key, and React Query's cache dedups across components. If
non-React consumers (tests, CLI tools) ever need the same caching, an
internal memo inside `tryDecrypt` keyed by row id + keyset hash would
cover them too — but that's a follow-up if/when those consumers exist.

### What this means for the plan's order

If items 1, 2, and 3 land first, the implementation order in this plan
shrinks:

- Step 1 ("`decryptForActiveRole` + unit tests") becomes a thin wrapper —
  the matrix-coverage tests move down to `tryDecrypt` in shared-types where
  they belong.
- The "no-local-cache" footnote in the per-row rules disappears; player
  views become honest about own moves.
- Sections that need to refresh on event changes drop their
  `gameStatePublicSeq`-piggyback hack.

Whether to do those framework changes first is a sequencing call. Items 1
and 3 are small and unlock cleaner code in places beyond the monitor
(activity feed, archive route, future replay tooling). Item 2 has a
slightly larger surface (interface change + cache lifecycle) but pays back
the same way. Items 4-10 can land alongside or after the monitor without
blocking it.

## Out of scope (call out, don't build)

- Recording / playback. The existing `archive` route + game record export
  cover post-hoc inspection.
- Side-by-side multi-role rendering in one panel. The single-role tab is
  enough for v1; `?multi=1` is a follow-up.
- Anonymizing display names in the `anonymous_spectator` view. Production
  spectators see real names today; the debug view should reflect that.
- Hooking the monitor into Godot game iframes. Monitor is text-only.
- "Host can debug-decrypt other players' private state." That requires the
  engine to write an additional host→host copy alongside the host→player
  row. Real change to the snapshot pipeline; not part of this plan.

## Risk: leaking key material into non-host simulations

The whole point is to render filtered views of unfiltered data the local
client *does* hold keys for. If we let a key slip into a simulated role that
shouldn't have it, we've defeated the purpose. Mitigation:

- `decryptForActiveRole` is the sole path from raw row → decrypted value.
  Section components never see the keypair object, only the per-row
  `DecryptOutcome` tagged union.
- The role → key-set mapping is one function with full unit-test coverage
  (the table in this plan, encoded). Adding a new role means updating that
  function and its tests, not editing call sites.
- Simulated host roles only become available when the local client *actually*
  holds the host keypair. We never fabricate decrypted output we couldn't
  produce in real life.
