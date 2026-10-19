import { createFileRoute, Navigate } from '@tanstack/react-router';

import { zRoomId } from '@brute-force-games/shared-types';

import { useSync } from '../sync/SyncContext';
import { RoomRoutePage } from './-roomRoutePage';

export const Route = createFileRoute('/room/$roomId/host')({
  component: RoomHostRoute
});

function RoomHostRoute() {
  const { roomId } = Route.useParams();
  const { identity, getRoleForRoom } = useSync();
  const parsed = zRoomId.safeParse(roomId);
  const role = parsed.success ? getRoleForRoom(parsed.data) : null;
  const selfIsHost = role?.kind === 'host' && role.hostPlayerId === identity.playerId;
  if (!parsed.success) {
    return <div style={{ padding: 16 }}>Invalid room id.</div>;
  }
  if (!selfIsHost) {
    return <Navigate to="/room/$roomId/play" params={{ roomId }} replace />;
  }
  return <RoomRoutePage routeSegment="host" roomIdParam={roomId} />;
}
