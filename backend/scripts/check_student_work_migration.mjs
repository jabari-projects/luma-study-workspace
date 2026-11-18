// Proves backend/app/schemas/migrations/2026_11_19_student_work_versions.sql on a throwaway
// in-memory Postgres (PGlite) shaped like the live database. Nothing here connects to a real
// database or reads any .env file. Synthetic rows only.
//
// HOW TO RUN (Git Bash), with PGLITE_DIR pointing at a folder whose node_modules has
// @electric-sql/pglite 0.5.x (on this PC: J:/LumaOps/pglite):
//   PGLITE_DIR=J:/LumaOps/pglite node backend/scripts/check_student_work_migration.mjs
// MIGRATION_PATH overrides the migration file (used to mutation-test this checker).
//
// What it does:
//  (a) builds the live replica (same builder as check_live_migration.mjs: live shape fixture,
//      Supabase stubs, the search triggers assumed live) and seeds synthetic rows;
//  (b) applies the migrations that come before this one (2026_11_15 .. 2026_11_17);
//  (c) applies this file twice;
//  (d) checks every pre-existing row and value is unchanged, and the new columns hold
//      their defaults (version 1, create_key null, progress_rev 0);
//  (e) runs the backend's new statement shapes the way PostgREST executes them:
//      an insert with create_key, a retried insert with the same key (unique violation
//      23505, which the backend turns into a replay), the same key for another user (allowed),
//      and the compare-and-swap update `... where version = v` (1 row, then 0 rows);
//  (f) injects a failure mid-file and proves nothing changed.
// PGlite has a single connection, so true concurrency is NOT exercised here; the backend's
// pytest suite covers racing saves with an in-memory fake.
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
const FILE_NAME = "2026_11_19_student_work_versions.sql"
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
// Everything already written before this file (2026_11_15 .. 2026_11_17), in name order.
const earlier = readdirSync(MIGRATIONS_DIR)
  .filter((name) => name.endsWith(".sql") && name < "2026_11_18")
  .sort()

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

const STUDENT_TABLES = ["notes", "summaries", "flashcards", "study_sessions"]
const NEW_COLUMNS = ["version", "create_key", "progress_rev"]

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
const columnsBefore = await columnsNow(db)
check("no student table has the new columns yet", STUDENT_TABLES.every((t) => NEW_COLUMNS.every((c) => !columnsBefore[t].includes(c))))
const beforeData = await dataSnapshot(db, columnsBefore)
const beforeSchema = await schemaSnapshot(db)
info(`seeded rows: ${STUDENT_TABLES.map((t) => `${t}=${beforeData[t].length}`).join(", ")}`)

// (c) apply twice
await step("apply migration (first run)", () => db.exec(migration))
const afterFirstSchema = await schemaSnapshot(db)
const afterFirstData = await dataSnapshot(db, await columnsNow(db))
await step("apply migration again (idempotent second run)", () => db.exec(migration))
check("second run changes no schema object", same(afterFirstSchema, await schemaSnapshot(db)))
check("second run changes no row", same(afterFirstData, await dataSnapshot(db, await columnsNow(db))))

// (d) existing rows unchanged, new columns hold their defaults
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
const oldColumnDefs = beforeSchema.cols
const changedDefs = oldColumnDefs.filter((c) => !afterFirstSchema.cols.some((d) => same(c, d)))
check("every old column keeps its type, nullability and default", changedDefs.length === 0, JSON.stringify(changedDefs))

const colDef = (table, column) => afterFirstSchema.cols.find((c) => c.table_name === table && c.column_name === column)
for (const table of STUDENT_TABLES) {
  const v = colDef(table, "version")
  check(`${table}.version is bigint not null default 1`, v?.data_type === "bigint" && v.is_nullable === "NO" && v.column_default === "1", JSON.stringify(v))
  const k = colDef(table, "create_key")
  check(`${table}.create_key is a nullable uuid`, k?.data_type === "uuid" && k.is_nullable === "YES" && k.column_default === null, JSON.stringify(k))
  const rows = (await db.query(`select count(*)::int n, count(*) filter (where version = 1 and create_key is null)::int ok from public.${ident(table)}`)).rows[0]
  check(`existing ${table} rows got version 1 and no create_key (${rows.n} rows)`, rows.n > 0 && rows.n === rows.ok)
  const index = afterFirstSchema.idx.find((i) => i.indexname === `${table}_user_create_key_uidx`)
  check(`${table} has the per-user partial unique index`, Boolean(index && /unique/i.test(index.indexdef) && /\(user_id, create_key\)/.test(index.indexdef) && /where \(create_key is not null\)/i.test(index.indexdef)), index?.indexdef)
}
const pr = colDef("flashcards", "progress_rev")
check("flashcards.progress_rev is bigint not null default 0", pr?.data_type === "bigint" && pr.is_nullable === "NO" && pr.column_default === "0", JSON.stringify(pr))
check("existing decks have progress_rev 0", (await db.query("select bool_and(progress_rev = 0) ok from public.flashcards")).rows[0].ok === true)
const columnsAfter = await columnsNow(db)
const otherChanged = Object.keys(columnsBefore).filter((t) => !STUDENT_TABLES.includes(t) && !same(columnsBefore[t], columnsAfter[t]))
check("no other table gained or lost a column", otherChanged.length === 0, otherChanged.join(", "))
const added = STUDENT_TABLES.flatMap((t) => columnsAfter[t].filter((c) => !columnsBefore[t].includes(c)).map((c) => `${t}.${c}`))
check("exactly the 9 planned columns were added", same(added.sort(), [
  "flashcards.create_key", "flashcards.progress_rev", "flashcards.version", "notes.create_key", "notes.version",
  "study_sessions.create_key", "study_sessions.version", "summaries.create_key", "summaries.version"]), added.join(", "))

// (e) the backend's statement shapes
const KEY = "5f0c8a52-6a51-4f2e-9d1a-0b6f3c2d7e11"
const created = await step("old code path: an insert with no version or create_key still works (version defaults to 1)", () =>
  insert(db, "notes", { user_id: U1, title: "Old shape", content: "SYNTH old", tags: [], is_public: false, study_type: "note", updated_at: new Date().toISOString() }))
check("that insert got version 1", created?.[0]?.version === "1" || created?.[0]?.version === 1 || created?.[0]?.version === 1n, String(created?.[0]?.version))
const keyed = await step("new code path: insert with create_key", () =>
  insert(db, "notes", { user_id: U1, title: "Keyed", content: "SYNTH keyed", tags: [], create_key: KEY }))
check("keyed insert stored the key", keyed?.[0]?.create_key === KEY)
await rejects("the same key again for the same student is refused (23505, so the backend replays)", "23505", () =>
  insert(db, "notes", { user_id: U1, title: "Keyed copy", content: "SYNTH copy", tags: [], create_key: KEY }))
await step("the same key from another student is allowed (the index is per student)", () =>
  insert(db, "notes", { user_id: U2, title: "Other", content: "SYNTH other", tags: [], create_key: KEY }))
await step("many rows with no key are allowed", async () => {
  await insert(db, "notes", { user_id: U1, title: "No key 1", content: "SYNTH", tags: [] })
  await insert(db, "notes", { user_id: U1, title: "No key 2", content: "SYNTH", tags: [] })
})
const replay = (await db.query("select count(*)::int n from public.notes where user_id = $1 and create_key = $2", [U1, KEY])).rows[0].n
check("exactly one keyed row for that student", replay === 1)
for (const table of ["summaries", "flashcards", "study_sessions"]) {
  const row = table === "summaries" ? { user_id: U1, content: "SYNTH", create_key: KEY }
    : table === "flashcards" ? { user_id: U1, front: "Q", back: "A", tags: [], create_key: KEY }
      : { user_id: U1, name: "Plan", duration_seconds: 60, create_key: KEY }
  await step(`${table}: keyed insert works`, () => insert(db, table, row))
  await rejects(`${table}: same key, same student refused`, "23505", () => insert(db, table, row))
}

const noteId = "a0000000-0000-4000-8000-000000000001"
const cas1 = await update(db, "notes", { title: "Cells v2", version: 2 }, { id: noteId, user_id: U1, version: "1" })
check("compare-and-swap update with the right version changes 1 row", cas1.length === 1)
const cas2 = await update(db, "notes", { title: "Stale tab", version: 2 }, { id: noteId, user_id: U1, version: "1" })
check("the same update from a stale tab changes 0 rows", cas2.length === 0)
const now1 = (await db.query("select title, version::int v, search_vector is not null sv from public.notes where id = $1", [noteId])).rows[0]
check("the newer title is kept, version is 2, the search trigger still ran", now1.title === "Cells v2" && now1.v === 2 && now1.sv === true, JSON.stringify(now1))
const deck = "b0000000-0000-4000-8000-000000000001"
const prog = await update(db, "flashcards", { progress_rev: 1 }, { id: deck, user_id: U1, progress_rev: "0" })
check("progress merge bumps progress_rev and leaves version alone", prog.length === 1 && String(prog[0].version) === "1" && String(prog[0].progress_rev) === "1")
const deckCas = await update(db, "flashcards", { front: "Edited", version: 2 }, { id: deck, user_id: U1, version: "1", progress_rev: "0" })
check("a deck save that read progress_rev 0 changes nothing after progress moved (the backend merges again)", deckCas.length === 0)

// (f) a failure mid-file leaves everything as it was
const fresh = await buildReplica()
const freshBefore = await schemaSnapshot(fresh)
const broken = migration.replace(/create unique index if not exists flashcards_user_create_key_uidx/, "select 1/0; create unique index if not exists flashcards_user_create_key_uidx")
check("failure injection found its anchor", broken !== migration)
await rejects("the broken copy stops with an error", null, () => fresh.exec(broken))
try {
  await fresh.exec("rollback")
} catch {
  /* already rolled back */
}
check("after the failure nothing changed (all or nothing)", same(freshBefore, await schemaSnapshot(fresh)))

await db.close()
await fresh.close()
console.log(results.join("\n"))
console.log(failures ? `\n${failures} CHECK(S) FAILED` : `\nALL CHECKS PASSED (${results.filter((r) => r.startsWith("PASS")).length} pass, 0 fail)`)
process.exit(failures ? 1 : 0)
