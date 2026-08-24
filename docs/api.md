# API reference

The FastAPI application is served from the URL configured as `VITE_API_BASE_URL` in the frontend. Except where noted, protected endpoints require `Authorization: Bearer <JWT>`. FastAPI also exposes its generated OpenAPI documentation when the service is running.

## Service and authentication

| Method | Endpoint | Purpose |
| --- | --- | --- |
| GET | `/health` | Returns API health and a timestamp. |
| POST | `/signup` | Creates a user and returns an authenticated session. |
| POST | `/login` | Authenticates a user and returns an authenticated session. |
| POST | `/auth/send-verification` | Sends an email-verification flow for the current user. |
| GET | `/auth/verify?token=` | Verifies an email token. |
| POST | `/auth/request-reset` | Starts password-reset handling for an email address. |
| POST | `/auth/reset` | Resets a password with a valid reset token. |
| GET | `/protected` | Small authenticated-route check. |

## Personal study collections

All collection routes are user-scoped by the bearer token.

| Method | Endpoint | Purpose |
| --- | --- | --- |
| POST | `/notes` | Create a note. |
| GET | `/notes` | List the current user's notes. |
| GET / PUT / DELETE | `/notes/{note_id}` | Retrieve, update, or delete one note. |
| POST | `/flashcards` | Create a flashcard. |
| GET | `/flashcards` | List the current user's flashcards. |
| GET / PUT / DELETE | `/flashcards/{flashcard_id}` | Retrieve, update, or delete one flashcard. |
| POST | `/summaries` | Create a summary. |
| GET | `/summaries` | List the current user's summaries. |
| GET / PUT / DELETE | `/summaries/{summary_id}` | Retrieve, update, or delete one summary. |
| POST | `/study-sessions` | Create a study session. |
| GET | `/study-sessions` | List the current user's study sessions. |
| GET / PUT / DELETE | `/study-sessions/{session_id}` | Retrieve, update, or delete one study session. |

Notes, flashcards, and summaries accept publishing fields used by public search. Their exact validation schemas are defined beside each router in `backend/app/`.

## Public discovery and analytics

| Method | Endpoint | Purpose |
| --- | --- | --- |
| GET | `/public/topics?query=` | Searches public notes, flashcards, and summaries by their content or tags. |
| GET | `/public/users?query=` | Searches users with public study materials. |
| POST | `/analytics/events` | Accepts an authenticated batch of analytics events. |

## Profile, notifications, and realtime

| Method | Endpoint | Purpose |
| --- | --- | --- |
| GET / PUT | `/me/profile` | Read or update the current user's profile fields. |
| POST / DELETE | `/me/avatar` | Upload or remove a JPEG, PNG, or WebP avatar. |
| POST / DELETE | `/me/theme-image` | Upload or remove a JPEG, PNG, or WebP custom theme image. |
| PUT | `/me/username` | Change the current username. |
| PUT | `/me/email` | Change the current email address. |
| DELETE | `/me/account` | Delete the current account and related application data. |
| GET | `/notifications` | List the current user's notifications. |
| POST | `/notifications/read` | Mark submitted notification IDs as read. |
| GET | `/users/search?query=` | Search profiles by username. |
| WS | `/ws` | Authenticated WebSocket connection, with the token supplied as a query parameter or authorization header. |

## AI, transcription, and subscription endpoints

| Method | Endpoint | Purpose |
| --- | --- | --- |
| POST | `/api/generate-notes` | Generates notes from a base64 image data URL; requires authentication and OpenAI configuration. |
| POST | `/api/transcribe` | Transcribes a multipart `audio` upload; requires authentication and Deepgram configuration. |
| POST | `/api/create-checkout-session` | Creates an authenticated Stripe Checkout subscription session. |
| POST | `/api/stripe-webhook` | Verifies Stripe's webhook signature and records supported checkout completion events. |

The AI routes enforce rate limits and use the existing free-versus-premium usage checks. Their service keys must remain server-side.

## Internal endpoints

`/internal/supabase/user-updated`, `/internal/supabase/user-updated-test`, and `/internal/debug/file` are internal support/webhook endpoints protected by the configured internal webhook secret. They are not browser-client APIs and should not be exposed for general integration use.
