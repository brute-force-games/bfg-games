## GitHub Pages deployment (static SPA)

This repo’s web client is a Vite SPA in `platform/web`. This document describes deploying it as a **static GitHub Pages site** (Project Pages) with **deep-link support** (so URLs like `/room/<id>/play` work on refresh).

### What you get
- **URL**: `https://<owner>.github.io/<repo>/`
- **SPA routing works**: direct loads/refreshes on nested routes load the app (via a Pages `404.html` fallback redirect)
- **No server required**: the site is static HTML/CSS/JS

---

## One-time GitHub repo setup

### 1) Enable GitHub Pages from Actions
In GitHub:
- Go to **Settings → Pages**
- Under **Build and deployment**, set **Source** to **GitHub Actions**

### 2) Ensure your default branch matches the workflow
The workflow in `.github/workflows/pages.yml` deploys on pushes to `main`.

If your default branch is not `main`, either:
- rename the branch to `main`, or
- update the workflow trigger in `.github/workflows/pages.yml`.

---

## How deployment works

On each push to `main`, GitHub Actions will:
- `npm ci` at the repo root (installs workspace deps)
- run `npm -w @brute-force-games/web run build`
- upload `platform/web/dist` as the Pages artifact
- deploy it to GitHub Pages

The deployment workflow is in `.github/workflows/pages.yml`.

---

## Important implementation details (why this works on Pages)

### Base path (Project Pages)
Project Pages hosts your site under `/<repo>/`, not `/`.

This repo configures that automatically:
- Vite sets `base` in production to `/${repoName}/` using `process.env.GITHUB_REPOSITORY`
  - file: `platform/web/vite.config.ts`
- TanStack Router uses the same base via `import.meta.env.BASE_URL`
  - file: `platform/web/src/router.tsx`

### SPA deep-link routing (refreshing nested routes)
GitHub Pages doesn’t support server-side rewrites like “serve `index.html` for all routes”.

Instead, we use a static fallback:
- `platform/web/public/404.html` catches deep links and redirects to `/<repo>/?p=/original/path&q=originalQuery`
- `platform/web/index.html` runs a tiny script that restores the original path/query with `history.replaceState`

This is the standard GitHub Pages SPA pattern.

---

## Local testing

### Build
From repo root:

```bash
npm -w @brute-force-games/web run build
```

### Preview the production build

```bash
npm -w @brute-force-games/web exec -- vite preview
```

Notes:
- `vite preview` will serve at a local URL (typically `http://localhost:4173/`).
- The Pages base path in this repo is applied for `mode === "production"`; when previewing locally you’ll still be able to validate that assets are loaded correctly, and you can sanity-check the deep-link behavior by visiting a nested route and hard-refreshing.

---

## Troubleshooting

### I only see a GitHub 404 when I refresh `/room/.../play`
- Confirm `platform/web/public/404.html` exists in the deployed artifact (it should be in `dist/404.html` after build).
- Confirm `index.html` contains the “restore deep-link” script in `<head>`.

### Assets 404 (JS/CSS not loading)
This almost always means the base path is wrong.
- Confirm your Pages URL is `https://<owner>.github.io/<repo>/` (Project Pages).
- Confirm the workflow is building in GitHub Actions (so `GITHUB_REPOSITORY` is set).

### My default branch isn’t `main`
Update the workflow trigger in `.github/workflows/pages.yml` under:

```yaml
on:
  push:
    branches:
      - main
```

---

## Changing the repo name
If you rename the repo, GitHub Pages’ base path changes (because it’s `/<repo>/`).

The Vite config uses `GITHUB_REPOSITORY` at build time, so **future deploys will automatically pick up the new repo name** after the rename.