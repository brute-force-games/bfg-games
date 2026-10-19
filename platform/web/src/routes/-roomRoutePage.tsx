import { Link, useNavigate } from '@tanstack/react-router';
import { useEffect, useMemo, useState } from 'react';

import {
  canSubmitGameMoves,
  deriveUserGameRole,
  generateRoomSeed,
  zGameType,
  zRoomId,
  GAME_FINALIZED_KIND,
  type LoadedGameHostKeypair,
  type RoomRouteSegment,
  type UserGameRole
} from '@brute-force-games/shared-types';

import type { Player, PlayerId, Room, RoomSessionRole, RoomStore } from '@brute-force-games/multiplayer-types';

import { useSync } from '../sync/SyncContext';
import { getGameEngine, listGameEngines, renderPlayerUI } from '../games/registry';
import type { AnyGameEngine } from '../games/types';
import { ActivityFeed } from '../games/chrome/ActivityFeed';
import { GameOverPanel } from '../games/chrome/GameOverPanel';
import { GameStatusBar } from '../games/chrome/GameStatusBar';
import { LobbyConfigCard } from '../games/chrome/LobbyConfigCard';
import { exportGameArchive } from '../games/archive/exportGameArchive';

const FRAMEWORK_GAME_OVER_KIND = 'framework/game_over' as const;
const FRAMEWORK_PLAYERS_ELIMINATED_KIND = 'framework/players_eliminated' as const;
const FRAMEWORK_GAME_STARTED_KIND = 'framework/game_started' as const;

export type RoomRoutePageProps = {
  routeSegment: RoomRouteSegment;
  roomIdParam: string;
  /** Optional invite shown in UI (e.g. `/play` route search). */
  invite?: string;
};

export function RoomRoutePage(props: RoomRoutePageProps) {
  const { routeSegment, roomIdParam, invite } = props;
  const parsedRoomId = zRoomId.safeParse(roomIdParam);
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

  const hostParticipatesAsPlayer = useMemo(() => {
    if (!roomId) return true;
    const role = getRoleForRoom(roomId);
    if (role?.kind !== 'host') return true;
    return role.participatesAsPlayer !== false;
  }, [roomId, getRoleForRoom]);

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

        const joinAsObserver = routeSegment === 'spectate' && !selfIsHost;

        const connectPromise = roomStore.connect({
          roomId,
          wsUrl: wsUrl!,
          ...(hostClaimArg !== undefined ? { hostClaim: hostClaimArg } : {}),
          ...(bootstrapRoomIfMissing !== undefined ? { bootstrapRoomIfMissing } : {}),
          ...(joinAsObserver ? { joinAsObserver: true } : {}),
          ...(selfIsHost ? { hostParticipatesAsPlayer } : {})
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
    };
  }, [
    roomId,
    roomStore,
    wsUrl,
    selfIsHost,
    getRoleForRoom,
    loadHostKeypairForRoom,
    touchRoomIndex,
    routeSegment,
    hostParticipatesAsPlayer
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
      routeSegment={routeSegment}
      roomStore={roomStore}
      connected={connected}
      selfIsHost={selfIsHost}
      hostParticipatesAsPlayer={hostParticipatesAsPlayer}
      roomId={roomId!}
      wsUrl={wsUrl}
      invite={invite}
    />
  );
}

// ─── Connected room view ────────────────────────────────────────────────────
//
// Split out so we can hold "connected" state without conditionally calling
// hooks. Once `roomStore` is non-null we render this component, which assumes
// the store exists and uses the abstract `RoomStore` interface throughout.

function ConnectedRoom(props: {
  routeSegment: RoomRouteSegment;
  roomStore: RoomStore;
  connected: 'connecting' | 'connected' | 'error';
  selfIsHost: boolean;
  hostParticipatesAsPlayer: boolean;
  roomId: string;
  wsUrl: string | null;
  invite?: string | undefined;
}) {
  const { routeSegment, roomStore, connected, selfIsHost, hostParticipatesAsPlayer, roomId, wsUrl, invite } =
    props;
  const { getRoleForRoom, createHostedRoom, identity } = useSync();

  const [players, setPlayers] = useState(() => roomStore.getPlayers());
  useEffect(() => roomStore.onPlayersChanged(setPlayers), [roomStore]);

  const [room, setRoom] = useState<ReturnType<RoomStore['getRoomOrNull']>>(() => roomStore.getRoomOrNull(roomId));
  useEffect(() => roomStore.onRoomChanged(setRoom), [roomStore, roomId]);

  const [sessionRole, setSessionRole] = useState<RoomSessionRole>(() => roomStore.getSelfRoomRole());
  useEffect(() => roomStore.onSelfRoomRoleChanged(setSessionRole), [roomStore]);

  const userGameRole: UserGameRole = useMemo(
    () =>
      deriveUserGameRole({
        route: routeSegment,
        sessionRole,
        hasHostClaim: selfIsHost,
        hostParticipatesAsPlayer,
        selfPlayerId: identity.playerId as PlayerId,
        roomHostPlayerId: room?.hostPlayerId
      }),
    [routeSegment, sessionRole, selfIsHost, hostParticipatesAsPlayer, identity.playerId, room?.hostPlayerId]
  );

  const navigate = useNavigate();
  useEffect(() => {
    if (routeSegment === 'spectate' && selfIsHost) {
      void navigate({ to: '/room/$roomId/play', params: { roomId }, replace: true });
    }
  }, [navigate, routeSegment, selfIsHost, roomId]);

  useEffect(() => {
    if (
      routeSegment === 'play' &&
      userGameRole.kind === 'host_moderator' &&
      connected === 'connected'
    ) {
      void navigate({ to: '/room/$roomId/host', params: { roomId }, replace: true });
    }
  }, [navigate, routeSegment, userGameRole.kind, connected, roomId]);

  const isObserver = sessionRole === 'observer';

  // Keep the browser tab title aligned with the room/game being viewed.
  useEffect(() => {
    const base = 'Brute Force Games';
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
  const roomStatus = room?.status ?? 'waiting';
  const roomGameType = room?.gameType ?? null;
  const engine = roomGameType ? getGameEngine(roomGameType) : null;
  const isLive = room !== null && (room.status === 'active' || room.status === 'finished');

  // Lobby state machine: host pushes waiting → starting once enough players
  // are ready. Active/finished are entered via the Start button (`startGame`).
  useEffect(() => {
    if (!selfIsHost) return;
    if (!room) return;
    if (room.status === 'active' || room.status === 'finished') return;
    const nextStatus = readyCount >= 2 ? 'starting' : 'waiting';
    if (room.status !== nextStatus) {
      void roomStore.updateRoomAsHost({ status: nextStatus });
    }
  }, [readyCount, room, roomStore, selfIsHost]);

  // ─── Host loops: delegate to the registered game engine ──────────────────
  //
  // Started once we know we're host, the room row is loaded, and the game
  // type is known. We deliberately exclude `room` itself from the deps:
  // arbitrary room-row updates (player join/ready, config tweaks) shouldn't
  // tear down the validator and re-prime the processed set.
  useEffect(() => {
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
  }, [selfIsHost, roomGameType, roomStore]);


  const hostSeesFocusedGame =
    selfIsHost &&
    isLive &&
    room &&
    engine &&
    (userGameRole.kind === 'host_player' || userGameRole.kind === 'host_moderator');

  if (hostSeesFocusedGame && roomStatus === 'active' && routeSegment === 'play' && userGameRole.kind === 'host_player') {
    return (
      <div style={{ maxWidth: 720, margin: '0 auto' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
          <h1 style={{ margin: 0 }}>Room</h1>
          <div style={{ display: 'flex', gap: 12 }}>
            <Link to="/">Home</Link>
            <Link to="/settings">Settings</Link>
          </div>
        </div>
        <RoomRouteNav roomId={roomId} current={routeSegment} selfIsHost={selfIsHost} />
        <HostActiveView
          roomStore={roomStore}
          room={room}
          engine={engine}
          players={players}
          userGameRole={userGameRole}
        />
      </div>
    );
  }

  if (
    hostSeesFocusedGame &&
    roomStatus === 'finished' &&
    (routeSegment === 'play' || routeSegment === 'host') &&
    (userGameRole.kind === 'host_player' || userGameRole.kind === 'host_moderator')
  ) {
    return (
      <div style={{ maxWidth: 720, margin: '0 auto' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
          <h1 style={{ margin: 0 }}>Room</h1>
          <div style={{ display: 'flex', gap: 12 }}>
            <Link to="/">Home</Link>
            <Link to="/settings">Settings</Link>
          </div>
        </div>
        <RoomRouteNav roomId={roomId} current={routeSegment} selfIsHost={selfIsHost} />
        <HostFinishedView
          roomStore={roomStore}
          room={room}
          engine={engine}
          players={players}
          getRoleForRoom={(id) => getRoleForRoom(id as never)}
          roomId={roomId}
          createHostedRoom={createHostedRoom}
          userGameRole={userGameRole}
        />
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
      <RoomRouteNav roomId={roomId} current={routeSegment} selfIsHost={selfIsHost} />
      {room && engine ? (
        <div style={{ marginTop: 8, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button
            type="button"
            onClick={() => {
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
          <Link to="/room/$roomId/archive" params={{ roomId: room.id }}>
            View archive
          </Link>
        </div>
      ) : null}

      <div style={{ marginTop: 16, padding: 16, border: '1px solid #ddd', borderRadius: 12 }}>
        <RoomMetadata
          roomId={roomId}
          invite={invite ?? room?.inviteCode}
          wsUrl={wsUrl ?? ''}
          connected={connected}
          selfDisplayName={playerById.get(roomStore.selfPlayerId)?.displayName ?? '(unknown)'}
          selfPlayerId={roomStore.selfPlayerId}
          selfIsHost={selfIsHost}
          isObserver={isObserver}
        />

        {selfIsHost && (routeSegment === 'host' || routeSegment === 'play') ? (
          <HostControls
            roomStore={roomStore}
            room={room}
            readyCount={readyCount}
            getRoleForRoom={(id) => getRoleForRoom(id as never)}
            roomId={roomId}
            createHostedRoom={createHostedRoom}
          />
        ) : null}

        {roomStatus !== 'active' ? (
          <LobbyConfigSection room={room} roomStore={roomStore} selfIsHost={selfIsHost} />
        ) : null}

        <PlayersList
          players={players}
          hostPlayerId={hostPlayerId}
          selfPlayerId={roomStore.selfPlayerId}
          roomStatus={roomStatus}
          readyCount={readyCount}
          onToggleReady={(ready) => roomStore.setSelfReady(ready)}
          canToggleReady={
            sessionRole === 'player' && userGameRole.kind !== 'host_moderator' && !isObserver
          }
        />

        {isLive && room ? (
          <div style={{ marginTop: 16, paddingTop: 12, borderTop: '1px solid #eee' }}>
            {engine ? (
              <GameStatusBar store={roomStore} engine={engine} players={players} />
            ) : (
              <h2 style={{ margin: '0 0 8px 0', fontSize: 16 }}>{room.gameType}</h2>
            )}
            {renderPlayerUI({
              gameType: room.gameType,
              store: roomStore,
              room,
              selfPlayerId: roomStore.selfPlayerId,
              players,
              userGameRole
            }) ?? <div style={{ color: '#777' }}>No engine for game type "{room.gameType}".</div>}
            {engine ? (
              <>
                <GameOverPanel store={roomStore} engine={engine} players={players} />
                <ActivityFeed store={roomStore} engine={engine} players={players} />
              </>
            ) : null}
          </div>
        ) : null}

        {room && roomStatus === 'active' && !isObserver && canSubmitGameMoves(userGameRole) ? (
          <AutoPlayPanel
            store={roomStore}
            room={room}
            selfPlayerId={roomStore.selfPlayerId}
            players={players}
          />
        ) : null}

        <LobbyChat
          roomStore={roomStore}
          playerById={playerById}
          hostPlayerId={hostPlayerId}
          isObserver={isObserver}
        />
      </div>
    </div>
  );
}

// ─── Host game views ────────────────────────────────────────────────────────

function HostActiveView(props: {
  roomStore: RoomStore;
  room: Room;
  engine: AnyGameEngine;
  players: ReadonlyArray<Player>;
  userGameRole: UserGameRole;
}) {
  const { roomStore, room, engine, players, userGameRole } = props;
  return (
    <div style={{ marginTop: 16, display: 'flex', flexDirection: 'column', gap: 16 }}>
      <GameStatusBar store={roomStore} engine={engine} players={players} />
      <div style={{ display: 'flex', justifyContent: 'center' }}>
        {renderPlayerUI({
          gameType: room.gameType,
          store: roomStore,
          room,
          selfPlayerId: roomStore.selfPlayerId,
          players,
          userGameRole
        }) ?? <div style={{ color: '#777' }}>No UI for game type "{room.gameType}".</div>}
      </div>
      <AutoPlayPanel
        store={roomStore}
        room={room}
        selfPlayerId={roomStore.selfPlayerId}
        players={players}
      />
      <ActivityFeed store={roomStore} engine={engine} players={players} />
    </div>
  );
}

function HostFinishedView(props: {
  roomStore: RoomStore;
  room: Room;
  engine: AnyGameEngine;
  players: ReadonlyArray<Player>;
  getRoleForRoom: (roomId: string) => ReturnType<ReturnType<typeof useSync>['getRoleForRoom']>;
  roomId: string;
  createHostedRoom: ReturnType<typeof useSync>['createHostedRoom'];
  userGameRole: UserGameRole;
}) {
  const { roomStore, room, engine, players, getRoleForRoom, roomId, createHostedRoom, userGameRole } = props;
  const navigate = useNavigate();
  const [creatingNew, setCreatingNew] = useState(false);

  const snap = roomStore.getGameStatePublicOrNull();
  const parsedState = snap ? engine.stateSchema.safeParse(snap.state) : null;
  const meta = parsedState?.success
    ? engine.getActiveGameMetadata({ state: parsedState.data, players, selfPlayerId: roomStore.selfPlayerId })
    : null;
  const outcome = meta?.phase === 'finished' ? meta.outcome ?? null : null;

  const playerNames = new Map(players.map((p) => [p.id, p.displayName]));
  const winnerNames = outcome?.kind === 'won'
    ? outcome.winnerPlayerIds.map((id) => playerNames.get(id) ?? id).join(', ')
    : null;

  const onNewGame = async () => {
    if (creatingNew) return;
    setCreatingNew(true);
    try {
      const gameType = zGameType.parse(room.gameType);
      const { roomId: newRoomId, invite } = await createHostedRoom({
        defaultGameType: gameType,
        seed: generateRoomSeed(),
        ...(room.gameConfig !== undefined ? { defaultGameConfig: room.gameConfig } : {}),
        ...(room.maxPlayers !== undefined ? { maxPlayers: room.maxPlayers } : {})
      });
      void navigate({ to: '/room/$roomId/play', params: { roomId: newRoomId }, search: { invite } });
    } finally {
      setCreatingNew(false);
    }
  };

  const downloadArchive = () => {
    const archive = exportGameArchive(roomStore, engine);
    const blob = new Blob([JSON.stringify(archive, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${room.id}-${room.gameType}-archive.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const exportRecord = () => {
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
  };

  return (
    <div style={{ marginTop: 16, display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* Outcome banner */}
      <div style={{
        padding: '16px 20px',
        borderRadius: 12,
        border: '1px solid #d1fae5',
        background: '#f0fdf4',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        flexWrap: 'wrap',
        gap: 12
      }}>
        <div>
          <div style={{ fontWeight: 700, fontSize: 18 }}>
            {outcome?.kind === 'won' ? `${winnerNames} wins!` : outcome?.kind === 'draw' ? 'Draw' : 'Game over'}
          </div>
          {outcome?.summary ? (
            <div style={{ color: '#555', fontSize: 13, marginTop: 2 }}>{outcome.summary}</div>
          ) : null}
        </div>
        <button
          type="button"
          style={{ padding: '8px 16px', borderRadius: 8, fontWeight: 600 }}
          disabled={creatingNew}
          onClick={() => void onNewGame()}
        >
          {creatingNew ? 'Creating…' : '+ New Game'}
        </button>
      </div>

      {/* Final board state */}
      <div style={{ display: 'flex', justifyContent: 'center' }}>
        {renderPlayerUI({
          gameType: room.gameType,
          store: roomStore,
          room,
          selfPlayerId: roomStore.selfPlayerId,
          players,
          userGameRole
        }) ?? <div style={{ color: '#777' }}>No UI for game type "{room.gameType}".</div>}
      </div>

      {/* Archive actions */}
      <div style={{
        padding: '12px 16px',
        borderRadius: 10,
        border: '1px solid #e5e7eb',
        background: '#fafafa',
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        flexWrap: 'wrap'
      }}>
        <span style={{ color: '#555', fontSize: 13, marginRight: 4 }}>Archive:</span>
        <Link to="/room/$roomId/archive" params={{ roomId }}>
          View archive
        </Link>
        <button type="button" onClick={downloadArchive}>Download archive</button>
        <button type="button" onClick={exportRecord}>Export signed record</button>
      </div>

      <ActivityFeed store={roomStore} engine={engine} players={players} />
    </div>
  );
}

// ─── Subcomponents (lobby-side UI) ──────────────────────────────────────────

function RoomRouteNav(props: { roomId: string; current: RoomRouteSegment; selfIsHost: boolean }) {
  const { roomId, current, selfIsHost } = props;
  const styleFor = (seg: RoomRouteSegment) =>
    ({ fontWeight: current === seg ? 700 : 400, color: current === seg ? '#111' : '#2563eb' }) as const;
  return (
    <nav style={{ marginTop: 12, display: 'flex', gap: 16, flexWrap: 'wrap', fontSize: 14 }}>
      <Link to="/room/$roomId/play" params={{ roomId }} style={styleFor('play')}>
        Play
      </Link>
      {selfIsHost ? (
        <Link to="/room/$roomId/host" params={{ roomId }} style={styleFor('host')}>
          Host
        </Link>
      ) : null}
      <Link to="/room/$roomId/observe" params={{ roomId }} style={styleFor('observe')}>
        Observe
      </Link>
      <Link to="/room/$roomId/spectate" params={{ roomId }} style={styleFor('spectate')}>
        Spectate
      </Link>
      <Link to="/room/$roomId/monitor" params={{ roomId }} style={{ fontWeight: 400, color: '#2563eb' }}>
        Monitor
      </Link>
    </nav>
  );
}

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
  isObserver: boolean;
}) {
  const origin = typeof window !== 'undefined' ? window.location.origin : null;
  const inviteQs =
    props.invite !== undefined && props.invite !== ''
      ? `?invite=${encodeURIComponent(props.invite)}`
      : '';
  const playerUrl =
    origin !== null
      ? `${origin}/room/${encodeURIComponent(props.roomId)}/play${inviteQs}`
      : null;
  const observerUrl =
    origin !== null ? `${origin}/room/${encodeURIComponent(props.roomId)}/spectate` : null;
  const roleLabel = props.connected !== 'connected'
    ? '(unknown)'
    : props.selfIsHost
      ? 'host'
      : props.isObserver
        ? 'observer (anonymous)'
        : 'player';

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
        <strong>role</strong>: {roleLabel}
      </div>
      {props.selfIsHost && playerUrl && observerUrl ? (
        <>
          <div style={{ marginTop: 8, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <strong style={{ minWidth: 100 }}>player link</strong>:
            <code style={{ fontSize: 12, background: '#f5f5f5', padding: '1px 6px', borderRadius: 4 }}>
              {playerUrl}
            </code>
            <button
              type="button"
              style={{ fontSize: 12 }}
              onClick={() => void navigator.clipboard.writeText(playerUrl)}
            >
              Copy
            </button>
          </div>
          <div style={{ marginTop: 6, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <strong style={{ minWidth: 100 }}>observer link</strong>:
            <code style={{ fontSize: 12, background: '#f5f5f5', padding: '1px 6px', borderRadius: 4 }}>
              {observerUrl}
            </code>
            <button
              type="button"
              style={{ fontSize: 12 }}
              onClick={() => void navigator.clipboard.writeText(observerUrl)}
            >
              Copy
            </button>
          </div>
        </>
      ) : null}
    </div>
  );
}

function HostControls(props: {
  roomStore: RoomStore;
  room: ReturnType<RoomStore['getRoomOrNull']>;
  readyCount: number;
  getRoleForRoom: (roomId: string) => ReturnType<ReturnType<typeof useSync>['getRoleForRoom']>;
  roomId: string;
  createHostedRoom: ReturnType<typeof useSync>['createHostedRoom'];
}) {
  const { roomStore, room, readyCount, getRoleForRoom, roomId, createHostedRoom } = props;
  const navigate = useNavigate();
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
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
    setStartError(null);
    try {
      const liveRoom = roomStore.getRoom();
      const engine = getGameEngine(liveRoom.gameType);
      if (!engine) return;
      const config = engine.configSchema.safeParse(liveRoom.gameConfig);
      // Read players fresh from the store so we never act on stale React state
      // (e.g. after a reset, players are wiped and re-synced asynchronously).
      const livePlayers = roomStore.getPlayers();
      const liveReadyPlayers = livePlayers.filter((p) => p.isReady);
      if (liveReadyPlayers.length < minPlayers) {
        setStartError(`Need ${minPlayers}+ ready players (currently ${liveReadyPlayers.length}). Wait a moment and try again.`);
        return;
      }
      const engineActions = await engine.startGame({
        ctx: { store: roomStore, selfPlayerId: roomStore.selfPlayerId },
        room: liveRoom,
        readyPlayers: liveReadyPlayers,
        config: config.success ? config.data : ({} as unknown)
      });
      if (engineActions.length === 0) {
        setStartError('Engine returned no actions — game could not start.');
        return;
      }

      const matchIndex = 0;
      const actions = [
        {
          kind: 'event' as const,
          eventKind: FRAMEWORK_GAME_STARTED_KIND,
          publicPayload: {
            playerIds: liveReadyPlayers.map((p) => p.id),
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
    } catch (e) {
      setStartError(String(e));
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
          setStartError(null);
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
      {startError ? (
        <div style={{ marginTop: 8, color: '#b91c1c', fontSize: 13 }}>{startError}</div>
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
  canToggleReady?: boolean;
}) {
  const { players, hostPlayerId, selfPlayerId, roomStatus, readyCount, onToggleReady, canToggleReady = true } =
    props;
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
                {p.id === selfPlayerId && canToggleReady ? (
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
  isObserver: boolean;
}) {
  const { roomStore, playerById, hostPlayerId, isObserver } = props;
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

        {isObserver ? (
          <div style={{ color: '#888', fontSize: 12, fontStyle: 'italic' }}>
            Observers can read chat but cannot send messages.
          </div>
        ) : (
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
        )}
      </div>
    </div>
  );
}
