# API reference

The FastAPI application is served from the URL configured as `VITE_API_BASE_URL` in the frontend. Except where noted, protected endpoints require `Authorization: Bearer <JWT>`. FastAPI also exposes its generated OpenAPI documentation when the service is running.

## Service and authentication

| Method | Endpoint | Purpose |
| --- | --- | --- |
| GET | `/health` | **Liveness only:** the server process is running. It does **not** check the database, so a 200 here is not proof that accounts, notes or search work. |
| GET | `/health/ready` | **Database readiness:** runs a tiny read-only query (no rows) with a 5-second limit. Returns 200 `{status: "ready"}` only if the database answers; otherwise 503 with `database` set to `not_configured`, `unreachable` or `timeout`. No error details are returned. |
| POST | `/signup` | Starts a signup and returns **202** `{"status":"check_email","email","ticket","resend_after_seconds":60,"code_expires_in_seconds":600}`. **No account is created yet**: the username and the argon2id password hash wait in a pending row until the emailed code is entered. `ticket` is random, kept only by the browser (session storage), and is needed with the code. The answer and its timing (padded to 0.8 s) are the same whether or not the email has an account. An existing owner gets a short "someone tried to sign up" notice (at most 1 per hour). For an existing email a decoy pending row is saved that can never succeed and whose code is never sent, so wrong tries lock and expire the same way and code checks reveal nothing either. Errors: 400 `password_invalid` (8–128 characters), 400 `username_taken` (checked against real accounts only, the same for any email), 429 `rate_limited` (10 signups per IP per hour). |
| POST | `/auth/verify-email` | Pending signup: body `{email, ticket, code}`; creates the account (verified) and returns a session. Logged-in account (Bearer token, no ticket): body `{code}`; marks the current address verified. Codes are bound to the address they were sent to, so a code can't verify a different email after a change. Errors (400): `code_incorrect` (also for unknown emails, wrong tickets, or no ticket and no login), `code_expired` (after 10 minutes), `code_locked` (after 5 wrong tries on one code), `account_exists` (someone with the inbox finished another signup first), `username_taken`. 429 `rate_limited`: 30 tries per IP and 10 per email or account per 10 minutes. Pasted codes with spaces or dashes work. |
| POST | `/auth/resend-code` | Body `{email, ticket}`. Always **202** `{"status":"sent_if_possible","resend_after_seconds":60}`. Sends a new code only for this browser's pending signup, within the limits: 60 s between codes, 5 per hour and 10 per day per signup, 20 per hour and 50 per day per inbox across all signups (looser, so strangers can't easily use up the owner's allowance), 20 requests per IP per hour. **A new code retires older unused codes for that signup.** |
| POST | `/login` | Returns a session with `user.email_verified`. Older unverified accounts can log in (the email is matched without regard to capital letters), but AI tools answer 403 `email_unverified` until they enter a code; the code page sends one automatically. Older plaintext passwords are upgraded to a hash on the next successful login. Failure: 401 "That email or password is wrong." After 10 failed tries for the same email and IP in 15 minutes, it returns 429. |
| POST | `/auth/send-verification` | Logged in: sends a new code. 429 `resend_cooldown` (with `retry_after`) inside the 60 s cooldown, 429 `rate_limited` at the hourly/daily cap, 503 `email_send_failed` when the email provider refuses. |
| GET | `/auth/verify?token=` | Old email links sent before codes existed. Still works until those links expire. |
| POST | `/auth/request-reset` | Emails a reset link to `{frontend}/reset-password?token=…`. It always returns the same message and takes about the same time, whether or not the account exists. Requests are rate-limited. Only a SHA-256 digest of the token is stored, and tokens are never logged. Links work for 30 minutes; a newer link replaces the older one. |
| POST | `/auth/reset` | Resets a password with a valid reset token (8–128 characters). The token is used up in the same conditional update that sets the password, so a link works once even with parallel requests; replays get 400 `reset_invalid`. Older sessions stop working: their next request gets 401 "Session expired. Please log in again." Using the emailed link also marks the email verified. |

Error bodies for the account routes: `{"detail": "<friendly message>", "error_code": "<code>"}` plus `retry_after` (seconds) on 429.

**Codes:** 6 digits, stored only as an HMAC-SHA256 digest keyed with the server secret and bound to the user and purpose. Never logged.

**Free AI allowance:** AI routes need a verified email (403 `email_unverified`). The daily free count is kept per user *and* per normalized email (lowercase, `+tag` removed, Gmail dots removed) under a keyed hash, so deleting and re-creating an account doesn't reset it. Free users run one AI request at a time per email on a server (429 "One AI task at a time"). This lock is per process: Render runs one `uvicorn` process today; with more workers or instances the reservation would have to move into the database. This doesn't stop one person from using many different email addresses.
| GET | `/protected` | Small authenticated-route check. |

## Personal study collections

All collection routes are user-scoped by the bearer token.

| Method | Endpoint | Purpose |
| --- | --- | --- |
| POST | `/notes` | Create a note. |
| GET | `/notes` | List the current user's notes. |
| GET / PUT / DELETE | `/notes/{note_id}` | Retrieve, update, or delete one note. |
| POST | `/flashcards` | Create a flashcard deck. Send `title`, `tags`, and `cards` (a list of `{id, front, back, review}`); a single `front`/`back` pair still works and becomes a one-card deck. |
| GET | `/flashcards` | List the current user's decks, each with its `cards`. |
| GET / PUT / DELETE | `/flashcards/{flashcard_id}` | Retrieve, update, or delete one deck. `PUT` with `cards` saves edits and review progress (each card's `review` holds its spaced-repetition schedule). |
| POST | `/summaries` | Create a summary. |
| GET | `/summaries` | List the current user's summaries. |
| GET / PUT / DELETE | `/summaries/{summary_id}` | Retrieve, update, or delete one summary. |
| POST | `/study-sessions` | Create a study session. |
| GET | `/study-sessions` | List the current user's study sessions. |
| GET / PUT / DELETE | `/study-sessions/{session_id}` | Retrieve, update, or delete one study session. |

Notes, flashcards, and summaries accept publishing fields used by public search. Their exact validation schemas are defined beside each router in `backend/app/`.

## Shared study sets and analytics

Shared study sets are for signed-in students only. Both search routes need a bearer token (401 without one). Results show the owner's username and nothing else about them: no user id, display name, photo or counts. Every API response carries `X-Robots-Tag: noindex, nofollow`, and `GET /robots.txt` disallows everything.

| Method | Endpoint | Purpose |
| --- | --- | --- |
| GET | `/public/topics?query=` | Signed in. Searches shared notes, flashcards, and summaries by their title, content or tags (never by a stored or old name), newest first, up to 80. Each item: `id, study_type, title, preview, tags, username, published_at, created_at`. `preview` is plain text with Markdown marks removed. `username` is the owner's current username, or `student` if it is unknown. |
| GET | `/public/users?query=` | Signed in. Finds students who shared something, by username only (3+ letters; shorter queries return `[]`). Each result: `username, items`. Looks the username up first, so a student who shared long ago is still found. Usernames are letters, numbers and `_`, so any other character returns `[]`. Up to 40 people, each with their newest 24 items. Closest name first, then A to Z. |
| GET | `/robots.txt` | `Disallow: /` for every crawler. |
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
| WS | `/ws` | Authenticated WebSocket connection, with the token supplied as a query parameter or authorization header. |

## AI, transcription, and subscription endpoints

| Method | Endpoint | Purpose |
| --- | --- | --- |
| POST | `/api/generate-notes` | Generates notes from a base64 image data URL; requires authentication and OpenAI configuration. |
| POST | `/api/transcribe` | Transcribes a multipart `audio` upload (WAV, MP3, M4A/MP4, WEBM, OGG; up to 25 MB) and returns `{transcript}`. Uses OpenAI speech-to-text (`OPENAI_TRANSCRIBE_MODEL`, default `gpt-4o-mini-transcribe`) when `OPENAI_API_KEY` is set, otherwise Deepgram. **The audio is sent to that provider**; Luma doesn't store it. The 25 MB cap is enforced on the bytes actually received, not only the `Content-Length` header (413). Other errors: 400 (empty or unsupported audio), 401, 403 (free daily limit), 429 (too many requests), 503 (no provider configured). Requires authentication. |
| POST | `/api/notes-from-text` | Turns text (a transcript, pasted words, an extracted file or web page) into study notes. Body: `{text, source_kind: audio\|paste\|file\|link\|youtube, source_label?}`. Returns `{title, summary, notes, key_terms, flashcards: [{front, back}], truncated}`. Text over 60,000 characters is cut and `truncated` is true. Counts toward the free daily notes limit. Requires authentication and OpenAI. |
| POST | `/api/import/link` | Reads the main text of a public web page. Body: `{url}`. Returns `{title, text, site_name, url, truncated}`. Private, local and cloud-metadata addresses are refused, redirects are re-checked, and pages over 3 MB are dropped (each connection times out after 10 seconds, with a 20-second deadline for the whole fetch). YouTube links return 422 with `code: "youtube"` (students paste the transcript instead, because YouTube blocks cloud servers). Errors use `{error, code}` with codes `blocked`, `fetch`, `pdf`, `type`, `too_short`. Requires authentication; does not use AI. |
| POST | `/api/create-checkout-session` | Creates an authenticated Stripe Checkout subscription session, reusing the account's linked Stripe customer when there is one. Answers 409 for a Premium account with no billing link (a legacy subscription): a new checkout would hide the unlinked subscription from status refresh and account deletion, so the account must be linked by hand first. |
| POST | `/api/stripe-webhook` | Verifies Stripe's webhook signature. `checkout.session.completed` is re-read from Stripe and links the customer/subscription ids to the account in `billing_accounts` / `billing_subscriptions` (refused if the owner fields disagree or the customer belongs to another account). `customer.subscription.*` events apply only to already-linked subscriptions; ownership is never guessed from email. Answers 500 on database or Stripe errors so Stripe retries. |

The AI routes enforce rate limits and the free daily limit. The daily limit **fails closed**: if usage can't be counted (for example, the database is down), free users are told they've reached the limit instead of getting unlimited AI. Every OpenAI and Deepgram call has a true total deadline (100 seconds for notes and images, 150 for transcription; see `backend/app/deadline.py`), below the browser's wait (120 and 180 seconds). Calls aren't retried automatically, and a call that misses its deadline answers 503 without using a free turn. OpenAI Responses calls send `store=false`, and Deepgram calls send `mip_opt_out=true`. Text sent to `/api/notes-from-text` goes to OpenAI, plus the page's title or link for web and YouTube imports. Students' own file names are not sent: audio goes as `recording.<ext>`, and uploaded documents are labeled "Uploaded file". `/api/transcribe` also returns 403 when a free student has no notes turns left, so a talk-to-text turn isn't wasted. Service keys must stay server-side. `TRUSTED_PROXY_HOPS` tells the server how many proxy hops to skip in `X-Forwarded-For`. Leave it at `0` (ignore the header; per-email limits still work) until it's checked on the real host. On Render, Cloudflare sits in front of Render's proxy, so `1` would probably pick a Cloudflare address, not the visitor's. Check it on staging before changing it.

## Internal endpoints

`/internal/supabase/user-updated`, `/internal/supabase/user-updated-test`, and `/internal/debug/file` are internal support/webhook endpoints protected by the configured internal webhook secret. They are not browser-client APIs and should not be exposed for general integration use.
