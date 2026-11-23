// Proves backend/app/schemas/migrations/2026_11_24_subjects.sql on a throwaway in-memory
// Postgres (PGlite) shaped like the live database. Nothing here connects to a real database
// or reads any .env file. Synthetic rows only.
//
// HOW TO RUN (Git Bash), with PGLITE_DIR pointing at a folder whose node_modules has
// @electric-sql/pglite 0.5.x (on this PC: J:/LumaOps/pglite):
//   PGLITE_DIR=J:/LumaOps/pglite node backend/scripts/check_subjects_migration.mjs
// MIGRATION_PATH overrides the migration file (used to mutation-test this checker).
//
// What it does:
//  (a) builds the live replica (same builder as check_student_work_migration.mjs: live shape
//      fixture, Supabase stubs, the search triggers assumed live) and seeds synthetic rows;
//  (b) applies the migrations already live, then the three release-1 files, each twice, and
//      seeds shared and private rows the way the API wrote them before this file;
//  (c) applies this file twice;
//  (d) checks every pre-existing row and value is unchanged and the new columns are null;
//  (e) checks the slug shape checks (bad slug and a subtopic with no subject are refused);
//  (f) runs public_study_search on synthetic shared rows across 5 subjects and 3 types:
//      private rows and blank titles never show, "1+1" and "50%" match literally, every
//      word must match (any order), "U.S." folds to "us", short words match whole words only,
//      subject names match through each word's pairs, the facet counts follow the documented
//      rules, paging and p_user_ids work;
//  (g) checks only the service role may run the search;
//  (h) injects a failure mid-file and proves nothing changed;
//  (i) a hand-made column of another type stops the file (its guard) with nothing changed.
// Exit code 1 if any check fails.

import { createRequire } from "node:module"
import { readFileSync, existsSync, readdirSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const here = dirname(fileURLToPath(import.meta.url))
const backendDir = resolve(here, "..")
const pgliteDir = process.env.PGLITE_DIR || process.cwd()
const requireFrom = createRequire(join(pgliteDir, "noop.js"))
const { PGlite } = requireFrom("@electric-sql/pglite")
const { uuid_ossp } = requireFrom("@electric-sql/pglite/contrib/uuid_ossp")

const MIGRATIONS_DIR = join(backendDir, "app", "schemas", "migrations")
const FILE_NAME = "2026_11_24_subjects.sql"
const shapePath = join(here, "fixtures", "live_shape_2026_11_15.json")
const migrationPath = process.env.MIGRATION_PATH || join(MIGRATIONS_DIR, FILE_NAME)
for (const p of [shapePath, migrationPath]) {
  if (!existsSync(p)) {
    console.error(`missing file: ${p}`)
    process.exit(2)
  }
}
const shape = JSON.parse(readFileSync(shapePath, "utf8")).tables
const migration = readFileSync(migrationPath, "utf8")
// Release order is name order. `earlier`: already applied to production (2026_11_15 ..
// 2026_11_17). `releaseBefore`: the release-1 files that run before this one (2026_11_18
// feedback, 2026_11_19 maintenance, 2026_11_19 student work), proven on the replica too.
const LIVE_BEFORE = "2026_11_18"
const sqlFiles = readdirSync(MIGRATIONS_DIR).filter((name) => name.endsWith(".sql")).sort()
const earlier = sqlFiles.filter((name) => name < LIVE_BEFORE)
const releaseBefore = sqlFiles.filter((name) => name >= LIVE_BEFORE && name < FILE_NAME)

// ---------------------------------------------------------------- reporting
const results = []
let failures = 0
const pass = (label) => results.push(`PASS  ${label}`)
const fail = (label, why) => {
  failures += 1
  results.push(`FAIL  ${label}${why ? `: ${why}` : ""}`)
}
const info = (label) => results.push(`INFO  ${label}`)
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
const firstLine = (error) => String(error?.message ?? error).split("\n")[0].slice(0, 220)
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
const rejects = async (label, expectedCode, fn) => {
  try {
    await fn()
    fail(label, "was allowed")
  } catch (error) {
    if (expectedCode && error?.code !== expectedCode) fail(label, `wrong error ${error?.code}: ${firstLine(error)}`)
    else pass(`${label} (rejected ${error?.code ?? ""})`)
  }
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)

// ---------------------------------------------------------------- replica (as check_live_migration.mjs)
const ORDER = ["users", "profiles", ...Object.keys(shape).filter((t) => t !== "users" && t !== "profiles")]
const ident = (name) => `"${name.replace(/"/g, '""')}"`
const sqlLiteral = (value) => `'${String(value).replace(/'/g, "''")}'`

function columnSql(name, col) {
  const parts = [ident(name), col.format]
  if (col.default !== null && col.default !== undefined) {
    const d = col.default
    if (typeof d === "number" || typeof d === "boolean") parts.push(`default ${d}`)
    else if (/\(/.test(d)) parts.push(`default ${d}`)
    else parts.push(`default ${sqlLiteral(d)}`)
  }
  if (col.required && !col.pk) parts.push("not null")
  if (col.fk) {
    const m = /table='(\w+)' column='(\w+)'/.exec(col.fk)
    parts.push(`references public.${ident(m[1])}(${ident(m[2])})`)
  }
  return parts.join(" ")
}

function tableSql(table) {
  const cols = shape[table]
  const defs = Object.entries(cols).map(([name, col]) => columnSql(name, col))
  const pk = Object.entries(cols).filter(([, c]) => c.pk).map(([n]) => ident(n))
  if (pk.length) defs.push(`primary key (${pk.join(", ")})`)
  return `create table public.${ident(table)} (\n  ${defs.join(",\n  ")}\n);`
}

const LEGACY_SEARCH_TRIGGERS = `
create or replace function public.notes_search_vector_trigger() returns trigger language plpgsql as $$
begin
  new.search_vector := to_tsvector('english', coalesce(new.title, '') || ' ' || coalesce(new.content, '') || ' ' || coalesce(array_to_string(new.tags, ' '), ''));
  return new;
end; $$;
create or replace function public.flashcards_search_vector_trigger() returns trigger language plpgsql as $$
begin
  new.search_vector := to_tsvector('english', coalesce(new.front, '') || ' ' || coalesce(new.back, '') || ' ' || coalesce(array_to_string(new.tags, ' '), ''));
  return new;
end; $$;
create or replace function public.summaries_search_vector_trigger() returns trigger language plpgsql as $$
begin
  new.search_vector := to_tsvector('english', coalesce(new.content, ''));
  return new;
end; $$;
create or replace function public.transcripts_search_vector_trigger() returns trigger language plpgsql as $$
begin
  new.search_vector := to_tsvector('english', coalesce(new.content, ''));
  return new;
end; $$;
create trigger notes_search_update before insert or update on public.notes for each row execute function public.notes_search_vector_trigger();
create trigger flashcards_search_update before insert or update on public.flashcards for each row execute function public.flashcards_search_vector_trigger();
create trigger summaries_search_update before insert or update on public.summaries for each row execute function public.summaries_search_vector_trigger();
create trigger transcripts_search_update before insert or update on public.transcripts for each row execute function public.transcripts_search_vector_trigger();
`

const SUPABASE_STUBS = `
create schema if not exists extensions;
create extension if not exists "uuid-ossp" with schema extensions;
create schema if not exists storage;
create table storage.buckets (
  id text primary key, name text not null, owner uuid,
  created_at timestamptz default now(), updated_at timestamptz default now(),
  public boolean default false, avif_autodetection boolean default false,
  file_size_limit bigint, allowed_mime_types text[], owner_id text
);
create unique index bname on storage.buckets (name);
insert into storage.buckets (id, name, public, created_at) values ('avatars', 'avatars', true, '2025-01-01T00:00:00Z');
`

const U1 = "11111111-1111-4111-8111-111111111111"
const U2 = "22222222-2222-4222-8222-222222222222"
const SEED = `
insert into public.users (id, email, username, role, created_at, password_hash, email_verified, is_admin) values
 ('${U1}', 'one@example.test', 'one', 'user', '2025-02-01T10:00:00Z', null, true, false),
 ('${U2}', 'two@example.test', 'two', 'user', '2025-03-01T10:00:00Z', null, true, false);
insert into public.profiles (user_id, username, created_at, role) values
 ('${U1}', 'one', '2025-02-01T10:00:00Z', 'user'),
 ('${U2}', 'two', '2025-03-01T10:00:00Z', 'user');
insert into public.notes (id, user_id, title, content, tags, created_at, updated_at) values
 ('a0000000-0000-4000-8000-000000000001', '${U1}', 'Cells', 'SYNTH-MARKER mitochondria.', '{biology}', '2025-04-01 09:00:00', '2025-04-01T09:00:00Z'),
 ('a0000000-0000-4000-8000-000000000002', '${U2}', 'History', 'SYNTH-MARKER 1066.', '{}', '2025-04-03 09:00:00', null);
insert into public.flashcards (id, user_id, front, back, tags, created_at, updated_at) values
 ('b0000000-0000-4000-8000-000000000001', '${U1}', 'What is ATP?', 'Energy', '{biology}', '2025-05-01 09:00:00', '2025-05-01T09:00:00Z');
insert into public.summaries (id, user_id, content, created_at) values
 ('c0000000-0000-4000-8000-000000000001', '${U1}', 'SYNTH-MARKER summary.', '2025-06-01 09:00:00');
insert into public.study_sessions (id, user_id, name, subject, notes, duration_seconds, created_at) values
 ('d0000000-0000-4000-8000-000000000001', '${U1}', 'Morning', 'Biology', 'Chapter 2', 1500, '2025-07-01 08:00:00');
`

async function buildReplica() {
  const db = new PGlite({ extensions: { uuid_ossp } })
  await db.exec(SUPABASE_STUBS)
  for (const role of ["anon", "authenticated", "service_role"]) {
    try {
      await db.exec(`create role ${role} nologin`)
    } catch {
      /* roles are optional for these checks */
    }
  }
  for (const table of ORDER) await db.exec(tableSql(table))
  await db.exec(LEGACY_SEARCH_TRIGGERS)
  await db.exec(SEED)
  for (const name of earlier) await db.exec(readFileSync(join(MIGRATIONS_DIR, name), "utf8"))
  return db
}

/** This release's files before this one, in order, each run twice (all are safe to repeat). */
async function applyReleaseBefore(db) {
  for (const name of releaseBefore) {
    const sql = readFileSync(join(MIGRATIONS_DIR, name), "utf8")
    await db.exec(sql)
    await db.exec(sql)
  }
}

const SUBJECT_TABLES = ["notes", "flashcards", "summaries"]
const NEW_COLUMNS = ["subject_slug", "subtopic_slug"]

/** Every public row, with only the columns that existed before this file. */
async function dataSnapshot(db, columnsByTable) {
  const out = {}
  for (const [table, cols] of Object.entries(columnsByTable)) {
    const list = cols.map(ident).join(", ")
    const r = await db.query(`select coalesce(json_agg(row_to_json(x) order by row_to_json(x)::text), '[]'::json) as rows from (select ${list} from public.${ident(table)}) x`)
    out[table] = r.rows[0].rows
  }
  return out
}

async function columnsNow(db) {
  const r = await db.query(`select table_name, column_name from information_schema.columns where table_schema = 'public' order by table_name, ordinal_position`)
  const out = {}
  for (const row of r.rows) (out[row.table_name] ||= []).push(row.column_name)
  return out
}

async function schemaSnapshot(db) {
  const cols = await db.query(`
    select table_name, column_name, data_type, is_nullable, column_default
    from information_schema.columns where table_schema = 'public' order by 1, 2`)
  const cons = await db.query(`
    select conrelid::regclass::text as rel, conname, pg_get_constraintdef(oid) as def
    from pg_constraint where connamespace = 'public'::regnamespace order by 1, 2`)
  const idx = await db.query(`select tablename, indexname, indexdef from pg_indexes where schemaname = 'public' order by 1, 2`)
  const trg = await db.query(`
    select c.relname, t.tgname from pg_trigger t join pg_class c on c.oid = t.tgrelid
    where not t.tgisinternal order by 1, 2`)
  const rls = await db.query(`select relname, relrowsecurity from pg_class where relnamespace = 'public'::regnamespace and relkind = 'r' order by 1`)
  return { cols: cols.rows, cons: cons.rows, idx: idx.rows, trg: trg.rows, rls: rls.rows }
}

// PostgREST runs supabase-py's .insert/.update through json_populate_record(set).
async function insert(db, table, row) {
  const cols = Object.keys(row).map(ident).join(", ")
  const r = await db.query(
    `insert into public.${ident(table)} (${cols}) select ${cols} from json_populate_recordset(null::public.${ident(table)}, $1::json) returning *`,
    [JSON.stringify([row])],
  )
  return r.rows
}
async function update(db, table, values, where) {
  const cols = Object.keys(values).map(ident)
  const params = [JSON.stringify(values)]
  const conds = Object.entries(where).map(([k, v]) => {
    params.push(v)
    return `${ident(k)}::text = $${params.length}`
  })
  const r = await db.query(
    `update public.${ident(table)} set (${cols.join(", ")}) = (select ${cols.join(", ")} from json_populate_record(null::public.${ident(table)}, $1::json))
     where ${conds.join(" and ")} returning *`,
    params,
  )
  return r.rows
}

// ================================================================= main
const db = await buildReplica()
info(`replica built from ${shapePath.split(/[\\/]/).pop()}, then ${earlier.join(", ")}`)
check("the release files before this one are the three release-1 files", releaseBefore.length === 3 && releaseBefore[0].startsWith("2026_11_18"), releaseBefore.join(","))
await step(`apply the release files before this one, each twice: ${releaseBefore.join(", ")}`, () => applyReleaseBefore(db))

// Shared and private synthetic rows written the way the API wrote them before this file
// (no subject yet), so the file must leave every one of them exactly as it is.
await step("seed shared and private rows from before this file", async () => {
  await insert(db, "notes", { id: "e0000000-0000-4000-8000-000000000001", user_id: U1, title: "Old shared note", content: "SYNTH 1+1 is 2", tags: ["math"], is_public: true, published_at: "2025-08-01T10:00:00Z", published_by: "one", study_type: "note" })
  await insert(db, "notes", { id: "e0000000-0000-4000-8000-000000000002", user_id: U2, title: "", content: "SYNTH blank title shared", tags: [], is_public: true, published_at: "2025-08-02T10:00:00Z", study_type: "note" })
  await insert(db, "flashcards", { id: "e0000000-0000-4000-8000-000000000003", user_id: U2, title: "Old deck", front: "Hola", back: "Hello", cards: [{ id: "x1", front: "Hola", back: "Hello" }], tags: [], is_public: true, published_at: "2025-08-03T10:00:00Z", study_type: "flashcards" })
})
const columnsBefore = await columnsNow(db)
check("no table has the new columns yet", SUBJECT_TABLES.every((t) => NEW_COLUMNS.every((c) => !columnsBefore[t].includes(c))))
const beforeData = await dataSnapshot(db, columnsBefore)
const beforeSchema = await schemaSnapshot(db)
info(`seeded rows: ${SUBJECT_TABLES.map((t) => `${t}=${beforeData[t].length}`).join(", ")}`)

// (c) apply twice
await step("apply migration (first run)", () => db.exec(migration))
const afterFirstSchema = await schemaSnapshot(db)
const afterFirstData = await dataSnapshot(db, await columnsNow(db))
await step("apply migration again (idempotent second run)", () => db.exec(migration))
check("the file sets lock_timeout 5s and statement_timeout 120s right after begin", startsWithTimeouts(migration))
{
  const t = await timeoutsAfter(db)
  check("the timeouts stay inside the file's transaction (nothing leaks to the session)", t.lock === "0" && t.stmt === "0", JSON.stringify(t))
}
check("second run changes no schema object", same(afterFirstSchema, await schemaSnapshot(db)))
check("second run changes no row", same(afterFirstData, await dataSnapshot(db, await columnsNow(db))))

// (d) existing rows unchanged, new columns null
const afterData = await dataSnapshot(db, columnsBefore)
for (const table of Object.keys(columnsBefore)) {
  check(`existing ${table} rows and values unchanged (${beforeData[table].length} rows)`, same(beforeData[table], afterData[table]))
}
const lostCons = beforeSchema.cons.filter((c) => !afterFirstSchema.cons.some((d) => d.rel === c.rel && d.conname === c.conname && d.def === c.def))
check("every constraint still present and identical", lostCons.length === 0, JSON.stringify(lostCons))
const lostIdx = beforeSchema.idx.filter((c) => !afterFirstSchema.idx.some((d) => d.indexname === c.indexname && d.indexdef === c.indexdef))
check("every index still present and identical", lostIdx.length === 0, JSON.stringify(lostIdx))
const lostTrg = beforeSchema.trg.filter((c) => !afterFirstSchema.trg.some((d) => d.relname === c.relname && d.tgname === c.tgname))
check("every trigger still present", lostTrg.length === 0, JSON.stringify(lostTrg))
check("RLS settings unchanged", same(beforeSchema.rls, afterFirstSchema.rls))
const changedDefs = beforeSchema.cols.filter((c) => !afterFirstSchema.cols.some((d) => same(c, d)))
check("every old column keeps its type, nullability and default", changedDefs.length === 0, JSON.stringify(changedDefs))
const colDef = (table, column) => afterFirstSchema.cols.find((c) => c.table_name === table && c.column_name === column)
for (const table of SUBJECT_TABLES) {
  for (const column of NEW_COLUMNS) {
    const c = colDef(table, column)
    check(`${table}.${column} is nullable text with no default`, c?.data_type === "text" && c.is_nullable === "YES" && c.column_default === null, JSON.stringify(c))
  }
  const rows = (await db.query(`select count(*)::int n, count(*) filter (where subject_slug is null and subtopic_slug is null)::int ok from public.${ident(table)}`)).rows[0]
  check(`existing ${table} rows have no subject (${rows.n} rows)`, rows.n > 0 && rows.n === rows.ok)
  const index = afterFirstSchema.idx.find((i) => i.indexname === `${table}_public_subject_idx`)
  check(`${table} has the partial subject index on shared rows`, Boolean(index && /\(subject_slug, subtopic_slug, published_at DESC\) WHERE is_public$/.test(index.indexdef)), index?.indexdef)
  for (const name of [`${table}_subject_slug_shape`, `${table}_subtopic_slug_shape`]) {
    const con = afterFirstSchema.cons.find((c) => c.conname === name)
    check(`${name} check exists`, Boolean(con), JSON.stringify(con))
  }
}
const columnsAfter = await columnsNow(db)
const otherChanged = Object.keys(columnsBefore).filter((t) => !SUBJECT_TABLES.includes(t) && !same(columnsBefore[t], columnsAfter[t]))
check("no other table gained or lost a column", otherChanged.length === 0, otherChanged.join(", "))
const added = SUBJECT_TABLES.flatMap((t) => columnsAfter[t].filter((c) => !columnsBefore[t].includes(c)).map((c) => `${t}.${c}`))
check("exactly the 6 planned columns were added", same(added.sort(), [
  "flashcards.subject_slug", "flashcards.subtopic_slug", "notes.subject_slug", "notes.subtopic_slug", "summaries.subject_slug", "summaries.subtopic_slug"]), added.join(", "))

// (e) the shape checks
await rejects("a subject that isn't a slug (Math!) is refused", "23514", () =>
  insert(db, "notes", { user_id: U1, title: "Bad", content: "SYNTH", tags: [], subject_slug: "Math!" }))
await rejects("a subtopic with no subject is refused", "23514", () =>
  insert(db, "notes", { user_id: U1, title: "Bad", content: "SYNTH", tags: [], subtopic_slug: "algebra" }))
await rejects("a slug over 40 letters is refused", "23514", () =>
  insert(db, "summaries", { user_id: U1, title: "Bad", content: "SYNTH", tags: [], subject_slug: "a".repeat(41) }))
await step("a good subject and subtopic are stored", () =>
  insert(db, "flashcards", { user_id: U1, title: "Good", front: "Q", back: "A", tags: [], subject_slug: "math", subtopic_slug: "algebra" }))
await step("old code path: an insert with no subject still works", () =>
  insert(db, "notes", { user_id: U1, title: "Old shape", content: "SYNTH old", tags: [] }))
const setSubject = await update(db, "notes", { subject_slug: "biology", subtopic_slug: "cells" }, { id: "a0000000-0000-4000-8000-000000000001", user_id: U1 })
check("an update can set a subject on an old row (the search trigger still runs)", setSubject.length === 1 && setSubject[0].subject_slug === "biology" && setSubject[0].search_vector !== null)
await update(db, "notes", { subject_slug: null, subtopic_slug: null }, { id: "a0000000-0000-4000-8000-000000000001", user_id: U1 })

// (f) the search function on synthetic shared rows across 5 subjects and 3 types
const U3 = "33333333-3333-4333-8333-333333333333"
await db.exec(`insert into public.users (id, email, username, role, created_at, password_hash, email_verified, is_admin) values ('${U3}', 'three@example.test', 'three', 'user', '2025-02-01T10:00:00Z', null, true, false); insert into public.profiles (user_id, username, created_at, role) values ('${U3}', 'three', '2025-02-01T10:00:00Z', 'user');`)
const SUBJECTS = [["math", "algebra"], ["math", "geometry"], ["biology", "cells"], ["spanish", "vocabulary"], ["us-history", "civil-war"], [null, null]]
const shared = []
for (let i = 0; i < 36; i += 1) {
  const [subject, subtopic] = SUBJECTS[i % SUBJECTS.length]
  const kind = ["notes", "flashcards", "summaries"][i % 3]
  const owner = i % 4 === 0 ? U3 : U2
  const words = i % 5 === 0 ? `SYNTH ${i} what is 1+1` : `SYNTH ${i} plain words`
  const published = new Date(Date.UTC(2026, 0, 1 + i)).toISOString()
  const base = { user_id: owner, title: `Shared ${i}`, tags: i % 7 === 0 ? ["quiz"] : [], is_public: true, published_at: published, published_by: "spoof", subject_slug: subject, subtopic_slug: subtopic }
  const row = kind === "flashcards"
    ? { ...base, front: `Card ${i}`, back: "Back", cards: [{ id: "a", front: `Card ${i}`, back: "Back" }, { id: "b", front: words, back: "two" }], study_type: "flashcards" }
    : { ...base, content: words, study_type: kind === "notes" ? "note" : "summary" }
  await insert(db, kind, row)
  shared.push({ i, kind, subject, subtopic, owner, words, published })
}
await insert(db, "notes", { user_id: U2, title: "Private 1+1", content: "SYNTH private 1+1", tags: [], is_public: false, subject_slug: "math", subtopic_slug: "algebra" })
await insert(db, "flashcards", { user_id: U2, title: "  ", front: "1+1", back: "2", tags: [], is_public: true, published_at: "2026-03-01T00:00:00Z", subject_slug: "math" })
await insert(db, "summaries", { user_id: U2, title: "Percent", content: "SYNTH 50% off", tags: [], is_public: true, published_at: "2026-03-02T00:00:00Z", subject_slug: "math", subtopic_slug: "fractions" })
await insert(db, "summaries", { user_id: U2, title: "Fifty", content: "SYNTH 50 percent", tags: [], is_public: true, published_at: "2026-03-03T00:00:00Z" })
await insert(db, "notes", { user_id: U2, title: "U.S. history review", content: "SYNTH Newton's laws", tags: [], is_public: true, published_at: "2025-12-01T00:00:00Z" })
await insert(db, "notes", { user_id: U2, title: "Business plan", content: "SYNTH focus", tags: [], is_public: true, published_at: "2025-12-02T00:00:00Z" })
info(`seeded ${shared.length} shared rows for search, plus 1 private, 1 with a blank title, 2 percent rows and 2 word rows`)

const search = async (args = {}) => {
  const a = { terms: [], subject: null, subtopic: null, type: null, users: null, limit: 30, offset: 0, ...args }
  const r = await db.query(
    "select public.public_study_search($1::jsonb, $2, $3, $4, $5::uuid[], $6, $7) as answer",
    [JSON.stringify(a.terms), a.subject, a.subtopic, a.type, a.users, a.limit, a.offset],
  )
  return r.rows[0].answer
}
/** Terms like public_search.search_terms: a literal word, or a folded word (whole word under 3 letters). */
const lit = (like) => ({ like, word: null, pairs: [] })
const word = (w, pairs = []) => ({ like: w.length >= 4 ? `%${w}%` : null, word: w.length < 3 ? `% ${w} %` : `% ${w}%`, pairs })
const want = (pred) => shared.filter(pred).length
const count = (list, key, value) => list.find((f) => f[key] === value)?.count ?? 0
const oldShared = 2 // the old shared note and old deck (the blank-title one never shows)
const expectedAll = shared.length + 2 + 2 + oldShared
const all = await search()
check(`no filters: every shared item with a title (${expectedAll})`, all.total === expectedAll, String(all.total))
check("a page holds 30 rows, newest shared first", all.rows.length === 30 && all.rows[0].title === "Fifty" && all.rows[1].title === "Percent", all.rows.slice(0, 2).map((r) => r.title).join(","))
check("private rows never show", !all.rows.some((r) => r.title.startsWith("Private")) && (await search({ terms: [lit("%private%")] })).total === 0)
check("blank titles never show", (await search({ terms: [lit("%blank title%")] })).total === 0 && (await search({ users: [U2], limit: 500 })).rows.every((r) => r.title.trim()))
const rowKeys = Object.keys(all.rows[0]).sort().join(",")
check("each row has exactly the planned fields (no published_by)", rowKeys === "body,created_at,id,published_at,study_type,subject_slug,subtopic_slug,tags,title,user_id", rowKeys)
const page2 = await search({ offset: 30 })
check("offset 30 gives the rest, with no repeats", page2.rows.length === expectedAll - 30 && !page2.rows.some((r) => all.rows.some((x) => x.id === r.id)))
const onePlus = await search({ terms: [lit("%1+1%")] })
const wantOnePlus = want((s) => s.words.includes("1+1")) + 1 // + the old shared note
check(`q "1+1" finds only rows with 1+1 (${wantOnePlus})`, onePlus.total === wantOnePlus, String(onePlus.total))
check("q matches a deck by a card other than the first", onePlus.rows.some((r) => r.study_type === "flashcards"))
check("q never matches published_by", (await search({ terms: [word("spoof")] })).total === 0)
const pct = await search({ terms: [lit("%50\\%%")] })
check('q "50%" matches a literal % only', pct.total === 1 && pct.rows[0].title === "Percent", JSON.stringify(pct.rows.map((r) => r.title)))
const underscore = await search({ terms: [lit("%\\_%")] })
check('q "_" matches a literal _ only (none here)', underscore.total === 0, String(underscore.total))
const byName = await search({ terms: [word("algebra", [{ subject: "math", subtopic: "algebra" }])] })
check('q matching a subtopic name ("Algebra") also finds items in math/algebra', byName.total === want((s) => s.subtopic === "algebra"), String(byName.total))
const bySubjectName = await search({ terms: [word("biology", [{ subject: "biology", subtopic: null }])] })
check('q matching a subject name ("Biology") finds every biology item', bySubjectName.total === want((s) => s.subject === "biology"), String(bySubjectName.total))
check("subject counts (no filters) are per subject, with No subject as null", count(all.subjects, "slug", "math") === want((s) => s.subject === "math") + 1 && count(all.subjects, "slug", null) === want((s) => s.subject === null) + oldShared + 1 + 2, JSON.stringify(all.subjects))
check("no subtopic counts until a subject is chosen", all.subtopics.length === 0)
check("type counts add up to the total", all.types.reduce((n, f) => n + f.count, 0) === all.total, JSON.stringify(all.types))
check("counts are sorted high to low", all.subjects.every((f, i, list) => i === 0 || list[i - 1].count >= f.count))
const math = await search({ subject: "math" })
check("subject filter: total is math only", math.total === want((s) => s.subject === "math") + 1, String(math.total))
check("subject filter: subject counts still show the other subjects", same(math.subjects, all.subjects))
check("subject filter: subtopic counts for math", count(math.subtopics, "slug", "algebra") === want((s) => s.subtopic === "algebra") && count(math.subtopics, "slug", "geometry") === want((s) => s.subtopic === "geometry") && count(math.subtopics, "slug", "fractions") === 1, JSON.stringify(math.subtopics))
const mathAlg = await search({ subject: "math", subtopic: "algebra" })
check("subtopic filter: total is math/algebra only", mathAlg.total === want((s) => s.subtopic === "algebra"))
check("subtopic filter: subtopic counts ignore the chosen subtopic", same(mathAlg.subtopics, math.subtopics))
check("subtopic filter: type counts follow subject + subtopic", mathAlg.types.reduce((n, f) => n + f.count, 0) === mathAlg.total)
const mathAlgDecks = await search({ subject: "math", subtopic: "algebra", type: "flashcards" })
check("type filter narrows to decks in math/algebra", mathAlgDecks.total === want((s) => s.subtopic === "algebra" && s.kind === "flashcards") && mathAlgDecks.rows.every((r) => r.study_type === "flashcards"))
check("type filter: type counts ignore the chosen type", same(mathAlgDecks.types, mathAlg.types))
const decksOnly = await search({ type: "flashcards" })
check("type filter: subject counts follow the type", decksOnly.subjects.reduce((n, f) => n + f.count, 0) === decksOnly.total)
const combined = await search({ terms: [lit("%1+1%")], subject: "math" })
check("search words and filters combine", combined.total === want((s) => s.subject === "math" && s.words.includes("1+1")), String(combined.total))
const anyOrder = await search({ terms: [lit("%1+1%"), word("what")] })
const otherOrder = await search({ terms: [word("what"), lit("%1+1%")] })
check("every word must match, in any order (the old note has 1+1 but not \"what\")", anyOrder.total === wantOnePlus - 1 && otherOrder.total === anyOrder.total, `${anyOrder.total} ${otherOrder.total}`)
check("a word that matches nothing else makes the whole search empty", (await search({ terms: [lit("%1+1%"), word("plain")] })).total === 0)
const usHistory = await search({ terms: [word("us"), word("history")] })
check('"us history" finds "U.S. history review" ("U.S." folds to "us")', usHistory.total === 1 && usHistory.rows[0].title === "U.S. history review", JSON.stringify(usHistory.rows.map((r) => r.title)))
const us = await search({ terms: [word("us")] })
check('a short word is a whole word: "us" never finds "Business" or "focus"', us.total === 1 && !us.rows.some((r) => r.title === "Business plan"), JSON.stringify(us.rows.map((r) => r.title)))
check("a longer word finds the start of a word (newtons, hist)", (await search({ terms: [word("newtons")] })).total === 1 && (await search({ terms: [word("hist")] })).total === 1)
check("an empty term list finds everything", (await search({ terms: [] })).total === expectedAll)
const mine = await search({ users: [U3], limit: 500 })
check("p_user_ids limits to those owners", mine.total === want((s) => s.owner === U3) && mine.rows.every((r) => r.user_id === U3))
const none = await search({ subject: "chemistry" })
check("a subject with nothing shared gives 0 and no rows", none.total === 0 && none.rows.length === 0)
const capped = await search({ limit: 100000 })
check("the page size is capped at 500", capped.rows.length === Math.min(500, expectedAll))
const flashRow = all.rows.find((r) => r.study_type === "flashcards")
check("a deck's body is its first card's question", typeof flashRow?.body === "string" && flashRow.body.startsWith("Card"), flashRow?.body)

// (g) only the service role may run the search
const roles = (await db.query("select rolname from pg_roles where rolname in ('anon', 'authenticated', 'service_role') order by 1")).rows.map((r) => r.rolname)
if (roles.length === 3) {
  const can = async (role) => (await db.query(`select has_function_privilege('${role}', 'public.public_study_search(jsonb, text, text, text, uuid[], integer, integer)', 'execute') as ok`)).rows[0].ok
  check("anon can't run the search", (await can("anon")) === false)
  check("authenticated can't run the search", (await can("authenticated")) === false)
  check("service_role can run the search", (await can("service_role")) === true)
} else {
  info(`roles missing in this PGlite (${roles.join(",")}): grant checks skipped`)
}
const fn = (await db.query("select prosecdef, provolatile, proconfig from pg_proc where proname = 'public_study_search'")).rows[0]
check("the search runs with the caller's rights, is read-only (stable) and pins search_path", fn.prosecdef === false && fn.provolatile === "s" && String(fn.proconfig).includes("search_path=public, pg_temp"), JSON.stringify(fn))

// (h) a failure mid-file leaves everything as it was
const fresh = await buildReplica()
await applyReleaseBefore(fresh)
const freshBefore = await schemaSnapshot(fresh)
const broken = migration.replace(/create index if not exists flashcards_public_subject_idx/, "select 1/0; create index if not exists flashcards_public_subject_idx")
check("failure injection found its anchor", broken !== migration)
await rejects("the broken copy stops with an error", null, () => fresh.exec(broken))
try {
  await fresh.exec("rollback")
} catch {
  /* already rolled back */
}
check("after the failure nothing changed (all or nothing)", same(freshBefore, await schemaSnapshot(fresh)))

// (i) drift: production got a "subject_slug" column by hand with another type. "if not exists"
// would skip it, so the file's guard must stop and roll everything back.
const drifted = await buildReplica()
await applyReleaseBefore(drifted)
await drifted.exec("alter table public.notes add column subject_slug integer")
const driftedBefore = await schemaSnapshot(drifted)
await rejects("a hand-made notes.subject_slug of another type stops the file", null, () => drifted.exec(migration))
try {
  await drifted.exec("rollback")
} catch {
  /* already rolled back */
}
check("after the drift stop nothing changed (all or nothing)", same(driftedBefore, await schemaSnapshot(drifted)))
await drifted.close()
// The same with a text column that has a default: every check passes, so only the guard can stop it.
const defaulted = await buildReplica()
await applyReleaseBefore(defaulted)
await defaulted.exec("alter table public.summaries add column subject_slug text default 'math'")
const defaultedBefore = await schemaSnapshot(defaulted)
try {
  await defaulted.exec(migration)
  fail("a hand-made summaries.subject_slug with a default stops the file at the guard", "was allowed")
} catch (error) {
  check("a hand-made summaries.subject_slug with a default stops the file at the guard", /subject columns are not as expected: summaries\.subject_slug/.test(String(error?.message)), firstLine(error))
}
try {
  await defaulted.exec("rollback")
} catch {
  /* already rolled back */
}
check("after the guard stop nothing changed (all or nothing)", same(defaultedBefore, await schemaSnapshot(defaulted)))
await defaulted.close()

await db.close()
await fresh.close()
console.log(results.join("\n"))
console.log(failures ? `\n${failures} CHECK(S) FAILED` : `\nALL CHECKS PASSED (${results.filter((r) => r.startsWith("PASS")).length} pass, 0 fail)`)
process.exit(failures ? 1 : 0)
