# Features

## Study workspace

- **Notes** — Create, read, update, delete, tag, and optionally publish personal notes.
- **Flashcards** — Decks of question-and-answer cards with tags and optional public publishing. A study mode flips cards and uses the FSRS spaced-repetition scheduler (ts-fsrs) to decide when each card comes back. Each card shows a "glow" level: Spark (new), Ember (learning), Flame (getting there), Lumen (known).
- **Quizzes** — Build a quiz from one or more decks with pick-the-answer, true-or-false, and type-the-answer questions, then retry the ones you missed.
- **Voice to Notes** — Record in the browser (with a live sound meter) or upload an audio file. Luma turns it into words, then into notes, key words and suggested flashcards. Students keep or toss each card and save a note, or a note plus a deck.
- **Import to Notes** — Paste text, upload a PDF, Word (.docx), TXT or Markdown file, or paste a web link. Files are read in the browser (pdf.js, mammoth), so the file itself is never uploaded. For YouTube, students paste the transcript from YouTube's "Show transcript" panel. The same notes-and-cards workbench follows.
- **Today** — Home screen with your next best step, a weekly glow goal, and quick links to every tool.
- **Summaries** — Save concise lesson summaries with tags and optional public publishing.
- **Study sessions** — Create and manage named study plans with a subject, notes, and a duration in seconds.

## Discovery and account experience

- **Public search** — Search public notes, flashcards, and summaries by topic or browse users who have published material.
- **Authentication and account management** — Sign up, log in, verify email, request and reset passwords, update profile information, and delete an account.
- **Profiles and themes** — Manage display details, color/theme preferences, avatar images, and custom theme images.
- **Notifications and live connection** — Retrieve and mark notifications as read; an authenticated WebSocket endpoint is available for server-to-user messages.

## Study tools and integrations

- **Image to Notes** — Upload a PNG, JPEG, or WebP image and use the implemented OpenAI integration to generate notes.
- **Voice Input** — Covered by Voice to Notes. Audio is turned into text with OpenAI speech-to-text, or Deepgram when no OpenAI key is set.
- **Subscription flow** — Start a Stripe Checkout subscription session; the Stripe webhook links the verified Stripe customer and subscription ids to the account (`billing_schema.sql`) and keeps the subscription status in sync. Subscriptions from before the link tables are not linked automatically and must be linked by hand after checking Stripe.
- **AI Tutor interface** — Provides the current chat and file-selection UI. The UI explicitly indicates that its interactive tutoring behavior is still in progress, so it is not documented as a completed AI chat feature.

## Operational support

- **Health and connection state** — The frontend checks the backend health endpoint and shows whether the service is reachable.
- **Analytics ingestion** — The API accepts batches of analytics events for the authenticated user.
