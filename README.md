# LUMA

LUMA brings notes, flashcards, summaries, and study sessions into one workspace. You can keep your study materials private or publish them for others to use.

The app uses React and TypeScript for the frontend and FastAPI for the backend. It also includes AI-assisted study tools. Development is ongoing, including work on the AI Tutor.

## Project layout

- `frontend/` contains the React interface and Vite configuration.
- `backend/` contains the FastAPI service and Supabase database schemas.
- `docs/` covers setup, features, the API, and remaining work.

## Run locally

You'll need Node.js 22.12 or later, Python 3.11 or later, and a Supabase project for accounts and saved study materials.

Install the frontend dependencies and create your local configuration:

```powershell
cd frontend
npm ci
Copy-Item .env.example .env.local
```

The example points to a local API on port 8000. In a separate terminal, set up the backend:

```powershell
cd backend
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
Copy-Item .env.example .env
```

Fill in the backend `.env` with your Supabase settings and a private JWT signing secret. Then start the API:

```powershell
.\.venv\Scripts\python.exe -m uvicorn main:app --env-file .env --reload --host 127.0.0.1 --port 8000
```

From `frontend/`, start the interface with `npm run dev`. See [local setup](docs/setup.md) for database schemas, optional integrations, and deployment settings. Keep existing local environment files if you've already configured the app; the copy commands above are for a fresh checkout.

## Development checks

Run these from `frontend/`:

```powershell
npm run lint
npm run build
```

## Current status

The app includes notes, flashcards, summaries, study sessions, public study materials, image-to-notes, and audio transcription. AI tools need the relevant provider credentials. Subscriptions need Stripe configuration. The AI Tutor screen is still in progress and does not yet have a connected tutoring endpoint.

## More documentation

- [Features](docs/features.md)
- [Architecture](docs/architecture.md)
- [API reference](docs/api.md)
- [Setup](docs/setup.md)
- [Roadmap](docs/roadmap.md)
