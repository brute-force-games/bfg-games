import type { ReactNode } from 'react';

import type { Room, RoomStore } from '@brute-force-games/multiplayer-types';

import type { AnyGameEngine } from '../types';

export function LobbyConfigCard(props: {
  engine: AnyGameEngine;
  room: Room;
  store: RoomStore;
  isHost: boolean;
  title?: ReactNode;
}) {
  const { engine, room, store, isHost } = props;
  const parsed = engine.configSchema.safeParse(room.gameConfig);
  const config = parsed.success ? parsed.data : engine.defaultConfig;

  return (
    <div style={{ marginTop: 16, padding: 12, border: '1px solid #eee', borderRadius: 12 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8 }}>
        <h2 style={{ margin: 0, fontSize: 16 }}>{props.title ?? 'Game config'}</h2>
        <div style={{ color: '#666', fontSize: 12 }}>{engine.displayName}</div>
      </div>
      <div style={{ marginTop: 10 }}>
        <engine.ConfigUI
          config={config as never}
          isHost={isHost}
          onChange={(next) => {
            if (!isHost) return;
            void store.updateRoomAsHost({ gameConfig: next });
          }}
        />
      </div>
    </div>
  );
}

