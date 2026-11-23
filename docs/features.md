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

- **Discover** — Signed-in students can search study sets other students chose to share. Shared items show only the username and topic.
- **Summary from a note** — Make a short summary from one of your notes (`/api/summarize`).
- **Reports** — Students can report a shared item; admins review reports on the admin reports page.
- **Authentication and account management** — Sign up, log in, verify email, request and reset passwords, update profile information, and delete an account.
- **Multiple accounts and the AI chat account** — A student can stay signed in to up to 3 accounts on one device and switch from the account menu (sidebar name, phone avatar, or Settings → Accounts on this device). Each browser tab keeps its own account, and each request carries only that account's token. AI notes and Voice to Notes work in every account. The future AI tutor chat will work for one account per device: the first one signed in, which keeps that role until it signs out (an expired sign-in or a password reset does not move it); then the next-oldest account gets it. Today this is worked out on the device only (`frontend/src/accounts.ts`), and the chat badge stays hidden until the chat ships (`AI_CHAT_UI_ENABLED` in `frontend/src/config.ts`). The server will need to enforce it when the chat ships.
- **Profiles and themes** — Manage display details, color/theme preferences, avatar images, and custom theme images.
- **Notifications and live connection** — Retrieve and mark notifications as read; an authenticated WebSocket endpoint is available for server-to-user messages.

## Study tools and integrations

- **Image to Notes** — Upload a PNG, JPEG, or WebP image and use the implemented OpenAI integration to generate notes.
- **Voice Input** — Covered by Voice to Notes. Audio is turned into text with OpenAI speech-to-text, or Deepgram when no OpenAI key is set.
- **Subscription flow (backend only, payments off)** — Start a Stripe Checkout subscription session; the Stripe webhook links the verified Stripe customer and subscription ids to the account (`billing_schema.sql`) and keeps the subscription status in sync. Subscriptions from before the link tables are not linked automatically and must be linked by hand after checking Stripe.
- **AI Tutor** — Not built yet. The `/ai-tutor`, `/subscribe` and `/transcripts` routes only send you to `/dashboard`, and `AI_CHAT_UI_ENABLED` is `false`. The tutor is planned last.

## Operational support

- **Health and connection state** — The frontend checks the backend health endpoint and shows whether the service is reachable.
- **Analytics ingestion** — The API accepts batches of analytics events for the authenticated user.
