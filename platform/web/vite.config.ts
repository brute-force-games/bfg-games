import { execSync } from 'child_process';
import react from '@vitejs/plugin-react';
import { TanStackRouterVite } from '@tanstack/router-plugin/vite';
import { defineConfig } from 'vite';

function computeBase(): string {
  const repo = process.env.GITHUB_REPOSITORY?.split('/')[1];
  return repo ? `/${repo}/` : '/';
}

function getGitSha(): string {
  try {
    return execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim();
  } catch {
    return 'unknown';
  }
}

export default defineConfig(({ mode }) => ({
  plugins: [
    TanStackRouterVite({ routesDirectory: './src/routes', generatedRouteTree: './src/routeTree.gen.ts' }),
    react()
  ],
  base: mode === 'production' ? computeBase() : '/',
  server: {
    port: 5173
  },
  define: {
    __APP_GIT_SHA__: JSON.stringify(getGitSha()),
    __APP_BUILD_TIME__: JSON.stringify(new Date().toISOString())
  }
}));

