import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

function computeBase(): string {
  // GitHub Pages Project Pages deploy at "/<repo>/".
  // In GitHub Actions, GITHUB_REPOSITORY is "<owner>/<repo>".
  const repo = process.env.GITHUB_REPOSITORY?.split('/')[1];
  return repo ? `/${repo}/` : '/';
}

export default defineConfig(({ mode }) => ({
  plugins: [react()],
  base: mode === 'production' ? computeBase() : '/',
  server: {
    port: 5173
  }
}));

