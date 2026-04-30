import { useEffect, useMemo, useRef } from 'react';

import {
  decodeBridgePayload,
  encodeBridgePayload,
  zBfgBridgeEnvelopeV1
} from '@brute-force-games/shared-types';
import type { Player, Room, RoomStore } from '@brute-force-games/multiplayer-types';

import type { AnyGameEngine } from '../types';

const EVT_GODOT_READY = 'godot_ready' as const;
const EVT_STATE_INIT = 'state_init' as const;
const EVT_STATE_PUBLIC = 'state_public' as const;
const EVT_INTENT = 'intent' as const;

export function GodotPlayerSurface(props: {
  store: RoomStore;
  room: Room;
  players: ReadonlyArray<Player>;
  engine: AnyGameEngine;
  isObserver: boolean;
}) {
  const { store, room, players, engine, isObserver } = props;
  const adapter = engine.godot;
  const iframeRef = useRef<HTMLIFrameElement | null>(null);

  const searchParams = useMemo(() => new URLSearchParams(window.location.search), []);
  const stub = searchParams.get('godot') === 'stub';

  useEffect(() => {
    if (!adapter) return;

    const post = (type: string, payload: unknown) => {
      const win = iframeRef.current?.contentWindow;
      if (!win) return;
      win.postMessage(
        {
          bfg: true,
          v: 1,
          game: room.gameType,
          type,
          payload: encodeBridgePayload(payload)
        },
        '*'
      );
    };

    const sendInit = () => {
      const snap = store.getGameStatePublicOrNull();
      if (!snap) return;
      const parsed = engine.stateSchema.safeParse(snap.state);
      if (!parsed.success) return;
      post(
        EVT_STATE_INIT,
        adapter.buildStateInit({
          state: parsed.data,
          selfPlayerId: store.selfPlayerId,
          players,
          config: engine.configSchema.parse(room.gameConfig),
          isObserver
        })
      );
      post(EVT_STATE_PUBLIC, adapter.buildStatePublic({ state: parsed.data, config: engine.configSchema.parse(room.gameConfig) }));
    };

    const onMessage = (evt: MessageEvent) => {
      const parsed = zBfgBridgeEnvelopeV1.safeParse(evt.data);
      if (!parsed.success) return;
      const env = parsed.data;
      if (env.game !== room.gameType) return;

      if (env.type === EVT_GODOT_READY) {
        sendInit();
        return;
      }

      if (env.type === EVT_INTENT) {
        const payload = decodeBridgePayload(env.payload);
        const intent = adapter.parseIntent({
          payload,
          selfPlayerId: store.selfPlayerId,
          config: engine.configSchema.parse(room.gameConfig)
        });
        if (!intent) return;
        void store.submit(intent);
      }
    };

    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [adapter, engine, isObserver, players, room.gameConfig, room.gameType, store]);

  useEffect(() => {
    if (!adapter) return;
    return store.onGameStatePublicChanged((snap) => {
      if (!snap) return;
      const parsed = engine.stateSchema.safeParse(snap.state);
      if (!parsed.success) return;
      const win = iframeRef.current?.contentWindow;
      if (!win) return;
      win.postMessage(
        {
          bfg: true,
          v: 1,
          game: room.gameType,
          type: EVT_STATE_PUBLIC,
          payload: encodeBridgePayload(adapter.buildStatePublic({ state: parsed.data, config: engine.configSchema.parse(room.gameConfig) }))
        },
        '*'
      );
    });
  }, [adapter, engine, room.gameConfig, room.gameType, store]);

  if (!adapter) return null;

  if (stub) {
    return (
      <div style={{ padding: 12, border: '1px dashed #ccc', borderRadius: 12, color: '#555' }}>
        Godot stub mode. Disable with `?godot=stub`.
      </div>
    );
  }

  return (
    <iframe
      ref={iframeRef}
      title={`${engine.displayName} (Godot)`}
      src={adapter.exportPath}
      style={{ width: '100%', height: 420, border: '1px solid #eee', borderRadius: 12 }}
      allow="fullscreen"
    />
  );
}

