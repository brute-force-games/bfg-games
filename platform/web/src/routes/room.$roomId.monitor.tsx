import { createFileRoute } from '@tanstack/react-router';
import { Suspense, useMemo } from 'react';
import { useSuspenseQuery } from '@tanstack/react-query';
import { z } from 'zod';

import {
  deriveUserGameRole,
  zRoomId,
  zUserGameRoleKind,
  type UserGameRoleKind
} from '@brute-force-games/shared-types';

import type { LoadedGameHostKeypair, RoomStore } from '@brute-force-games/multiplayer-types';
import type { RoomId } from '@brute-force-games/shared-types';

import { RoleMonitorPanel } from '../games/monitor/RoleMonitorPanel';
import { useSync } from '../sync/SyncContext';

export const Route = createFileRoute('/room/$roomId/monitor')({
  validateSearch: z.object({
    role: zUserGameRoleKind.optional()
  }),
  component: RoomMonitorRoute
});

async function connectMonitorStore(
  roomStore: RoomStore,
  roomId: string,
  loadHostKeypairForRoom: (id: string) => Promise<LoadedGameHostKeypair | null>
): Promise<{ store: RoomStore; hostKeypair: LoadedGameHostKeypair | null }> {
  const hostKeypair = await loadHostKeypairForRoom(roomId);
  const wsUrl = `wss://todo.demo.tinybase.org/${encodeURIComponent(roomId)}`;
  await roomStore.connect({
    roomId: roomId as never,
    wsUrl,
    ...(hostKeypair ? { hostClaim: { hostKeypair }, hostParticipatesAsPlayer: false } : {})
  });
  return { store: roomStore, hostKeypair };
}

function MonitorConnected(props: {
  roomStore: RoomStore;
  hostKeypair: LoadedGameHostKeypair | null;
  roomId: string;
}) {
  const { identity } = useSync();
  const search = Route.useSearch();
  const navigate = Route.useNavigate();

  const defaultSimulatedRole = useMemo((): UserGameRoleKind => {
    const room = props.roomStore.getRoom();
    const derived = deriveUserGameRole({
      route: 'play',
      sessionRole: props.roomStore.getSelfRoomRole(),
      hasHostClaim: props.hostKeypair !== null,
      hostParticipatesAsPlayer: false,
      selfPlayerId: identity.playerId,
      roomHostPlayerId: room.hostPlayerId
    });
    return derived.kind;
  }, [props.roomStore, props.hostKeypair, identity.playerId]);

  const simulatedRole = search.role ?? defaultSimulatedRole;

  const onSimulatedRoleChange = (r: UserGameRoleKind) => {
    void navigate({ search: { role: r }, replace: true });
  };

  return (
    <RoleMonitorPanel
      roomStore={props.roomStore}
      identity={identity}
      hostKeypair={props.hostKeypair}
      simulatedRole={simulatedRole}
      onSimulatedRoleChange={onSimulatedRoleChange}
      roomId={props.roomId}
    />
  );
}

function MonitorLoader(props: { roomId: string }) {
  const { getRoomStore, loadHostKeypairForRoom } = useSync();
  const roomStore = useMemo(() => getRoomStore(props.roomId as never), [getRoomStore, props.roomId]);

  const { data } = useSuspenseQuery({
    queryKey: ['room', props.roomId, 'monitor-connect'],
    queryFn: () =>
      connectMonitorStore(roomStore, props.roomId, (id) =>
        loadHostKeypairForRoom(id as RoomId)
      )
  });

  return <MonitorConnected roomStore={data.store} hostKeypair={data.hostKeypair} roomId={props.roomId} />;
}

function RoomMonitorRoute() {
  const { roomId: roomIdParam } = Route.useParams();
  const parsedRoomId = zRoomId.safeParse(roomIdParam);

  if (!parsedRoomId.success) {
    return (
      <div style={{ maxWidth: 800, margin: '0 auto', padding: 16 }}>
        <h1 style={{ marginTop: 0 }}>Monitor</h1>
        <p style={{ color: '#b91c1c' }}>Invalid room ID.</p>
      </div>
    );
  }

  const roomId = parsedRoomId.data;

  return (
    <div style={{ maxWidth: 960, margin: '0 auto', padding: 16 }}>
      <h1 style={{ marginTop: 0, fontSize: 22 }}>Role monitor</h1>
      <p style={{ fontSize: 13, color: '#555', marginBottom: 16 }}>
        Read-only debug view. Simulated roles withhold keys at render time. Your client still connects as a real participant
        (see session notes in-panel).
      </p>
      <Suspense fallback={<p style={{ color: '#888' }}>Connecting…</p>}>
        <MonitorLoader roomId={roomId} />
      </Suspense>
    </div>
  );
}
