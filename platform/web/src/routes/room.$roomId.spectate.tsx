import { createFileRoute } from '@tanstack/react-router';

import { zRoomId } from '@brute-force-games/shared-types';

import { RoomRoutePage } from './-roomRoutePage';

export const Route = createFileRoute('/room/$roomId/spectate')({
  component: RoomSpectateRoute
});

function RoomSpectateRoute() {
  const { roomId } = Route.useParams();
  const parsed = zRoomId.safeParse(roomId);
  if (!parsed.success) {
    return (
      <div style={{ maxWidth: 720, margin: '0 auto', padding: 16 }}>
        Invalid room id.
      </div>
    );
  }
  return <RoomRoutePage routeSegment="spectate" roomIdParam={roomId} />;
}
