// Proves backend/app/schemas/migrations/2026_11_15_bring_live_up_to_date.sql on a
// throwaway in-memory Postgres (PGlite) shaped like the live database.
// Nothing here connects to a real database or reads any .env file.
//
// HOW TO RUN (from a folder whose node_modules has @electric-sql/pglite 0.5.x):
//   cd <folder with node_modules/@electric-sql/pglite>
//   node <repo>/backend/scripts/check_live_migration.mjs [live_shape.json]
// For example (Git Bash, Luma worktree):
//   cd "$TEMP/claude/.../scratchpad/pgcheck" &&
//   node C:/Users/jabar/Documents/Luma/.claude/worktrees/luma-learning-platform-b6d3c1/backend/scripts/check_live_migration.mjs
// Or set PGLITE_DIR to that folder and run from anywhere. MIGRATION_PATH overrides the
// migration file (used to mutation-test this checker).
// The live shape defaults to backend/scripts/fixtures/live_shape_2026_11_15.json
// (column names, types, NOT NULL, defaults, PKs and FKs only; no rows).
//
// What it does:
//  (a) builds a replica of the live tables plus Supabase stubs (extensions schema with
//      uuid_generate_v4, storage.buckets holding "avatars", the anon/authenticated/
//      service_role roles) and the search triggers ASSUMED to exist live (the first
//      version of personal_search_schema.sql, limited to the four tables that have
//      search_vector live);
//  (b) inserts synthetic rows in the old shape;
//  (c) applies the migration twice;
//  (d) checks every pre-existing value is unchanged and the new defaults/backfills;
//  (e) runs the backend's insert/update/select shapes the way PostgREST executes them
//      (json_populate_recordset), so type coercion is exercised too;
//  (f) injects a failure mid-migration and proves nothing changed;
//  (g) installs password_hash_guard.sql afterwards and proves it coexists.
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
const { uuid_ossp } = requireFrom("@electric-sql/pglite/contrib/uuid_ossp")

const shapePath = process.argv[2] || join(here, "fixtures", "live_shape_2026_11_15.json")
const migrationPath = process.env.MIGRATION_PATH || join(backendDir, "app", "schemas", "migrations", "2026_11_15_bring_live_up_to_date.sql")
const guardPath = join(backendDir, "app", "schemas", "password_hash_guard.sql")
for (const p of [shapePath, migrationPath, guardPath]) {
  if (!existsSync(p)) {
    console.error(`missing file: ${p}`)
    process.exit(2)
  }
}
const shape = JSON.parse(readFileSync(shapePath, "utf8")).tables
const migration = readFileSync(migrationPath, "utf8")
const guardSql = readFileSync(guardPath, "utf8")

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
const expectRejected = async (label, fn) => {
  try {
    await fn()
    fail(label, "was allowed")
  } catch (error) {
    pass(`${label} (rejected: ${firstLine(error)})`)
  }
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)

// ---------------------------------------------------------------- replica builder
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
    parts.push(`references public.${ident(m[1])}(${ident(m[2])})`) // on delete unknown live: NO ACTION assumed
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

// Search triggers as they are ASSUMED to exist live: the first version of
// personal_search_schema.sql (summaries by content only, flashcards without title),
// on the four tables that have search_vector live. study_sessions has no
// search_vector live, so no trigger is assumed there (it would break every insert).
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
  id text primary key,
  name text not null,
  owner uuid,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  public boolean default false,
  avif_autodetection boolean default false,
  file_size_limit bigint,
  allowed_mime_types text[],
  owner_id text
);
create unique index bname on storage.buckets (name);
insert into storage.buckets (id, name, public, created_at) values ('avatars', 'avatars', true, '2025-01-01T00:00:00Z');
`

// Fixed ids so runs are comparable.
const U1 = "11111111-1111-4111-8111-111111111111" // legacy plain-text password
const U2 = "22222222-2222-4222-8222-222222222222" // hashed, legacy Stripe subscription
const U3 = "33333333-3333-4333-8333-333333333333" // admin, no password
const U4 = "44444444-4444-4444-8444-444444444444" // created by the new code, then deleted
const ARGON = "$argon2id$v=19$m=65536,t=3,p=4$c29tZXNhbHQ$aGFzaGhhc2hoYXNo"

const SEED = `
insert into public.users (id, email, username, theme_color, role, created_at, password, password_hash, email_verified, is_admin, verification_token, verification_expires_at, email_verification_sent_at, email_verification_token) values
 ('${U1}', 'one@example.test', 'one', 'midnight', 'user', '2025-02-01T10:00:00Z', 'plain-old-pw', null, false, false, 'legacy-vt', '2025-02-02T10:00:00Z', null, null),
 ('${U2}', 'two@example.test', 'two', 'ocean', 'user', '2025-03-01T10:00:00Z', '${ARGON}', '${ARGON}', true, false, null, null, '2025-03-01 10:05:00', 'abc123digest'),
 ('${U3}', 'admin@example.test', 'admin', default, 'admin', '2025-01-01T10:00:00Z', null, null, true, true, null, null, null, null);
insert into public.profiles (user_id, username, display_name, avatar_url, theme_color, custom_theme_image_url, timezone, theme_mode, phone_number, birthday, created_at, role) values
 ('${U1}', 'one', 'One O''Neil', 'https://x.test/storage/v1/object/public/avatars/${U1}/a.png', 'midnight', null, 'America/New_York', 'dark', null, '2001-04-05', '2025-02-01T10:00:00Z', 'user'),
 ('${U2}', 'two', 'Two', null, null, null, null, null, '+15550001111', null, '2025-03-01T10:00:00Z', 'user'),
 ('${U3}', 'admin', null, null, null, null, null, null, null, null, '2025-01-01T10:00:00Z', 'admin');
insert into public.notes (id, user_id, title, content, tags, created_at, updated_at) values
 ('a0000000-0000-4000-8000-000000000001', '${U1}', 'Cells', 'Mitochondria make ATP.', '{biology,cells}', '2025-04-01 09:00:00', '2025-04-01T09:00:00Z'),
 ('a0000000-0000-4000-8000-000000000002', '${U1}', 'Empty tags', 'No tags here', '{}', '2025-04-02 09:00:00', null),
 ('a0000000-0000-4000-8000-000000000003', '${U2}', 'History', 'The year 1066.', '{history}', '2025-04-03 09:00:00', '2025-04-03T09:00:00Z');
insert into public.flashcards (id, user_id, front, back, tags, created_at, updated_at) values
 ('b0000000-0000-4000-8000-000000000001', '${U1}', 'What is ATP?', 'Energy currency', '{biology}', '2025-05-01 09:00:00', '2025-05-01T09:00:00Z'),
 ('b0000000-0000-4000-8000-000000000002', '${U1}', 'H2O?', 'Water', '{}', '2025-05-02 09:00:00', null),
 ('b0000000-0000-4000-8000-000000000003', '${U2}', '1066?', 'Hastings', '{history}', '2025-05-03 09:00:00', '2025-05-03T09:00:00Z');
insert into public.summaries (id, user_id, content, created_at, source_type, source_id) values
 ('c0000000-0000-4000-8000-000000000001', '${U1}', 'Summary of cells.', '2025-06-01 09:00:00', 'note', 'a0000000-0000-4000-8000-000000000001'),
 ('c0000000-0000-4000-8000-000000000002', '${U2}', 'Summary of history.', '2025-06-02 09:00:00', null, null);
insert into public.study_sessions (id, user_id, name, subject, notes, duration_seconds, created_at) values
 ('d0000000-0000-4000-8000-000000000001', '${U1}', 'Morning', 'Biology', 'Chapter 2', 1500, '2025-07-01 08:00:00'),
 ('d0000000-0000-4000-8000-000000000002', '${U2}', 'Evening', null, null, 0, '2025-07-01 20:00:00');
insert into public.transcripts (id, user_id, content, created_at, source) values
 ('e0000000-0000-4000-8000-000000000001', '${U1}', 'Lecture transcript text.', '2025-08-01 10:00:00', 'upload');
insert into public.notifications (id, user_id, message, read, created_at) values
 ('f0000000-0000-4000-8000-000000000001', '${U1}', 'Welcome to Luma!', false, '2025-02-01T10:00:00Z'),
 ('f0000000-0000-4000-8000-000000000002', '${U1}', 'Your streak is 3 days', true, '2025-02-04T10:00:00Z'),
 ('f0000000-0000-4000-8000-000000000003', '${U2}', '', false, '2025-03-02T10:00:00Z');
insert into public.ai_usage (id, user_id, feature, tokens_used, created_at, type) values
 ('90000000-0000-4000-8000-000000000001', '${U1}', 'notes', 120, '2025-09-01T10:00:00Z', 'notes'),
 ('90000000-0000-4000-8000-000000000002', '${U1}', 'chat', 0, '2025-09-02T10:00:00Z', null);
insert into public.subscriptions (id, user_id, stripe_customer_id, stripe_subscription_id, status, current_period_end, created_at) values
 ('80000000-0000-4000-8000-000000000001', '${U2}', 'cus_legacy2', 'sub_legacy2', 'active', '2026-12-01T00:00:00Z', '2025-03-01T10:00:00Z'),
 ('80000000-0000-4000-8000-000000000002', '${U3}', 'cus_legacy3', 'sub_legacy3', 'canceled', '2025-06-01T00:00:00Z', '2025-01-01T10:00:00Z');
insert into public.email_verification_tokens (id, user_id, token, created_at, expires_at) values
 ('70000000-0000-4000-8000-000000000001', '${U1}', 'evt-1', '2025-02-01T10:00:00Z', '2025-02-02T10:00:00Z');
insert into public.password_reset_tokens (id, user_id, token, created_at, expires_at) values
 ('60000000-0000-4000-8000-000000000001', '${U2}', 'prt-1', '2025-03-05T10:00:00Z', '2025-03-06T10:00:00Z');
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
  return db
}

// ---------------------------------------------------------------- snapshots
const PK = (table) => Object.entries(shape[table]).filter(([, c]) => c.pk).map(([n]) => n)

async function dataSnapshot(db) {
  // Only the columns that exist live today, so new columns don't count as changes.
  const out = {}
  for (const table of ORDER) {
    const cols = Object.keys(shape[table]).map(ident).join(", ")
    const order = PK(table).map((c) => `x.${ident(c)}::text`).join(", ")
    const r = await db.query(`select coalesce(json_agg(row_to_json(x) order by ${order}), '[]'::json) as rows from (select ${cols} from public.${ident(table)}) x`)
    out[table] = r.rows[0].rows
  }
  const b = await db.query(`select coalesce(json_agg(row_to_json(b) order by b.id), '[]'::json) as rows from storage.buckets b`)
  out["storage.buckets"] = b.rows[0].rows
  return out
}

async function liveColumnDefs(db) {
  const r = await db.query(`
    select table_name, column_name, data_type, udt_name, is_nullable, column_default
    from information_schema.columns where table_schema = 'public'
    order by table_name, column_name`)
  const out = {}
  for (const row of r.rows) {
    if (shape[row.table_name] && shape[row.table_name][row.column_name]) out[`${row.table_name}.${row.column_name}`] = row
  }
  return out
}

async function schemaSnapshot(db) {
  const cols = await db.query(`
    select table_schema, table_name, column_name, data_type, is_nullable, column_default
    from information_schema.columns where table_schema in ('public', 'storage')
    order by 1, 2, 3`)
  const cons = await db.query(`
    select conrelid::regclass::text as rel, conname, pg_get_constraintdef(oid) as def
    from pg_constraint where connamespace in ('public'::regnamespace, 'storage'::regnamespace) order by 1, 2`)
  const idx = await db.query(`select schemaname, tablename, indexname, indexdef from pg_indexes where schemaname in ('public', 'storage') order by 1, 2, 3`)
  const trg = await db.query(`
    select c.relname, t.tgname, pg_get_triggerdef(t.oid) as def, p.prosrc
    from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_proc p on p.oid = t.tgfoid
    where not t.tgisinternal order by 1, 2`)
  const rls = await db.query(`
    select c.relname, c.relrowsecurity from pg_class c
    where c.relnamespace = 'public'::regnamespace and c.relkind = 'r' order by 1`)
  return { cols: cols.rows, cons: cons.rows, idx: idx.rows, trg: trg.rows, rls: rls.rows }
}

// ---------------------------------------------------------------- PostgREST-like helpers
// PostgREST turns a JSON body into SQL with json_populate_recordset, which is what
// supabase-py's .insert/.upsert/.update end up running. Reproducing that here
// exercises the same column-type coercions (ISO strings, JSON arrays, jsonb).
async function insert(db, table, rows) {
  const list = Array.isArray(rows) ? rows : [rows]
  const cols = [...new Set(list.flatMap((r) => Object.keys(r)))].map(ident).join(", ")
  const r = await db.query(
    `insert into public.${ident(table)} (${cols}) select ${cols} from json_populate_recordset(null::public.${ident(table)}, $1::json) returning *`,
    [JSON.stringify(list)],
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
async function select(db, table, columns, where = {}, tail = "") {
  const params = []
  const conds = Object.entries(where).map(([k, v]) => {
    params.push(v)
    return `${ident(k)}::text = $${params.length}`
  })
  const r = await db.query(
    `select ${columns} from public.${ident(table)} ${conds.length ? `where ${conds.join(" and ")}` : ""} ${tail}`,
    params,
  )
  return r.rows
}
async function del(db, table, where) {
  const params = []
  const conds = Object.entries(where).map(([k, v]) => {
    params.push(v)
    return `${ident(k)}::text = $${params.length}`
  })
  const r = await db.query(`delete from public.${ident(table)} where ${conds.join(" and ")} returning *`, params)
  return r.rows
}
const nowIso = () => new Date().toISOString()
const utcNaiveIso = () => new Date().toISOString().replace("Z", "") // datetime.utcnow().isoformat()

// ================================================================= main
const db = await buildReplica()
info(`replica built from ${shapePath.split(/[\\/]/).pop()} (${ORDER.length} tables) on PGlite ${(await db.query("select version() as v")).rows[0].v.split(" ").slice(0, 2).join(" ")}`)
info("assumed live search triggers: notes(title,content,tags), flashcards(front,back,tags), summaries(content), transcripts(content); none on study_sessions")
info("assumed live FK on-delete actions: NO ACTION (the API description does not show them)")

// (b) the old shape works as live does today: the code's inserts fail.
await expectRejected("before: ai_usage insert as the code sends it fails today (feature NOT NULL)", () =>
  insert(db, "ai_usage", { user_id: U1, type: "notes", created_at: utcNaiveIso() }))
await expectRejected("before: notifications insert as the code sends it fails today", () =>
  insert(db, "notifications", { id: "f0000000-0000-4000-8000-0000000000aa", user_id: U1, type: "system", actor_user_id: null, created_at: utcNaiveIso(), read: false, payload: null }))

const beforeData = await dataSnapshot(db)
const beforeDefs = await liveColumnDefs(db)
const beforeSchema = await schemaSnapshot(db)
info(`seeded rows: ${Object.entries(beforeData).map(([t, rows]) => `${t}=${rows.length}`).join(", ")}`)

// (c) apply twice
await step("apply migration (first run)", () => db.exec(migration))
const afterFirstData = await dataSnapshot(db)
const afterFirstSchema = await schemaSnapshot(db)
const firstRunNew = await db.query(`
  select json_agg(row_to_json(x) order by x.t, x.id) as rows from (
    select 'flashcards' t, id::text, row_to_json(f)::text j from public.flashcards f
    union all select 'notifications', id::text, row_to_json(n)::text from public.notifications n
    union all select 'summaries', id::text, row_to_json(s)::text from public.summaries s
    union all select 'profiles', user_id::text, row_to_json(p)::text from public.profiles p) x`)
await step("apply migration again (idempotent second run)", () => db.exec(migration))
const afterSecondSchema = await schemaSnapshot(db)
const secondRunNew = await db.query(`
  select json_agg(row_to_json(x) order by x.t, x.id) as rows from (
    select 'flashcards' t, id::text, row_to_json(f)::text j from public.flashcards f
    union all select 'notifications', id::text, row_to_json(n)::text from public.notifications n
    union all select 'summaries', id::text, row_to_json(s)::text from public.summaries s
    union all select 'profiles', user_id::text, row_to_json(p)::text from public.profiles p) x`)
check("second run changes no schema object (columns, constraints, indexes, triggers, RLS)", same(afterFirstSchema, afterSecondSchema))
check("second run changes no row (including new columns and backfills)", same(firstRunNew.rows[0].rows, secondRunNew.rows[0].rows))

// (d) existing data and definitions unchanged
const afterData = await dataSnapshot(db)
for (const table of ORDER) {
  const changed = !same(beforeData[table], afterData[table])
  check(`existing ${table} rows and values unchanged (${beforeData[table].length} rows${shape[table].search_vector ? ", incl. search_vector" : ""})`, !changed,
    changed ? "values differ" : undefined)
}
const bucketsAfter = afterData["storage.buckets"]
check("avatars bucket row unchanged", same(beforeData["storage.buckets"][0], bucketsAfter.find((b) => b.id === "avatars")))
check("themes bucket created and public", bucketsAfter.some((b) => b.id === "themes" && b.name === "themes" && b.public === true))

const afterDefs = await liveColumnDefs(db)
const intendedDefaultChanges = { "ai_usage.feature": "'ai'::text", "notifications.message": "''::text" }
const defDiffs = []
for (const key of Object.keys(beforeDefs)) {
  const a = beforeDefs[key]
  const b = afterDefs[key]
  if (!b) { defDiffs.push(`${key} missing`); continue }
  const same1 = a.data_type === b.data_type && a.udt_name === b.udt_name && a.is_nullable === b.is_nullable
  const defaultOk = intendedDefaultChanges[key] ? (a.column_default === null && b.column_default === intendedDefaultChanges[key]) : a.column_default === b.column_default
  if (!same1 || !defaultOk) defDiffs.push(`${key}: ${JSON.stringify(a)} -> ${JSON.stringify(b)}`)
}
check(`all ${Object.keys(beforeDefs).length} live columns keep type, nullability and default (only ai_usage.feature and notifications.message gain a default)`, defDiffs.length === 0, defDiffs.join("; "))
const lostConstraints = beforeSchema.cons.filter((c) => !afterFirstSchema.cons.some((d) => d.rel === c.rel && d.conname === c.conname && d.def === c.def))
check("every live constraint still present and identical", lostConstraints.length === 0, JSON.stringify(lostConstraints))
const lostIdx = beforeSchema.idx.filter((c) => !afterFirstSchema.idx.some((d) => d.indexname === c.indexname && d.indexdef === c.indexdef))
check("every live index still present and identical", lostIdx.length === 0, JSON.stringify(lostIdx))
const rlsBefore = Object.fromEntries(beforeSchema.rls.map((r) => [r.relname, r.relrowsecurity]))
const rlsAfter = Object.fromEntries(afterFirstSchema.rls.map((r) => [r.relname, r.relrowsecurity]))
check("RLS setting of every existing table untouched", Object.keys(rlsBefore).every((t) => rlsBefore[t] === rlsAfter[t]))
check("RLS enabled on new tables analytics_events, billing_accounts, billing_subscriptions",
  rlsAfter.analytics_events === true && rlsAfter.billing_accounts === true && rlsAfter.billing_subscriptions === true)
const pol = await db.query(`select count(*)::int n from pg_policies where tablename in ('analytics_events','billing_accounts','billing_subscriptions')`)
check("new tables have no policies (service role only)", pol.rows[0].n === 0)

// defaults and backfills on existing rows
const fc = await db.query(`select id::text, front, back, cards, title, is_public, study_type, published_at from public.flashcards where id::text like 'b0000000%' order by id`)
check("flashcards: each existing row got exactly one card {id: <id>-0, front, back, review: null}",
  fc.rows.every((r) => Array.isArray(r.cards) && r.cards.length === 1 && same(r.cards[0], { id: `${r.id}-0`, back: r.back, front: r.front, review: null })),
  JSON.stringify(fc.rows.map((r) => r.cards)))
check("flashcards: is_public false, study_type 'flashcards', title null on existing rows",
  fc.rows.every((r) => r.is_public === false && r.study_type === "flashcards" && r.title === null && r.published_at === null))
const nt = await db.query(`select is_public, study_type from public.notes`)
check("notes: is_public false and study_type 'note' on existing rows", nt.rows.every((r) => r.is_public === false && r.study_type === "note"))
const sm = await db.query(`select title, tags, is_public, study_type, updated_at from public.summaries`)
check("summaries: tags '{}', is_public false, study_type 'summary', updated_at filled on existing rows",
  sm.rows.every((r) => same(r.tags, []) && r.is_public === false && r.study_type === "summary" && r.title === null && r.updated_at !== null))
const pf = await db.query(`select user_id::text, subscription_status from public.profiles order by user_id`)
const pfBy = Object.fromEntries(pf.rows.map((r) => [r.user_id, r.subscription_status]))
check("profiles: 'premium' only for the account with a still-billable legacy subscription (U2 active), 'free' for U1 (none) and U3 (canceled)",
  pfBy[U1] === "free" && pfBy[U2] === "premium" && pfBy[U3] === "free", JSON.stringify(pfBy))
{
  // U2 is now what billing.is_unlinked_paid_account() and the deletion billing gate look for.
  const gate = await db.query(`select (select subscription_status from public.profiles where user_id = $1) s,
    (select count(*) from public.billing_accounts where user_id = $1)::int + (select count(*) from public.billing_subscriptions where user_id = $1)::int links`, [U2])
  check("U2 reads as an unlinked paid account (premium, no billing link), so deletion stops at billing_needs_review",
    gate.rows[0].s === "premium" && gate.rows[0].links === 0)
  // A later run must not overwrite a status the app has since set.
  await db.query(`update public.profiles set subscription_status = 'free' where user_id = $1`, [U2])
  await db.exec(migration)
  const kept = await db.query(`select subscription_status s from public.profiles where user_id = $1`, [U2])
  check("re-running the migration does not reset an app-set subscription_status", kept.rows[0].s === "free")
  await db.query(`update public.profiles set subscription_status = 'premium' where user_id = $1`, [U2])
}
const nf = await db.query(`select id::text, message, type, payload, actor_user_id from public.notifications order by id`)
check("notifications: type 'system' on existing rows, actor_user_id null", nf.rows.every((r) => r.type === "system" && r.actor_user_id === null))
check("notifications: payload.message copied from message where message is non-empty, else left null",
  nf.rows.every((r) => (r.message ? same(r.payload, { message: r.message }) : r.payload === null)))
const ss = await db.query(`select updated_at from public.study_sessions union all select updated_at from public.transcripts`)
check("study_sessions/transcripts: updated_at filled on existing rows", ss.rows.every((r) => r.updated_at !== null))
const au = await db.query(`select feature from public.ai_usage order by id`)
check("ai_usage: existing feature values kept", same(au.rows.map((r) => r.feature), ["notes", "chat"]))
const trg = await db.query(`select count(*)::int n from pg_trigger where not tgisinternal and tgname like '%_search_update'`)
check("five search triggers installed (notes, flashcards, summaries, transcripts, study_sessions)", trg.rows[0].n === 5)
const legacySubs = await db.query(`select count(*)::int n from public.subscriptions`)
const billingRows = await db.query(`select (select count(*) from public.billing_accounts)::int + (select count(*) from public.billing_subscriptions)::int n`)
check("legacy subscriptions not copied into billing tables", legacySubs.rows[0].n === 2 && billingRows.rows[0].n === 0)
const guardBefore = await db.query(`select count(*)::int n from pg_trigger where tgname = 'luma_password_hash_guard'`)
check("migration does not install the password guard", guardBefore.rows[0].n === 0)

// (e) every backend query shape against the migrated replica
await step("auth.create_user insert (id, email, password hash, username, created_at)", () =>
  insert(db, "users", { id: U4, email: "four@example.test", password: ARGON, username: "four", created_at: utcNaiveIso() }))
await step("main.create_profile insert (user_id, username '', created_at)", () =>
  insert(db, "profiles", { user_id: U4, username: "", created_at: utcNaiveIso() }))
await step("users select * by email / id / username, select password, select role", async () => {
  for (const [k, v] of [["email", "four@example.test"], ["id", U4], ["username", "four"]]) {
    const rows = await select(db, "users", "*", { [k]: v })
    if (rows.length !== 1) throw new Error(`select by ${k} returned ${rows.length}`)
  }
  await select(db, "users", "password", { id: U1 })
  await select(db, "users", "role", { id: U3 })
  await select(db, "users", "email, username, email_verified", { id: U4 })
})
await step("issue_password_reset_token update (password_reset_token, password_reset_sent_at)", async () => {
  const rows = await update(db, "users", { password_reset_token: "f".repeat(64), password_reset_sent_at: utcNaiveIso() }, { id: U1 })
  if (rows.length !== 1) throw new Error("no row updated")
})
await step("get_user_by_password_reset_token select", async () => {
  const rows = await select(db, "users", "*", { password_reset_token: "f".repeat(64) })
  if (rows.length !== 1 || rows[0].password !== "plain-old-pw") throw new Error("lookup failed or password changed")
})
await step("reset password update (password hash, clear token and sent_at)", () =>
  update(db, "users", { password: ARGON, password_reset_token: null, password_reset_sent_at: null }, { id: U4 }))
await step("email verification updates (token+sent_at, then verified + cleared)", async () => {
  await update(db, "users", { email_verification_token: "e".repeat(64), email_verification_sent_at: utcNaiveIso() }, { id: U4 })
  await select(db, "users", "*", { email_verification_token: "e".repeat(64) })
  await update(db, "users", { email_verified: true, email_verification_token: null, email_verification_sent_at: null }, { id: U4 })
})
await step("change username / email updates", async () => {
  await update(db, "users", { username: "four_b" }, { id: U4 })
  await update(db, "users", { email: "four.b@example.test" }, { id: U4 })
})
await step("update_profile (display_name, theme_color, timezone, theme_mode, phone_number, birthday)", () =>
  update(db, "profiles", { display_name: "Four", theme_color: "ocean", timezone: "UTC", theme_mode: "light", phone_number: "+1555", birthday: "2000-01-01" }, { user_id: U4 }))
await step("update_profile avatar_url and custom_theme_image_url", async () => {
  await update(db, "profiles", { avatar_url: `https://x.test/storage/v1/object/public/avatars/${U4}/p.png` }, { user_id: U4 })
  await update(db, "profiles", { custom_theme_image_url: `https://x.test/storage/v1/object/public/themes/themes/${U4}/t.png` }, { user_id: U4 })
})
await step("set_subscription_status / billing.refresh_subscription_status update", () =>
  update(db, "profiles", { subscription_status: "premium" }, { user_id: U4 }))
await step("public_search people lookup (user_id, username) ilike, exact then contains", async () => {
  await db.query(`select user_id, username from public.profiles where username ilike $1 limit 5`, ["four\\_b"])
  await db.query(`select user_id, username from public.profiles where username ilike $1 limit 100`, ["%fo%"])
})

const publishCreate = (studyType) => ({ is_public: false, published_at: null, published_by: null, study_type: studyType, updated_at: nowIso() })
const publishOn = (studyType) => ({ is_public: true, published_at: nowIso(), published_by: "four_b", study_type: studyType, updated_at: utcNaiveIso() })
const publishOff = () => ({ is_public: false, published_at: null, published_by: null, updated_at: utcNaiveIso() })

const note = (await step("notes create (user_id, title, content, tags, publish fields)", async () =>
  (await insert(db, "notes", { user_id: U4, title: "Four's note", content: "Body", tags: ["a", "b"], ...publishCreate("note") }))[0]))
if (note) {
  await step("notes update with publish (title, content, tags, is_public, published_at, published_by, study_type, updated_at)", () =>
    update(db, "notes", { title: "Four's note v2", content: "Body 2", tags: ["c"], ...publishOn("note") }, { id: note.id, user_id: U4 }))
  const sv = await db.query(`select search_vector::text v from public.notes where id = $1`, [note.id])
  check("notes search_vector covers title + content + tags after update", /'v2'|'note'/.test(sv.rows[0].v) && /'bodi'|'body'/.test(sv.rows[0].v) && /'c'/.test(sv.rows[0].v), sv.rows[0].v)
}
const card = (await step("flashcards create (user_id, title, cards, front, back, tags, publish fields)", async () =>
  (await insert(db, "flashcards", {
    user_id: U4, title: "Deck", cards: [{ id: "c1", front: "Q1", back: "A1", review: null }, { id: "c2", front: "Q2", back: "A2", review: { due: "2026-11-20" } }],
    front: "Q1", back: "A1", tags: ["deck"], ...publishCreate("flashcards"),
  }))[0]))
if (card) {
  await step("flashcards update cards + publish", () =>
    update(db, "flashcards", { cards: [{ id: "c1", front: "Q1b", back: "A1b", review: null }], front: "Q1b", back: "A1b", title: "Deck 2", ...publishOn("flashcards") }, { id: card.id, user_id: U4 }))
  const sv = await db.query(`select search_vector::text v from public.flashcards where id = $1`, [card.id])
  check("flashcards search_vector now includes the title", /'deck'/.test(sv.rows[0].v), sv.rows[0].v)
}
await step("flashcards publish an OLD row (existing front/back row, adding a title)", () =>
  update(db, "flashcards", { title: "ATP", ...publishOn("flashcards") }, { id: "b0000000-0000-4000-8000-000000000001", user_id: U1 }))
const summary = (await step("summaries create (user_id, title, content, tags, publish fields)", async () =>
  (await insert(db, "summaries", { user_id: U4, title: "Sum", content: "Summary body", tags: ["s"], ...publishCreate("summary") }))[0]))
if (summary) {
  await step("summaries update with publish", () =>
    update(db, "summaries", { title: "Sum 2", tags: ["s", "t"], ...publishOn("summary") }, { id: summary.id, user_id: U4 }))
  await step("summaries unpublish (is_public false clears published_at/by)", () =>
    update(db, "summaries", publishOff(), { id: summary.id, user_id: U4 }))
}
await step("notes unpublish", () => note && update(db, "notes", publishOff(), { id: note.id, user_id: U4 }))
const session = (await step("study_sessions create (user_id, name, subject, notes, duration_seconds, updated_at)", async () =>
  (await insert(db, "study_sessions", { user_id: U4, name: "Night", subject: "Math", notes: "Ch 1", duration_seconds: 600, updated_at: utcNaiveIso() }))[0]))
if (session) {
  await step("study_sessions update (name, duration_seconds, updated_at)", () =>
    update(db, "study_sessions", { name: "Night 2", duration_seconds: 900, updated_at: utcNaiveIso() }, { id: session.id, user_id: U4 }))
}
const transcript = (await step("transcripts create (user_id, content, updated_at)", async () =>
  (await insert(db, "transcripts", { user_id: U4, content: "Spoken words", updated_at: utcNaiveIso() }))[0]))
if (transcript) {
  await step("transcripts update (content, updated_at)", () =>
    update(db, "transcripts", { content: "Spoken words 2", updated_at: utcNaiveIso() }, { id: transcript.id, user_id: U4 }))
}
await step("list selects (select * where user_id order by created_at desc) for all five study tables", async () => {
  for (const t of ["notes", "flashcards", "summaries", "study_sessions", "transcripts"]) {
    await select(db, t, "*", { user_id: U4 }, "order by created_at desc")
  }
})
await step("public search selects (exact column lists, is_public = true order by published_at desc limit 100)", async () => {
  const n = await db.query(`select id, user_id, title, content, tags, created_at, is_public, published_at, study_type from public.notes where is_public = true order by published_at desc limit 100`)
  const f = await db.query(`select id, user_id, title, front, back, tags, created_at, is_public, published_at, study_type from public.flashcards where is_public = true order by published_at desc limit 100`)
  const s = await db.query(`select id, user_id, title, content, tags, created_at, is_public, published_at, study_type from public.summaries where is_public = true order by published_at desc limit 100`)
  if (f.rows.length !== 2) throw new Error(`expected 2 public flashcards, got ${f.rows.length}`)
  await db.query(`select user_id, username from public.profiles where user_id::text = any($1::text[])`, [[U1, U4]])
  return [n.rows.length, f.rows.length, s.rows.length]
})
await step("public_search people items (is_public = true and user_id in the looked-up ids, limit 500)", async () => {
  for (const t of ["notes", "summaries"]) {
    await db.query(`select id, user_id, title, content, tags, created_at, is_public, published_at, study_type from public.${t} where is_public = true and user_id::text = any($1::text[]) order by published_at desc limit 500`, [[U1, U4]])
  }
  await db.query(`select id, user_id, title, front, back, tags, created_at, is_public, published_at, study_type from public.flashcards where is_public = true and user_id::text = any($1::text[]) order by published_at desc limit 500`, [[U1, U4]])
})
await step("ai_usage insert with only (user_id, type, created_at)", async () => {
  const rows = await insert(db, "ai_usage", { user_id: U4, type: "notes", created_at: utcNaiveIso() })
  if (rows[0].feature !== "ai") throw new Error(`feature = ${rows[0].feature}`)
})
await step("ai_usage daily count select (id where user_id, type, created_at >= day start)", () =>
  db.query(`select id from public.ai_usage where user_id::text = $1 and type = $2 and created_at >= $3 limit 3`, [U4, "notes", utcNaiveIso().slice(0, 10) + "T00:00:00"]))
await step("notifications insert as create_notification sends it (no message)", async () => {
  const rows = await insert(db, "notifications", { id: "f0000000-0000-4000-8000-0000000000b1", user_id: U1, type: "system", actor_user_id: U4, created_at: utcNaiveIso(), read: false, payload: { message: "Hello" } })
  if (rows[0].message !== "") throw new Error("message default not applied")
})
await step("notifications insert with payload null", () =>
  insert(db, "notifications", { id: "f0000000-0000-4000-8000-0000000000b2", user_id: U4, type: "system", actor_user_id: null, created_at: utcNaiveIso(), read: false, payload: null }))
await expectRejected("notifications type outside ('system') rejected by check constraint", () =>
  insert(db, "notifications", { id: "f0000000-0000-4000-8000-0000000000b3", user_id: U4, type: "friend_request", created_at: utcNaiveIso(), read: false }))
await step("notifications list select (id, type, actor_user_id, created_at, read, payload where type='system')", async () => {
  const r = await db.query(`select id, type, actor_user_id, created_at, read, payload from public.notifications where user_id::text = $1 and type = 'system' order by created_at desc`, [U1])
  if (r.rows.length !== 3) throw new Error(`expected 3 for U1, got ${r.rows.length}`)
})
await step("notifications mark read (update read where user_id and id in (...))", () =>
  db.query(`update public.notifications set read = true where user_id::text = $1 and id::text = any($2::text[]) returning id`, [U1, ["f0000000-0000-4000-8000-000000000001"]]))
await step("analytics_events insert (anonymous and signed-in rows in one batch)", () =>
  insert(db, "analytics_events", [
    { user_id: null, event_name: "page_view", event_group: "navigation", page_path: "/", feature_key: null, subscription_tier: null, surface: null, metadata: {}, created_at: nowIso() },
    { user_id: U4, event_name: "feature_usage", event_group: "feature", page_path: "/notes", feature_key: "notes", subscription_tier: "free", surface: "web", metadata: { n: 1, ok: true, s: "x" }, created_at: nowIso() },
  ]))
await step("billing_accounts upsert on_conflict user_id (insert, then update)", async () => {
  await upsert(db, "billing_accounts", { user_id: U4, stripe_customer_id: "cus_four", updated_at: nowIso() }, "user_id")
  await upsert(db, "billing_accounts", { user_id: U4, stripe_customer_id: "cus_four", updated_at: nowIso() }, "user_id")
})
await step("billing_subscriptions upsert on_conflict stripe_subscription_id (insert, then status change)", async () => {
  const row = { stripe_subscription_id: "sub_four", user_id: U4, stripe_customer_id: "cus_four", status: "active", current_period_end: "2026-12-15T00:00:00+00:00", updated_at: nowIso() }
  await upsert(db, "billing_subscriptions", row, "stripe_subscription_id")
  await upsert(db, "billing_subscriptions", { ...row, status: "past_due" }, "stripe_subscription_id")
})
await step("billing selects (by user_id, by stripe_customer_id, by stripe_subscription_id)", async () => {
  await select(db, "billing_accounts", "*", { user_id: U4 }, "limit 1")
  await select(db, "billing_accounts", "*", { stripe_customer_id: "cus_four" }, "limit 1")
  await select(db, "billing_subscriptions", "*", { stripe_subscription_id: "sub_four" }, "limit 1")
  await select(db, "billing_subscriptions", "*", { user_id: U4 })
})
await expectRejected("billing_accounts: one Stripe customer cannot link to two accounts (unique)", () =>
  upsert(db, "billing_accounts", { user_id: U3, stripe_customer_id: "cus_four", updated_at: nowIso() }, "user_id"))

// Account deletion, in account_deletion.py order, for the account created by the new code.
await step("account deletion for a new-code account (actor anonymize, child tables, profiles, users)", async () => {
  await db.exec("begin")
  try {
    await db.query(`update public.notifications set actor_user_id = null where actor_user_id::text = $1 returning id`, [U4])
    for (const t of ["notifications", "ai_usage", "analytics_events", "flashcards", "notes", "study_sessions", "summaries", "transcripts"]) {
      await del(db, t, { user_id: U4 })
      const left = await select(db, t, "user_id", { user_id: U4 }, "limit 1")
      if (left.length) throw new Error(`rows remain in ${t}`)
    }
    await del(db, "profiles", { user_id: U4 })
    await del(db, "users", { id: U4 })
    if ((await select(db, "users", "*", { id: U4 })).length) throw new Error("user row remains")
    await db.exec("commit")
  } catch (e) {
    await db.exec("rollback")
    throw e
  }
})
const billingLeft = await db.query(`select (select count(*) from public.billing_accounts where user_id::text = $1)::int + (select count(*) from public.billing_subscriptions where user_id::text = $1)::int n`, [U4])
check("billing rows removed with the users row (on delete cascade)", billingLeft.rows[0].n === 0)
const actorLeft = await db.query(`select count(*)::int n from public.notifications where id = 'f0000000-0000-4000-8000-0000000000b1' and actor_user_id is null`)
check("another student's notification kept, actor anonymized", actorLeft.rows[0].n === 1)

// Legacy account with rows in legacy tables that reference users(id).
{
  await db.exec("begin")
  let outcome
  try {
    for (const t of ["notifications", "ai_usage", "analytics_events", "flashcards", "notes", "study_sessions", "summaries", "transcripts", "profiles"]) {
      await del(db, t, { user_id: U2 })
    }
    await del(db, "users", { id: U2 })
    outcome = "users row deleted"
  } catch (e) {
    outcome = `users delete blocked: ${firstLine(e)}`
  }
  await db.exec("rollback")
  info(`legacy account U2 (has public.subscriptions + password_reset_tokens rows), assuming NO ACTION FKs: ${outcome}. Not changed by this migration; see report.`)
}

// Storage bucket the code uses.
const themes = await db.query(`select public from storage.buckets where id = 'themes'`)
check("storage: themes bucket public (get_public_url URLs resolve)", themes.rows[0]?.public === true)

// (f) a failure mid-migration rolls back completely
async function rollbackCheck(label, marker, where) {
  const fresh = await buildReplica()
  const before = await dataSnapshot(fresh)
  const beforeS = await schemaSnapshot(fresh)
  const idx = migration.indexOf(marker)
  if (idx < 0) {
    fail(label, `marker not found: ${marker}`)
    return
  }
  const injected = `do $$ begin raise exception 'injected failure for rollback test'; end $$;\n`
  const broken = where === "before" ? migration.slice(0, idx) + injected + migration.slice(idx) : migration.replace(marker, marker + "\n" + injected)
  let threw = false
  try {
    await fresh.exec(broken)
  } catch (e) {
    threw = /injected failure/.test(String(e.message))
  }
  try {
    await fresh.exec("rollback")
  } catch {
    /* no open transaction */
  }
  const after = await dataSnapshot(fresh)
  const afterS = await schemaSnapshot(fresh)
  const extra = await fresh.query(`
    select (select count(*) from information_schema.columns where table_schema='public' and table_name='profiles' and column_name='subscription_status')::int
         + (select count(*) from information_schema.tables where table_schema='public' and table_name in ('analytics_events','billing_accounts','billing_subscriptions'))::int
         + (select count(*) from storage.buckets where id = 'themes')::int as n`)
  check(label, threw && same(before, after) && same(beforeS, afterS) && extra.rows[0].n === 0,
    `threw=${threw} dataSame=${same(before, after)} schemaSame=${same(beforeS, afterS)} newObjects=${extra.rows[0].n}`)
  await fresh.close()
}
await rollbackCheck("rollback: failure injected after the flashcards backfill leaves data and schema untouched", "-- 12. Indexes the schema files define", "before")
await rollbackCheck("rollback: failure injected after the themes bucket insert (just before commit) leaves everything untouched", "notify pgrst, 'reload schema';", "before")

// (g) password guard afterwards
await step("install password_hash_guard.sql after the migration", () => db.exec(guardSql))
await expectRejected("guard: plain-text password insert rejected", () =>
  insert(db, "users", { id: "55555555-5555-4555-8555-555555555555", email: "five@example.test", password: "plain", username: "five", created_at: utcNaiveIso() }))
await step("guard: argon2 hash insert accepted", () =>
  insert(db, "users", { id: "66666666-6666-4666-8666-666666666666", email: "six@example.test", password: ARGON, username: "six", created_at: utcNaiveIso() }))
await expectRejected("guard: resetting a password to plain text rejected", () =>
  update(db, "users", { password: "plain-again" }, { id: U2 }))
await step("guard: password reset token update still works (does not touch password)", () =>
  update(db, "users", { password_reset_token: "a".repeat(64), password_reset_sent_at: utcNaiveIso() }, { id: U1 }))
const legacyPw = await db.query(`select password from public.users where id::text = $1`, [U1])
check("guard: legacy plain-text row left readable for the hashing script", legacyPw.rows[0].password === "plain-old-pw")
await step("migration re-applied with the guard installed (still idempotent)", () => db.exec(migration))
const guardOn = await db.query(`select public.luma_password_guard_installed() as v`)
check("guard still reports installed after the re-run", guardOn.rows[0].v === true)

await db.close()
console.log(results.join("\n"))
console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`} (${results.filter((r) => r.startsWith("PASS")).length} pass, ${failures} fail)`)
process.exit(failures === 0 ? 0 : 1)
