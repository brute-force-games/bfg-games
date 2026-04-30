import { useEffect, useMemo, useState } from 'react';

import type { Player, RoomStore } from '@brute-force-games/multiplayer-types';

import type { AnyGameEngine } from '../types';

export function GameStatusBar(props: {
  store: RoomStore;
  engine: AnyGameEngine;
  players: ReadonlyArray<Player>;
}) {
  const { store, engine, players } = props;

  const [gameStatePublicSeq, setGameStatePublicSeq] = useState(() => store.getGameStatePublicOrNull()?.seq ?? -1);
  useEffect(
    () =>
      store.onGameStatePublicChanged((s) => {
        setGameStatePublicSeq(s?.seq ?? -1);
      }),
    [store]
  );

  const meta = useMemo(() => {
    const snap = store.getGameStatePublicOrNull();
    if (!snap) return null;
    const parsed = engine.stateSchema.safeParse(snap.state);
    if (!parsed.success) return null;
    return engine.getActiveGameMetadata({
      state: parsed.data,
      players,
      selfPlayerId: store.selfPlayerId
    });
  }, [engine, gameStatePublicSeq, players, store]);

  if (!meta) return null;

  return (
    <div style={{ padding: 10, border: '1px solid #eee', borderRadius: 12, background: '#fafafa' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'baseline' }}>
        <div style={{ fontWeight: 600 }}>{engine.displayName}</div>
        {meta.turnSummary ? <div style={{ color: '#555', fontSize: 13 }}>{meta.turnSummary}</div> : null}
      </div>
      {meta.badges && meta.badges.length > 0 ? (
        <div style={{ display: 'flex', gap: 8, marginTop: 6, flexWrap: 'wrap' }}>
          {meta.badges.map((b, idx) => (
            <span
              key={idx}
              style={{
                fontSize: 12,
                padding: '2px 8px',
                borderRadius: 999,
                background: '#fff',
                border: '1px solid #e7e7e7',
                color: '#444'
              }}
            >
              <strong style={{ fontWeight: 600 }}>{b.label}:</strong> {b.value}
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}

