# bfg-games (Phase 1: TicTacToe)

This repo is being built from `BUILD-PLAN.md`. Right now the web app has Phase 2 routing scaffolding (home → room → settings), plus monorepo/typecheck scaffolding.

## Prerequisites

- Node.js + npm
- (Later phases) Godot **4.6.2-stable** + matching export templates (for web export)

## Install

```bash
npm install
```

## Run the web dev server

```bash
npm -w @brute-force-games/web run dev
```

Then open:

- `http://127.0.0.1:5173/`

## Typecheck

```bash
npm run typecheck
```

## Build (web)

```bash
npm -w @brute-force-games/web run build
```

## E2E smoke test (Playwright)

First-time only (installs browser binaries):

```bash
npm -w @brute-force-games/web exec -- playwright install --with-deps
```

Run the smoke test:

```bash
npm -w @brute-force-games/web run test:e2e
```

Notes:

- The test will start the Vite dev server automatically, or reuse an already-running server on `127.0.0.1:5173`.

## Codegen (GDScript bridge stub)

This currently writes a stub file at `games/tictactoe/autoloads/BridgeProtocol.gd`.

```bash
npm run gen:gdscript
```

## Godot export (not wired yet)

`scripts/godot-export.sh` is currently a stub (it exits with failure). We’ll wire it up once the Godot project and export pipeline are in place.

## FAQ

### “Couldn't connect to the GDScript language server at 127.0.0.1:6008…”

That’s from the editor extension trying to connect to Godot’s GDScript Language Server.

- Start the Godot editor and open `games/tictactoe/project.godot`, **or**
- disable the extension’s language-server integration if you don’t want it.

