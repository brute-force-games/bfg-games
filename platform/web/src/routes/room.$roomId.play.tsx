import { createFileRoute, Link, useNavigate } from '@tanstack/react-router';
import { useEffect, useMemo, useState } from 'react';
import { z } from 'zod';

import {
  generateRoomSeed,
  zGameType,
  zRoomId,
  GAME_FINALIZED_KIND,
  type LoadedGameHostKeypair
} from '@brute-force-games/shared-types';

export const Route = createFileRoute('/room/$roomId/play')({
  validateSearch: z.object({ invite: z.string().optional() })
});

import type { Player, PlayerId, Room, RoomStore } from '@brute-force-games/multiplayer-types';

import { useSync } from '../sync/SyncContext';
import { getGameEngine, listGameEngines, renderPlayerUI } from '../games/registry';
import { ActivityFeed } from '../games/chrome/ActivityFeed';
import { GameOverPanel } from '../games/chrome/GameOverPanel';
import { GameStatusBar } from '../games/chrome/GameStatusBar';
import { LobbyConfigCard } from '../games/chrome/LobbyConfigCard';
import { exportGameArchive } from '../games/archive/exportGameArchive';

const FRAMEWORK_GAME_OVER_KIND = 'framework/game_over' as const;
const FRAMEWORK_PLAYERS_ELIMINATED_KIND = 'framework/players_eliminated' as const;
const FRAMEWORK_GAME_STARTED_KIND = 'framework/game_started' as const;

export function RoomPlayRoute() {
  const { roomId: roomIdParam } = Route.useParams();
  const parsedRoomId = zRoomId.safeParse(roomIdParam);
  const search = Route.useSearch();
  const {
    getRoomStore,
    identity,
    touchRoomIndex,
    getRoleForRoom,
    loadHostKeypairForRoom
  } = useSync();
  const [connected, setConnected] = useState<'connecting' | 'connected' | 'error'>('connecting');

  const roomId = parsedRoomId.success ? parsedRoomId.data : null;
  const roomStore = useMemo(() => (roomId ? getRoomStore(roomId) : null), [getRoomStore, roomId]);

  const selfIsHost = useMemo(() => {
    if (!roomId) return false;
    const role = getRoleForRoom(roomId);
    return role?.kind === 'host' && role.hostPlayerId === identity.playerId;
  }, [roomId, getRoleForRoom, identity.playerId]);

  const wsUrl = useMemo(() => {
    if (!roomId) return null;
    return `wss://todo.demo.tinybase.org/${encodeURIComponent(roomId)}`;
  }, [roomId]);

  // ─── Connect lifecycle ───────────────────────────────────────────────────
  useEffect(() => {
    if (!roomId) return;
    if (!roomStore) return;
    let cancelled = false;
    void (async () => {
      try {
        setConnected('connecting');
        touchRoomIndex(roomId, {
          connected: true,
          wsUrl: wsUrl ?? '',
          selfRole: selfIsHost ? 'host' : 'player'
        });

        let hostClaimArg: { hostKeypair: LoadedGameHostKeypair } | undefined;
        let bootstrapRoomIfMissing:
          | { gameType: ReturnType<typeof zGameType.parse>; gameConfig?: unknown; maxPlayers?: number }
          | undefined;
        if (selfIsHost) {
          const hostKeypair = await loadHostKeypairForRoom(roomId);
          if (hostKeypair) {
            hostClaimArg = { hostKeypair };
            const role = getRoleForRoom(roomId);
            if (role?.kind === 'host' && role.bootstrap) {
              bootstrapRoomIfMissing = {
                gameType: role.bootstrap.gameType,
                ...(role.bootstrap.gameConfig !== undefined ? { gameConfig: role.bootstrap.gameConfig } : {}),
                ...(role.bootstrap.maxPlayers !== undefined ? { maxPlayers: role.bootstrap.maxPlayers } : {})
              };
            }
          }
        }

        const connectPromise = roomStore.connect({
          roomId,
          wsUrl: wsUrl!,
          ...(hostClaimArg !== undefined ? { hostClaim: hostClaimArg } : {}),
          ...(bootstrapRoomIfMissing !== undefined ? { bootstrapRoomIfMissing } : {})
        });
        const timeoutPromise = new Promise<void>((_, reject) =>
          window.setTimeout(() => reject(new Error('connect timeout')), 8_000)
        );
        await Promise.race([connectPromise, timeoutPromise]);
        if (!cancelled) setConnected('connected');
      } catch {
        if (!cancelled) setConnected('error');
      }
    })();
    return () => {
      cancelled = true;
      touchRoomIndex(roomId, { connected: false });
      // SyncContext owns the room store's lifetime — see comment in
      // SyncProvider. Don't destroy on cleanup; leaving it parked in the map
      // means StrictMode's setup → cleanup → setup pattern can reuse the same
      // instance, and revisiting the room reuses the WS instead of opening a
      // new one.
    };
  }, [
    roomId,
    roomStore,
    wsUrl,
    selfIsHost,
    getRoleForRoom,
    loadHostKeypairForRoom,
    touchRoomIndex
  ]);

  if (!parsedRoomId.success) {
    return <InvalidRoomLink rawId={roomIdParam} />;
  }

  if (!roomStore) {
    return (
      <div style={{ maxWidth: 720, margin: '0 auto' }}>
        <div style={{ marginTop: 16, padding: 16, border: '1px solid #ddd', borderRadius: 12 }}>
          Loading room…
        </div>
      </div>
    );
  }

  return (
    <ConnectedRoom
      roomStore={roomStore}
      connected={connected}
      selfIsHost={selfIsHost}
      roomId={roomId!}
      wsUrl={wsUrl}
      search={search}
    />
  );
}

// ─── Connected room view ────────────────────────────────────────────────────
//
// Split out so we can hold "connected" state without conditionally calling
// hooks. Once `roomStore` is non-null we render this component, which assumes
// the store exists and uses the abstract `RoomStore` interface throughout.

function ConnectedRoom(props: {
  roomStore: RoomStore;
  connected: 'connecting' | 'connected' | 'error';
  selfIsHost: boolean;
  roomId: string;
  wsUrl: string | null;
  search: Record<string, string | undefined>;
}) {
  const { roomStore, connected, selfIsHost, roomId, wsUrl, search } = props;
  const { getRoleForRoom, createHostedRoom } = useSync();

  const [players, setPlayers] = useState(() => roomStore.getPlayers());
  useEffect(() => roomStore.onPlayersChanged(setPlayers), [roomStore]);

  const [room, setRoom] = useState<ReturnType<RoomStore['getRoomOrNull']>>(null);
  useEffect(() => roomStore.onRoomChanged(setRoom), [roomStore]);

  // Keep the browser tab title aligned with the room/game being viewed.
  useEffect(() => {
    const base = 'Acronym Game';
    if (!room) {
      document.title = `${base} — Room`;
      return;
    }
    const engineName = room.gameType ? getGameEngine(room.gameType)?.displayName : null;
    const gameLabel = engineName ?? (room.gameType ? String(room.gameType) : 'Room');
    const status = room.status ? String(room.status) : '';
    const statusSuffix = status && status !== 'waiting' ? ` (${status})` : '';
    document.title = `${gameLabel}${statusSuffix} — ${roomId} — ${base}`;
  }, [room, roomId]);

  const playerById = useMemo(() => new Map(players.map((p) => [p.id, p])), [players]);
  const hostPlayerId = room?.hostPlayerId ?? null;
  const readyPlayers = players.filter((p) => p.isReady);
  const readyCount = readyPlayers.length;

  // Lobby state machine: host pushes waiting → starting once enough players
  // are ready. Active/finished are entered via the Start button (`startGame`).
  useEffect(() => {
    if (connected !== 'connected') return;
    if (!selfIsHost) return;
    if (!room) return;
    if (room.status === 'active' || room.status === 'finished') return;
    const nextStatus = readyCount >= 2 ? 'starting' : 'waiting';
    if (room.status !== nextStatus) {
      void roomStore.updateRoomAsHost({ status: nextStatus });
    }
  }, [connected, readyCount, room, roomStore, selfIsHost]);

  // ─── Host loops: delegate to the registered game engine ──────────────────
  //
  // Started once we know we're host, the room row is loaded, and the game
  // type is known. We deliberately exclude `room` itself from the deps:
  // arbitrary room-row updates (player join/ready, config tweaks) shouldn't
  // tear down the validator and re-prime the processed set.
  const roomGameType = room?.gameType ?? null;
  useEffect(() => {
    if (connected !== 'connected') return;
    if (!selfIsHost) return;
    if (!roomGameType) return;
    const engine = getGameEngine(roomGameType);
    if (!engine) return;

    let stopped = false;
    let chatHandle: { stop: () => void } | null = null;
    let gameHandle: { stop: () => void } | null = null;
    try {
      chatHandle = roomStore.startLobbyChatHostLoop();
      gameHandle = roomStore.startHostLoop({
        onSubmission: async ({ submission, plaintext }) => {
          if (stopped) return null;
          const liveRoom = roomStore.getRoom();
          if (liveRoom.status !== 'active') return null;
          if (liveRoom.gameType !== roomGameType) return null;
          const config = engine.configSchema.safeParse(liveRoom.gameConfig);
          const result = await engine.applySubmission({
            ctx: { store: roomStore, selfPlayerId: roomStore.selfPlayerId },
            submission,
            plaintext,
            room: liveRoom,
            config: config.success ? config.data : ({} as unknown)
          });
          if (!result) return null;

          const actions = [...result.actions];

          // Shell lifecycle derived from outcome.
          if (result.outcome.kind === 'eliminated') {
            actions.push({
              kind: 'event',
              eventKind: FRAMEWORK_PLAYERS_ELIMINATED_KIND,
              publicPayload: {
                playerIds: result.outcome.playerIds,
                ...(result.outcome.publicPayload !== undefined ? { payload: result.outcome.publicPayload } : {})
              }
            });
          } else if (result.outcome.kind === 'won') {
            actions.push({
              kind: 'event',
              eventKind: FRAMEWORK_GAME_OVER_KIND,
              publicPayload: {
                kind: 'won',
                winnerPlayerIds: result.outcome.winnerPlayerIds,
                ...(result.outcome.publicPayload !== undefined ? { payload: result.outcome.publicPayload } : {})
              }
            });
            actions.push({
              kind: 'event',
              eventKind: GAME_FINALIZED_KIND,
              publicPayload: {
                kind: GAME_FINALIZED_KIND,
                outcome: 'win',
                winnerPlayerIds: result.outcome.winnerPlayerIds
              }
            });
            actions.push({ kind: 'updateRoom', patch: { status: 'finished' } });
          } else if (result.outcome.kind === 'draw') {
            actions.push({
              kind: 'event',
              eventKind: FRAMEWORK_GAME_OVER_KIND,
              publicPayload: {
                kind: 'draw',
                winnerPlayerIds: [],
                ...(result.outcome.publicPayload !== undefined ? { payload: result.outcome.publicPayload } : {})
              }
            });
            actions.push({
              kind: 'event',
              eventKind: GAME_FINALIZED_KIND,
              publicPayload: { kind: GAME_FINALIZED_KIND, outcome: 'draw', winnerPlayerIds: [] }
            });
            actions.push({ kind: 'updateRoom', patch: { status: 'finished' } });
          }

          // Persist one history row when a public snapshot was written in this turn.
          const lastPublic = [...actions].reverse().find((a) => a.kind === 'gameStatePublic');
          if (lastPublic && lastPublic.kind === 'gameStatePublic') {
            actions.push({ kind: 'gameStateHistory', state: lastPublic.state });
          }

          return actions;
        }
      });
    } catch {
      // Not host of this room (claim/keypair mismatch). Silently skip;
      // host-only methods would otherwise throw.
    }

    return () => {
      stopped = true;
      gameHandle?.stop();
      chatHandle?.stop();
    };
  }, [connected, selfIsHost, roomGameType, roomStore]);

  if (connected === 'error') {
    return (
      <div style={{ maxWidth: 720, margin: '0 auto' }}>
        <div style={{ padding: 16, border: '1px solid #f2c2c2', borderRadius: 12 }}>
          <strong style={{ color: '#7a1f1f' }}>Connection error</strong>
          <p style={{ marginTop: 8, color: '#555' }}>
            We couldn't reach the multiplayer server. Try refreshing.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div style={{ maxWidth: 720, margin: '0 auto' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <h1 style={{ margin: 0 }}>Room</h1>
        <div style={{ display: 'flex', gap: 12 }}>
          <Link to="/">Home</Link>
          <Link to="/settings">Settings</Link>
        </div>
      </div>
      {room ? (
        <div style={{ marginTop: 8, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button
            type="button"
            onClick={() => {
              const engine = room.gameType ? getGameEngine(room.gameType) : null;
              if (!engine) return;
              const archive = exportGameArchive(roomStore, engine);
              const blob = new Blob([JSON.stringify(archive, null, 2)], { type: 'application/json' });
              const url = URL.createObjectURL(blob);
              const a = document.createElement('a');
              a.href = url;
              a.download = `${room.id}-${room.gameType}-archive.json`;
              a.click();
              URL.revokeObjectURL(url);
            }}
          >
            Download archive
          </button>
          {selfIsHost && room.status === 'finished' ? (
            <button
              type="button"
              onClick={() => {
                const engine = room.gameType ? getGameEngine(room.gameType) : null;
                if (!engine) return;
                void roomStore
                  .exportGameRecord({
                    appVersion: (import.meta as { env?: Record<string, string> }).env?.VITE_GIT_SHA ?? 'dev',
                    engineVersion: engine.version
                  })
                  .then((record) => {
                    const blob = new Blob([JSON.stringify(record, null, 2)], { type: 'application/json' });
                    const url = URL.createObjectURL(blob);
                    const a = document.createElement('a');
                    a.href = url;
                    a.download = `${room.id}-${room.gameType}-record.json`;
                    a.click();
                    URL.revokeObjectURL(url);
                  });
              }}
            >
              Export signed record
            </button>
          ) : null}
        </div>
      ) : null}

      <div style={{ marginTop: 16, padding: 16, border: '1px solid #ddd', borderRadius: 12 }}>
        <RoomMetadata
          roomId={roomId}
          invite={search.invite}
          wsUrl={wsUrl ?? ''}
          connected={connected}
          selfDisplayName={playerById.get(roomStore.selfPlayerId)?.displayName ?? '(unknown)'}
          selfPlayerId={roomStore.selfPlayerId}
          selfIsHost={selfIsHost}
        />

        {selfIsHost ? (
          <HostControls
            roomStore={roomStore}
            room={room}
            readyPlayers={readyPlayers}
            readyCount={readyCount}
            getRoleForRoom={(id) => getRoleForRoom(id as never)}
            roomId={roomId}
            createHostedRoom={createHostedRoom}
          />
        ) : null}

        {connected === 'connected' && (room?.status ?? 'waiting') !== 'active' ? (
          <LobbyConfigSection room={room} roomStore={roomStore} selfIsHost={selfIsHost} />
        ) : null}

        <PlayersList
          players={players}
          hostPlayerId={hostPlayerId}
          selfPlayerId={roomStore.selfPlayerId}
          roomStatus={room?.status ?? 'waiting'}
          readyCount={readyCount}
          onToggleReady={(ready) => roomStore.setSelfReady(ready)}
        />

        {room && (room.status === 'active' || room.status === 'finished') ? (
          <div style={{ marginTop: 16, paddingTop: 12, borderTop: '1px solid #eee' }}>
            {getGameEngine(room.gameType) ? (
              <GameStatusBar store={roomStore} engine={getGameEngine(room.gameType)!} players={players} />
            ) : (
              <h2 style={{ margin: '0 0 8px 0', fontSize: 16 }}>
                {getGameEngine(room.gameType)?.displayName ?? room.gameType}
              </h2>
            )}
            {renderPlayerUI({
              gameType: room.gameType,
              store: roomStore,
              room,
              selfPlayerId: roomStore.selfPlayerId,
              players
            }) ?? <div style={{ color: '#777' }}>No engine for game type "{room.gameType}".</div>}
            {getGameEngine(room.gameType) ? (
              <>
                <GameOverPanel store={roomStore} engine={getGameEngine(room.gameType)!} players={players} />
                <ActivityFeed store={roomStore} engine={getGameEngine(room.gameType)!} players={players} />
              </>
            ) : null}
          </div>
        ) : null}

        {room?.status === 'active' ? (
          <AutoPlayPanel
            store={roomStore}
            room={room}
            selfPlayerId={roomStore.selfPlayerId}
            players={players}
          />
        ) : null}

        <LobbyChat roomStore={roomStore} playerById={playerById} hostPlayerId={hostPlayerId} />
      </div>
    </div>
  );
}

// ─── Subcomponents (lobby-side UI) ──────────────────────────────────────────

function InvalidRoomLink(props: { rawId: string }) {
  return (
    <div style={{ maxWidth: 720, margin: '0 auto' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <h1 style={{ margin: 0 }}>Invalid room link</h1>
        <div style={{ display: 'flex', gap: 12 }}>
          <Link to="/">Home</Link>
          <Link to="/settings">Settings</Link>
        </div>
      </div>

      <div style={{ marginTop: 16, padding: 16, border: '1px solid #f2c2c2', borderRadius: 12 }}>
        <p style={{ marginTop: 0, color: '#7a1f1f' }}>
          This URL has an invalid <strong>roomId</strong>: <code>{props.rawId}</code>
        </p>
        <p style={{ marginTop: 0, color: '#555' }}>
          Room ids must start with <code>room_</code>. The easiest fix is to go Home and click{' '}
          <strong>New Game</strong>, or paste a full invite link.
        </p>

        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <Link to="/">
            <button type="button">Go Home</button>
          </Link>
        </div>
      </div>
    </div>
  );
}

function RoomMetadata(props: {
  roomId: string;
  invite: string | undefined;
  wsUrl: string;
  connected: 'connecting' | 'connected' | 'error';
  selfDisplayName: string;
  selfPlayerId: string;
  selfIsHost: boolean;
}) {
  return (
    <div style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 13 }}>
      <div>
        <strong>roomId</strong>: {props.roomId}
      </div>
      <div>
        <strong>invite</strong>: {props.invite ?? '(none)'}
      </div>
      <div>
        <strong>ws</strong>: {props.wsUrl}
      </div>
      <div>
        <strong>sync</strong>: {props.connected} (self: {props.selfDisplayName} / {props.selfPlayerId})
      </div>
      <div>
        <strong>role</strong>:{' '}
        {props.connected === 'connected' ? (props.selfIsHost ? 'host' : 'player') : '(unknown)'}
      </div>
    </div>
  );
}

function HostControls(props: {
  roomStore: RoomStore;
  room: ReturnType<RoomStore['getRoomOrNull']>;
  readyPlayers: ReadonlyArray<ReturnType<RoomStore['getPlayers']>[number]>;
  readyCount: number;
  getRoleForRoom: (roomId: string) => ReturnType<ReturnType<typeof useSync>['getRoleForRoom']>;
  roomId: string;
  createHostedRoom: ReturnType<typeof useSync>['createHostedRoom'];
}) {
  const { roomStore, room, readyPlayers, readyCount, getRoleForRoom, roomId, createHostedRoom } = props;
  const navigate = useNavigate();
  const [starting, setStarting] = useState(false);
  const [creatingNew, setCreatingNew] = useState(false);

  const minPlayers = useMemo(() => {
    if (!room?.gameType) return 2;
    return getGameEngine(room.gameType)?.minPlayers ?? 2;
  }, [room?.gameType]);

  const canStart =
    readyCount >= minPlayers && room?.status !== 'active' && room?.status !== 'finished' && !starting;

  const onStart = async () => {
    if (starting) return;
    setStarting(true);
    try {
      const liveRoom = roomStore.getRoom();
      const engine = getGameEngine(liveRoom.gameType);
      if (!engine) return;
      const config = engine.configSchema.safeParse(liveRoom.gameConfig);
      const engineActions = await engine.startGame({
        ctx: { store: roomStore, selfPlayerId: roomStore.selfPlayerId },
        room: liveRoom,
        readyPlayers,
        config: config.success ? config.data : ({} as unknown)
      });
      if (engineActions.length === 0) return;

      const matchIndex = 0;
      const actions = [
        {
          kind: 'event' as const,
          eventKind: FRAMEWORK_GAME_STARTED_KIND,
          publicPayload: {
            playerIds: readyPlayers.map((p) => p.id),
            matchIndex,
            seed: liveRoom.seed,
            gameType: liveRoom.gameType
          },
          fromPlayerId: roomStore.selfPlayerId
        },
        ...engineActions.filter(
          (a) => !(a.kind === 'updateRoom' && (a.patch as { status?: unknown } | undefined)?.status === 'active')
        ),
        { kind: 'updateRoom' as const, patch: { status: 'active' as const } }
      ];

      const lastPublic = [...actions].reverse().find((a) => a.kind === 'gameStatePublic');
      if (lastPublic && lastPublic.kind === 'gameStatePublic') {
        actions.push({ kind: 'gameStateHistory' as const, state: lastPublic.state });
      }

      await roomStore.applyHostActions(actions);
    } finally {
      setStarting(false);
    }
  };

  const onNewGame = async () => {
    if (creatingNew) return;
    setCreatingNew(true);
    try {
      const gameType = zGameType.parse(room?.gameType ?? 'tictactoe');
      const { roomId: newRoomId, invite } = await createHostedRoom({
        defaultGameType: gameType,
        seed: generateRoomSeed(),
        ...(room?.gameConfig !== undefined ? { defaultGameConfig: room.gameConfig } : {}),
        ...(room?.maxPlayers !== undefined ? { maxPlayers: room.maxPlayers } : {})
      });
      void navigate({ to: '/room/$roomId/play', params: { roomId: newRoomId }, search: { invite } });
    } finally {
      setCreatingNew(false);
    }
  };

  return (
    <div style={{ marginTop: 10 }}>
      <button
        type="button"
        onClick={() => {
          const role = getRoleForRoom(roomId);
          const hostBootstrap = role?.kind === 'host' ? role.bootstrap : null;
          roomStore.resetRoomAsHost({
            gameType: (room?.gameType ?? hostBootstrap?.gameType ?? 'tictactoe') as never,
            gameConfig: room?.gameConfig ?? hostBootstrap?.gameConfig,
            maxPlayers: room?.maxPlayers ?? hostBootstrap?.maxPlayers
          });
        }}
      >
        Reset room (dev)
      </button>
      {room?.status !== 'active' ? (
        <button
          type="button"
          style={{ marginLeft: 8 }}
          disabled={!canStart}
          onClick={() => void onStart()}
        >
          Start{' '}
          {room?.gameType ? (getGameEngine(room.gameType)?.displayName ?? String(room.gameType)) : 'game'}{' '}
          {readyCount < minPlayers ? `(need ${minPlayers}+ joined)` : ''}
        </button>
      ) : null}
      {room?.status === 'finished' ? (
        <button
          type="button"
          style={{ marginLeft: 8 }}
          disabled={creatingNew}
          onClick={() => void onNewGame()}
        >
          {creatingNew ? 'Creating…' : '+ New Game'}
        </button>
      ) : null}
    </div>
  );
}

function LobbyConfigSection(props: {
  room: ReturnType<RoomStore['getRoomOrNull']>;
  roomStore: RoomStore;
  selfIsHost: boolean;
}) {
  const { room, roomStore, selfIsHost } = props;
  const engines = useMemo(() => listGameEngines(), []);

  if (!room) {
    return (
      <div style={{ marginTop: 16, paddingTop: 12, borderTop: '1px solid #eee' }}>
        <h2 style={{ margin: '0 0 8px 0', fontSize: 16 }}>Game</h2>
        <div style={{ color: '#666', fontSize: 13 }}>Loading room…</div>
      </div>
    );
  }

  const engine = getGameEngine(room.gameType) ?? engines[0] ?? null;
  const configLocked = room.status === 'active' || room.status === 'finished';

  return (
    <div style={{ marginTop: 16, paddingTop: 12, borderTop: '1px solid #eee' }}>
      <h2 style={{ margin: '0 0 8px 0', fontSize: 16 }}>Game</h2>

      {selfIsHost ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span style={{ width: 120, color: '#555' }}>Game</span>
            <select
              value={String(room.gameType)}
              disabled={configLocked}
              onChange={(e) => {
                const nextGameType = zGameType.parse(e.target.value);
                const nextEngine = getGameEngine(nextGameType) ?? null;
                if (!nextEngine) return;
                const nextConfig = nextEngine.defaultConfig as unknown as Record<string, unknown>;
                const cfgMaxPlayers =
                  typeof nextConfig.maxPlayers === 'number' ? nextConfig.maxPlayers : nextEngine.maxPlayers;
                void roomStore.updateRoomAsHost({
                  gameType: nextGameType,
                  gameConfig: nextEngine.defaultConfig,
                  maxPlayers: Math.min(nextEngine.maxPlayers, cfgMaxPlayers)
                });
              }}
            >
              {engines.map((e) => (
                <option key={e.gameType} value={e.gameType}>
                  {e.displayName}
                </option>
              ))}
            </select>
          </label>

          {engine ? (
            <LobbyConfigCard
              engine={engine}
              room={room}
              store={roomStore}
              isHost={!configLocked}
              title={configLocked ? 'Game config (locked)' : 'Game config'}
            />
          ) : null}
        </div>
      ) : (
        <div style={{ color: '#666', fontSize: 13 }}>
          Host is configuring the game. Current selection:{' '}
          <strong>{engine?.displayName ?? String(room.gameType)}</strong>
        </div>
      )}
    </div>
  );
}

function PlayersList(props: {
  players: ReadonlyArray<ReturnType<RoomStore['getPlayers']>[number]>;
  hostPlayerId: string | null;
  selfPlayerId: string;
  roomStatus: string;
  readyCount: number;
  onToggleReady: (ready: boolean) => void;
}) {
  const { players, hostPlayerId, selfPlayerId, roomStatus, readyCount, onToggleReady } = props;
  return (
    <div style={{ marginTop: 12 }}>
      <h2 style={{ margin: '0 0 8px 0', fontSize: 16 }}>Players</h2>
      <ul style={{ margin: 0, paddingLeft: 18 }}>
        {players.map((p) => (
          <li key={p.id}>
            <span style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 12 }}>
              {p.id.slice(0, 12)}…
            </span>{' '}
            — {p.displayName}{' '}
            {hostPlayerId && p.id === hostPlayerId ? (
              <strong style={{ marginLeft: 6 }}>(host)</strong>
            ) : null}{' '}
            {roomStatus !== 'active' ? (
              <>
                —{' '}
                <strong style={{ color: p.isReady ? '#14532d' : '#7a1f1f' }}>
                  {p.isReady ? 'joined' : 'not joined'}
                </strong>{' '}
                {p.id === selfPlayerId ? (
                  <button
                    type="button"
                    style={{ marginLeft: 8 }}
                    onClick={() => onToggleReady(!p.isReady)}
                  >
                    {p.isReady ? 'Leave game' : 'Join game'}
                  </button>
                ) : null}{' '}
              </>
            ) : null}
            — lastSeen {new Date(p.lastSeen).toLocaleTimeString()}
          </li>
        ))}
      </ul>
      {roomStatus !== 'active' ? (
        <div style={{ marginTop: 8, color: '#555' }}>
          Joined: <strong>{readyCount}</strong> / {players.length} (need 2+)
        </div>
      ) : null}
    </div>
  );
}

function AutoPlayPanel(props: {
  store: RoomStore;
  room: Room;
  selfPlayerId: string;
  players: ReadonlyArray<Player>;
}) {
  const { store, room, selfPlayerId, players } = props;
  const engine = getGameEngine(room.gameType);
  const [log, setLog] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  if (!engine) return null;

  const handleAutoPlay = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const config = engine.configSchema.safeParse(room.gameConfig);
      const result = await engine.autoPlay({
        store,
        selfPlayerId: selfPlayerId as PlayerId,
        room,
        config: config.success ? config.data : ({} as unknown),
        players
      });
      if (!result) {
        setLog((prev) => ['(no move available — not your turn or game over)', ...prev]);
        return;
      }
      await store.submit(result.submission);
      setLog((prev) => [result.description, ...prev]);
    } catch (err) {
      setLog((prev) => [`Error: ${String(err)}`, ...prev]);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ marginTop: 12, paddingTop: 12, borderTop: '1px solid #eee' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
        <h2 style={{ margin: 0, fontSize: 16 }}>Auto Play</h2>
        <button type="button" disabled={busy} onClick={() => { void handleAutoPlay(); }}>
          {busy ? 'Playing…' : '▶ Auto Play'}
        </button>
      </div>
      {log.length > 0 ? (
        <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12, color: '#555', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' }}>
          {log.slice(0, 8).map((entry, i) => (
            <li key={i}>{entry}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function LobbyChat(props: {
  roomStore: RoomStore;
  playerById: Map<string, ReturnType<RoomStore['getPlayers']>[number]>;
  hostPlayerId: string | null;
}) {
  const { roomStore, playerById, hostPlayerId } = props;
  const [chatText, setChatText] = useState('');
  const [chatEvents, setChatEvents] = useState(() => roomStore.getLobbyChatEvents());
  useEffect(() => roomStore.onLobbyChatEventsChanged(setChatEvents), [roomStore]);

  return (
    <div style={{ marginTop: 16, paddingTop: 12, borderTop: '1px solid #eee' }}>
      <h2 style={{ margin: '0 0 8px 0', fontSize: 16 }}>Lobby chat</h2>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <div
          style={{
            border: '1px solid #ddd',
            borderRadius: 10,
            padding: 10,
            maxHeight: 220,
            overflow: 'auto',
            background: '#fff'
          }}
        >
          {chatEvents.length === 0 ? (
            <div style={{ color: '#777' }}>No messages yet.</div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {chatEvents
                .slice()
                .sort((a, b) => a.seq - b.seq)
                .map((e) => {
                  const p = playerById.get(e.fromPlayerId);
                  return (
                    <div key={e.id} style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
                      <span
                        style={{
                          width: 10,
                          height: 10,
                          borderRadius: 999,
                          background: p?.avatarColor ?? '#999',
                          display: 'inline-block',
                          flex: '0 0 auto'
                        }}
                        aria-label="player color"
                      />
                      <strong style={{ fontSize: 13 }}>
                        {p?.displayName ?? e.fromPlayerId.slice(0, 12) + '…'}
                      </strong>
                      <span style={{ color: '#999' }}>:</span>
                      {hostPlayerId && e.fromPlayerId === hostPlayerId ? (
                        <strong style={{ marginRight: 6 }}>(host)</strong>
                      ) : null}
                      <span style={{ color: '#333' }}>{e.text}</span>
                    </div>
                  );
                })}
            </div>
          )}
        </div>

        <form
          onSubmit={(ev) => {
            ev.preventDefault();
            const text = chatText.trim();
            if (!text) return;
            void roomStore.submitLobbyChatMessage({ text });
            setChatText('');
          }}
          style={{ display: 'flex', gap: 8 }}
        >
          <input
            value={chatText}
            onChange={(e) => setChatText(e.target.value)}
            placeholder="Say hi…"
            style={{ flex: 1, padding: 10, borderRadius: 10, border: '1px solid #ccc' }}
          />
          <button type="submit" disabled={!chatText.trim()}>
            Send
          </button>
        </form>
      </div>
    </div>
  );
}
