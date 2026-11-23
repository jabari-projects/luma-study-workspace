# Luma handoff

The one page any agent reads to pick up Luma. Public-safe: private details live in the owner's Obsidian vault (`00 Home/Luma Handoff.md`).

- **Last checked against code:** 2026-11-21, `origin/main` = `7b602b9`.
- **How to keep it true:** after each task, change only the rows you touched, then add a line to `docs/agents/LOG.md`. If this page and the code disagree, the code wins. Fix the page.

## 1. What Luma should do

Luma is a simple, creative study app for students age 13 and up in the U.S. Students sign in with email and get:

- notes, smart flashcards (FSRS spaced repetition) and quizzes;
- Voice to Notes, Import to Notes (text, PDF, Word, web links) and Image to Notes;
- summaries made from a note;
- Discover: study sets other students chose to share (signed-in only, usernames only).

Product rules: study material is private until the student shares it. Luma is a learning app, not a social app (no DMs, comments, follows or like counts). No ads, no trackers. Words stay simple. Original AI tutor characters come last, as a Premium feature.

## 2. How it is built

| Part | What | Where it runs |
|---|---|---|
| Website | React 19 + TypeScript + Vite in `frontend/` | Vercel, https://lumastudyhub.com, auto-deploys from `main` |
| API | FastAPI (Python) in `backend/` | Render free plan (API host is in the vault), auto-deploy is **off**, deploys are started by hand |
| Database and files | Postgres + Storage | Supabase (free plan; backups: see the vault) |
| Email | Sign-up codes, resets, email-change notices | Resend, from the lumastudyhub.com domain |
| DNS | Domain, DNS, help@ forwarding | Cloudflare (registrar, DNS, email routing) |
| AI | Image to Notes, speech to text | OpenAI (Deepgram is the second speech path in code) |
| Payments | Stripe code exists, payments are **off** | (not active) |

Sign-in uses Luma's own users table and Luma's own JWTs, not Supabase Auth. The browser never talks to Supabase directly; it only calls the API (`VITE_API_BASE_URL`).

Code map: `frontend/src/` is split by area (`account/`, `capture/`, `notes/`, `study/`, `discover/`, `ui/`), with routes in `App.tsx`. `backend/app/` has one module per area (`auth.py`, `email_codes.py`, `notes.py`, `flashcards.py`, `capture.py`, `link_import.py`, `reports.py`, `publishing.py`, `account_deletion.py`, `billing.py`, `rate_limits.py`, ...). SQL changes live in `backend/app/schemas/migrations/` (dated files, add-only). The fake API for tests is `frontend/dev/mock-api.mjs`.

## 3. Live versions

| Part | Commit | Notes |
|---|---|---|
| Website (Vercel) | `7b602b9` | Same as `origin/main`. |
| API (Render) | `99350a5` | Nothing in `backend/` or `render.yaml` changed between `99350a5` and `7b602b9`, so the live API runs the same backend code as `main`. |
| Database | 4 migrations on `main` (2026_11_15 to 2026_11_17) | Recorded as applied. The 3 migrations on branches (section 5) are **not** applied. |

## 4. On `main` and deployed

Status words: `built` / `fake-tested` / `real-tested` / `deployed` (see CLAUDE.md).

| Feature | Status | What was really checked live |
|---|---|---|
| Email-code sign-up and verify, log in, password reset | deployed | A real reset email reached the owner's inbox (2026-11-17). |
| Email change and account deletion (both ask for the password) | deployed | fake-tested; live check pending (see the vault). |
| Up to 3 accounts per device, switch from the account menu | deployed | fake-tested; switching between two real accounts not tried live. |
| Notes, decks with FSRS study, quizzes, study plans | deployed | fake-tested; live checks were mostly signed-out smoke tests. |
| Import, Voice and Image to Notes | deployed | fake-tested. No paid real AI call has been made in testing. |
| Summary from a note (`/api/summarize`) | deployed | fake-tested. |
| Discover (signed-in only, usernames only) | deployed | fake-tested. |
| Content reports and the admin reports page | deployed | fake-tested. |
| Theme: Light, Dark, Automatic, plus theme colour | deployed | fake-tested; site loads live. |
| New landing page | deployed | Signed-out page checked live. |
| CORS for lumastudyhub.com and Luma's own Vercel builds | deployed | real-tested from the live site. |
| `/health` and `/health/ready` | deployed | real-tested. |
| Stripe routes | built, fake-tested | Payments are off. Never tried in Stripe test mode. |

Routes `/ai-tutor`, `/subscribe` and `/transcripts` only send you to `/dashboard`. `AI_CHAT_UI_ENABLED` is `false` in `frontend/src/config.ts`.

Test files on `main`: 25 backend test files, 16 Playwright specs, 13 unit test files.

## 5. On branches (not live)

| Branch | Pushed? | What it holds | Status |
|---|---|---|---|
| `claude/student-work` | yes | Autosave with version checks and conflict notices, drafts kept in the tab only, retry-safe creates, flashcard progress merge, maintenance mode, encrypted backup tools (`ops/backup/`), deployment checklist. Also holds the `landing-fix` merge (`4f72de7`). Migrations `2026_11_19_student_work_versions.sql` and `2026_11_19_maintenance_state.sql`. | built, fake-tested (counts recorded in the vault, not re-run for this page) |
| `claude/feedback-poll` | yes | Monthly feedback poll: backend, migration `2026_11_18_monthly_feedback.sql`, student and admin pages, fake API, e2e. 5 commits behind `main`. | built, fake-tested |
| `claude/release-1` | **no, local only** (worktree `J:/LumaPilot/wt-release`) | `student-work` + `feedback-poll` merged, plus a release rehearsal tool. | **in progress** in another workflow. Do not edit it. |
| `claude/backup-tools`, `claude/maintenance` | yes | Single commits that are already inside `student-work`. | superseded by `student-work` |
| `claude/handoff-docs` | not yet | This handoff system (CLAUDE.md, AGENTS.md, `docs/handoff/`, `docs/agents/`). | built |
| `claude/secondary-work` | **no, local only** (worktree `J:/LumaPilot/wt-secondary`) | Nothing yet; it sits at `7b602b9`. Reserved for the second Claude account. | not started (reserved) |
| `claude/subjects-search` | **no, local only** (worktree `J:/LumaPilot/wt-subjects`, from `main` `98d10f0`) | Owner feedback of 2026-11-23. Part A: deck editor errors for cards not filled in (box with a link per card, red "Not filled in" marks, focus, "Remove N empty cards", one wording in the box and the sticky bar, "Fix N" on phones; autosave waits instead of failing), the same in the Import/Voice/Image workbench, and "Make cards from my notes" (paste or pick a note, AI through the existing free daily turns or a free list finder, review before adding; a big button above an empty deck; Save deck points at suggestions not added yet) in place of "Paste a list". Part B: one subject list (67 subjects, 784 subtopics with aliases like "ap calc" and "trig", `backend/app/data/subjects.json`, `GET /subjects`), a subject picker on notes, decks, summaries and the workbench, "Share with the crowd?" asked once right after the first save of a new deck or note (on the editor) or a deck or summary made from a note, and Discover search (every word must match, any order, "U.S." = "us") with subject, subtopic and type chips with counts (`GET /public/search`; chips fold under "Filters" on phones). Review fixes of 2026-11-23 applied (see `docs/agents/LOG.md`). **Has a migration, NOT APPLIED:** `2026_11_24_subjects.sql` (6 nullable columns, shape checks, 3 partial indexes, one read-only search function for the service role only). Deploy order is in `docs/deployment-checklist.md` ("Subjects and Discover search"): backup + rehearsal + owner OK, apply the file, VERIFY, then backend, then website. `/health/ready` now answers 503 `needs_update` if the backend reaches a database without these columns. | built, fake-tested (not deployed) |

Already merged into `main` (safe to ignore): `polish-a`, `polish-b`, `security-gaps`, `theme-color`, `landing-fix`, `domain-cors`, `finish-website`, `log-privacy-fix`, `multi-account`, `luma-learning-platform-b6d3c1`.

Not on any branch yet: admin help desk, smart study reminders, the AI tutor.

## 6. What's next, in order

1. **Backup step** (owner; details in the vault). It is done only when the backup's restore test passes **and** `ops/backup/rehearse_migrations.py` has passed on that real backup with `--after 2026_11_17_content_reports` (run from `ops/backup` on `claude/student-work` or `claude/release-1`).
2. **Deploy release-1**, only after step 1, only once the release workflow has finished the branch, and only with the owner's OK. Follow `docs/deployment-checklist.md` on `claude/release-1`, section "First release only" (being written now; use it once it is committed). In short, stop at the first thing that is not exactly as written:
   1. Real backup, restore test and migration rehearsal passed (step 1).
   2. Turn auto-deploy **off** on Render **and Vercel** before anything is merged. Merging to `main` while Vercel auto-deploys would ship the new website onto the old API. Never run the new website on the old API.
   3. Apply the 3 add-only SQL files by hand, one at a time, in this order: `2026_11_18_monthly_feedback.sql`, then `2026_11_19_maintenance_state.sql`, then `2026_11_19_student_work_versions.sql`.
   4. Run each file's VERIFY part. This is a hard stop: if any number is off, do not go on.
   5. Merge `claude/release-1` into `main` and push. Nothing deploys yet, because auto-deploy is off. (Render's deploy tool has no commit setting, so the release must be on `main` first.)
   6. Deploy the API on Render by hand. Wait until `/health/ready` and `/maintenance/status` both answer 200, then do one test save.
   7. Only then deploy the website on Vercel by hand. Then turn auto-deploy back on for both.
   8. If something goes wrong: roll back Vercel first, then Render. Never restore the database.
3. **Owner safety approvals** (list in the vault).
4. **Admin help desk** (planned; plan is in the vault).
5. **Smart study reminders** (opt-in, Luma data only, with caps).
6. **AI tutor**, last (Premium only).

Small clean-ups any agent may pick up (on their own branch, after claiming):

- Discover search speed (after `claude/subjects-search` is live): every search reads every shared row and builds each deck's text from its cards. Fine at today's size. When it grows, add a separate add-only migration: a stored search-text column on shared rows with a `pg_trgm` GIN index (or reuse `search_vector`), and keep the API role's statement time limit in mind. The website already stops an older search when a new one starts.

- Remove the unused host configs `backend/railway.json` and `frontend/netlify.toml` (production is Vercel + Render).
- Make `render.yaml` match the live service (auto-deploy off, health check path, Python version).
- Remove the leftover `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY` declarations in `frontend/src/vite-env.d.ts` and the commented-out lines in `frontend/.env.example` (the frontend no longer uses Supabase directly; `docs/setup.md` already says so).
- Add a dev requirements file with a pinned pytest, so a fresh venv can run the tests without a hand install.
- Refresh `docs/roadmap.md` (an August plan). (`README.md` "Current status" was fixed on `claude/handoff-docs`.)

## 7. Known bugs and rough edges (non-sensitive)

- The free Render server sleeps. The first visit can sit on "Checking your session..." for about 37 seconds.
- On a note page, the floating Publish button can cover the study panel.
- Import tabs scroll sideways on phones narrower than 360 px.
- `multi-account.spec.ts` (around line 221) was flaky under heavy load; it was recorded as fixed, so watch it.
- Not yet tested on a real phone (only Playwright phone sizes).

Security and legal items are tracked only in the vault, not here.

## 8. How to resume

1. Read `CLAUDE.md`, then this page, then `docs/agents/ACTIVE.md`.
2. `git fetch origin`, then make a worktree from `origin/main` for your task (see `docs/agents/PROTOCOL.md`). The owner's older main checkout may be behind; always branch from `origin/main`.
3. Start the fake API and website (CLAUDE.md section 3), run the checks, then start work.
4. When done, update this page, `docs/agents/LOG.md` and the vault.

## 9. Other docs

- [CLAUDE.md](../../CLAUDE.md): rules and workflow for agents
- [TOOLS.md](TOOLS.md): plugins, connectors, skills, services, repos
- [PROTOCOL.md](../agents/PROTOCOL.md), [ACTIVE.md](../agents/ACTIVE.md), [LOG.md](../agents/LOG.md): multi-agent work
- [setup.md](../setup.md), [architecture.md](../architecture.md), [api.md](../api.md), [features.md](../features.md), [roadmap.md](../roadmap.md)
