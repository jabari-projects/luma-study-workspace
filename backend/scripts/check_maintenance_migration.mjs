// Proves backend/app/schemas/migrations/2026_11_19_maintenance_state.sql on a throwaway
// in-memory Postgres (PGlite) shaped like the live database. Nothing here connects to a real
// database or reads any .env file. Synthetic rows only.
//
// HOW TO RUN (Git Bash), with PGLITE_DIR pointing at a folder whose node_modules has
// @electric-sql/pglite 0.5.x (on this PC: J:/LumaOps/pglite):
//   PGLITE_DIR=J:/LumaOps/pglite node backend/scripts/check_maintenance_migration.mjs
// MIGRATION_PATH overrides the migration file (used to mutation-test this checker).
//
// What it does:
//  (a) builds the live replica (same builder as check_live_migration.mjs: live shape fixture,
//      Supabase stubs, the search triggers assumed live) and seeds synthetic rows;
//  (b) applies the migrations that come before this one (2026_11_15 .. 2026_11_18);
//  (c) applies this file twice;
//  (d) checks every pre-existing table, row and value is unchanged, the singleton row exists
//      (phase none, rev 1), RLS is on and anon/authenticated have no access;
//  (e) runs the backend's statement shapes the way PostgREST executes them: the
//      compare-and-swap on rev (1 row, then 0 rows), the instance upsert, job rows and log
//      rows, and the CHECK rules (one row only, known phases, reasons, kinds, backup stamp);
//  (f) injects a failure mid-file and proves nothing changed.
// PGlite has a single connection, so true concurrency is NOT exercised here; the backend's
// pytest suite covers racing admins and two instances with an in-memory fake.
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
const FILE_NAME = "2026_11_19_maintenance_state.sql"
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
// Everything that runs before this file, in name order (the release order): the live ones
// (2026_11_15 .. 2026_11_17), then this release's 2026_11_18 monthly feedback.
const earlier = readdirSync(MIGRATIONS_DIR)
  .filter((name) => name.endsWith(".sql") && name < FILE_NAME)
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
const ADMIN = "33333333-3333-4333-8333-333333333333"
const SEED = `
insert into public.users (id, email, username, role, created_at, password_hash, email_verified, is_admin) values
 ('${U1}', 'one@example.test', 'one', 'user', '2025-02-01T10:00:00Z', null, true, false),
 ('${ADMIN}', 'admin@example.test', 'admin', 'admin', '2025-01-01T10:00:00Z', null, true, true);
insert into public.profiles (user_id, username, created_at, role) values
 ('${U1}', 'one', '2025-02-01T10:00:00Z', 'user'),
 ('${ADMIN}', 'admin', '2025-01-01T10:00:00Z', 'admin');
insert into public.notes (id, user_id, title, content, tags, created_at, updated_at) values
 ('a0000000-0000-4000-8000-000000000001', '${U1}', 'Cells', 'SYNTH-MARKER mitochondria.', '{biology}', '2025-04-01 09:00:00', '2025-04-01T09:00:00Z');
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

const NEW_TABLES = ["maintenance_state", "maintenance_instances", "maintenance_jobs", "maintenance_log"]

/** Every row of the tables that existed before this file. */
async function dataSnapshot(db, tables) {
  const out = {}
  for (const table of tables) {
    const r = await db.query(`select coalesce(json_agg(row_to_json(x) order by row_to_json(x)::text), '[]'::json) as rows from public.${ident(table)} x`)
    out[table] = r.rows[0].rows
  }
  return out
}

async function tablesNow(db) {
  const r = await db.query(`select relname from pg_class where relnamespace = 'public'::regnamespace and relkind = 'r' order by 1`)
  return r.rows.map((row) => row.relname)
}

async function schemaSnapshot(db, onlyTables = null) {
  const keep = (rel) => !onlyTables || onlyTables.includes(String(rel).replace(/^public\./, ""))
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
  return {
    cols: cols.rows.filter((r) => keep(r.table_name)),
    cons: cons.rows.filter((r) => keep(r.rel)),
    idx: idx.rows.filter((r) => keep(r.tablename)),
    trg: trg.rows.filter((r) => keep(r.relname)),
    rls: rls.rows.filter((r) => keep(r.relname)),
  }
}

// PostgREST runs supabase-py's .insert/.update/.upsert through json_populate_record(set).
async function insert(db, table, row) {
  const cols = Object.keys(row).map(ident).join(", ")
  const r = await db.query(
    `insert into public.${ident(table)} (${cols}) select ${cols} from json_populate_recordset(null::public.${ident(table)}, $1::json) returning *`,
    [JSON.stringify([row])],
  )
  return r.rows
}
async function upsert(db, table, row, onConflict) {
  const cols = Object.keys(row).map(ident)
  const sets = cols.filter((c) => c !== ident(onConflict)).map((c) => `${c} = excluded.${c}`).join(", ")
  const r = await db.query(
    `insert into public.${ident(table)} (${cols.join(", ")}) select ${cols.join(", ")} from json_populate_recordset(null::public.${ident(table)}, $1::json)
     on conflict (${ident(onConflict)}) do update set ${sets} returning *`,
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
const oldTables = await tablesNow(db)
check("no maintenance table exists yet", NEW_TABLES.every((t) => !oldTables.includes(t)))
const beforeData = await dataSnapshot(db, oldTables)
const beforeSchema = await schemaSnapshot(db, oldTables)

// (c) apply twice
await step("migration applies", () => db.exec(migration))
await step("migration applies a second time (safe to run twice)", () => db.exec(migration))
check("the file sets lock_timeout 5s and statement_timeout 120s right after begin", startsWithTimeouts(migration))
{
  const t = await timeoutsAfter(db)
  check("the timeouts stay inside the file's transaction (nothing leaks to the session)", t.lock === "0" && t.stmt === "0", JSON.stringify(t))
}

// The tables maintenance.py counts before and after a break (COUNT_TABLES) and the column it
// probes on each (PROBE_COLUMNS, else "id") all exist once this release's files have run.
{
  const source = readFileSync(join(backendDir, "app", "maintenance.py"), "utf8")
  const block = source.match(/COUNT_TABLES = \(([^)]*)\)/)
  const counted = block ? [...block[1].matchAll(/"([a-z_]+)"/g)].map((m) => m[1]) : []
  const probeBlock = source.match(/PROBE_COLUMNS[^=]*= \{([^}]*)\}/)
  const probes = Object.fromEntries(probeBlock ? [...probeBlock[1].matchAll(/"([a-z_]+)": \("([a-z_]+)",\)/g)].map((m) => [m[1], m[2]]) : [])
  check("COUNT_TABLES read from maintenance.py includes transcripts and the feedback ballots", ["transcripts", "feedback_responses", "feedback_answers"].every((t) => counted.includes(t)), counted.join(","))
  for (const table of counted) {
    const column = probes[table] ?? "id"
    await step(`reopen checks can count and probe ${table}.${column}`, () => db.exec(`select count(*)::int n from public.${ident(table)}; select ${ident(column)} from public.${ident(table)} limit 0`))
  }
}

// (d) nothing old changed
check("every pre-existing row and value is unchanged", same(beforeData, await dataSnapshot(db, oldTables)))
check("every pre-existing table, column, constraint, index, trigger and RLS flag is unchanged", same(beforeSchema, await schemaSnapshot(db, oldTables)))
const nowTables = await tablesNow(db)
check("the four maintenance tables exist", NEW_TABLES.every((t) => nowTables.includes(t)), nowTables.join(","))
check("no table was removed", oldTables.every((t) => nowTables.includes(t)))

const single = (await db.query("select id, phase, rev::int rev, reason, note from public.maintenance_state")).rows
check("exactly one state row after two runs: id 1, phase none, rev 1", single.length === 1 && single[0].id === 1 && single[0].phase === "none" && single[0].rev === 1 && single[0].reason === "" && single[0].note === "", JSON.stringify(single))

for (const t of NEW_TABLES) {
  const row = (await db.query("select relrowsecurity r from pg_class where oid = to_regclass($1)", [`public.${t}`])).rows[0]
  check(`RLS on: ${t}`, row?.r === true)
  for (const role of ["anon", "authenticated"]) {
    const priv = (await db.query(
      `select has_table_privilege($1, $2, 'select') or has_table_privilege($1, $2, 'insert')
           or has_table_privilege($1, $2, 'update') or has_table_privilege($1, $2, 'delete') p`,
      [role, `public.${t}`],
    )).rows[0]
    check(`${role} has no access to ${t}`, priv?.p === false)
  }
  const sr = (await db.query(
    `select has_table_privilege('service_role', $1, 'select') and has_table_privilege('service_role', $1, 'insert')
        and has_table_privilege('service_role', $1, 'update') and has_table_privilege('service_role', $1, 'delete') p`,
    [`public.${t}`],
  )).rows[0]
  check(`service_role can use ${t}`, sr?.p === true)
}

// (e) the backend's statement shapes
await rejects("a second state row is refused", "23514", () => db.query("insert into public.maintenance_state (id) values (2)"))
await rejects("an unknown phase is refused", "23514", () => update(db, "maintenance_state", { phase: "reopened" }, { id: 1 }))
await rejects("an unknown reason is refused", "23514", () => update(db, "maintenance_state", { reason: "because" }, { id: 1 }))
await rejects("a note over 200 characters is refused", "23514", () => update(db, "maintenance_state", { note: "x".repeat(201) }, { id: 1 }))
await rejects("a backup stamp in the wrong shape is refused", "23514", () => update(db, "maintenance_state", { backup_ref: "G:/LumaBackups/x" }, { id: 1 }))

const cas1 = await update(
  db,
  "maintenance_state",
  { phase: "announced", rev: 2, reason: "database_update", note: "Short test break", start_at: "2026-12-01T11:00:00Z", estimated_end_at: "2026-12-01T12:00:00Z", updated_by: ADMIN, updated_at: "2026-11-19T10:00:00Z" },
  { id: 1, rev: "1" },
)
check("compare-and-swap with the right rev changes 1 row", cas1.length === 1 && String(cas1[0].rev) === "2" && cas1[0].phase === "announced")
const cas2 = await update(db, "maintenance_state", { phase: "draining", rev: 2 }, { id: 1, rev: "1" })
check("the same change from a stale admin tab changes 0 rows", cas2.length === 0)
const active = await update(
  db,
  "maintenance_state",
  { phase: "active", rev: 3, backup_ref: "20261201T105500Z", counts_at_activation: { users: 2, notes: 1 }, activated_at: "2026-12-01T11:00:00Z" },
  { id: 1, rev: "2" },
)
check("active with a backup stamp and counts (jsonb) is stored", active.length === 1 && active[0].counts_at_activation?.users === 2 && active[0].backup_ref === "20261201T105500Z")

const inst = await upsert(db, "maintenance_instances", { instance_id: "srv-a", in_flight: 2, phase_seen: "draining", heartbeat_at: "2026-12-01T10:59:00Z", code_version: "abc123" }, "instance_id")
const inst2 = await upsert(db, "maintenance_instances", { instance_id: "srv-a", in_flight: 0, phase_seen: "active", heartbeat_at: "2026-12-01T11:00:00Z", code_version: "abc123" }, "instance_id")
const instCount = (await db.query("select count(*)::int n from public.maintenance_instances")).rows[0].n
check("instance upsert writes one row per instance and keeps the newest count", inst.length === 1 && inst2[0].in_flight === 0 && instCount === 1)

await step("a job row for an AI request", () =>
  insert(db, "maintenance_jobs", { job_id: "e1000000-0000-4000-8000-000000000001", instance_id: "srv-a", kind: "ai_transcribe", started_at: "2026-12-01T10:58:00Z", expected_end_at: "2026-12-01T11:01:00Z" }))
await rejects("an unknown job kind is refused", "23514", () =>
  insert(db, "maintenance_jobs", { job_id: "e1000000-0000-4000-8000-000000000002", instance_id: "srv-a", kind: "mining", expected_end_at: "2026-12-01T11:01:00Z" }))
await rejects("a job without an expected end is refused", "23502", () =>
  db.query("insert into public.maintenance_jobs (job_id, instance_id, kind) values ('e1000000-0000-4000-8000-000000000003', 'srv-a', 'upload')"))
const del = await db.query("delete from public.maintenance_jobs where job_id = 'e1000000-0000-4000-8000-000000000001' returning job_id")
check("a finished job row is removed", del.rows.length === 1)

const log = await insert(db, "maintenance_log", { actor_user_id: ADMIN, action: "activate", from_phase: "draining", to_phase: "active", detail: { counts: { users: 2 } } })
check("a log row gets an id and time by default", log.length === 1 && log[0].id && log[0].at)
const bare = await insert(db, "maintenance_log", { action: "log_check" })
check("detail defaults to {}", same(bare[0].detail, {}))

// Deleting the admin account keeps the state and log rows, without the name.
await db.query("delete from public.profiles where user_id = $1", [ADMIN])
await step("the admin account can still be deleted", () => db.query("delete from public.users where id = $1", [ADMIN]))
const afterDelete = (await db.query("select updated_by from public.maintenance_state")).rows[0]
const logAfter = (await db.query("select count(*)::int n, count(actor_user_id)::int named from public.maintenance_log")).rows[0]
check("state and log rows stay, with the admin id set to null", afterDelete.updated_by === null && logAfter.n === 2 && logAfter.named === 0, JSON.stringify({ afterDelete, logAfter }))

// Running the file again later never resets a break that is on.
await step("migration applies a third time with a break on", () => db.exec(migration))
const stillActive = (await db.query("select phase, rev::int rev from public.maintenance_state")).rows[0]
check("re-running keeps the current phase and rev", stillActive.phase === "active" && stillActive.rev === 3, JSON.stringify(stillActive))

// (f) a failure mid-file leaves everything as it was
const fresh = await buildReplica()
const freshBefore = await schemaSnapshot(fresh)
const broken = migration.replace(/create table if not exists public\.maintenance_jobs/, "select 1/0; create table if not exists public.maintenance_jobs")
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
