This folder should contain the Godot HTML5 export for TicTacToe.

Expected path:
- `platform/web/public/godot/tictactoe/index.html`

How to generate:
1. Open `games/tictactoe/` in Godot (4.6.x).
2. Export an HTML5 build (Web).
3. Copy the export output into this folder so `index.html` is at the path above.

The web app embeds this export in an iframe and communicates via `postMessage`.
Message protocol (both directions):

```js
// Parent -> iframe:
{ bfg: true, type: "ttt_state_init" | "ttt_move_made" | "ttt_game_over", payload: any }

// Iframe -> parent:
{ bfg: true, type: "ttt_player_move", payload: { cellIndex: number } }
```

