# Features

## Study workspace

- **Notes** — Create, read, update, delete, tag, and optionally publish personal notes.
- **Flashcards** — Store question-and-answer flashcards with tags and optional public publishing.
- **Summaries** — Save concise lesson summaries with tags and optional public publishing.
- **Study sessions** — Create and manage named study plans with a subject, notes, and a duration in seconds.

## Discovery and account experience

- **Public search** — Search public notes, flashcards, and summaries by topic or browse users who have published material.
- **Authentication and account management** — Sign up, log in, verify email, request and reset passwords, update profile information, and delete an account.
- **Profiles and themes** — Manage display details, color/theme preferences, avatar images, and custom theme images.
- **Notifications and live connection** — Retrieve and mark notifications as read; an authenticated WebSocket endpoint is available for server-to-user messages.

## Study tools and integrations

- **Image to Notes** — Upload a PNG, JPEG, or WebP image and use the implemented OpenAI integration to generate notes.
- **Voice Input** — Upload an audio file and use the Deepgram integration to return a transcript.
- **Subscription flow** — Start a Stripe Checkout subscription session; the Stripe webhook updates the user's subscription status after checkout.
- **AI Tutor interface** — Provides the current chat and file-selection UI. The UI explicitly indicates that its interactive tutoring behavior is still in progress, so it is not documented as a completed AI chat feature.

## Operational support

- **Health and connection state** — The frontend checks the backend health endpoint and shows whether the service is reachable.
- **Analytics ingestion** — The API accepts batches of analytics events for the authenticated user.
