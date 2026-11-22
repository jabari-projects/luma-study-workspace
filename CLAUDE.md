# CLAUDE.md: start here, every agent, every time

Luma is a simple study app for students (notes, smart flashcards, quizzes, Voice/Import/Image to Notes, summaries, Discover). This file tells any Claude agent (any account, any PC) how to pick up the work without old chats.

**This repo is PUBLIC.** Read the privacy rules (section 5) before you write anything.

## 1. Read first (before any code)

1. `docs/handoff/HANDOFF.md`: what is live, what is on branches, what to do next.
2. `docs/agents/ACTIVE.md`: who is working on what right now. Do not touch claimed files.
3. `docs/agents/PROTOCOL.md`: the rules for working alongside other agents.
4. `docs/handoff/TOOLS.md`: plugins, connectors, skills, services and repos.
5. If the folder `G:/LumaLocal/Luma Knowledge` exists on this PC, read the Obsidian vault too:
   `START HERE.md`, then `00 Home/Luma Handoff.md`. The vault holds private notes (owner decisions, incidents, security gaps) that must never go in this repo. If G: is missing, say so to the owner and carry on with the repo docs.
6. Check the code itself. Docs can lag. Trust `git log origin/main` and the files over any note. If a note is wrong, fix the note.

## 2. Owner's standing rules

- **Plain, friendly words.** All student-facing copy and all notes for the owner are simple, about a 3rd-grade reading level.
- **Never print, paste or commit secrets** (keys, passwords, tokens, `.env` values). Read variable *names* only.
- **No paid or metered tools without the owner's OK each time** (for example the TinyFish connector, paid AI calls to OpenAI or Deepgram in tests, paid hosting).
- **Big files go on J: or G:, never C:** (downloads, models, caches, backups, logs).
- **No endless polling.** Push, don't poll. Wait on a real signal.
- **No fallback or duplicate code.** No "v2" copies. Replace the old code and delete it.
- **Database changes only ADD** (new tables, new columns, new indexes). Never drop or rewrite data.
- **Back up before any risky database change.** Backups are encrypted and live under `G:/LumaBackups`.
- **Never restore production automatically.** A restore is always a hand-checked owner step.
- **Deploy approvals:** small, reversible fixes may ship. The owner must approve launch, anything paid, production migrations, anything destructive, and big merges.
- **Status words** (use exactly these, never blur them):
  - `built`: the code exists on a branch.
  - `fake-tested`: tests pass with the fake API or fakes, no real services.
  - `real-tested`: checked against the real service or the live site.
  - `deployed`: running in production.

## 3. Run and test

Use the fake API for almost everything. It needs no database, email or AI.

```powershell
cd frontend
npm ci
npm run mock-api                      # fake API on 127.0.0.1:8787 (in-memory, seeded .test accounts, email codes print to the console)
$env:VITE_API_BASE_URL="http://127.0.0.1:8787"; npm run dev   # website on 5173
```

`.claude/launch.json` has the same two servers as `luma-mock-api` and `luma-web-mock` for the Claude preview pane.

Checks, from `frontend/`:

```powershell
npm run lint
npm run build        # tsc -b and vite build
npm test             # node --test unit tests
npm run e2e          # Playwright on Edge: desktop, tablet, phone. Starts its own fake API (8788) and vite (5174)
```

Backend, from `backend/` (make a venv first: `python -m venv .venv` then `.venv/Scripts/python.exe -m pip install -r requirements.txt`):

```powershell
.venv/Scripts/python.exe -m pytest -q -p no:cacheprovider
```

`tests/conftest.py` clears every provider key and sets `APP_ENV=test`, so tests never reach a real service.

Migration checks run on PGlite (installed outside the repo):

```powershell
$env:PGLITE_DIR="J:/LumaOps/pglite"; node backend/scripts/check_live_migration.mjs
```

The real backend (`uvicorn main:app --env-file .env` from `backend/`) needs Supabase and a JWT secret. You should rarely need it. See `docs/setup.md`.

## 4. Documentation workflow (do this every task)

1. **Before you start:** add one line to `docs/agents/ACTIVE.md` with your agent id, branch, files or areas, and start date. Make one branch and one worktree per task (worktrees go on `J:/LumaPilot/wt-<task>`). Never edit files another agent has claimed.
2. **While you work:** keep commits small. Use the status words above.
3. **After each task or big change:**
   - Update `docs/handoff/HANDOFF.md` (status table, branches, next steps). Change only the rows your work touched.
   - Add a line to the bottom of `docs/agents/LOG.md`. It is append-only. Never edit or delete other lines.
   - If the vault is reachable, update `00 Home/Luma Handoff.md` and the vault's Session Log or Task Board with the private details.
   - Mark your `ACTIVE.md` line `done` (or remove it when your branch merges).
4. **If you must stop mid-task:** write a "Remaining plan" note in `LOG.md` (what is done, what is left, which files, how to test) and leave your claim as `paused`.
5. Any new plugin, connector, skill, outside service or repo goes in `docs/handoff/TOOLS.md` in the same commit.

## 5. Privacy: this repo is public

Never put these in the repo, in commit messages, or in PR text:

- secrets or where their values are stored beyond "owner's dashboard" or "local DPAPI file";
- personal data (names, emails, student data, account counts);
- private business info (money, budgets, legal questions, vendor accounts);
- security weaknesses that are not fixed yet;
- service IDs, project refs and dashboard links.

Those go only in the Obsidian vault on G:. If you are not sure, put it in the vault.

## 6. Git habits

- Never commit to `main` directly. Branch, then the owner approves the merge.
- Do not push or deploy unless the task says so and the rules in section 2 allow it.
- The `gh` CLI is not installed on the owner's PC. Use plain `git`.
- Never use bare `git stash` (the stash is shared by all worktrees). Use a WIP commit.
- End commit messages with the co-author line your session gives you.
