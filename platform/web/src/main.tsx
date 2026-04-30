import React from 'react';
import ReactDOM from 'react-dom/client';

import { RouterProvider } from '@tanstack/react-router';
import { router } from './router';
import { SyncProvider } from './sync/SyncContext';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <SyncProvider>
      <RouterProvider router={router} />
    </SyncProvider>
  </React.StrictMode>
);

