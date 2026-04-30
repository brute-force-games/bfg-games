import { useEffect, useMemo, useState } from 'react';

import type { Player, RoomStore } from '@brute-force-games/multiplayer-types';

import type { AnyGameEngine } from '../types';

export function GameOverPanel(props: {
  store: RoomStore;
  engine: AnyGameEngine;
  players: ReadonlyArray<Player>;
}) {
  const { store, engine, players } = props;

  const [gameStatePublicSeq, setGameStatePublicSeq] = useState(() => store.getGameStatePublicOrNull()?.seq ?? -1);
  useEffect(() => store.onGameStatePublicChanged((s) => setGameStatePublicSeq(s?.seq ?? -1)), [store]);

  const outcome = useMemo(() => {
    const snap = store.getGameStatePublicOrNull();
    if (!snap) return null;
    const parsed = engine.stateSchema.safeParse(snap.state);
    if (!parsed.success) return null;
    const meta = engine.getActiveGameMetadata({
      state: parsed.data,
      players,
      selfPlayerId: store.selfPlayerId
    });
    return meta.phase === 'finished' ? meta.outcome ?? null : null;
  }, [engine, gameStatePublicSeq, players, store.selfPlayerId, store]);

  if (!outcome) return null;

  return (
    <div
      style={{
        marginTop: 12,
        padding: 12,
        borderRadius: 12,
        border: '1px solid #e5e5e5',
        background: '#fff7e6'
      }}
    >
      <strong>Game over.</strong> <span style={{ color: '#444' }}>{outcome.summary}</span>
    </div>
  );
}

