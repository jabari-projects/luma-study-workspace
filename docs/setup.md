# Local setup

## Prerequisites

- Node.js 20+ and npm
- Python 3.11+
- A Supabase project for persistent/authenticated application data
- OpenAI and Deepgram credentials only when using image-to-notes or voice transcription
- Stripe credentials only when testing the subscription checkout flow

## Frontend

From `frontend/`:

```bash
npm install
```

Create a local environment file such as `frontend/.env.local`:

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

Set the backend environment variables in your shell or deployment provider. Required values for normal authenticated/data-backed operation are:

```dotenv
SUPABASE_URL=
SUPABASE_SERVICE_ROLE_KEY=
JWT_SECRET_KEY=
API_BASE_URL=http://127.0.0.1:8000
FRONTEND_ORIGIN=http://localhost:5173
```

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
uvicorn main:app --reload --host 127.0.0.1 --port 8000
```

## Database schemas

Apply the SQL files in `backend/app/schemas/` to the Supabase project as appropriate for the features you intend to run. They cover the data structures used by notes, flashcards, summaries, transcripts, study sessions, profiles, subscriptions, analytics, notifications, AI usage, and related account flows.

## Security and deployment

Never commit actual service keys, webhook secrets, or local `.env.local` files. Keep the frontend's browser-visible values limited to public configuration, and keep Supabase service-role, OpenAI, Deepgram, Stripe, JWT, email, and webhook secrets on the backend/deployment platform. `render.yaml`, `backend/railway.json`, `frontend/vercel.json`, and `frontend/netlify.toml` remain included as deployment integration files.
