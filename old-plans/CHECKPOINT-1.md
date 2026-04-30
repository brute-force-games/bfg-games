# CHECKPOINT 1 — Scaffold + Phase 2 Routing

Date: 2026-04-25

## What we built

### Monorepo scaffold (Phase 0)
- Root npm workspaces: `platform/*`
- Root scripts:
  - `npm run typecheck` (runs `tsc --noEmit` in all workspaces)
  - `npm run gen:gdscript` (stub generator)
  - `npm run test:e2e` (runs Playwright from the web workspace)
- TypeScript base config: `tsconfig.base.json` (strict, shared path alias)
- Workspaces created and typechecking:
  - `platform/shared-types`
  - `platform/web` (Vite + React)
  - `platform/edge` (scaffold only; Phase 1 uses TinyBase demo DO server)
- Added TinyBase schema/codec layer file at `platform/web/src/sync/tinybase/schema.ts`
  - Exports: `ROOM_TABLES_SCHEMA`, `readRow`, `writeRow`, `readAllRows`

### Web routing (Phase 2)
Implemented the Phase 2 routing skeleton and file layout under `platform/web/src/routes/`:
- `/` — `routes/index.tsx`
  - **New Game** generates `roomId` + `invite` client-side and navigates to `/room/:roomId/play?invite=...`
  - **Join** accepts a full invite URL or direct `room_...` id
- `/room/:roomId/play` — `routes/room.$roomId.play.tsx` (shell page; shows `roomId` + `invite`)
- `/settings` — `routes/settings.tsx` (placeholder UI)

Router wiring:
- `platform/web/src/router.tsx` now imports those route components and validates `invite` search param.

Utilities:
- `platform/web/src/utils/invite.ts`:
  - `makeRoomId()`
  - `generateInviteCode()`
  - `parseInviteInput()`

Games scaffolding:
- `platform/web/src/games/types.ts` (`GameDefinition<TConfig>`)
- `platform/web/src/games/registry.ts` (`GAME_REGISTRY`)
- `platform/web/src/games/tictactoe/definition.ts` (`TicTacToeGameDefinition` with empty `ConfigUI`)

### Playwright smoke test
Added a minimal e2e smoke test that:
- starts/reuses Vite at `127.0.0.1:5173`
- clicks **New Game**
- asserts the URL matches `/room/room_.../play?invite=...`

Files:
- `platform/web/playwright.config.ts`
- `platform/web/tests/smoke.spec.ts`

## Decisions / deviations from BUILD-PLAN.md

### Godot version pin clarified
`BUILD-PLAN.md` now explicitly says **Godot 4.6.2-stable** (and notes matching export templates).

### Package scope rename
We renamed packages/import paths from `@acronym-game/*` to `@brute-force-games/*`:
- Packages now: `@brute-force-games/web`, `@brute-force-games/shared-types`, `@brute-force-games/edge`
- TS path alias updated accordingly in `tsconfig.base.json`
- Docs + scripts updated (`README.md`, root `package.json`, `BUILD-PLAN.md` example import)

### Playwright browser install note
Running Playwright locally requires downloading browser binaries:
- first time: `npm -w @brute-force-games/web exec -- playwright install --with-deps`

## How to run what exists today

Install:
```bash
npm install
```

Run web dev server:
```bash
npm -w @brute-force-games/web run dev
```

Typecheck:
```bash
npm run typecheck
```

Run Playwright smoke test:
```bash
npm run test:e2e
```

## Known gaps (not started yet)
- Phase 1 identity + LocalStore persistence
- Phase 4 sync layer (RoomStore/WsSynchronizer wiring, public demo DO wsUrl, player rows/heartbeat)
- Phase 5 lobby flow
- Phase 6 Godot canvas + bridge
