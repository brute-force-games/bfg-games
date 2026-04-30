import { Outlet, RootRoute, Route, Router } from '@tanstack/react-router';
import { z } from 'zod';

import { IndexRoute } from './routes/index';
import { RoomPlayRoute } from './routes/room.$roomId.play';
import { SettingsRoute } from './routes/settings';

function normalizeBasepath(baseUrl: string): string {
  // Vite's BASE_URL is typically "/" or "/repoName/" (note trailing slash).
  // TanStack Router expects a basepath without a trailing slash (except root).
  if (baseUrl === '/' || baseUrl === '') return '/';
  return baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
}

function Root() {
  return (
    <div style={{ fontFamily: 'system-ui, sans-serif', padding: 16 }}>
      <Outlet />
    </div>
  );
}

const rootRoute = new RootRoute({ component: Root });

const indexRoute = new Route({
  getParentRoute: () => rootRoute,
  path: '/',
  component: IndexRoute
});

const roomPlayRoute = new Route({
  getParentRoute: () => rootRoute,
  path: '/room/$roomId/play',
  validateSearch: z.object({ invite: z.string().optional() }),
  component: RoomPlayRoute
});

const settingsRoute = new Route({
  getParentRoute: () => rootRoute,
  path: '/settings',
  component: SettingsRoute
});

const routeTree = rootRoute.addChildren([indexRoute, roomPlayRoute, settingsRoute]);

export const router = new Router({
  routeTree,
  basepath: normalizeBasepath(import.meta.env.BASE_URL)
});

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}

