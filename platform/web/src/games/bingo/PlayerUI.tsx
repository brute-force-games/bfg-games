import { useEffect, useMemo, useState, type ReactElement } from 'react';

import {
  BINGO_EVT_CALLED,
  BINGO_EVT_GAME_OVER,
  BINGO_EVT_STARTED,
  BINGO_SUBMIT_CALL,
  BINGO_SUBMIT_CALL_SPECIFIC,
  BINGO_WIN_LINES,
  zBingoPublicState,
  type BingoConfig,
  type BingoPublicPlayer
} from '@brute-force-games/shared-types';

import type { RoomEvent } from '@brute-force-games/multiplayer-types';

import type { PlayerUIProps } from '../types';

const BINGO_COLS = ['B', 'I', 'N', 'G', 'O'] as const;

// Column number ranges for the called-numbers tracker
const COL_RANGES: [number, number][] = [
  [1, 15], [16, 30], [31, 45], [46, 60], [61, 75]
];

function getWinLineIndices(board: number[], calledSet: Set<number>): Set<number> {
  const result = new Set<number>();
  for (const line of BINGO_WIN_LINES) {
    if (line.every((idx) => board[idx] === 0 || calledSet.has(board[idx]!))) {
      for (const idx of line) result.add(idx);
    }
  }
  return result;
}

// ─── Bingo board ─────────────────────────────────────────────────────────────

function BingoBoard(props: {
  player: BingoPublicPlayer;
  calledSet: Set<number>;
  isSelf: boolean;
}) {
  const { player, calledSet, isSelf } = props;
  const { board, hasBingo } = player;
  const winCells = hasBingo ? getWinLineIndices(board, calledSet) : new Set<number>();

  return (
    <div>
      {/* Column headers */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 48px)', gap: 3, marginBottom: 3 }}>
        {BINGO_COLS.map((col) => (
          <div
            key={col}
            style={{
              height: 28,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontWeight: 800,
              fontSize: 16,
              color: hasBingo ? '#b8860b' : '#2a7ae2',
              letterSpacing: 1
            }}
          >
            {col}
          </div>
        ))}
      </div>

      {/* Cells */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 48px)', gap: 3 }}>
        {board.map((num, idx) => {
          const isFree = num === 0;
          const isMarked = isFree || calledSet.has(num);
          const isWin = winCells.has(idx);
          return (
            <div
              key={idx}
              style={{
                width: 48,
                height: 48,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                borderRadius: 6,
                border: isWin
                  ? '2px solid #b8860b'
                  : isMarked
                    ? '2px solid #2a7ae2'
                    : '1px solid #ccc',
                background: isWin
                  ? '#fff8dc'
                  : isMarked
                    ? isSelf ? '#dbeafe' : '#f0f4ff'
                    : '#fff',
                fontWeight: isMarked ? 700 : 400,
                fontSize: isFree ? 10 : 15,
                color: isWin ? '#8b6914' : isMarked ? '#1e40af' : '#555',
                transition: 'all 0.15s'
              }}
            >
              {isFree ? 'FREE' : num}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── Called numbers column tracker ───────────────────────────────────────────

function CalledNumbersTracker({ calledSet }: { calledSet: Set<number> }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 6 }}>
      {BINGO_COLS.map((col, ci) => {
        const [min, max] = COL_RANGES[ci]!;
        const nums: number[] = [];
        for (let n = min; n <= max; n++) nums.push(n);
        return (
          <div key={col}>
            <div style={{
              textAlign: 'center',
              fontWeight: 800,
              fontSize: 13,
              color: '#2a7ae2',
              marginBottom: 4
            }}>
              {col}
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
              {nums.map((n) => (
                <div
                  key={n}
                  style={{
                    height: 20,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    borderRadius: 4,
                    background: calledSet.has(n) ? '#dbeafe' : 'transparent',
                    color: calledSet.has(n) ? '#1e40af' : '#ccc',
                    fontWeight: calledSet.has(n) ? 700 : 400,
                    fontSize: 12,
                    transition: 'all 0.1s'
                  }}
                >
                  {n}
                </div>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ─── Activity feed ────────────────────────────────────────────────────────────

function formatEvent(
  ev: RoomEvent,
  playerById: Map<string, { displayName: string }>
): ReactElement {
  const p = ev.publicPayload as Record<string, unknown>;
  const name = (id: string) =>
    playerById.get(id)?.displayName ?? id.slice(0, 10) + '…';

  if (ev.kind === BINGO_EVT_STARTED) {
    return (
      <span>
        🎉 Game started — {String(p['playerCount'])} players, first caller:{' '}
        <strong>{name(String(p['firstTurnPlayerId']))}</strong>
      </span>
    );
  }
  if (ev.kind === BINGO_EVT_CALLED) {
    const num = Number(p['number']);
    const col = num <= 15 ? 'B' : num <= 30 ? 'I' : num <= 45 ? 'N' : num <= 60 ? 'G' : 'O';
    const bingos = (p['newBingoPlayerIds'] as string[]) ?? [];
    return (
      <span>
        <strong>{name(String(p['calledBy']))}</strong> called{' '}
        <strong style={{ fontFamily: 'monospace' }}>{col}{num}</strong>
        {bingos.length > 0 ? (
          <span style={{ color: '#b8860b', marginLeft: 6 }}>
            🎊 BINGO! {bingos.map((id) => name(id)).join(', ')}
          </span>
        ) : null}
      </span>
    );
  }
  if (ev.kind === BINGO_EVT_GAME_OVER) {
    const winners = (p['winnerPlayerIds'] as string[]) ?? [];
    return (
      <span>
        🏁 Game over! {winners.map((id) => name(id)).join(', ')} win
        {winners.length > 1 ? '' : 's'}!
      </span>
    );
  }
  return <span>{ev.kind}</span>;
}

// ─── Component ───────────────────────────────────────────────────────────────

export function BingoPlayerUI(props: PlayerUIProps<BingoConfig>) {
  const { store, selfPlayerId, players } = props;
  const playerById = useMemo(() => new Map(players.map((p) => [p.id, p])), [players]);

  const [gameStatePublic, setGameStatePublic] = useState(() => store.getGameStatePublicOrNull());
  useEffect(() => store.onGameStatePublicChanged(setGameStatePublic), [store]);

  const [events, setEvents] = useState<RoomEvent[]>(() => store.getEvents());
  useEffect(() => { setEvents(store.getEvents()); }, [gameStatePublic, store]);

  const [submitting, setSubmitting] = useState(false);
  const [pickedNumber, setPickedNumber] = useState<number | null>(null);

  const parsedPublic = gameStatePublic
    ? zBingoPublicState.safeParse(gameStatePublic.state)
    : null;

  if (!parsedPublic?.success) {
    return <div style={{ color: '#777', padding: 16 }}>Waiting for game state…</div>;
  }

  const state = parsedPublic.data;
  const isMyTurn = state.turnPlayerId === selfPlayerId && state.phase === 'active';
  const isFinished = state.phase === 'finished';
  const calledSet = new Set(state.calledNumbers);
  const selfPlayer = state.players.find((p) => p.playerId === selfPlayerId) ?? null;
  const currentName = state.turnPlayerId
    ? (playerById.get(state.turnPlayerId)?.displayName ?? state.turnPlayerId.slice(0, 10) + '…')
    : null;

  async function handleCall(specific?: number) {
    if (submitting || !isMyTurn) return;
    setSubmitting(true);
    try {
      const payload =
        specific !== undefined
          ? { kind: BINGO_SUBMIT_CALL_SPECIFIC, number: specific }
          : { kind: BINGO_SUBMIT_CALL };
      await store.submit({
        kind: specific !== undefined ? BINGO_SUBMIT_CALL_SPECIFIC : BINGO_SUBMIT_CALL,
        plaintext: new TextEncoder().encode(JSON.stringify(payload))
      });
      setPickedNumber(null);
    } finally {
      setSubmitting(false);
    }
  }

  // Uncalled numbers are derivable from public state — no private state needed.
  const uncalledNumbers = useMemo(() => {
    const called = new Set(state.calledNumbers);
    const all: number[] = [];
    for (let n = 1; n <= 75; n++) if (!called.has(n)) all.push(n);
    return all;
  }, [state.calledNumbers]);

  const cardStyle: React.CSSProperties = {
    padding: 12,
    borderRadius: 10,
    border: '1px solid #ddd',
    background: '#fff'
  };

  return (
    <div style={{ fontFamily: 'system-ui, sans-serif', maxWidth: 860 }}>
      {/* Main layout */}
      <div style={{ display: 'grid', gridTemplateColumns: '270px 1fr', gap: 12, marginBottom: 12 }}>
        {/* Left: your board + call button */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div style={cardStyle}>
            <div style={{ fontSize: 13, fontWeight: 700, color: '#333', marginBottom: 10 }}>
              {selfPlayer
                ? selfPlayer.hasBingo
                  ? '🎊 BINGO!'
                  : `Your board — ${selfPlayer.markedCount}/25 marked`
                : 'Your board'}
            </div>
            {selfPlayer ? (
              <BingoBoard player={selfPlayer} calledSet={calledSet} isSelf />
            ) : (
              <div style={{ color: '#888', fontSize: 13 }}>Observing</div>
            )}
          </div>

          {/* Call section */}
          {!isFinished && selfPlayer ? (
            <div style={cardStyle}>
              {isMyTurn ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                  {/* Random call */}
                  <button
                    type="button"
                    onClick={() => { void handleCall(); }}
                    disabled={submitting}
                    style={{
                      width: '100%',
                      padding: '10px 0',
                      borderRadius: 8,
                      border: 'none',
                      background: submitting ? '#ccc' : '#2a7ae2',
                      color: '#fff',
                      fontWeight: 700,
                      fontSize: 15,
                      cursor: submitting ? 'not-allowed' : 'pointer'
                    }}
                  >
                    {submitting ? 'Calling…' : '🎱 Call Random'}
                  </button>

                  {/* Divider */}
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: '#bbb', fontSize: 12 }}>
                    <div style={{ flex: 1, height: 1, background: '#eee' }} />
                    or pick
                    <div style={{ flex: 1, height: 1, background: '#eee' }} />
                  </div>

                  {/* Number grid — uncalled numbers grouped by column */}
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 4 }}>
                    {BINGO_COLS.map((col, ci) => {
                      const [min, max] = COL_RANGES[ci]!;
                      const colUncalled = uncalledNumbers.filter((n) => n >= min && n <= max);
                      return (
                        <div key={col}>
                          <div style={{ textAlign: 'center', fontWeight: 700, fontSize: 11, color: '#2a7ae2', marginBottom: 3 }}>
                            {col}
                          </div>
                          <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                            {colUncalled.map((n) => (
                              <button
                                key={n}
                                type="button"
                                onClick={() => { void handleCall(n); }}
                                disabled={submitting}
                                style={{
                                  padding: '3px 0',
                                  borderRadius: 4,
                                  border: pickedNumber === n ? '2px solid #2a7ae2' : '1px solid #ddd',
                                  background: pickedNumber === n ? '#dbeafe' : '#fafafa',
                                  color: '#333',
                                  fontSize: 12,
                                  fontWeight: pickedNumber === n ? 700 : 400,
                                  cursor: submitting ? 'not-allowed' : 'pointer'
                                }}
                              >
                                {n}
                              </button>
                            ))}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              ) : (
                <div style={{ fontSize: 13, color: '#888', textAlign: 'center', padding: '6px 0' }}>
                  Waiting for <strong>{currentName ?? '…'}</strong> to call
                </div>
              )}
            </div>
          ) : null}
        </div>

        {/* Right: called number tracker */}
        <div style={cardStyle}>
          <div style={{ fontSize: 13, fontWeight: 700, color: '#333', marginBottom: 10 }}>
            Called Numbers
          </div>
          <CalledNumbersTracker calledSet={calledSet} />
        </div>
      </div>

      {/* Other players' boards (for spectating / post-game) */}
      {state.players.filter((p) => p.playerId !== selfPlayerId).length > 0 ? (
        <div style={cardStyle}>
          <div style={{ fontSize: 13, fontWeight: 700, color: '#333', marginBottom: 12 }}>
            Other boards
          </div>
          <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap' }}>
            {state.players
              .filter((p) => p.playerId !== selfPlayerId)
              .map((p) => (
                <div key={p.playerId}>
                  <div style={{ fontSize: 12, fontWeight: 600, color: '#555', marginBottom: 6, textAlign: 'center' }}>
                    {playerById.get(p.playerId)?.displayName ?? p.playerId.slice(0, 10) + '…'}
                    {p.hasBingo ? ' 🎊' : ` (${p.markedCount}/25)`}
                  </div>
                  <BingoBoard player={p} calledSet={calledSet} isSelf={false} />
                </div>
              ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}
