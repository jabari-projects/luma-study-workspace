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

The TypeScript environment declarations also reserve `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY`. Set them only if the client code/configuration you are running requires them; the current API client itself requires `VITE_API_BASE_URL`.

Start the client:

```bash
npm run dev
```

## Backend

From `backend/`, create and activate a virtual environment, then install dependencies:

```bash
python -m venv .venv
# PowerShell
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
```

For a fresh checkout, copy `backend/.env.example` to `backend/.env` and fill in your values. You can also set the variables directly in your shell or deployment provider. Required values for normal authenticated/data-backed operation are:

```dotenv
SUPABASE_URL=
SUPABASE_SERVICE_ROLE_KEY=
JWT_SECRET_KEY=
API_BASE_URL=http://127.0.0.1:8000
FRONTEND_ORIGIN=http://localhost:5173
```

Use a private, randomly generated `JWT_SECRET_KEY` that stays the same between server restarts. For example, generate one locally with `python -c "import secrets; print(secrets.token_urlsafe(48))"` and put the result in the backend environment only. Do not rely on the development fallback for a deployed app.

Optionally set `FEEDBACK_VOTER_KEY_SECRET` (made the same way) for the monthly feedback poll's one-vote-per-email check. Without it the poll uses `JWT_SECRET_KEY`. Change it only between polls: a new value while a poll is open lets someone who deleted their account and signed up again with the same email vote a second time in that poll.

`SUPABASE_KEY` is accepted as an alternative to `SUPABASE_SERVICE_ROLE_KEY`. `FRONTEND_ORIGINS` accepts a comma-separated list or JSON array of allowed origins; `PUBLIC_APP_URL` is also recognized for the frontend origin. `APP_ENV` (or `ENV`) and `LOG_LEVEL` are optional deployment settings.

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

# Internal Supabase webhook endpoints
WEBHOOK_SECRET=

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

Apply the SQL files in `backend/app/schemas/` to the Supabase project as appropriate for the features you intend to run. They cover the data structures used by notes, flashcards, summaries, transcripts, study sessions, profiles, subscriptions, analytics, notifications, AI usage, and related account flows.

## Security and deployment

Never commit actual service keys, webhook secrets, or populated environment files. The checked-in `.env.example` files contain placeholders only. All `VITE_*` values are included in the public browser bundle, so keep Supabase service-role, OpenAI, Deepgram, Stripe, JWT, email, and webhook secrets on the backend/deployment platform.

For a deployed backend, set `APP_ENV=production`, a stable private `JWT_SECRET_KEY`, the public `API_BASE_URL`, and your frontend origin settings explicitly. `render.yaml`, `backend/railway.json`, `frontend/vercel.json`, and `frontend/netlify.toml` are included as deployment integration files. Changing these repository files does not configure credentials in a hosting account.
