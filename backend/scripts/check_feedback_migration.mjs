// Proves backend/app/schemas/migrations/2026_11_18_monthly_feedback.sql on a throwaway
// in-memory Postgres (PGlite). Nothing here connects to a real database or reads any .env file.
//
// HOW TO RUN (Git Bash), with PGLITE_DIR pointing at a folder whose node_modules has
// @electric-sql/pglite 0.5.x:
//   PGLITE_DIR=<folder> node backend/scripts/check_feedback_migration.mjs
// MIGRATION_PATH overrides the migration file (used to mutation-test this checker).
//
// PGlite has a single connection, so true concurrency is NOT exercised here: concurrent
// sends are covered by the unique keys proven below plus the backend's pytest suite.
// Polls that are already open or closed are seeded with the poll guard trigger switched off
// (the guard rightly refuses to approve a poll whose start time has passed).
// Exit code 1 if any check fails.

import { createRequire } from "node:module"
import { readFileSync, existsSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const here = dirname(fileURLToPath(import.meta.url))
const backendDir = resolve(here, "..")
const pgliteDir = process.env.PGLITE_DIR || process.cwd()
const requireFrom = createRequire(join(pgliteDir, "noop.js"))
const { PGlite } = requireFrom("@electric-sql/pglite")

const migrationPath =
  process.env.MIGRATION_PATH || join(backendDir, "app", "schemas", "migrations", "2026_11_18_monthly_feedback.sql")
if (!existsSync(migrationPath)) {
  console.error(`missing file: ${migrationPath}`)
  process.exit(2)
}
const migration = readFileSync(migrationPath, "utf8")

const results = []
let failures = 0
const pass = (label) => results.push(`PASS  ${label}`)
const fail = (label, why) => {
  failures += 1
  results.push(`FAIL  ${label}${why ? `: ${why}` : ""}`)
}
const check = (label, condition, why) => (condition ? pass(label) : fail(label, why))

// The file sets lock_timeout and statement_timeout right after begin (fail fast instead of
// queueing every save behind a lock), and only for its own transaction: nothing leaks out.
const startsWithTimeouts = (sql) => {
  const statements = sql
    .split(/\r?\n/)
    .map((line) => line.split("--")[0])
    .join(" ")
    .split(";")
    .map((s) => s.trim().replace(/\s+/g, " ").toLowerCase())
    .filter(Boolean)
  return statements[0] === "begin" && statements[1] === "set local lock_timeout = '5s'" && statements[2] === "set local statement_timeout = '120s'"
}
const timeoutsAfter = async (db) => {
  const lock = (await db.query("show lock_timeout")).rows[0].lock_timeout
  const stmt = (await db.query("show statement_timeout")).rows[0].statement_timeout
  return { lock, stmt }
}
const firstLine = (error) => String(error?.message ?? error).split("\n")[0].slice(0, 200)
const step = async (label, fn) => {
  try {
    const value = await fn()
    pass(label)
    return value
  } catch (error) {
    fail(label, firstLine(error))
    return undefined
  }
}
// Expects an error whose message or SQLSTATE contains `expected`.
const rejects = async (label, expected, fn) => {
  try {
    await fn()
    fail(label, "was allowed")
  } catch (error) {
    const text = `${error?.code ?? ""} ${error?.message ?? error}`
    if (expected && !text.includes(expected)) fail(label, `wrong error: ${firstLine(error)}`)
    else pass(`${label} (rejected: ${firstLine(error)})`)
  }
}

const BASE = `
  create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
  create table public.users (id uuid primary key default gen_random_uuid(), email text, email_verified boolean default false);
  grant select on public.users to service_role;
`
const KEY = (n) => n.toString(16).padStart(64, "0")
const TABLES = ["feedback_polls", "feedback_questions", "feedback_responses", "feedback_answers", "feedback_skips",
  "feedback_comment_themes", "feedback_theme_members", "feedback_admin_updates"]

const db = new PGlite()
await db.exec(BASE)
const q = async (sql, params = []) => (await db.query(sql, params)).rows
const one = async (sql, params = []) => (await q(sql, params))[0]
const asRole = async (role, fn) => {
  await db.exec(`set role ${role}`)
  try {
    return await fn()
  } finally {
    await db.exec("reset role")
  }
}

// ---------------------------------------------------------------- apply (twice: idempotent)
await step("migration applies", () => db.exec(migration))
await step("migration applies a second time (idempotent)", () => db.exec(migration))
check("the file sets lock_timeout 5s and statement_timeout 120s right after begin", startsWithTimeouts(migration))
{
  const t = await timeoutsAfter(db)
  check("the timeouts stay inside the file's transaction (nothing leaks to the session)", t.lock === "0" && t.stmt === "0", JSON.stringify(t))
}

for (const t of TABLES) {
  const row = await one("select relrowsecurity r from pg_class where oid = to_regclass($1)", [`public.${t}`])
  check(`RLS on: ${t}`, row?.r === true)
  for (const role of ["anon", "authenticated"]) {
    const priv = await one(
      `select has_table_privilege($1, $2, 'select') or has_table_privilege($1, $2, 'insert')
           or has_table_privilege($1, $2, 'update') or has_table_privilege($1, $2, 'delete') p`,
      [role, `public.${t}`],
    )
    check(`${role} has no privilege on ${t}`, priv?.p === false)
  }
}
const FUNCS = ["feedback_submit(uuid, uuid, text, jsonb, text, text[])", "feedback_save_questions(uuid, text[])",
  "feedback_totals(uuid)", "feedback_forget_voter_keys()"]
for (const f of FUNCS) {
  for (const role of ["anon", "authenticated"]) {
    const row = await one("select has_function_privilege($1, $2, 'execute') p", [role, `public.${f}`])
    check(`${role} cannot execute ${f}`, row?.p === false)
  }
  const sr = await one("select has_function_privilege('service_role', $1, 'execute') p", [`public.${f}`])
  check(`service_role can execute ${f}`, sr?.p === true)
}
const grants = {
  feedback_responses: { select: true, insert: false, delete: false },
  feedback_answers: { select: true, insert: false, update: false, delete: false },
  feedback_polls: { delete: false },
}
for (const [table, privs] of Object.entries(grants)) {
  for (const [priv, expected] of Object.entries(privs)) {
    const row = await one("select has_table_privilege('service_role', $1, $2) p", [`public.${table}`, priv])
    check(`service_role ${priv} on ${table} is ${expected}`, row?.p === expected)
  }
}

const definer = await one("select prosecdef d, proconfig c from pg_proc where oid = to_regprocedure('public.feedback_submit(uuid, uuid, text, jsonb, text, text[])')")
check("feedback_submit is security definer with search_path pinned", definer?.d === true && String(definer?.c).includes("search_path=public, pg_temp"), JSON.stringify(definer))
const voterKeyGrant = await one("select has_column_privilege('service_role', 'public.feedback_responses', 'voter_key', 'update') u, has_column_privilege('service_role', 'public.feedback_responses', 'poll_id', 'update') p")
check("service_role may update voter_key (to forget it) but not poll_id", voterKeyGrant.u === true && voterKeyGrant.p === false)

// ---------------------------------------------------------------- users
const verified = (await one("insert into public.users (email, email_verified) values ('a@example.test', true) returning id")).id
const verified2 = (await one("insert into public.users (email, email_verified) values ('b@example.test', true) returning id")).id
const unverified = (await one("insert into public.users (email, email_verified) values ('c@example.test', false) returning id")).id

// ---------------------------------------------------------------- drafts, wording lock, approval
const draft = (await one(
  "insert into public.feedback_polls (period_month, opens_at, closes_at) values ('2030-01-01', now() + interval '2 days', now() + interval '9 days') returning id",
)).id
await rejects("insert a poll as approved", "insert_as_draft", () =>
  q("insert into public.feedback_polls (period_month, opens_at, closes_at, approved_at) values ('2030-02-01', now() + interval '40 days', now() + interval '47 days', now())"))
await rejects("approve with no questions", "no_questions", () =>
  q("update public.feedback_polls set approved_at = now() where id = $1", [draft]))
await rejects("window longer than 31 days", "feedback_polls_window", () =>
  q("insert into public.feedback_polls (period_month, opens_at, closes_at) values ('2030-03-01', now(), now() + interval '32 days')"))
await rejects("period_month must be the 1st", "check", () =>
  q("insert into public.feedback_polls (period_month, opens_at, closes_at) values ('2030-03-02', now(), now() + interval '7 days')"))
const saved = await step("save questions on a draft", () =>
  one("select public.feedback_save_questions($1, $2::text[]) n", [draft, ["  Add a dark mode  ", "Make cards load faster"]]))
check("save questions returns the count", saved?.n === 2)
const labels = await q("select position, label from public.feedback_questions where poll_id = $1 order by position", [draft])
check("labels are trimmed and numbered", labels.length === 2 && labels[0].label === "Add a dark mode" && labels[1].position === 2)
await rejects("label shorter than 3 characters", "check", () =>
  q("select public.feedback_save_questions($1, $2::text[])", [draft, ["ok"]]))
const stillTwo = await one("select count(*)::int n from public.feedback_questions where poll_id = $1", [draft])
check("a failed save leaves the old questions", stillTwo.n === 2)

const pastDraft = (await one(
  "insert into public.feedback_polls (period_month, opens_at, closes_at) values ('2029-01-01', now() - interval '1 hour', now() + interval '6 days') returning id",
)).id
await q("select public.feedback_save_questions($1, $2::text[])", [pastDraft, ["Add a dark mode"]])
await rejects("approve a poll whose start time has passed", "opens_in_past", () =>
  q("update public.feedback_polls set approved_at = now() where id = $1", [pastDraft]))

await step("approve a draft that opens in the future", () =>
  q("update public.feedback_polls set approved_at = now() where id = $1", [draft]))
await rejects("insert a question on an approved poll", "wording_locked", () =>
  q("insert into public.feedback_questions (poll_id, position, label) values ($1, 3, 'Another change')", [draft]))
await rejects("edit a question on an approved poll", "wording_locked", () =>
  q("update public.feedback_questions set label = 'Changed wording' where poll_id = $1 and position = 1", [draft]))
await rejects("delete a question on an approved poll", "wording_locked", () =>
  q("delete from public.feedback_questions where poll_id = $1", [draft]))
await rejects("save_questions on an approved poll", "wording_locked", () =>
  q("select public.feedback_save_questions($1, $2::text[])", [draft, ["New wording here"]]))
await rejects("delete an approved poll", "wording_locked", () =>
  q("delete from public.feedback_polls where id = $1", [draft]))
await step("move an approved poll's dates before it opens", () =>
  q("update public.feedback_polls set opens_at = now() + interval '3 days', closes_at = now() + interval '10 days' where id = $1", [draft]))
await step("move an approved poll back to draft before it opens", () =>
  q("update public.feedback_polls set approved_at = null where id = $1", [draft]))
await step("re-approve", () => q("update public.feedback_polls set approved_at = now() where id = $1", [draft]))

// overlap
const overlapDraft = (await one(
  "insert into public.feedback_polls (period_month, opens_at, closes_at) values ('2030-04-01', now() + interval '4 days', now() + interval '11 days') returning id",
)).id
pass("overlapping drafts are fine")
await q("select public.feedback_save_questions($1, $2::text[])", [overlapDraft, ["Add a dark mode"]])
await rejects("two overlapping approved polls", "23P01", () =>
  q("update public.feedback_polls set approved_at = now() where id = $1", [overlapDraft]))

// ---------------------------------------------------------------- seeded open / closed / scheduled polls
async function seedPoll(month, opensSql, closesSql, labelsList, approve = true) {
  await db.exec("alter table public.feedback_polls disable trigger feedback_polls_guard")
  try {
    const id = (await one(
      `insert into public.feedback_polls (period_month, opens_at, closes_at) values ($1, ${opensSql}, ${closesSql}) returning id`,
      [month],
    )).id
    await q("select public.feedback_save_questions($1, $2::text[])", [id, labelsList])
    if (approve) await q("update public.feedback_polls set approved_at = now() - interval '2 days' where id = $1", [id])
    return id
  } finally {
    await db.exec("alter table public.feedback_polls enable trigger feedback_polls_guard")
  }
}
const open = await seedPoll("2028-01-01", "now() - interval '1 hour'", "now() + interval '1 day'",
  ["Add a dark mode", "Make cards load faster", "Add a phone app"])
const closed = await seedPoll("2027-01-01", "now() - interval '8 days'", "now() - interval '2 hours'", ["Add a dark mode"])
const scheduled = await seedPoll("2028-06-01", "now() + interval '1 day 1 hour'", "now() + interval '1 day 2 hours'", ["Add a dark mode"])
const openQs = (await q("select id, position from public.feedback_questions where poll_id = $1 order by position", [open])).map((r) => r.id)
const closedQ = (await one("select id from public.feedback_questions where poll_id = $1", [closed])).id

await rejects("dates of a started poll are locked", "wording_locked", () =>
  q("update public.feedback_polls set closes_at = closes_at + interval '1 day' where id = $1", [open]))
await rejects("unapprove a started poll", "wording_locked", () =>
  q("update public.feedback_polls set approved_at = null where id = $1", [open]))

const submit = (poll, user, key, answers, comment = null, flags = []) =>
  asRole("service_role", () =>
    one("select * from public.feedback_submit($1, $2, $3, $4::jsonb, $5, $6::text[])",
      [poll, user, key, JSON.stringify(answers), comment, flags]))

const ballot = [
  { question_id: openQs[0], wants_change: true },
  { question_id: openQs[1], wants_change: false },
]
const first = await step("verified student submits (as service_role)", () =>
  submit(open, verified, KEY(1), ballot, "Please add a dark mode", ["privacy"]))
check("first send is created", first?.created === true)
const again = await step("same student sends again", () =>
  submit(open, verified, KEY(1), [{ question_id: openQs[0], wants_change: false }]))
check("second send is not created and returns the first ballot", again?.created === false && again?.response_id === first?.response_id)
const counts1 = await one("select (select count(*)::int from public.feedback_responses where poll_id = $1) r, (select count(*)::int from public.feedback_answers where poll_id = $1) a", [open])
check("still one ballot and two answers", counts1.r === 1 && counts1.a === 2, JSON.stringify(counts1))
const firstAnswer = await one("select wants_change from public.feedback_answers where question_id = $1", [openQs[0]])
check("the retry did not change the first answer", firstAnswer.wants_change === true)

await rejects("unverified student", "email_unverified", () => submit(open, unverified, KEY(3), ballot))
await rejects("a question from another poll rolls back", "", () =>
  submit(open, verified2, KEY(2), [{ question_id: openQs[0], wants_change: true }, { question_id: closedQ, wants_change: true }]))
await rejects("a repeated question rolls back", "", () =>
  submit(open, verified2, KEY(2), [{ question_id: openQs[0], wants_change: true }, { question_id: openQs[0], wants_change: false }]))
await rejects("'maybe' is not an answer", "", () =>
  submit(open, verified2, KEY(2), [{ question_id: openQs[0], wants_change: "maybe" }]))
const afterBad = await one("select count(*)::int n from public.feedback_responses where user_id = $1", [verified2])
check("bad ballots left no response row behind", afterBad.n === 0)

await rejects("plain second insert for the same account", "23505", () =>
  q("insert into public.feedback_responses (poll_id, user_id, voter_key) values ($1, $2, $3)", [open, verified, KEY(9)]))
await rejects("plain second insert for the same email key", "23505", () =>
  q("insert into public.feedback_responses (poll_id, user_id, voter_key) values ($1, $2, $3)", [open, verified2, KEY(1)]))
await rejects("voter_key must be a 64-hex hash", "check", () =>
  q("insert into public.feedback_responses (poll_id, user_id, voter_key) values ($1, $2, 'someone@example.test')", [open, verified2]))
await rejects("a ballot without a voter_key is refused", "ballot_needs_voter", () =>
  q("insert into public.feedback_responses (poll_id, user_id, voter_key) values ($1, $2, null)", [open, verified2]))
await rejects("feedback_submit refuses a missing voter_key", "ballot_needs_voter", () =>
  submit(open, verified2, null, [{ question_id: openQs[0], wants_change: true }]))
await rejects("service_role cannot insert a ballot directly (only feedback_submit)", "permission denied", () =>
  asRole("service_role", () => q("insert into public.feedback_responses (poll_id, user_id, voter_key) values ($1, $2, $3)", [open, verified2, KEY(2)])))
await rejects("service_role cannot insert an answer directly", "permission denied", () =>
  asRole("service_role", () => q("insert into public.feedback_answers (response_id, poll_id, question_id, wants_change) values ($1, $2, $3, true)", [first.response_id, open, openQs[2]])))
await rejects("nobody can add an answer to an existing ballot", "ballot_immutable", () =>
  q("insert into public.feedback_answers (response_id, poll_id, question_id, wants_change) values ($1, $2, $3, true)", [first.response_id, open, openQs[2]]))
const stillTwoAnswers = await one("select count(*)::int n from public.feedback_answers where response_id = $1", [first.response_id])
check("the existing ballot still has its two answers", stillTwoAnswers.n === 2)

await rejects("scheduled poll refuses ballots", "poll_not_open", () => submit(scheduled, verified2, KEY(2), [{ question_id: openQs[0], wants_change: true }]))
await rejects("closed poll refuses ballots", "poll_closed", () => submit(closed, verified2, KEY(2), [{ question_id: closedQ, wants_change: true }]))
await rejects("draft poll refuses ballots", "poll_not_open", () =>
  q("insert into public.feedback_responses (poll_id, user_id, voter_key) values ($1, $2, $3)", [pastDraft, verified2, KEY(2)]))
const retryAfterClose = await step("a retry after close by someone who voted is acknowledged", async () => {
  await db.exec("alter table public.feedback_responses disable trigger feedback_responses_guard")
  try {
    await q("insert into public.feedback_responses (poll_id, user_id, voter_key) values ($1, $2, $3)", [closed, verified, KEY(1)])
  } finally {
    await db.exec("alter table public.feedback_responses enable trigger feedback_responses_guard")
  }
  return submit(closed, verified, KEY(1), [])
})
check("retry after close returns created=false", retryAfterClose?.created === false)

// comment rules
await rejects("comment over 500 characters", "check", () =>
  submit(open, verified2, KEY(2), [], "x".repeat(501)))
await rejects("comment with a control character", "check", () =>
  submit(open, verified2, KEY(2), [], "bell\u0007"))
const emoji = await step("500 emoji are accepted (code points, not bytes)", () =>
  submit(open, verified2, KEY(2), [{ question_id: openQs[0], wants_change: true }], "\u{1F600}".repeat(500)))
check("emoji ballot created", emoji?.created === true)

// totals
const third = (await one("insert into public.users (email, email_verified) values ('d@example.test', true) returning id")).id
await submit(open, third, KEY(4), [{ question_id: openQs[0], wants_change: true }, { question_id: openQs[1], wants_change: true }])
const totals = await asRole("service_role", () => q("select * from public.feedback_totals($1)", [open]))
const byPos = Object.fromEntries(totals.map((r) => [r.position, r]))
check("totals: question 1 has 3 yes 0 no", byPos[1]?.yes_count === 3 && byPos[1]?.no_count === 0, JSON.stringify(byPos[1]))
check("totals: question 2 has 1 yes 1 no (one skipped)", byPos[2]?.yes_count === 1 && byPos[2]?.no_count === 1)
check("totals: question 3 nobody answered", byPos[3]?.yes_count === 0 && byPos[3]?.no_count === 0)
check("totals: 3 participants", totals.every((r) => r.participants === 3))

// ballots never change
await rejects("owner cannot update an answer", "ballot_immutable", () =>
  q("update public.feedback_answers set wants_change = false where response_id = $1", [first.response_id]))
await rejects("service_role cannot update an answer", "permission denied", () =>
  asRole("service_role", () => q("update public.feedback_answers set wants_change = false where response_id = $1", [first.response_id])))
await rejects("service_role cannot delete a ballot", "permission denied", () =>
  asRole("service_role", () => q("delete from public.feedback_responses where id = $1", [first.response_id])))
await rejects("comment cannot be rewritten", "ballot_immutable", () =>
  asRole("service_role", () => q("update public.feedback_responses set comment = 'rewritten' where id = $1", [first.response_id])))
await rejects("a ballot cannot be moved to another account", "ballot_immutable", () =>
  asRole("service_role", () => q("update public.feedback_responses set user_id = $2 where id = $1", [first.response_id, verified2])))
await rejects("voter_key cannot change", "ballot_immutable", () =>
  asRole("service_role", () => q("update public.feedback_responses set voter_key = $2 where id = $1", [first.response_id, KEY(77)])))
await rejects("voter_key can't be forgotten while the account exists", "voter_key_in_use", () =>
  asRole("service_role", () => q("update public.feedback_responses set voter_key = null where id = $1", [first.response_id])))
await step("service_role can set urgent flags", () =>
  asRole("service_role", () => q("update public.feedback_responses set urgent_flags = '{security}', urgent_set_by_admin = true where id = $1", [first.response_id])))

// ---------------------------------------------------------------- account deletion
const theme = (await one("insert into public.feedback_comment_themes (poll_id, label, term, source) values ($1, 'Dark mode', 'dark mode', 'auto') returning id", [open])).id
await q("insert into public.feedback_theme_members (theme_id, poll_id, response_id, source) values ($1, $2, $3, 'auto')", [theme, open, first.response_id])
await q("insert into public.feedback_skips (poll_id, user_id) values ($1, $2)", [scheduled, verified])
await step("deleting the users row is not blocked", () => q("delete from public.users where id = $1", [verified]))
const kept = await one("select user_id, comment, urgent_flags, urgent_set_by_admin from public.feedback_responses where id = $1", [first.response_id])
check("ballot kept without the account", kept && kept.user_id === null)
check("comment deleted with the account", kept && kept.comment === null && kept.urgent_flags.length === 0 && kept.urgent_set_by_admin === false)
const keptAnswers = await one("select count(*)::int n from public.feedback_answers where response_id = $1", [first.response_id])
check("answers stay in the totals", keptAnswers.n === 2)
const members = await one("select count(*)::int n from public.feedback_theme_members where response_id = $1", [first.response_id])
check("theme links for the deleted comment are gone", members.n === 0)
const skips = await one("select count(*)::int n from public.feedback_skips where user_id = $1", [verified])
check("skip records go with the account", skips.n === 0)
const totalsAfter = await asRole("service_role", () => q("select * from public.feedback_totals($1)", [open]))
check("totals unchanged after deletion", totalsAfter.find((r) => r.position === 1)?.yes_count === 3 && totalsAfter[0].participants === 3)

// The email key: kept while the poll is open, forgotten once it has closed.
await rejects("an open poll's anonymous ballot keeps its voter_key", "voter_key_in_use", () =>
  asRole("service_role", () => q("update public.feedback_responses set voter_key = null where id = $1", [first.response_id])))
const closedBefore = await one("select count(*)::int n from public.feedback_responses where poll_id = $1 and voter_key = $2", [closed, KEY(1)])
check("before cleanup, the closed poll's anonymous ballot still has the email key", closedBefore.n === 1)
const forgot = await step("service_role runs feedback_forget_voter_keys", () =>
  asRole("service_role", () => one("select public.feedback_forget_voter_keys() n")))
check("cleanup clears exactly the closed poll's anonymous ballot", forgot?.n === 1, JSON.stringify(forgot))
const closedAfter = await one("select count(*)::int n, count(voter_key)::int k from public.feedback_responses where poll_id = $1", [closed])
check("a known email can no longer find the deleted account's closed-poll answers", closedAfter.n === 1 && closedAfter.k === 0)
const openKept = await one("select voter_key from public.feedback_responses where id = $1", [first.response_id])
check("the open poll's anonymous ballot keeps its email key", openKept.voter_key === KEY(1))
const forgotAgain = await asRole("service_role", () => one("select public.feedback_forget_voter_keys() n"))
check("cleanup is safe to run again", forgotAgain.n === 0)
await rejects("a forgotten voter_key can't be put back", "ballot_immutable", () =>
  asRole("service_role", () => q("update public.feedback_responses set voter_key = $2 where poll_id = $1", [closed, KEY(1)])))

// The backend's own deletion step (service role): clear user_id + comment on the ballot.
await q("insert into public.feedback_theme_members (theme_id, poll_id, response_id, source) values ($1, $2, $3, 'admin')", [theme, open, emoji.response_id])
await step("service_role can anonymize a ballot (backend deletion step)", () =>
  asRole("service_role", () => q("update public.feedback_responses set user_id = null, comment = null, urgent_flags = '{}', urgent_set_by_admin = false where user_id = $1", [verified2])))
const anon2 = await one("select user_id, comment from public.feedback_responses where id = $1", [emoji.response_id])
check("backend step leaves an anonymous ballot", anon2.user_id === null && anon2.comment === null)
const members2 = await one("select count(*)::int n from public.feedback_theme_members where response_id = $1", [emoji.response_id])
check("backend step removes theme links", members2.n === 0)

// Delete and sign up again with the same email: same voter_key, no second vote.
const reborn = (await one("insert into public.users (email, email_verified) values ('a@example.test', true) returning id")).id
const rebornVote = await step("re-created account sends a ballot", () => submit(open, reborn, KEY(1), ballot))
check("re-created account with the same email can't vote twice", rebornVote?.created === false)
const totalsReborn = await asRole("service_role", () => q("select participants from public.feedback_totals($1)", [open]))
check("participants unchanged after the re-created account tried", totalsReborn[0].participants === 3)

// ---------------------------------------------------------------- time zone
const dst = await one(`select
  ('2026-10-25 12:00 America/Chicago'::timestamptz = '2026-10-25T17:00:00Z') a,
  ('2026-11-01 12:00 America/Chicago'::timestamptz = '2026-11-01T18:00:00Z') b,
  ('2027-03-28 12:00 America/Chicago'::timestamptz = '2027-03-28T17:00:00Z') c,
  ('2026-11-29 12:00 America/Chicago'::timestamptz = '2026-11-29T18:00:00Z') d`)
check("Chicago noon converts across DST (Oct/Nov/Mar)", dst.a && dst.b && dst.c && dst.d, JSON.stringify(dst))

// ---------------------------------------------------------------- failure mid-file leaves nothing
{
  const fresh = new PGlite()
  await fresh.exec(BASE)
  const broken = migration.replace("notify pgrst, 'reload schema';", "select 1/0;")
  let threw = false
  try {
    await fresh.exec(broken)
  } catch {
    threw = true
    await fresh.exec("rollback").catch(() => {})
  }
  const left = (await fresh.query("select to_regclass('public.feedback_polls') t, to_regprocedure('public.feedback_totals(uuid)') f")).rows[0]
  check("a failure mid-file rolls everything back", threw && left.t === null && left.f === null)
  await fresh.close()
}

await db.close()
console.log(results.join("\n"))
console.log(`\nfeedback migration checks: ${results.length - failures} passed, ${failures} failed`)
process.exit(failures ? 1 : 0)
