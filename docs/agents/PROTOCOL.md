# Multi-agent protocol

How several agents (on one or more Claude accounts) work on Luma at the same time without overwriting each other.

**Public repo: follow `CLAUDE.md` section 5. Private or security details go only in the vault.**

## 1. One task, one branch, one worktree

- Name the branch `claude/<short-task>` (for example `claude/help-desk`).
- Make a worktree for it on the J: drive, never on the C: drive (on another PC: a sibling folder next to your checkout, off the system drive):
  ```powershell
  git fetch origin
  git worktree add -b claude/<task> J:/LumaPilot/wt-<task> origin/main
  ```
- Branch from `origin/main` unless your task builds on another unmerged branch. If it does, say so in your claim.
- Never work inside another agent's worktree. Never check out another agent's branch to edit it.
- Never use bare `git stash` (all worktrees share it). Make a WIP commit instead.

## 2. Claim before you start

Add one row to `docs/agents/ACTIVE.md`:

| Agent | Branch | Files / areas | Started | State |
|---|---|---|---|---|

- **Agent:** a short id you will reuse, like `claude-helpdesk-1`.
- **Files / areas:** be specific (`backend/app/helpdesk*.py`, `frontend/src/admin/`). Shared files you must touch (`App.tsx`, `main.py`, `api.md`) go here too.
- **State:** `active`, `paused`, `done`.

Before claiming, read the table. If your files overlap an `active` claim, do not start. Pick other work or ask the owner.

The claim row lives on your branch. Other agents only see it once it is on `main` or pushed, so also tell the owner which branch you are on, and check `git branch -a` and `git worktree list` for work that is not in the table yet.

## 3. Who updates what

| File | Who writes | How |
|---|---|---|
| `docs/agents/ACTIVE.md` | each agent, own row only | add, change your own row; never touch others' rows |
| `docs/agents/LOG.md` | every agent | append at the bottom only; never edit or delete earlier lines (only the owner may redact a line that leaked private info) |
| `docs/handoff/HANDOFF.md` | every agent | change only the rows and sections your work changed |
| `docs/handoff/TOOLS.md` | any agent that adds or drops a tool | same commit as the change |
| `CLAUDE.md`, `PROTOCOL.md` | only with the owner's OK | these are the rules |
| Vault `00 Home/Luma Handoff.md` | every agent that can reach G: | private details: decisions, owner steps, security notes |

## 4. Conflict rules

- On a merge conflict in `LOG.md`: keep **both** sides, in time order.
- On a conflict in `ACTIVE.md`: keep every agent's own row as that agent last wrote it.
- On a conflict in `HANDOFF.md`: keep the newest fact for each row. If unsure, check the code and write what is true.
- Never resolve a code conflict by deleting another agent's work. Stop and ask the owner.
- If two agents need the same shared file (for example `App.tsx`), the second one waits, or rebases after the first merges.

## 5. Merge order

1. Only the owner approves merges into `main` (small reversible fixes may ship under the standing rule; launch, paid, migrations, destructive changes and big merges need the owner).
2. Merge the oldest finished branch first. Each later branch rebases or merges `origin/main` and re-runs all checks before it merges.
3. A branch with a database migration merges only after a fresh backup and the owner's OK. Migrations only add things.
4. After a merge: update `HANDOFF.md` (live versions, branches table), add a `LOG.md` line, mark the claim `done`.

## 6. Handing off mid-task

If you must stop before you finish:

1. Commit what you have on your branch (WIP is fine; never leave changes only in the working tree).
2. Set your `ACTIVE.md` row to `paused`.
3. Append to `LOG.md` a **Remaining plan** entry:
   ```
   - 2026-11-21 | claude-xyz | claude/<task> | PAUSED. Done: ... Left: 1) ... 2) ... Files: ... Test with: ... Watch out for (public-safe only): ...
   ```
4. If the vault is reachable, copy the same note into the vault with any private details.

The next agent takes over by changing the row's Agent to its own id and setting it back to `active`.

## 7. Truth rules

- Write only what you checked. Use the status words `built` / `fake-tested` / `real-tested` / `deployed`.
- Say what you did NOT test.
- Facts about git come from `git` (`git log origin/main`, `git worktree list`), not from memory or old notes.
