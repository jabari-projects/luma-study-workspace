# Agent log

**Public repo: follow `CLAUDE.md` section 5. Private or security details go only in the vault.**

Append-only. Newest at the bottom. Never edit or delete a line someone else wrote (only the owner may redact a line that leaked private info). Format:

`- YYYY-MM-DD | agent id | branch | what changed, status word, what is next`

Use a **Remaining plan** entry when you stop mid-task (see `PROTOCOL.md` section 6).

---

- 2026-11-21 | claude-handoff-1 | claude/handoff-docs | Set up the handoff system: `CLAUDE.md`, `AGENTS.md`, `docs/handoff/HANDOFF.md`, `docs/handoff/TOOLS.md`, `docs/agents/ACTIVE.md`, `docs/agents/LOG.md`, `docs/agents/PROTOCOL.md`; added a contributor link section to `README.md`; fixed clearly wrong lines in `docs/architecture.md`, `docs/features.md`, `docs/setup.md`, `docs/roadmap.md` (pointer only) and `frontend/README.md`. Facts were checked against `origin/main` 7b602b9 and `git` branch data. Status: built, not merged, not pushed. Next: owner reviews and merges; the vault gets `00 Home/Luma Handoff.md`.
- 2026-11-21 | claude-handoff-1 | claude/handoff-docs | Review fixes: pytest install step (CLAUDE.md, setup.md); release-1 deploy order rewritten to match the release checklist (backup + restore test + rehearsal, auto-deploy off, SQL feedback then maintenance_state then student_work_versions, VERIFY hard stop, merge, Render, then Vercel); removed hostnames, project names, backup paths and open-gap wording from public docs; privacy rules widened (CLAUDE.md section 5, PROTOCOL, LOG); other-PC path note; secondary-work branch and wider release-1 claim; README status and setup.md Supabase lines fixed; TOOLS adds visualize, plugin version, other org repos. Status: built, docs only, not pushed. Next: owner reviews and merges.
