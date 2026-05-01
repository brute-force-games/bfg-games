import React from 'react';
import ReactDOM from 'react-dom/client';

import { createRouter, RouterProvider } from '@tanstack/react-router';
import { routeTree } from './routeTree.gen';

function normalizeBasepath(baseUrl: string): string {
  if (baseUrl === '/' || baseUrl === '') return '/';
  return baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
}

const router = createRouter({
  routeTree,
  basepath: normalizeBasepath(import.meta.env.BASE_URL)
});

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <RouterProvider router={router} />
  </React.StrictMode>
);
