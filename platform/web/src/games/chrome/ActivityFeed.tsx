import { useEffect, useMemo, useState } from 'react';

import type { Player, RoomEvent, RoomStore } from '@brute-force-games/multiplayer-types';

import type { AnyGameEngine, GameStep, StepView } from '../types';

export function ActivityFeed(props: {
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

  const [events, setEvents] = useState<RoomEvent[]>(() => store.getEvents());
  useEffect(() => {
    // Existing store does not have an events subscription; the host writes
    // event + state snapshot together, so refreshing on snapshot change is
    // enough to keep the feed current.
    setEvents(store.getEvents());
  }, [store, gameStatePublicSeq]);

  const currentState = useMemo(() => {
    const snap = store.getGameStatePublicOrNull();
    if (!snap) return null;
    const parsed = engine.stateSchema.safeParse(snap.state);
    return parsed.success ? parsed.data : null;
  }, [engine.stateSchema, gameStatePublicSeq, store]);

  const views = useMemo(() => {
    return events
      .slice()
      .sort((a, b) => a.seq - b.seq)
      .map((step): { step: GameStep; view: StepView | null } => ({
        step,
        view: engine.formatStep({ step, players, currentState })
      }))
      .filter((x) => x.view !== null) as Array<{ step: GameStep; view: StepView }>;
  }, [currentState, engine, events, players]);

  if (views.length === 0) return null;

  return (
    <div style={{ marginTop: 12, borderTop: '1px solid #eee', paddingTop: 12 }}>
      <h3 style={{ margin: '0 0 8px 0', fontSize: 14, color: '#444' }}>Activity</h3>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {views.map(({ step, view }) => (
          <div key={step.id} style={{ fontSize: 13, color: '#333' }}>
            {view.icon ? <span style={{ marginRight: 6 }}>{view.icon}</span> : null}
            <span>{view.summary}</span>
            {view.detail ? <div style={{ marginTop: 2, color: '#555' }}>{view.detail}</div> : null}
          </div>
        ))}
      </div>
    </div>
  );
}

