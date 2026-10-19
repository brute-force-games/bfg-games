import { createFileRoute } from '@tanstack/react-router';
import { z } from 'zod';

import { zRoomId } from '@brute-force-games/shared-types';

import { RoomRoutePage } from './-roomRoutePage';

export const Route = createFileRoute('/room/$roomId/play')({
  validateSearch: z.object({
    invite: z.string().optional()
  }),
  component: RoomPlayRoute
});

function RoomPlayRoute() {
  const { roomId } = Route.useParams();
  const search = Route.useSearch();
  const parsed = zRoomId.safeParse(roomId);
  if (!parsed.success) {
    return (
      <div style={{ maxWidth: 720, margin: '0 auto', padding: 16 }}>
        Invalid room id.
      </div>
    );
  }
  return (
    <RoomRoutePage
      routeSegment="play"
      roomIdParam={roomId}
      {...(search.invite !== undefined ? { invite: search.invite } : {})}
    />
  );
}
