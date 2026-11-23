# Tools, connectors, services and repos

Everything Luma uses or has set up, and whether it is in use. Public-safe: no keys, no account details. Credentials are only ever "in the owner's dashboard" or "in a local DPAPI file".

- **Last checked:** 2026-11-21.
- **Rule:** when you add, remove or start using a tool, update this file in the same commit. Paid or metered tools need the owner's OK each time.

Status words: **in use**, **set up, not used**, **saved for later**, **not for Luma**.

## Repos

| Repo | What | Status |
|---|---|---|
| `github.com/jabari-projects/luma-study-workspace` (**public**) | All Luma code. Vercel and Render build from `main`. The `gh` CLI is not installed and there is no GitHub connector; use plain git. | in use |
| An earlier repo of the project | Older history. Details are in the vault. | not used |
| Other repos in the same GitHub organization | Not identified. See the vault. | unknown |
| `latent-spaces/brag` (v0.6.0) | Promo video plugin. Saved, not installed. | saved for later |
| Official Obsidian skills (pinned commit `3981277`) | Source of the `obsidian-*` and `json-canvas` skills. | copied in as skills |
| Vercel `agent-skills` (`1a2c79d`) and `web-interface-guidelines` (`434b7f9`) | Source of `luma-react-best-practices` and `luma-web-design-guidelines`. | copied in as skills |
| `microsoft/playwright-mcp` (0.0.84) | The Playwright MCP server in `.mcp.json`. | set up, not used |
| `antfu-collective/vite-ssg`, `Daydreamer-riri/vite-react-ssg` | Read for research only. | not installed |

Everything tracked in this repo is public, including `.claude/skills`, `.claude/agents`, `.claude/launch.json` and `.mcp.json`.

## Claude plugins and skills

| Name | What | Status |
|---|---|---|
| `frontend-design` plugin (Anthropic, `claude-plugins-official`, version 1.1.1, installed 2026-11-15) | Design guidance for UI work. The only user-level plugin installed and enabled. | in use |
| `/brag` plugin | Launch/promo video. Install only after the site is finished and promotion is approved; check that it makes no paid calls first. | saved for later |
| Project skills in `.claude/skills/`: `luma-react-best-practices`, `luma-web-design-guidelines`, `luma-promotion`, `obsidian-markdown`, `obsidian-bases`, `json-canvas` | React rules, offline web design checks, launch marketing prep, and writing Obsidian notes. | in use |
| Project agent `.claude/agents/luma-reviewer.md` | Read-only reviewer and researcher. Writes reports only to the vault's `50 Reviews` folder. Never uses real services. | in use |
| Codex mirror (`.codex/`, `.agents/skills/`) | Copies of the same agent and skills for the OpenAI Codex CLI. Exists only as untracked files in one local worktree; not in git. Whether Codex is used is unknown. Do not commit `.codex/` or `.agents/` without the owner's OK. | set up, not confirmed |
| User-level `playwright-cli` skill | Browser automation helper. | available |
| Skills and agents from other projects | Not for Luma. | not for Luma |
| Built-in session skills (docs, pdf, xlsx, code-review, security-review, simplify, schedule, ...) | Provided by the Claude app. | available as needed |

## Connectors (MCP) and app tools

| Name | What | Status |
|---|---|---|
| Supabase connector | Database admin: migrations, SQL, logs. Used to apply live migrations. Sign-in is held by the Claude app. | in use (production changes need the owner's OK) |
| Render connector | Service status, deploys, logs, env var names. Its deploy tool can only deploy the newest commit, so some deploys are done in the dashboard. | in use |
| Claude Browser pane | Drives dashboards (Render, Supabase, Vercel, Cloudflare, Resend, GitHub) and previews local servers. The owner opens it and signs in; passwords and 2FA stay with the owner. | in use |
| Context7 | Up-to-date library docs. Free plan, public library questions only. | in use |
| Shadcn UI | Component catalog. Reference only (Luma uses plain CSS, no Tailwind). | set up, not used |
| TinyFish | Paid, wallet-billed web fetching and automation. | **do not use without the owner's OK each time** |
| Playwright MCP (`.mcp.json`) | Browser control as a chat tool. Not switched on; the Playwright test runner covers this. | set up, not used |
| Claude in Chrome, computer use, terminal panel, docs connector, scheduled tasks, MCP registry, `visualize` (inline charts and diagrams) | Available in the Claude app. No record of use for Luma. Scheduled tasks would matter for the backup schedule, which needs the owner's OK. | available, not used |

## Outside services

| Service | What it does for Luma | Status | Where settings live |
|---|---|---|---|
| Vercel | Hosts the website, https://lumastudyhub.com. Auto-deploys from `main`. | in use | owner's dashboard |
| Render (free plan) | Hosts the API. Auto-deploy off. Sleeps when idle. | in use | owner's dashboard |
| Supabase (free plan) | Postgres database and file storage. Backups: see the vault. | in use | owner's dashboard |
| Resend | Sends sign-up codes, resets and email-change notices. Domain verified. | in use | owner's dashboard |
| Cloudflare | Domain registrar, DNS, email routing for help@. | in use | owner's dashboard |
| help@ inbox | Receives the help@ mail that Cloudflare forwards. Details in the vault. No Claude connector. | in use | owner's account |
| OpenAI | Image to Notes and speech to text. Will power the tutor (last). | in use | owner's dashboard |
| Deepgram | Second speech-to-text path in code. Whether to keep it is still open. | in use in code | owner's dashboard |
| Stripe | Billing code for Premium after launch. Payments are off. | built, not active | owner's dashboard |
| GitHub | Code hosting (see Repos). | in use | owner's account |
| Obsidian | The project vault on the owner's G: drive (not a git repo). The core Sync plugin is switched on; no community plugins. | in use | local only |

## Local tools on the owner's PC

These paths exist only on the owner's PC. On another PC, see the note at the top of `CLAUDE.md`.

| Tool | What | Status |
|---|---|---|
| Node 24, npm | Frontend build, tests, fake API. | in use |
| Python 3.12 / 3.14 + venv | Backend and tests. | in use |
| Playwright 1.64 + axe, Microsoft Edge | Browser tests on desktop, tablet and phone sizes with accessibility checks. | in use |
| PGlite (`J:/LumaOps/pglite`) | In-process Postgres for migration checks. | in use |
| PostgreSQL 17 (`J:/LumaOps/postgres`) | `pg_dump` and practice restores for the backup tool (127.0.0.1 only). | in use in tests |
| gpg (bundled with Git for Windows) | Encrypts backups. | in use in tests |
| Windows DPAPI + Task Scheduler | Locks saved backup credentials to the owner's Windows user (local DPAPI file). Any backup schedule needs the owner's OK. | built (details in the vault) |
| Backup storage | Encrypted, kept off the repo. Location and state are in the vault. | see the vault |
| whisper.cpp (`J:/LumaPilot/whisper`) + ffmpeg 9.0.2 (on J:) | Local speech-to-text pilot. Too heavy for free Render. | pilot done, not used |
| Vercel CLI link | The owner's older main checkout is linked to the Vercel project; the CLI is not on PATH. | not used day to day |

## Main libraries

- **Frontend:** React 19, react-router-dom 7, axios, motion, ts-fsrs, pdfjs-dist, mammoth, sonner, canvas-confetti, rough-notation, auto-animate, Phosphor icons, Fontsource fonts. Build: Vite 8, TypeScript 5.9, ESLint 9.
- **Backend:** FastAPI, uvicorn, pydantic, PyJWT, argon2-cffi, httpx, supabase (Python), openai, stripe, trafilatura.

## Not used (leftovers)

- `backend/railway.json` (Railway) and `frontend/netlify.toml` (Netlify): production is Render + Vercel. Candidates for removal.
