# Plan diffs: `CURSOR-PLAN.md` vs `CLAUDE-PLAN.md`

## High-level alignment (same in both)
~~- **Two projects**: Godot 4.6.2 web export + Vite/React SPA.~~
~~- **Shared schemas/types**: TypeScript + Zod, with branded ID types and prefixed ID strings for Godot interop.~~
~~- **Multiplayer**: Cloudflare Durable Objects, per-room DO keyed by `RoomId`, WebSocket transport.~~
~~- **Sync model**: custom **intent → validate/authorize in DO → broadcast patches** approach (explicitly *not* relying on TinyBase’s built-in WS synchronizer).~~

Moved to `FINAL-PLAN.md` → **High-level alignment (agreed)**.

## Direct conflicts / choices (they differ materially)
~~- **Repo folder layout + naming**~~
~~  - **CURSOR**: `apps/web`, `apps/edge`, `packages/shared`, `packages/protocol`, `godot/acronym-game-web`, `scripts/`.~~
~~  - **CLAUDE**: top-level `acronym-game-app/`, `acronym-game-edge/`, `acronym-game-web/`, plus `shared-types/shared` + `shared-types/protocol`, and `scripts/godot-export.sh`.~~
~~  - **Impact**: mostly naming/organization; affects import paths, tooling defaults, and how Cloudflare configs are organized.~~

Moved to `FINAL-PLAN.md` → **Repo folder layout + naming** decision.

~~- **Godot embedding strategy (route shape + DOM integration)**~~
~~  - **CURSOR**: Godot is served under a dedicated `/play` route and loaded from `/godot/acronym-game-web/...`; described as a “separate route/sub-app.”~~
~~  - **CLAUDE**: Godot is mounted *inside* a React route as a component (`<GodotCanvas />`) so SPA chrome wraps it; route is `/room/:roomId/play`.~~
~~  - **Impact**: affects how UI overlays/HUD integrate, how routing carries `roomId`, and whether “play” must be tied to a room route.~~

Moved to `FINAL-PLAN.md` → **Godot route + embedding** decision.

## Details present in `CLAUDE-PLAN.md` but not in `CURSOR-PLAN.md`
~~- **Explicit “two TinyBase stores” architecture**~~
~~  - Local store persisted to `localStorage` (identity + preferences) via TinyBase persister.~~
~~  - Room store as a synced read-replica + intent queue, created on join and torn down on leave.~~

~~- **More specific room data model**~~
~~  - Proposed tables: `room`, `players`, `rounds`, `submissions` (with some TBD fields marked ❓).~~

~~- **Host reassignment rule**~~
~~  - If host disconnects: reassign host to the next oldest connection.~~

~~- **Edge API contract includes join token**~~
~~  - `POST /api/rooms → { roomId, joinToken }`.~~
~~  - **CURSOR** mentions “join info” but doesn’t specify tokens.~~

~~- **App stack choices called out**~~
~~  - React 19 explicitly.~~
~~  - TanStack Router explicitly.~~
~~  - Explicitly argues **TanStack Query not needed** (TinyBase subscriptions + plain `fetch`).~~

~~- **Concrete route tree**~~
~~  - `/`, `/room/:roomId`, `/room/:roomId/play`, `/settings`.~~

~~- **Concrete file-level Godot integration sketch**~~
~~  - `src/godot/GodotCanvas.tsx`, `src/godot/bridge.ts`, export artifacts in `public/godot/`.~~
~~  - Specific JS bridge names (`window.__godotBridge.receive`, `window.__acronymApp.onGodotEvent`).~~

~~- **Deployment mechanics**~~
~~  - Mentions Pages `_routes.json` proxying `/api/*` to Worker.~~

~~- **Roadmap + phased Definition of Done**~~
~~  - Phases 0–6 with staged deliverables.~~
~~  - “Definition of Done” is scoped to phases 0–3 and includes local-store persistence requirements.~~

~~- **Open questions section**~~
~~  - Mechanics, round timer mode, acronym source.~~

Moved to `FINAL-PLAN.md` → **Claude decisions we’re adopting (project conventions)**.

## Details present in `CURSOR-PLAN.md` but not in `CLAUDE-PLAN.md`
~~- **Explicit “packages split”** between `packages/shared` (branding/utilities) and `packages/protocol` (schemas/codecs/versioning) as separate workspaces (concept exists in Claude plan but naming/packaging differs).~~

Moved to `FINAL-PLAN.md` → **Shared code packaging** decision (single shared location for now).
Resolved clarification: `shared-types/` is **one** npm package/workspace (not split into `shared-types/shared` + `shared-types/protocol` workspaces).
- **Protocol versioning requirement**
  - `PROTOCOL_VERSION` constant and `{ v }` on top-level messages.
  - (Claude plan implies schemas, but doesn’t explicitly require versioning.)

- **Godot export path + copy strategy is described generically**
  - Export to staging then copy into `apps/web/public/godot/acronym-game-web/*`.
  - (Claude plan is more concrete: headless export script directly into app `public/godot/`.)

- **Edge routes list includes optional room metadata endpoint**
  - `GET /api/rooms/:id` (optional).

## “Same idea, different level of specificity”
- **ID system**
  - Both use `<prefix>_<ulid>` style; CURSOR mentions base32/ULID options, CLAUDE standardizes on ULID and adds `RoundId` + `SubmissionId` upfront.
  - Branding implementation differs: CURSOR uses `__brand` string property; CLAUDE uses `unique symbol` (both workable).

- **TinyBase sync language**
  - Both describe intent/patch; CLAUDE more explicitly positions the client store as “read replica + intent queue.”

## Practical reconciliation recommendation (to merge the plans cleanly)
~~- **Pick one repo layout**: either CURSOR’s `apps/`+`packages/` or CLAUDE’s top-level `acronym-game-*` folders; everything else can be adapted.~~
~~- **Pick the play route model**:~~
~~  - If play must always be attached to a room: prefer CLAUDE’s `/room/:roomId/play`.~~
~~  - If play can exist standalone (debug/dev or single-player): CURSOR’s `/play` is simpler, but you can still accept `roomId` via querystring.~~

Resolved and moved to `FINAL-PLAN.md` → **Repo folder layout + naming** and **Godot route + embedding**.

## Decision log (user-chosen)
~~- **Repo folder layout + naming**: use **CLAUDE** layout/naming (top-level `acronym-game-app/`, `acronym-game-edge/`, `acronym-game-web/`, `shared-types/...`, `scripts/...`).~~
~~- **`acronym-game-edge/` scope**: keep it, but as a **minimal** Cloudflare Worker entrypoint + Durable Object deployment unit (Worker only routes HTTP/WS to the DO; most logic lives in the DO).~~

Moved to `FINAL-PLAN.md` → **Finalized decisions (from conflict resolution)**.
