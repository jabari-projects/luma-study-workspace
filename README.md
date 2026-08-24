# LUMA

LUMA is a full-stack study workspace for keeping notes, flashcards, summaries, study sessions, and published study materials in one place. The React client provides the study experience, while the FastAPI service handles authentication, data access, AI-assisted tools, subscriptions, and integrations with Supabase, OpenAI, Deepgram, and Stripe.

## Repository layout

- `frontend/` — React, TypeScript, and Vite application.
- `backend/` — FastAPI application, Supabase client, database schemas, and deployment configuration.
- `docs/` — architecture, feature, API, setup, and roadmap documentation.

## Installation

1. Install Node.js 20+ and Python 3.11+.
2. Install the frontend packages:

   ```bash
   cd frontend
   npm install
   ```

3. Create and activate a Python virtual environment, then install the backend packages:

   ```bash
   cd ../backend
   python -m venv .venv
   # PowerShell
   .\.venv\Scripts\Activate.ps1
   pip install -r requirements.txt
   ```

4. Configure the environment variables described in [docs/setup.md](docs/setup.md). Do not commit local environment files or service credentials.

## Run locally

Start the API from `backend/`:

```bash
uvicorn main:app --reload --host 127.0.0.1 --port 8000
```

In a second terminal, start the client from `frontend/`:

```bash
npm run dev
```

The Vite client expects `VITE_API_BASE_URL` to point to the running FastAPI server, such as `http://127.0.0.1:8000`.

## Environment variables

The frontend requires `VITE_API_BASE_URL`. The backend uses Supabase and JWT settings for core authenticated data flows; OpenAI, Deepgram, Stripe, and email settings enable their corresponding implemented integrations. See [docs/setup.md](docs/setup.md) for the complete variable list and when each is needed.

## Future Plans

The active direction is to harden and complete the study workflows already present: personal and public study materials, AI-assisted image and audio processing, account and subscription management, and the in-progress AI Tutor interface. See [docs/roadmap.md](docs/roadmap.md) for a scoped roadmap based on the current codebase.

## Documentation

- [Architecture](docs/architecture.md)
- [Features](docs/features.md)
- [API reference](docs/api.md)
- [Local setup](docs/setup.md)
- [Roadmap](docs/roadmap.md)
