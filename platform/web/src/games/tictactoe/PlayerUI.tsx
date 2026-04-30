import { useEffect, useMemo, useRef, useState } from 'react';

import {
  encodeBridgePayload,
  WIN_LINES,
  zBfgBridgeEnvelopeV1,
  zTicTacToeConfig,
  zTicTacToeState,
  zTttBridgeIntentPayload,
  zTttBridgeStateInitPayload,
  zTttBridgeStatePublicPayload,
  BRIDGE_GAME_TICTACTOE,
  EVT_BRIDGE_GODOT_READY,
  EVT_BRIDGE_INTENT,
  EVT_BRIDGE_STATE_INIT,
  EVT_BRIDGE_STATE_PUBLIC,
  type TicTacToeConfig,
  type TicTacToeSymbolPair,
  type CellValue,
  type TttBridgeStateInitPayload
} from '@brute-force-games/shared-types';

import type { GameStatePublic } from '@brute-force-games/multiplayer-types';

import type { PlayerUIProps } from '../types';

const TTT_KIND_MOVE = 'tictactoe/move';

function symbolMapFor(config: TicTacToeConfig): { X: string; O: string } {
  if (config.symbolPair === 'lion_lamb') return { X: 'Lion', O: 'Lamb' };
  if (config.symbolPair === 'red_blue') return { X: 'Red', O: 'Blue' };
  return { X: 'X', O: 'O' };
}

const SUBTITLES: Record<TicTacToeSymbolPair, string> = {
  xo: 'X vs. O · classic',
  red_blue: 'Red vs. Blue · color battle',
  lion_lamb: 'Lion vs. Lamb · wild edition'
};

export function TicTacToePlayerUI(props: PlayerUIProps<TicTacToeConfig>) {
  const { store, room, selfPlayerId, players } = props;
  const config = zTicTacToeConfig.safeParse(props.config).data ?? { symbolPair: 'xo', ui: 'godot' };
  const symbolByMark = useMemo(() => symbolMapFor(config), [config]);
  const playerById = useMemo(() => new Map(players.map((p) => [p.id, p])), [players]);

  // Temporary: dev flags read directly from URL until <GodotPlayerSurface> lands.
  const searchParams = useMemo(() => new URLSearchParams(window.location.search), []);
  const debugBridge = (() => {
    const v = searchParams.get('debug');
    return v === '1' || v === 'true' || v === 'bridge';
  })();

  const [gameStatePublic, setGameStatePublic] = useState<GameStatePublic | null>(() =>
    store.getGameStatePublicOrNull()
  );
  useEffect(() => store.onGameStatePublicChanged(setGameStatePublic), [store]);

  if (config.ui === 'react') {
    return (
      <ReactBoard
        gameStatePublic={gameStatePublic}
        store={store}
        selfPlayerId={selfPlayerId}
        playerById={playerById}
        symbolByMark={symbolByMark}
        symbolPair={config.symbolPair}
      />
    );
  }

  return (
    <GodotBoard
      gameStatePublic={gameStatePublic}
      room={room}
      store={store}
      selfPlayerId={selfPlayerId}
      symbolByMark={symbolByMark}
      symbolPair={config.symbolPair}
      stub={searchParams.get('godot') === 'stub'}
      debugBridge={debugBridge}
    />
  );
}

// ─── React board ────────────────────────────────────────────────────────────

const CELL = 80;
const BOARD = 3 * CELL; // 240

function cellCenter(idx: number) {
  return { x: (idx % 3) * CELL + CELL / 2, y: Math.floor(idx / 3) * CELL + CELL / 2 };
}

function ReactBoard(props: {
  gameStatePublic: GameStatePublic | null;
  store: PlayerUIProps<TicTacToeConfig>['store'];
  selfPlayerId: PlayerUIProps<TicTacToeConfig>['selfPlayerId'];
  playerById: Map<string, PlayerUIProps<TicTacToeConfig>['players'][number]>;
  symbolByMark: { X: string; O: string };
  symbolPair: TicTacToeSymbolPair;
}) {
  const { gameStatePublic, store, selfPlayerId, symbolByMark, symbolPair } = props;
  const parsed = gameStatePublic ? zTicTacToeState.safeParse(gameStatePublic.state) : null;
  const state = parsed?.success ? parsed.data : null;

  // Session scores persist across restarts within this page load.
  const [scores, setScores] = useState({ X: 0, O: 0 });
  const gameCounted = useRef(false);
  useEffect(() => {
    if (state?.moveCount === 0 && !state.winnerId && !state.isDraw) gameCounted.current = false;
  }, [state?.moveCount, state?.winnerId, state?.isDraw]);
  useEffect(() => {
    if (!state || gameCounted.current || (!state.winnerId && !state.isDraw)) return;
    if (state.winnerId) {
      const mark = state.winnerId === state.playerX ? 'X' : 'O';
      setScores((s) => ({ ...s, [mark]: s[mark] + 1 }));
    }
    gameCounted.current = true;
  }, [state?.winnerId, state?.isDraw, state?.playerX]);

  const myMark: 'X' | 'O' | null = state
    ? selfPlayerId === state.playerX ? 'X' : selfPlayerId === state.playerO ? 'O' : null
    : null;

  const winMark: 'X' | 'O' | null = state?.winnerId
    ? state.winnerId === state.playerX ? 'X' : 'O'
    : null;

  const winLine = winMark && state
    ? (WIN_LINES.find((line) => line.every((i) => state.board[i] === winMark)) ?? null)
    : null;

  const cells: CellValue[] = state ? Array.from(state.board) : Array(9).fill(null) as CellValue[];

  // ── Banner content ─────────────────────────────────────────────────────────
  let bannerText = 'Waiting for state…';
  let bannerBg = '#f0ece4';
  let bannerColor = '#777';
  let bannerWeight: React.CSSProperties['fontWeight'] = 400;
  let dashed = false;

  if (state) {
    if (state.winnerId && winMark) {
      dashed = true;
      bannerWeight = 700;
      if (symbolPair === 'xo') {
        bannerText = `${symbolByMark[winMark]} wins! 🎉`;
        bannerBg = '#fef3ef'; bannerColor = '#e05c40';
      } else if (symbolPair === 'red_blue') {
        bannerText = `${symbolByMark[winMark]} wins!`;
        bannerBg = winMark === 'X' ? '#fce8e7' : '#e7edf8';
        bannerColor = winMark === 'X' ? '#c45c52' : '#4e74b9';
      } else {
        bannerText = winMark === 'X' ? '🦁 Lion wins! Roar!' : '🐑 Lamb wins! Baa!';
        bannerBg = '#fef8e7'; bannerColor = winMark === 'X' ? '#c4860e' : '#4a6a90';
      }
    } else if (state.isDraw) {
      dashed = true; bannerWeight = 700; bannerText = 'Draw 🤝'; bannerColor = '#555';
    } else {
      const t = state.currentPlayerId === state.playerX ? 'X' : 'O';
      bannerWeight = 600;
      if (symbolPair === 'xo') {
        bannerText = `${symbolByMark[t]}'s turn`;
      } else if (symbolPair === 'red_blue') {
        bannerText = `${symbolByMark[t]}'s turn`;
        bannerBg = t === 'X' ? '#fce8e7' : '#e7edf8';
        bannerColor = t === 'X' ? '#c45c52' : '#4e74b9';
      } else {
        bannerText = `${t === 'X' ? '🦁' : '🐑'} ${symbolByMark[t]}'s turn`;
      }
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 16 }}>
      {/* Title + subtitle */}
      <div style={{ textAlign: 'center' }}>
        <div style={{ fontFamily: 'Georgia, "Times New Roman", serif', fontSize: 26, fontWeight: 700, letterSpacing: '-0.3px', color: '#1a1a1a' }}>
          Tic Tac Toe
        </div>
        <div style={{ fontSize: 13, color: '#aaa', marginTop: 2 }}>{SUBTITLES[symbolPair]}</div>
      </div>

      {/* Scoreboard */}
      <ScoreRow symbolPair={symbolPair} symbolByMark={symbolByMark} scores={scores} />

      {/* Board */}
      <div style={{ position: 'relative', width: BOARD, height: BOARD }}>
        <div style={{ display: 'grid', gridTemplateColumns: `repeat(3, ${CELL}px)`, gridTemplateRows: `repeat(3, ${CELL}px)` }}>
          {cells.map((cell, idx) => {
            const row = Math.floor(idx / 3);
            const col = idx % 3;
            const isMyTurn = state?.currentPlayerId === selfPlayerId;
            const disabled = cell != null || !!state?.winnerId || !!state?.isDraw || !isMyTurn || myMark == null;
            return (
              <button
                key={idx}
                type="button"
                disabled={disabled}
                onClick={() => {
                  void store.submit({
                    kind: TTT_KIND_MOVE,
                    plaintext: new TextEncoder().encode(JSON.stringify({ playerId: selfPlayerId, cellIndex: idx }))
                  });
                }}
                style={{
                  width: CELL, height: CELL, boxSizing: 'border-box',
                  borderRight: col < 2 ? '2px solid #1a1a1a' : 'none',
                  borderBottom: row < 2 ? '2px solid #1a1a1a' : 'none',
                  borderLeft: 'none', borderTop: 'none',
                  background: 'none', padding: 0,
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  cursor: disabled ? 'default' : 'pointer'
                }}
              >
                <CellMark value={cell} symbolPair={symbolPair} />
              </button>
            );
          })}
        </div>

        {/* Win line for XO */}
        {winLine && symbolPair === 'xo' && (() => {
          const a = cellCenter(winLine[0]);
          const b = cellCenter(winLine[2]);
          const dx = b.x - a.x; const dy = b.y - a.y;
          const len = Math.sqrt(dx * dx + dy * dy);
          const ext = 24;
          return (
            <svg width={BOARD} height={BOARD} style={{ position: 'absolute', top: 0, left: 0, pointerEvents: 'none' }}>
              <line
                x1={a.x - (dx / len) * ext} y1={a.y - (dy / len) * ext}
                x2={b.x + (dx / len) * ext} y2={b.y + (dy / len) * ext}
                stroke="#e05c40" strokeWidth={5} strokeLinecap="round"
              />
            </svg>
          );
        })()}
      </div>

      {/* Status banner + reset */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, width: BOARD }}>
        <div style={{
          flex: 1, padding: '9px 14px', borderRadius: 8, fontSize: 14, textAlign: 'center',
          border: dashed ? '1.5px dashed #ccc' : '1.5px solid transparent',
          background: bannerBg, color: bannerColor, fontWeight: bannerWeight
        }}>
          {bannerText}
        </div>
        <button
          type="button"
          onClick={() => { void store.submit({ kind: 'tictactoe/restart' }); }}
          style={{ padding: '9px 12px', borderRadius: 8, border: '1px solid #d8d3c8', background: '#f0ece4', color: '#888', fontSize: 13, cursor: 'pointer', whiteSpace: 'nowrap' }}
        >
          ↺ reset
        </button>
      </div>
    </div>
  );
}

function CellMark({ value, symbolPair }: { value: CellValue; symbolPair: TicTacToeSymbolPair }) {
  if (!value) return null;
  if (symbolPair === 'xo') {
    return value === 'X' ? (
      <svg width={CELL} height={CELL} viewBox={`0 0 ${CELL} ${CELL}`} style={{ display: 'block' }}>
        <line x1={18} y1={18} x2={62} y2={62} stroke="#1a1a1a" strokeWidth={6} strokeLinecap="round" />
        <line x1={62} y1={18} x2={18} y2={62} stroke="#1a1a1a" strokeWidth={6} strokeLinecap="round" />
      </svg>
    ) : (
      <svg width={CELL} height={CELL} viewBox={`0 0 ${CELL} ${CELL}`} style={{ display: 'block' }}>
        <circle cx={40} cy={40} r={22} fill="none" stroke="#1a1a1a" strokeWidth={6} />
      </svg>
    );
  }
  if (symbolPair === 'red_blue') {
    return (
      <div style={{
        width: 54, height: 54, borderRadius: 10,
        background: value === 'X' ? '#c45c52' : '#4e74b9'
      }} />
    );
  }
  // lion_lamb
  return (
    <div style={{
      width: 60, height: 60, borderRadius: '50%',
      background: value === 'X' ? '#f0b030' : '#b8cfe4',
      display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 30
    }}>
      {value === 'X' ? '🦁' : '🐑'}
    </div>
  );
}

function ScoreRow({ symbolPair, symbolByMark, scores }: {
  symbolPair: TicTacToeSymbolPair;
  symbolByMark: { X: string; O: string };
  scores: { X: number; O: number };
}) {
  const xLabel = symbolPair === 'lion_lamb' ? `🦁 ${symbolByMark.X}` : symbolByMark.X;
  const oLabel = symbolPair === 'lion_lamb' ? `🐑 ${symbolByMark.O}` : symbolByMark.O;
  const xColor = symbolPair === 'red_blue' ? '#c45c52' : symbolPair === 'lion_lamb' ? '#c4860e' : '#1a1a1a';
  const oColor = symbolPair === 'red_blue' ? '#4e74b9' : '#1a1a1a';
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 16 }}>
      <span style={{ fontWeight: 700, color: xColor }}>{xLabel}</span>
      <span style={{ color: '#aaa', fontSize: 13 }}>vs</span>
      <span style={{ fontWeight: 700, color: oColor }}>{oLabel}</span>
      <span style={{ marginLeft: 12, fontSize: 18, letterSpacing: 1, color: '#555' }}>
        {scores.X} – {scores.O}
      </span>
    </div>
  );
}

// ─── Godot iframe board ─────────────────────────────────────────────────────

function GodotBoard(props: {
  gameStatePublic: GameStatePublic | null;
  room: PlayerUIProps<TicTacToeConfig>['room'];
  store: PlayerUIProps<TicTacToeConfig>['store'];
  selfPlayerId: PlayerUIProps<TicTacToeConfig>['selfPlayerId'];
  symbolByMark: { X: string; O: string };
  symbolPair: TicTacToeSymbolPair;
  stub: boolean;
  debugBridge: boolean;
}) {
  const { gameStatePublic, room, store, selfPlayerId, symbolByMark, symbolPair, stub, debugBridge } = props;
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const [godotReady, setGodotReady] = useState(false);
  const [godotDebug, setGodotDebug] = useState({ received: 0, sent: 0, lastType: '' });
  const [iframeLoaded, setIframeLoaded] = useState(false);
  const [iframeLoadCount, setIframeLoadCount] = useState(0);
  // Dev cache-busting: browsers aggressively cache the Godot export (index.js/wasm).
  // We pin a timestamp for this mount so it doesn't thrash on re-renders, but
  // a hard refresh/new navigation will pull the latest export.
  const cacheBust = useMemo(() => (import.meta.env.DEV ? String(Date.now()) : ''), []);
  const src = stub
    ? '/godot/tictactoe/stub.html'
    : `/godot/tictactoe/index.html${cacheBust ? `?v=${encodeURIComponent(cacheBust)}` : ''}`;

  const parsedState = gameStatePublic ? zTicTacToeState.safeParse(gameStatePublic.state) : null;
  const isObserver =
    parsedState?.success === true &&
    parsedState.data.playerX !== selfPlayerId &&
    parsedState.data.playerO !== selfPlayerId;

  const postToGodot = useMemo(
    () => (type: string, payload: unknown) => {
      iframeRef.current?.contentWindow?.postMessage(
        {
          bfg: true,
          v: 1,
          game: BRIDGE_GAME_TICTACTOE,
          type,
          payload: encodeBridgePayload(payload)
        },
        '*'
      );
      if (debugBridge) {
        // eslint-disable-next-line no-console
        console.debug('[ttt bridge] → godot', { type, payload });
      }
      setGodotDebug((d) => ({ ...d, sent: d.sent + 1, lastType: type }));
    },
    [debugBridge]
  );

  useEffect(() => {
    function onMessage(ev: MessageEvent) {
      const parsedEnv = zBfgBridgeEnvelopeV1.safeParse(ev.data);
      if (!parsedEnv.success) return;
      const env = parsedEnv.data;
      if (env.game !== BRIDGE_GAME_TICTACTOE) return;

      if (debugBridge) {
        // eslint-disable-next-line no-console
        console.debug('[ttt bridge] ← godot raw', env);
      }
      setGodotDebug((d) => ({ ...d, received: d.received + 1, lastType: String(env.type ?? '') }));
      if (env.type === EVT_BRIDGE_GODOT_READY) {
        setGodotReady(true);
        return;
      }

      let decoded: unknown;
      try {
        decoded = JSON.parse(env.payload);
      } catch {
        return;
      }

      if (env.type === EVT_BRIDGE_INTENT) {
        const parsed = zTttBridgeIntentPayload.safeParse(decoded);
        if (!parsed.success) return;
        if (room.status !== 'active') return;

        void store.submit({
          kind: TTT_KIND_MOVE,
          plaintext: new TextEncoder().encode(
            JSON.stringify({ playerId: selfPlayerId, cellIndex: parsed.data.cellIndex })
          )
        });
      }
    }

    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [debugBridge, room.status, selfPlayerId, store]);

  useEffect(() => {
    if (!godotReady) return;
    if (!gameStatePublic) return;
    const parsed = zTicTacToeState.safeParse(gameStatePublic.state);
    if (!parsed.success) return;
    const state = parsed.data;

    const init: TttBridgeStateInitPayload = zTttBridgeStateInitPayload.parse({
      localPlayerId: selfPlayerId,
      view: state.playerX === selfPlayerId || state.playerO === selfPlayerId ? 'player' : 'observer',
      publicState: {
        board: state.board,
        currentPlayerId: state.currentPlayerId,
        playerX: state.playerX,
        playerO: state.playerO,
        winnerId: state.winnerId,
        isDraw: state.isDraw,
        moveCount: state.moveCount
      },
      symbolByMark,
      symbolPair
    });
    postToGodot(EVT_BRIDGE_STATE_INIT, init);
    postToGodot(EVT_BRIDGE_STATE_PUBLIC, zTttBridgeStatePublicPayload.parse({ publicState: init.publicState }));
  }, [gameStatePublic, godotReady, postToGodot, selfPlayerId, symbolByMark]);

  return (
    <>
      {isObserver ? <ObservingBanner /> : null}
      <div
        style={{
          border: '1px solid #e5e7eb',
          borderRadius: 16,
          overflow: 'hidden',
          background: 'linear-gradient(180deg, #0b1020 0%, #0a0f1b 100%)',
          boxShadow: '0 10px 30px rgba(0,0,0,0.08)'
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 12,
            padding: '10px 12px',
            borderBottom: '1px solid rgba(255,255,255,0.08)',
            color: 'rgba(255,255,255,0.92)'
          }}
        >
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, minWidth: 0 }}>
            <strong style={{ fontSize: 13, letterSpacing: 0.2 }}>Godot</strong>
            <span style={{ fontSize: 12, color: 'rgba(255,255,255,0.7)' }}>
              {godotReady ? 'ready' : iframeLoaded ? 'loading…' : 'loading iframe…'}
            </span>
            {stub ? (
              <span
                style={{
                  fontSize: 11,
                  padding: '2px 8px',
                  borderRadius: 999,
                  border: '1px solid rgba(255,255,255,0.14)',
                  color: 'rgba(255,255,255,0.8)'
                }}
              >
                stub
              </span>
            ) : null}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flex: '0 0 auto' }}>
            <a
              href={src}
              target="_blank"
              rel="noreferrer"
              style={{ fontSize: 12, color: 'rgba(255,255,255,0.8)' }}
            >
              Open
            </a>
          </div>
        </div>

        <div style={{ position: 'relative' }}>
          <iframe
            ref={iframeRef}
            title="TicTacToe (Godot)"
            src={src}
            style={{
              width: '100%',
              height: 420,
              border: 0,
              display: 'block',
              background: 'transparent'
            }}
            onLoad={() => {
              setIframeLoaded(true);
              setIframeLoadCount((n) => n + 1);
              if (debugBridge) {
                // eslint-disable-next-line no-console
                console.debug('[ttt bridge] iframe loaded', { src });
              }
            }}
          />
          {!godotReady ? (
            <div
              style={{
                position: 'absolute',
                inset: 0,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                pointerEvents: 'none',
                background:
                  'linear-gradient(180deg, rgba(11,16,32,0.75) 0%, rgba(10,15,27,0.35) 100%)'
              }}
            >
              <div
                style={{
                  textAlign: 'center',
                  padding: 14,
                  borderRadius: 14,
                  border: '1px solid rgba(255,255,255,0.10)',
                  background: 'rgba(255,255,255,0.06)',
                  color: 'rgba(255,255,255,0.92)',
                  maxWidth: 360
                }}
              >
                <div style={{ fontWeight: 800, marginBottom: 6 }}>Loading game…</div>
                <div style={{ fontSize: 13, color: 'rgba(255,255,255,0.75)' }}>
                  {iframeLoaded
                    ? 'Waiting for the game to finish starting up.'
                    : 'Waiting for the iframe to load.'}
                </div>
              </div>
            </div>
          ) : null}
        </div>
      </div>

      {debugBridge ? (
        <div style={{ marginTop: 8, color: '#555', fontSize: 13 }}>
          Godot: <strong>{godotReady ? 'ready' : 'not ready'}</strong> — iframe{' '}
          <strong>{iframeLoaded ? `loaded (${iframeLoadCount})` : 'not loaded'}</strong> — received{' '}
          <strong>{godotDebug.received}</strong>, sent <strong>{godotDebug.sent}</strong>
          {godotDebug.lastType ? (
            <>
              {' '}
              — last <code>{godotDebug.lastType}</code>
            </>
          ) : null}
        </div>
      ) : null}
    </>
  );
}

// ─── Shared bits ────────────────────────────────────────────────────────────

function ObservingBanner() {
  return (
    <div
      style={{
        marginBottom: 10,
        padding: '6px 10px',
        borderRadius: 8,
        border: '1px solid #e7e2cc',
        background: '#fdf9e6',
        color: '#6b5b1f',
        fontSize: 13
      }}
    >
      You are <strong>observing</strong> this game — the host started it before you joined,
      so you can watch but can't make moves.
    </div>
  );
}
