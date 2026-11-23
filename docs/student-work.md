# Keeping student work safe (saving, drafts, conflicts, retries)

Status: built and tested locally with made-up data only. **Not deployed. The migration is not applied.**
Design: section B of the safety design (`J:/LumaPilot/safety-design.md`).

## What students see

| Where | How it saves |
|---|---|
| Change a note or summary (`/notes/:id/edit`, `/summaries/:id/edit`) | Saves by itself 1.5 s after typing stops, and right away when you leave the form. "Save changes" saves now and opens the note. |
| New note (`/notes/new`) | Saved only with **Save note** (no half notes in the list). Then the page becomes the edit page and saves by itself. |
| Change a deck (`/flashcards/:id/edit`) | Saves by itself 2 s after typing stops. Review progress is never sent from here. |
| New deck (`/flashcards/new`) | **Save deck** first, then it saves by itself. |
| Studying a deck | Every grade is saved right away as progress only (`PATCH /flashcards/:id/progress`). |
| Study plan form, Image/Voice/Import to notes, Make a summary, Make a deck | Saved only with their own buttons. Until then they count as unsaved, and a text-only copy is kept in the tab. |
| Settings (username, theme) | Buttons are turned off while saving. |

The save line says: "Not saved yet", "Saving...", "Still saving..." (after 5 s), "Saved at 2:41 PM"
(only after the server confirmed it, with a `version`), "You're offline. We'll save when you're back.",
"Couldn't save. Your words are still here." + **Try again**, "Sign in again to save." + **Sign in**,
"Luma is taking a short break. Your words are kept in this tab."

## Server contract (backend/app/edit_versions.py)

- Every note, summary, deck and study plan has `version` (starts at 1, +1 on each saved edit).
- `PUT /{kind}/{id}` takes `expected_version`. If the row moved on: **409**
  `{"detail": "This was changed in another tab or on another device.", "error_code": "edit_conflict", "current": {...}}`.
  If the stored row already holds exactly what was sent (a retry whose first copy landed): 200.
  Missing item: **404** `error_code: "item_gone"`.
- `POST /{kind}` takes the header `Idempotency-Key: <uuid>`. The same key again from the same student
  returns the first row with **200** + `Idempotent-Replay: true` (first time: 201). Another student's
  key never matches (the unique index is per student). A key that isn't a uuid: 422 `bad_idempotency_key`.
- `PATCH /flashcards/{id}/progress` `{"reviews": {"<card id>": <review or null>}}` (1 to 500 cards)
  merges progress per card, never changes words or `version`. Busy 3 times in a row: 409 `progress_busy`.
- The deck editor's `PUT` keeps the stored progress for each card id; new cards start fresh.
- The client can never set `version`, `create_key` or `progress_rev`.
- **OVERLAP** (deploy safety): a `PUT` without `expected_version` still works (last write wins, the
  version still goes up), and a `POST` without a key still works. This is for browsers that still have
  the old page open during a deploy. Remove it in the contract step (deployment checklist step 9):
  make `expected_version` required (428 `version_required`), only once the backend logs show no
  `PUT` without `expected_version` for 14 days in a row, and only after a "new version, save and
  reload" signal has shipped. Old pages have no autosave and no draft for saved items, so the 428
  `detail` must say in plain words: "Luma was updated. Copy your text somewhere safe, then reload the
  page." Task Board item: "Remove the OVERLAP save code".

## Migration (NOT APPLIED)

`backend/app/schemas/migrations/2026_11_19_student_work_versions.sql` is additive only: 9 new columns
with defaults and 4 partial unique indexes, in one transaction, safe to run twice. Apply it **before**
deploying the backend (old code ignores the new columns, so a code rollback is safe).

Checks:

```
PGLITE_DIR=J:/LumaOps/pglite node backend/scripts/check_student_work_migration.mjs   # 70 checks
J:/LumaPilot/wt-feedback/backend/.venv/Scripts/python.exe -m pytest -q -p no:cacheprovider -W ignore   # from backend/
```

## Drafts (privacy)

- Kept **only in this browser tab** (`sessionStorage`), key `luma.draft:v1:<account>:<kind>:<item|new>`.
  Text only, never pictures, sound or files. At most 200 KB each. Older than 24 h: dropped.
- Read only when the key's account AND the saved account both match the tab's account.
- Removed when saved, on **Throw it away**, on sign-out (that account), sign-out of all, account
  deletion, and when the tab closes. Closing the tab is never treated as a save.
- The old device copy `luma.noteDraft:<account>` (localStorage, written by the release before this
  one, which told students "Draft saved on this device") is **never deleted unseen**. Real-data
  migration path (`accounts.ts`, `NoteEditorPage.tsx`):
  - **Write a note** offers it once: "We found a note you did not save on this device..." with
    **Use them** (the words go into the editor and this tab's draft; the device copy is removed
    only once that note is saved) or **Throw them away** (removed). Saving a different note while
    the offer is ignored never removes it. If the student used the words, then closed the tab
    without saving, the offer comes back next time. The notes page shows "You have a note you did not save on this
    device. **Open it**" while one is waiting.
  - Removed without an offer only when that account is no longer on this device (signed out, as the
    old code did), on sign-out of that account or of all accounts, and after 2027-02-01.
  - An old tab still open after the deploy can keep writing its copy; the new code leaves it alone.
  - Remove the migration after 2027-02-01 (Task Board item: "Remove the luma.noteDraft migration").
  - Tested by `frontend/e2e/legacy-draft.spec.ts` and `frontend/src/work/drafts.test.ts`.
- Policy text to update (Integration track): "An unsaved draft is kept only in that browser tab. It is
  removed when you save, sign out, delete your account, or close the tab."

## Never losing work by leaving

- The browser's "Leave site?" warning shows only while something isn't saved.
- An in-app link waits: "Saving your work...", then goes on by itself. If saving fails: "Your work
  isn't saved." **Stay here** / **Leave anyway**.
- Switching, adding or signing out of an account with unsaved work asks first: "You have work that
  isn't saved yet." **Stay and save** (default) / **Switch anyway** (sign out: "Signing out throws
  away work that isn't saved.").
- A sign-in that ends (401) keeps the page open with **Sign in again** (email fixed to that account; a
  different account is refused). A sign-out in another tab keeps the page open with **Sign in**, **Copy
  my text**, **Throw it away**. With nothing unsaved, both behave as before.

## Tests (made-up data only)

- Backend: `test_student_work_versions.py`, `test_student_work_idempotency.py`,
  `test_flashcard_progress_merge.py`, `test_student_work_migration_file.py` (fake DB in `work_fakes.py`).
- Unit: `frontend/src/work/saveClient.test.ts`, `drafts.test.ts`, `unsaved.test.ts`.
- Browser (desktop, tablet, phone): `autosave.spec.ts`, `offline-expired.spec.ts`, `conflict.spec.ts`,
  `duplicate-retry.spec.ts`, `drafts-accounts.spec.ts`, plus updated `notes`, `study`, `multi-account`
  and `theme` specs. Run with `E2E_API_PORT=8850 E2E_WEB_PORT=5250 npx playwright test <spec>`.
- The fake API (`frontend/dev/mock-api.mjs`) mirrors the contract and adds local-only hooks:
  `/__test/slow`, `/__test/fail` (`500`, `drop-after-commit`, `drop-before-commit`), `/__test/edit-elsewhere`.

Not tested here (assumptions): real Postgres concurrency under load (PGlite has one connection; racing
saves are covered by the pytest fake), and real Supabase/PostgREST error codes beyond `23505`.
