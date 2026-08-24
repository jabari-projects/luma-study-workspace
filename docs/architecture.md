# Architecture

LUMA is split into a browser client in `frontend/` and an API service in `backend/`. This separation keeps the study interface and navigation in a React/TypeScript application while placing authentication, authorization, integrations, and data operations behind FastAPI endpoints. It also lets the client target a locally running or deployed API through `VITE_API_BASE_URL` without embedding server credentials in the browser bundle.

## Frontend

`frontend/` is a Vite application built with React 19, TypeScript, React Router, Axios, and the Supabase JavaScript package. `src/App.tsx` contains the routed UI for landing and account pages, the dashboard, note/flashcard/summary/study-session collections, public search, image-to-notes, voice input, subscription, and settings. `src/api.ts` centralizes the API base URL, bearer-token attachment, local session storage, and client-side error handling; `AuthContext.tsx` supplies authentication state to protected routes.

## Backend

`backend/` is a FastAPI application. `app/main.py` owns application setup, CORS, authentication and profile routes, the health check, file-based AI tools, Stripe checkout/webhook handling, notifications, and the authenticated WebSocket endpoint. Feature routers keep CRUD and search concerns separate in `notes.py`, `flashcards.py`, `study_sessions.py`, `summaries.py`, `transcripts.py`, `analytics.py`, and `public_search.py`.

## Data and integrations

`backend/app/supabase_client.py` creates the Supabase client, and `backend/app/schemas/` contains the SQL schemas for the app's persisted features, including notes, flashcards, summaries, transcripts, sessions, profiles, subscriptions, analytics, notifications, and AI usage. Supabase provides the application data and storage used by profile images and theme images. The backend uses OpenAI for image-to-notes generation, Deepgram for audio transcription, Stripe for subscription checkout and webhooks, and JWT bearer tokens for authenticated API access.

## Deployment boundaries

The repository includes `render.yaml` for a Render backend deployment, `backend/railway.json` for Railway, and Vercel/Netlify configuration under `frontend/`. Environment-specific URLs, CORS origins, and credentials are supplied through environment variables rather than source code.
