# LUMA frontend

This is LUMA's React and TypeScript interface. It uses Vite for development and builds, React Router for navigation, and Axios for backend requests.

## Local development

Use Node.js 22.12 or later. From this directory:

```powershell
npm ci
Copy-Item .env.example .env.local
npm run dev
```

For a fresh checkout, the example configuration points to `http://127.0.0.1:8000`. If you already have a local environment file, keep it and update only the values you intend to change. Backend requests use `VITE_API_BASE_URL`; see [the full setup guide](../docs/setup.md) to start the API and configure Supabase.

All `VITE_*` values are visible to anyone using the site. Never put service-role keys, JWT signing secrets, or private AI/payment credentials in this directory's environment files.

## Checks and builds

```powershell
npm run lint
npm run build
npm run preview
```

`npm run build` checks TypeScript and writes the production build to `dist/`. The preview command serves that build locally; it does not start the backend.

The AI Tutor is not built yet. Its route only sends you to the dashboard.

For tests, also run `npm test` (unit tests) and `npm run e2e` (Playwright, uses the fake API in `dev/mock-api.mjs`).
