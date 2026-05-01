import { createRootRoute, Outlet } from '@tanstack/react-router';

import { SyncProvider } from '../sync/SyncContext';

export const Route = createRootRoute({
  component: Root
});

function Root() {
  return (
    <SyncProvider>
      <div style={{ fontFamily: 'system-ui, sans-serif', padding: 16 }}>
        <Outlet />
      </div>
    </SyncProvider>
  );
}
