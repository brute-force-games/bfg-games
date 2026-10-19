import { createFileRoute, Outlet } from '@tanstack/react-router';

export const Route = createFileRoute('/room/$roomId')({
  component: RoomLayout
});

function RoomLayout() {
  return <Outlet />;
}
