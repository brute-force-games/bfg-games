import { useEffect, useMemo, useState, type ReactElement } from 'react';

import {
  GOFISH_EVT_ASKED,
  GOFISH_EVT_BOOK_MADE,
  GOFISH_EVT_DEALT,
  GOFISH_EVT_DREW,
  GOFISH_EVT_GAME_OVER,
  GOFISH_EVT_GO_FISH,
  GOFISH_EVT_TRANSFERRED,
  GOFISH_RANKS,
  GOFISH_SUBMIT_ASK,
  GOFISH_SUBMIT_DRAW,
  zGoFishPrivateState,
  zGoFishPublicState,
  type GoFishConfig,
  type GoFishPrivateState,
  type GoFishRank
} from '@brute-force-games/shared-types';

import type { RoomEvent } from '@brute-force-games/multiplayer-types';
import type { PlayerId } from '@brute-force-games/multiplayer-types';

import type { PlayerUIProps } from '../types';
import { GOFISH_PRIVATE_KIND } from './engine';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function playerName(
  playerId: string,
  playerById: Map<string, { displayName: string }>
): string {
  return playerById.get(playerId)?.displayName ?? playerId.slice(0, 12) + '…';
}

function rankLabel(rank: string): string {
  return rank === 'A' ? 'Aces' : rank + 's';
}

function formatEvent(
  ev: RoomEvent,
  playerById: Map<string, { displayName: string }>
): ReactElement {
  const p = ev.publicPayload as Record<string, unknown>;
  const kind = ev.kind;

  if (kind === GOFISH_EVT_DEALT) {
    return (
      <span>
        🃏 Cards dealt — deck has <strong>{String(p['deckCount'])}</strong> remaining
      </span>
    );
  }
  if (kind === GOFISH_EVT_ASKED) {
    return (
      <span>
        <strong>{playerName(String(p['askingPlayerId']), playerById)}</strong> asked{' '}
        <strong>{playerName(String(p['targetPlayerId']), playerById)}</strong> for{' '}
        <strong>{rankLabel(String(p['rank']))}</strong>
      </span>
    );
  }
  if (kind === GOFISH_EVT_TRANSFERRED) {
    return (
      <span>
        <strong>{playerName(String(p['fromPlayerId']), playerById)}</strong> gave{' '}
        <strong>{String(p['count'])}</strong>{' '}
        <strong>{rankLabel(String(p['rank']))}</strong> to{' '}
        <strong>{playerName(String(p['toPlayerId']), playerById)}</strong>
      </span>
    );
  }
  if (kind === GOFISH_EVT_GO_FISH) {
    const drewCard = p['drewCard'] as boolean;
    return (
      <span>
        <strong>{playerName(String(p['playerId']), playerById)}</strong> 🐟 Go Fish!{' '}
        {drewCard ? 'Drew a card.' : 'Deck empty.'}
      </span>
    );
  }
  if (kind === GOFISH_EVT_DREW) {
    return (
      <span>
        <strong>{playerName(String(p['playerId']), playerById)}</strong> drew a card (empty hand)
      </span>
    );
  }
  if (kind === GOFISH_EVT_BOOK_MADE) {
    return (
      <span>
        <strong>{playerName(String(p['playerId']), playerById)}</strong> completed a book of{' '}
        <strong>{rankLabel(String(p['rank']))}</strong> 📚 ({String(p['newBookCount'])} total)
      </span>
    );
  }
  if (kind === GOFISH_EVT_GAME_OVER) {
    return <span>🏁 Game over!</span>;
  }
  return <span>{kind}</span>;
}

// ─── Component ───────────────────────────────────────────────────────────────

export function GoFishPlayerUI(props: PlayerUIProps<GoFishConfig>) {
  const { store, room, selfPlayerId, players } = props;
  const playerById = useMemo(() => new Map(players.map((p) => [p.id, p])), [players]);

  // ── Public state ───────────────────────────────────────────────────────────
  const [gameStatePublic, setGameStatePublic] = useState(() => store.getGameStatePublicOrNull());
  useEffect(() => store.onGameStatePublicChanged(setGameStatePublic), [store]);

  // ── Private state ──────────────────────────────────────────────────────────
  const [gameStatePrivateRaw, setGameStatePrivateRaw] = useState(() =>
    store.getGameStatePrivateOrNull(selfPlayerId)
  );
  useEffect(
    () => store.onGameStatePrivateChanged(selfPlayerId, setGameStatePrivateRaw),
    [selfPlayerId, store]
  );

  const [privateState, setPrivateState] = useState<GoFishPrivateState | null>(null);
  useEffect(() => {
    if (!gameStatePrivateRaw) {
      setPrivateState(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const v = await store.decryptJsonForSelfFromGameStatePrivate({
          row: gameStatePrivateRaw,
          seq: gameStatePrivateRaw.seq,
          gameType: room.gameType,
          kind: GOFISH_PRIVATE_KIND
        });
        if (cancelled) return;
        const parsed = zGoFishPrivateState.safeParse(v);
        setPrivateState(parsed.success ? parsed.data : null);
      } catch {
        if (!cancelled) setPrivateState(null);
      }
    })();
    return () => { cancelled = true; };
  }, [gameStatePrivateRaw, room.gameType, store]);

  // ── Events (re-read when public state changes) ────────────────────────────
  const [events, setEvents] = useState<RoomEvent[]>(() => store.getEvents());
  useEffect(() => {
    setEvents(store.getEvents());
  }, [gameStatePublic, store]);

  // ── UI state ───────────────────────────────────────────────────────────────
  const [selectedRank, setSelectedRank] = useState<GoFishRank | null>(null);
  const [selectedTarget, setSelectedTarget] = useState<PlayerId | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // ── Parse public state ─────────────────────────────────────────────────────
  const parsedPublic = gameStatePublic
    ? zGoFishPublicState.safeParse(gameStatePublic.state)
    : null;

  if (!parsedPublic?.success) {
    return <div style={{ color: '#777', padding: 16 }}>Waiting for game state…</div>;
  }

  const state = parsedPublic.data;
  const me = state.players.find((p) => p.playerId === selfPlayerId) ?? null;
  const isObserver = me == null;
  const isMyTurn = state.turnPlayerId === selfPlayerId && state.phase === 'active';
  const myHand = privateState?.hand ?? [];
  const handIsEmpty = myHand.length === 0;

  // Reset selections on turn change
  // (handled via useEffect keyed on turnPlayerId)
  // eslint-disable-next-line react-hooks/rules-of-hooks
  useEffect(() => {
    setSelectedRank(null);
    setSelectedTarget(null);
  }, [state.turnPlayerId]);

  // ── Grouped hand by rank ──────────────────────────────────────────────────
  const rankGroups = GOFISH_RANKS.filter((r) => myHand.includes(r)).map((r) => ({
    rank: r,
    count: myHand.filter((x) => x === r).length
  }));

  const otherPlayers = state.players.filter((p) => p.playerId !== selfPlayerId);

  // ── Action helpers ─────────────────────────────────────────────────────────
  async function handleAsk() {
    if (!selectedTarget || !selectedRank) return;
    setSubmitting(true);
    try {
      await store.submit({
        kind: GOFISH_SUBMIT_ASK,
        plaintext: new TextEncoder().encode(
          JSON.stringify({ kind: GOFISH_SUBMIT_ASK, targetPlayerId: selectedTarget, rank: selectedRank })
        )
      });
    } finally {
      setSubmitting(false);
    }
  }

  async function handleDraw() {
    setSubmitting(true);
    try {
      await store.submit({
        kind: GOFISH_SUBMIT_DRAW,
        plaintext: new TextEncoder().encode(JSON.stringify({ kind: GOFISH_SUBMIT_DRAW }))
      });
    } finally {
      setSubmitting(false);
    }
  }

  // ── Layout styles ──────────────────────────────────────────────────────────
  const isFinished = state.phase === 'finished';

  const statusBarStyle: React.CSSProperties = {
    display: 'flex',
    gap: 12,
    alignItems: 'center',
    padding: '10px 16px',
    borderRadius: 10,
    background: isFinished ? '#1a3a1a' : '#1a2a3a',
    color: '#e8f0ff',
    fontSize: 14,
    fontWeight: 500,
    marginBottom: 12,
    flexWrap: 'wrap'
  };

  const cardStyle: React.CSSProperties = {
    padding: 12,
    borderRadius: 10,
    border: '1px solid #ddd',
    background: '#fff'
  };

  const sectionTitleStyle: React.CSSProperties = {
    fontSize: 13,
    fontWeight: 700,
    marginBottom: 8,
    color: '#333'
  };

  // ── Render ─────────────────────────────────────────────────────────────────
  const currentTurnName = state.turnPlayerId
    ? playerName(state.turnPlayerId, playerById)
    : null;

  return (
    <div style={{ fontFamily: 'system-ui, sans-serif', maxWidth: 800 }}>
      {/* ── Observer notice ── */}
      {isObserver ? (
        <div style={{
          marginBottom: 12,
          padding: '8px 12px',
          borderRadius: 8,
          border: '1px solid #e7e2cc',
          background: '#fdf9e6',
          color: '#6b5b1f',
          fontSize: 13
        }}>
          You are <strong>observing</strong> this game.
        </div>
      ) : null}

      {/* ── Hand area ── */}
      {!isObserver ? (
        <div style={{ ...cardStyle, marginBottom: 12 }}>
          <div style={sectionTitleStyle}>Your hand</div>
          {privateState === null && (me?.handCount ?? 0) > 0 ? (
            <div style={{ color: '#888', fontSize: 13 }}>Waiting for private state…</div>
          ) : handIsEmpty ? (
            <div style={{ color: '#888', fontSize: 13 }}>No cards in hand</div>
          ) : (
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              {rankGroups.map(({ rank, count }) => {
                const isSelected = selectedRank === rank;
                return (
                  <button
                    key={rank}
                    onClick={() => setSelectedRank(isSelected ? null : rank)}
                    style={{
                      padding: '6px 14px',
                      borderRadius: 999,
                      border: isSelected ? '2px solid #2a7ae2' : '1px solid #ccc',
                      background: isSelected ? '#e8f4ff' : '#fafafa',
                      color: isSelected ? '#1a5cb5' : '#333',
                      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                      fontSize: 13,
                      fontWeight: isSelected ? 700 : 400,
                      cursor: 'pointer',
                      transition: 'all 0.1s'
                    }}
                  >
                    {rank} ×{count}
                  </button>
                );
              })}
            </div>
          )}
        </div>
      ) : null}

      {/* ── Action area ── */}
      {!isObserver && state.phase === 'active' ? (
        <div style={{ ...cardStyle, marginBottom: 12 }}>
          <div style={sectionTitleStyle}>Action</div>
          {isMyTurn ? (
            handIsEmpty ? (
              state.deckCount > 0 ? (
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <span style={{ fontSize: 13, color: '#555' }}>Your hand is empty.</span>
                  <button
                    onClick={() => { void handleDraw(); }}
                    disabled={submitting}
                    style={{
                      padding: '8px 18px',
                      borderRadius: 8,
                      border: 'none',
                      background: '#2a7ae2',
                      color: '#fff',
                      fontWeight: 700,
                      fontSize: 14,
                      cursor: submitting ? 'not-allowed' : 'pointer',
                      opacity: submitting ? 0.6 : 1
                    }}
                  >
                    Draw a card
                  </button>
                </div>
              ) : (
                <div style={{ fontSize: 13, color: '#888' }}>
                  No cards and deck is empty — waiting to skip turn.
                </div>
              )
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                {/* Target selection */}
                <div>
                  <div style={{ fontSize: 12, color: '#666', marginBottom: 6 }}>
                    Ask player:
                  </div>
                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                    {otherPlayers.map((p) => {
                      const isSelected = selectedTarget === p.playerId;
                      return (
                        <button
                          key={p.playerId}
                          onClick={() => setSelectedTarget(isSelected ? null : p.playerId as PlayerId)}
                          style={{
                            padding: '6px 14px',
                            borderRadius: 8,
                            border: isSelected ? '2px solid #2a7ae2' : '1px solid #ccc',
                            background: isSelected ? '#e8f4ff' : '#fafafa',
                            color: isSelected ? '#1a5cb5' : '#333',
                            fontWeight: isSelected ? 700 : 400,
                            fontSize: 13,
                            cursor: 'pointer'
                          }}
                        >
                          {playerName(p.playerId, playerById)}
                        </button>
                      );
                    })}
                  </div>
                </div>

                {/* Rank hint */}
                {selectedRank ? (
                  <div style={{ fontSize: 13, color: '#555' }}>
                    Asking for: <strong>{rankLabel(selectedRank)}</strong>
                    <span style={{ color: '#999', marginLeft: 6 }}>(click hand chip to change)</span>
                  </div>
                ) : (
                  <div style={{ fontSize: 13, color: '#999' }}>
                    Select a rank from your hand above.
                  </div>
                )}

                {/* Ask button */}
                <div>
                  <button
                    onClick={() => { void handleAsk(); }}
                    disabled={
                      !selectedTarget ||
                      !selectedRank ||
                      !myHand.includes(selectedRank) ||
                      submitting
                    }
                    style={{
                      padding: '8px 20px',
                      borderRadius: 8,
                      border: 'none',
                      background:
                        selectedTarget && selectedRank && myHand.includes(selectedRank) && !submitting
                          ? '#2a7ae2'
                          : '#ccc',
                      color: '#fff',
                      fontWeight: 700,
                      fontSize: 14,
                      cursor:
                        selectedTarget && selectedRank && myHand.includes(selectedRank) && !submitting
                          ? 'pointer'
                          : 'not-allowed'
                    }}
                  >
                    Ask!
                  </button>
                </div>
              </div>
            )
          ) : (
            <div style={{ fontSize: 13, color: '#888' }}>
              Waiting for{' '}
              <strong>
                {state.turnPlayerId ? playerName(state.turnPlayerId, playerById) : '…'}
              </strong>
              &apos;s turn…
            </div>
          )}
        </div>
      ) : null}

      {/* ── Game over panel ── */}
      {isFinished ? (
        <div style={{
          padding: 16,
          borderRadius: 10,
          background: '#1a3a1a',
          color: '#e8ffe8',
          marginBottom: 12
        }}>
          <div style={{ fontSize: 18, fontWeight: 700, marginBottom: 10 }}>
            🏁 Game Over!
          </div>
          <div style={{ marginBottom: 8 }}>
            {state.winnerPlayerIds.length === 1 ? 'Winner' : 'Winners'}:{' '}
            <strong>
              {state.winnerPlayerIds.map((id) => playerName(id, playerById)).join(', ')}
            </strong>
          </div>
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
            {state.players
              .slice()
              .sort((a, b) => b.bookCount - a.bookCount)
              .map((p) => (
                <div
                  key={p.playerId}
                  style={{
                    padding: '6px 12px',
                    borderRadius: 8,
                    background: state.winnerPlayerIds.includes(p.playerId) ? '#2a5a2a' : '#1a3a1a',
                    border: state.winnerPlayerIds.includes(p.playerId)
                      ? '1px solid #4a9a4a'
                      : '1px solid #2a4a2a',
                    fontSize: 13
                  }}
                >
                  <strong>{playerName(p.playerId, playerById)}</strong>: 📚×{p.bookCount}
                </div>
              ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}
