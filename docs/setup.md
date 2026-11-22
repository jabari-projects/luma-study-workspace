# Local setup

## Prerequisites

- Node.js 22.12+ and npm
- Python 3.11+
- A Supabase project for persistent/authenticated application data
- OpenAI and Deepgram credentials only when using image-to-notes or voice transcription
- Stripe credentials only when testing the subscription checkout flow

## Frontend

From `frontend/`:

```bash
npm ci
```

For a fresh checkout, copy `frontend/.env.example` to `frontend/.env.local`. Keep existing local configuration if you already have it. The API setting is:

```dotenv
VITE_API_BASE_URL=http://127.0.0.1:8000
```

`VITE_API_BASE_URL` is the only setting the website needs. The browser never talks to Supabase directly. The `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` names still in `src/vite-env.d.ts` and `.env.example` are unused leftovers; leave them unset.

Start the client:

```bash
npm run dev
```

## Without a database (fake API)

For most work you do not need Supabase. `npm run mock-api` in `frontend/` starts an in-memory fake API on port 8787 with seeded test accounts; set `VITE_API_BASE_URL=http://127.0.0.1:8787` before `npm run dev`. Tests: `npm test`, `npm run e2e` (frontend) and `python -m pytest -q` (backend, after `pip install pytest==9.2.0` in the backend venv; see below). See `CLAUDE.md` for the full list.

## Backend

From `backend/`, create and activate a virtual environment, then install dependencies:

```bash
python -m venv .venv
# PowerShell
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
# Test tools are not in requirements.txt; add pytest to run the backend tests
pip install pytest==9.2.0
```

For a fresh checkout, copy `backend/.env.example` to `backend/.env` and fill in your values. You can also set the variables directly in your shell or deployment provider. Required values for normal authenticated/data-backed operation are:

```dotenv
SUPABASE_URL=
SUPABASE_SERVICE_ROLE_KEY=
JWT_SECRET_KEY=
FRONTEND_ORIGIN=http://localhost:5173
```

Use a private, randomly generated `JWT_SECRET_KEY` that stays the same between server restarts. For example, generate one locally with `python -c "import secrets; print(secrets.token_urlsafe(48))"` and put the result in the backend environment only. The server will not start without `JWT_SECRET_KEY`, or with one shorter than 32 characters.

`SUPABASE_KEY` is accepted as an alternative to `SUPABASE_SERVICE_ROLE_KEY`. `FRONTEND_ORIGINS` accepts a comma-separated list or JSON array of allowed origins; `PUBLIC_APP_URL` is also recognized for the frontend origin. `APP_ENV` and `LOG_LEVEL` are optional deployment settings.

Configure only the integrations you plan to use:

```dotenv
# Image-to-notes
OPENAI_API_KEY=
OPENAI_ENDPOINT=
OPENAI_VISION_MODEL=

# Voice transcription
DEEPGRAM_API_KEY=

# Stripe subscription checkout and webhooks
STRIPE_SECRET_KEY=
STRIPE_WEBHOOK_SECRET=
STRIPE_PRICE_ID=

# Email-related flows when configured
RESEND_API_KEY=
EMAIL_FROM=

# AI usage tuning (optional)
FREE_AI_DAILY_LIMIT=
AI_RATE_LIMIT_WINDOW_SECONDS=
```

Run the API:

```bash
uvicorn main:app --env-file .env --reload --host 127.0.0.1 --port 8000
```

`app/config.py` reads the process environment; it does not load `.env` files itself. The `--env-file .env` option explicitly loads your local file through Uvicorn. Omit that option when your shell or deployment platform already supplies the environment.

## Database schemas

Apply the SQL files in `backend/app/schemas/` to the Supabase project as appropriate for the features you intend to run. Changes after the first schemas are dated, add-only files in `backend/app/schemas/migrations/`; apply them in date order. They cover the data structures used by notes, flashcards, summaries, transcripts, study sessions, profiles, subscriptions, analytics, notifications, AI usage, and related account flows.

## Security and deployment

Never commit actual service keys, webhook secrets, or populated environment files. The checked-in `.env.example` files contain placeholders only. All `VITE_*` values are included in the public browser bundle, so keep Supabase service-role, OpenAI, Deepgram, Stripe, JWT, email, and webhook secrets on the backend/deployment platform.

For a deployed backend, set `APP_ENV=production`, a stable private `JWT_SECRET_KEY` (at least 32 characters), and your frontend origin settings explicitly. Production uses `frontend/vercel.json` (Vercel) and `render.yaml` (Render). `backend/railway.json` and `frontend/netlify.toml` are leftovers for hosts that are not used. Changing these repository files does not configure credentials in a hosting account.
