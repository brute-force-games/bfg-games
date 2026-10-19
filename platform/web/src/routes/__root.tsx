import { createRootRoute, Outlet } from '@tanstack/react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { SyncProvider } from '../sync/SyncContext';

export const Route = createRootRoute({
  component: Root
});

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      staleTime: Infinity
    }
  }
});

function Root() {
  return (
    <QueryClientProvider client={queryClient}>
      <SyncProvider>
        <div style={{ fontFamily: 'system-ui, sans-serif', padding: 16 }}>
          <Outlet />
        </div>
      </SyncProvider>
    </QueryClientProvider>
  );
}
