// FAKE Luma API for local visual checks only. Nothing here is real:
// no database, no email, no AI. Data lives in memory and vanishes on restart.
//
//   npm run mock-api            (port 8787; PORT=8789 npm run mock-api for another)
//   VITE_API_BASE_URL=http://127.0.0.1:8787 npm run dev
//
// "Emails" are printed to this console, e.g. [FAKE EMAIL] code for a@b.test: 123456
// Seeded accounts: demo@luma.test / demo-password (verified),
//                  second@luma.test / demo-password (verified, "sam"),
//                  third@luma.test / demo-password (verified, "lee"),
//                  unverified@luma.test / demo-password (not verified yet).
// Each account has its own theme color, decks and notes, so a switch is easy to see.
// Test helpers (local only):
//   POST /__test/expire {"email": "..."}   ends that account's sign-ins, like a password reset elsewhere
//   TOKEN_TTL_SECONDS=60 npm run mock-api  sign-ins stop working after 60 seconds
//   GET  /__test/outbox?email=...          the newest fake emails for that address (codes, reset links, email-changed notices)
//   POST /__test/profile {"email": "...", "fields": {...}}  writes saved profile fields as-is, null
//                                          included (an old profile with no color, say); the real
//                                          PUT /me/profile cannot clear a field, so neither can ours
//   POST /__test/skip-code-wait {"email": "..."}  ends that account's 60 s wait between codes
//   POST /__test/slow {"path": "/notes", "ms": 4000, "times": 1}  the next saves to that path wait first
//   POST /__test/fail {"path": "/notes", "mode": "500" | "drop-after-commit" | "drop-before-commit" | "limit" | "busy", "times": 1}
//                                          "drop-after-commit" saves, then cuts the connection (a lost answer)
//   POST /__test/edit-elsewhere {"kind": "notes", "id": "...", "fields": {...}}  another tab saves (version + 1)
//   POST /__test/maintenance, /__test/maintenance/jobs  set the fake maintenance break (see "maintenance (fake)")
// Fake admin for maintenance: admin@example.test / demo-password (demo@luma.test is a fake admin too).
//   POST /__test/clock, /__test/feedback   fake clock and monthly poll scenarios (see dev/mock-feedback.mjs)
// It follows the account contract in docs/api.md (signup -> code -> session).
import http from "node:http"
import { randomInt, randomUUID } from "node:crypto"

import { FEEDBACK_RETAINED, forgetFeedbackUser, handleFeedback } from "./mock-feedback.mjs"

const PORT = Number(process.env.PORT || 8787)
const TOKEN_TTL_MS = Number(process.env.TOKEN_TTL_SECONDS || 0) * 1000
const profiles = new Map() // account id -> saved profile fields (theme etc.)
const THEME_MODES = ["light", "dark", "auto"]

// ---------- fake accounts ----------
const accounts = new Map() // email -> account
const sessions = new Map() // token -> account id
const resetTokens = new Map() // token -> { id, expires }
const pending = new Map() // signup ticket -> { email, username, password, code } (no account yet)
const reports = [] // fake review queue
const outbox = new Map() // email -> [{ kind, code?, link? }] (fake emails, for browser tests)
function deliver(email, message) {
  const list = outbox.get(email) || []
  list.push({ ...message, at: Date.now() })
  outbox.set(email, list.slice(-10))
}
function addAccount(email, username, password, verified, id = randomUUID(), theme_color = "#0f766e", role = "user") {
  const account = { id, email, username, password, email_verified: verified, code: null, lastSent: 0, version: 1, role }
  accounts.set(email, account)
  profiles.set(id, { theme_color, theme_mode: process.env.MODE || "light" })
  return account
}
addAccount("demo@luma.test", "jabari", "demo-password", true, "u1", "#0f766e", "admin")
addAccount("second@luma.test", "sam", "demo-password", true, "u2", "#7c3aed")
addAccount("third@luma.test", "lee", "demo-password", true, "u3", "#ea580c")
addAccount("unverified@luma.test", "new_student", "demo-password", false, randomUUID(), "#db2777")
/** Like users.role = 'admin' on the real server. The demo account and admin@example.test are fake admins. */
const isAdmin = (a) => Boolean(a && a.role === "admin")
const byId = (id) => [...accounts.values()].find((a) => a.id === id)
const publicUser = (a) => ({ id: a.id, email: a.email, username: a.username, email_verified: a.email_verified })
function newSession(account) {
  const token = `fake-${randomUUID()}`
  sessions.set(token, { id: account.id, version: account.version, created: Date.now() })
  return { access_token: token, user: publicUser(account) }
}
function accountFor(req) {
  const token = (req.headers.authorization || "").replace(/^Bearer /, "")
  if (token === "mock") return byId("u1") // old demo token
  const s = sessions.get(token)
  if (s && TOKEN_TTL_MS && Date.now() - s.created > TOKEN_TTL_MS) return null
  const a = s && byId(s.id)
  return a && a.version === s.version ? a : null
}
// A code is for one address: the account's own, or the new one during an email change.
// quiet: save the code but send nothing (a new email that already has an account).
function sendCode(account, to = account.email, { quiet = false } = {}) {
  if (codeWait(account)) return false
  const sentAt = (account.lastSent = Date.now())
  account.code = { value: String(randomInt(0, 1_000_000)).padStart(6, "0"), email: to, expires: sentAt + 600_000, attempts: 0, used: false }
  if (quiet) return true
  console.log(`[FAKE EMAIL] code for ${to}: ${account.code.value}`)
  deliver(to, { kind: "code", code: account.code.value })
  return true
}
/** Seconds until this account (or pending signup) may get another code; 0 when it may now. */
function codeWait(account) {
  const left = 60_000 - (Date.now() - (account.lastSent || 0))
  return left > 0 ? Math.ceil(left / 1000) : 0
}
const err = (detail, error_code, extra = {}) => ({ detail, error_code, ...extra })
// Shared-item previews read as plain words, like _clip in backend/app/public_search.py:
// no #, **, _, `, list dashes, quotes, rules or "::" card separators.
function clipPreview(value, limit = 220) {
  const plain = String(value || "")
    .replace(/^[ \t]*(?:[-*_][ \t]*){3,}$/gm, " ")
    .replace(/^[ \t]*(?:#{1,6}[ \t]+|>[ \t]?|[-*+][ \t]+(?:\[[ xX]\][ \t]+)?)/gm, "")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[ \t]*::[ \t]*/g, " - ")
    .replace(/\*+|~~|`+|(?<![A-Za-z0-9])_+|_+(?![A-Za-z0-9])/g, "")
    .split(/\s+/)
    .filter(Boolean)
    .join(" ")
  return plain.length <= limit ? plain : `${plain.slice(0, limit - 3).trimEnd()}...`
}
const COOLDOWN = (wait) => err("Wait a moment before asking for another code.", "resend_cooldown", { retry_after: wait })
const CHANGE_STARTED = { status: "code_sent_if_possible", resend_after_seconds: 60, code_expires_in_seconds: 600 }
const CODE_INCORRECT = err("That code doesn't match. Check your newest email.", "code_incorrect")
const CODE_LOCKED = err("Too many tries. Send a new code.", "code_locked")
/** Uses up a right code; else the error body, like the real code check. */
function checkCode(c, raw) {
  const code = String(raw || "").replace(/\D/g, "")
  if (Date.now() > c.expires) return err("That code is too old. Send a new one.", "code_expired")
  if (c.attempts >= 5) return CODE_LOCKED
  if (code !== c.value) {
    c.attempts += 1
    return c.attempts >= 5 ? CODE_LOCKED : CODE_INCORRECT
  }
  c.used = true
  return null
}
const TOO_MANY = "Too many tries. Wait a little and try again."
/** Like check_current_password: 5 tries per 15 minutes (a right one clears them) and 10 per day. */
function checkPassword(a, candidate) {
  const now = Date.now()
  a.pwTries = (a.pwTries || []).filter((t) => now - t < 15 * 60_000)
  a.pwDay = (a.pwDay || []).filter((t) => now - t < 86_400_000)
  if (a.pwTries.length >= 5) return [429, err(TOO_MANY, "rate_limited", { retry_after: 15 * 60 })]
  a.pwTries.push(now)
  if (a.pwDay.length >= 10) return [429, err(TOO_MANY, "rate_limited", { retry_after: 86_400 })]
  a.pwDay.push(now)
  if (candidate !== a.password) return [400, err("That password is wrong.", "wrong_password")]
  a.pwTries = []
  return null
}
/** The password field is required (min 1 character), so leaving it out is a plain 422. */
const needsPassword = (body) => typeof body.current_password !== "string" || !body.current_password
const MISSING_PASSWORD = { detail: [{ loc: ["body", "current_password"], msg: "Field required", type: "missing" }] }
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/
const aiGate = (req) => {
  const a = accountFor(req)
  if (!a) return [401, { error: "Please log in again." }]
  if (!a.email_verified) {
    const msg = "Check your email and enter your code to use AI tools."
    return [403, { error: msg, detail: msg, error_code: "email_unverified" }]
  }
  return null
}
const now = Date.now()
const past = (h) => new Date(now - h * 3600e3).toISOString()
const decks = [
  {
    id: "d1", user_id: "u1", title: "Solar System", tags: ["science"], is_public: false, created_at: past(90), updated_at: past(2),
    cards: [
      { id: "c1", front: "Which planet is closest to the Sun?", back: "Mercury", review: null },
      { id: "c2", front: "What is the largest planet?", back: "Jupiter", review: { due: past(5), stability: 3, difficulty: 5, elapsed_days: 2, scheduled_days: 3, learning_steps: 0, reps: 3, lapses: 0, state: 2, last_review: past(80) } },
      { id: "c3", front: "Which planet has the famous rings?", back: "Saturn", review: { due: new Date(now + 9 * 864e5).toISOString(), stability: 12, difficulty: 4, elapsed_days: 5, scheduled_days: 12, learning_steps: 0, reps: 5, lapses: 0, state: 2, last_review: past(30) } },
      { id: "c4", front: "What is the red planet?", back: "Mars", review: null },
      { id: "c5", front: "What star is at the center of our solar system?", back: "The Sun", review: null },
    ],
  },
  {
    id: "d2", user_id: "u1", title: "Spanish Basics", tags: ["spanish", "words"], is_public: true, published_by: "jabari", published_at: past(20), created_at: past(200), updated_at: past(20),
    cards: [
      { id: "s1", front: "Hello", back: "Hola", review: null },
      { id: "s2", front: "Thank you", back: "Gracias", review: null },
      { id: "s3", front: "Cat", back: "Gato", review: null },
      { id: "s4", front: "Water", back: "Agua", review: null },
    ],
  },
]
const notes = []
// Summaries have the same shape as notes. The demo account starts with one.
const summaries = [
  {
    id: "5a1e0000-0000-4000-8000-000000000001", user_id: "u1", title: "The water cycle in short", tags: ["science"],
    content: "Water goes up as vapor, makes clouds, and falls as rain or snow. Then it starts again.",
    is_public: false, published_at: null, published_by: null, study_type: "summary", created_at: past(48), updated_at: past(30),
  },
]
// Study plans (/study-sessions). Like the backend, time is kept in seconds.
const studyPlans = []

// --- maintenance (fake) helpers: the same rules as backend/app/maintenance.py, in memory ---
// A second fake admin for the maintenance routes, beside the demo account (role "admin", like
// users.role on the real server, which checks the role, not an email).
addAccount("admin@example.test", "luma_admin", "demo-password", true, "uadmin", "#2563eb", "admin")
const MAINT_FIELDS = { start_at: null, estimated_end_at: null, drain_started_at: null, grace_ends_at: null, activated_at: null, backup_ref: null, counts_at_activation: null, checks: null, checks_passed_at: null }
const maint = { phase: "none", rev: 1, reason: "", note: "", reopened_at: null, ...MAINT_FIELDS, jobs: 0, failChecks: [] }
const maintLog = []
const editSessions = new Map() // fake edit-session token -> issued (ms)
const MAINT_ACTIVE = "Luma is taking a short break. Your saved work is safe. Please try again after the break."
const MAINT_DRAINING = "Luma is getting ready for a short break, so new work can't start right now. Work you already started can still be saved for a few minutes."
const isoZ = (ms) => (ms == null ? null : new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z"))
const msOf = (iso) => (iso ? Date.parse(iso) : null)
function maintStatus() {
  const reopened = msOf(maint.reopened_at)
  return {
    phase: maint.phase, rev: maint.rev, reason: maint.reason, note: maint.note,
    start_at: maint.start_at, estimated_end_at: maint.estimated_end_at,
    drain_started_at: maint.drain_started_at, grace_ends_at: maint.grace_ends_at,
    recently_reopened: maint.phase === "none" && reopened !== null && Date.now() - reopened < 30 * 60_000,
    server_time: isoZ(Date.now()),
  }
}
function maintRetryAfter() {
  const end = msOf(maint.estimated_end_at)
  return end === null ? 900 : Math.min(3600, Math.max(60, Math.ceil((end - Date.now()) / 1000)))
}
const MAINT_AI = ["/api/generate-notes", "/api/transcribe", "/api/notes-from-text", "/api/summarize", "/api/import/link"]
const MAINT_OPEN_GETS = ["/maintenance/status", "/health", "/health/ready", "/robots.txt", "/me", "/me/profile"]
const MAINT_CONTENT = ["notes", "summaries", "flashcards", "study-sessions", "transcripts"]
function maintGroup(method, path, parts) {
  const read = method === "GET" || method === "HEAD"
  // Test hooks (the feedback poll's fake clock and scenarios) are never part of the break.
  if (method === "OPTIONS" || path === "/admin/maintenance" || path.startsWith("/admin/maintenance/") || path.startsWith("/__test/")) return "open"
  if ((read && MAINT_OPEN_GETS.includes(path)) || (method === "POST" && path === "/login")) return "open"
  if (method === "POST" && path === "/maintenance/edit-session") return "edit"
  if (method === "POST" && MAINT_AI.includes(path)) return "long"
  if ((method === "DELETE" && path === "/me/account") || (["POST", "DELETE"].includes(method) && ["/me/avatar", "/me/theme-image"].includes(path)) || (method === "POST" && path === "/signup")) return "long"
  if (method === "POST" && path === "/api/stripe-webhook") return "webhook"
  if (read) return "read"
  return MAINT_CONTENT.includes(parts[0]) ? "content" : "write"
}
/** null to let the request through, else [error_code, message, retry_after]. */
function maintGate(req, path, parts) {
  return maintDecide(maintGroup(req.method, path, parts), req.headers["x-luma-edit-session"])
}
/** Like ordinary_writes_allowed() on the server: would an ordinary write pass right now? */
const maintWritesAllowed = () => maintDecide("write") === null
function maintDecide(group, editHeader) {
  if (group === "open" || maint.phase === "none" || maint.phase === "announced") return null
  if (maint.phase === "active" || maint.phase === "checking") return ["maintenance_active", MAINT_ACTIVE, group === "webhook" ? 600 : maintRetryAfter()]
  const graceOver = Date.now() >= (msOf(maint.grace_ends_at) ?? 0)
  const draining = ["maintenance_draining", MAINT_DRAINING, maintRetryAfter()]
  if (group === "read") return null
  // Payment events wait from 60 s (DRAIN_SETTLE_SECONDS) before the grace ends, like the server.
  if (group === "webhook") return Date.now() >= (msOf(maint.grace_ends_at) ?? 0) - 60_000 ? draining : null
  if (group === "long" || group === "edit") return draining
  if (group === "write") return graceOver ? draining : null
  const issued = editSessions.get(String(editHeader || ""))
  if (!graceOver && issued !== undefined && issued <= (msOf(maint.drain_started_at) ?? 0)) return null
  return draining
}
const chicagoWall = new Intl.DateTimeFormat("en-US", { timeZone: "America/Chicago", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
const wallOf = (ms) => {
  const p = Object.fromEntries(chicagoWall.formatToParts(new Date(ms)).map((x) => [x.type, x.value]))
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`
}
/** A Chicago wall time ("2026-12-01T05:00") as ms, or [error_code, message] like the server. */
function chicagoToMs(local) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(String(local || ""))
  if (!m) return ["time_invalid", "Pick a day and a time."]
  const base = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5])
  if (new Date(base).getUTCDate() !== +m[3] || +m[4] > 23) return ["time_invalid", "Pick a day and a time."]
  const hits = [5, 6].map((h) => base + h * 3_600_000).filter((ms) => wallOf(ms) === local)
  if (hits.length === 0) return ["time_skipped", "That time is skipped when clocks change. Pick another time."]
  if (hits.length > 1) return ["time_twice", "That time happens twice when clocks change. Pick another time."]
  return hits[0]
}
function maintTimes(body) {
  const start = chicagoToMs(body.start_local)
  if (Array.isArray(start)) return start
  const end = chicagoToMs(body.estimated_end_local)
  if (Array.isArray(end)) return end
  if (start < Date.now() + 30 * 60_000) return ["time_too_soon", "Pick a start at least 30 minutes from now."]
  if (end <= start) return ["time_order", "The end has to be after the start."]
  return { start_at: isoZ(start), estimated_end_at: isoZ(end) }
}
function maintMove(action, changes, detail = {}) {
  const from = maint.phase
  Object.assign(maint, changes)
  maint.rev += 1
  maintLog.push({ at: isoZ(Date.now()), action, from_phase: from, to_phase: maint.phase, detail })
}
function maintSafety(body) {
  const reasons = []
  const now = Date.now()
  const waitUntil = Math.max(msOf(maint.grace_ends_at) ?? now, (msOf(maint.drain_started_at) ?? now) + 60_000)
  if (now < waitUntil) reasons.push({ code: "grace_not_over", seconds_left: Math.ceil((waitUntil - now) / 1000) })
  if (maint.jobs > 0) reasons.push({ code: "jobs_running", count: maint.jobs })
  if (maint.reason === "database_update" && !(body && body.backup_checked && /^[0-9]{8}T[0-9]{6}Z$/.test(String(body.backup_ref || "")))) reasons.push({ code: "backup_missing" })
  return reasons
}
function maintView() {
  const { jobs, failChecks, ...state } = maint
  void failChecks
  const view = {
    status: maintStatus(),
    state,
    instances: [{ instance: "fake-server", this_one: true, in_flight: 0, heartbeat_age_seconds: 0, phase_seen: maint.phase, code_version: "fake" }],
    jobs: { running: jobs, stale: 0, by_kind: jobs ? { ai_transcribe: jobs } : {} },
    log: maintLog.slice(-20).reverse(),
    partial: false,
    server_time: isoZ(Date.now()),
  }
  if (maint.phase === "draining") view.safety = maintSafety(null)
  return view
}
const maintCounts = () => ({ users: accounts.size, profiles: profiles.size, notes: notes.length, summaries: summaries.length, flashcards: decks.length, study_sessions: studyPlans.length })

let currentOrigin = "http://localhost:5173"
function send(res, code, body) {
  res.writeHead(code, {
    "content-type": "application/json",
    "access-control-allow-origin": currentOrigin,
    "access-control-allow-credentials": "true",
    "access-control-allow-headers": "authorization, content-type, idempotency-key, x-luma-edit-session",
    "access-control-allow-methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
    // Like the backend: nothing the API serves belongs in a search engine.
    "x-robots-tag": "noindex, nofollow",
    "access-control-expose-headers": "x-luma-maintenance, x-luma-maintenance-rev, retry-after",
    "x-luma-maintenance": maint.phase,
    "x-luma-maintenance-rev": String(maint.rev),
  })
  res.end(body === undefined ? "" : JSON.stringify(body))
}

const shape = (d) => ({ ...d, front: d.cards[0]?.front ?? "", back: d.cards[0]?.back ?? "", study_type: "flashcards" })

// --- student work (fake): versions, retry-safe creates and save faults, like backend/app/edit_versions.py ---
const createKeys = new Map() // `${user}:${kind}:${key}` -> item id
const faults = [] // { path, ms, mode, times } set by /__test/slow and /__test/fail
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const CONFLICT_DETAIL = "This was changed in another tab or on another device."
const BAD_KEY = err("That save key isn't valid. Please reload Luma and try again.", "bad_idempotency_key")
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
/** Every row has a version (the seeded ones start at 1). */
const versioned = (item) => {
  if (typeof item.version !== "number") item.version = 1
  return item
}
/** The client never sets these. */
const clientOnly = ({ expected_version, version, create_key, progress_rev, ...rest }) => rest
/** The Idempotency-Key header: {key} (null when not sent) or {bad: true}. */
function createKeyOf(req) {
  const raw = req.headers["idempotency-key"]
  if (raw === undefined) return { key: null }
  const key = String(raw).trim().toLowerCase()
  return UUID_RE.test(key) ? { key } : { bad: true }
}
/** The same key from the same student returns the first item (200 + Idempotent-Replay). */
function replayed(res, me, kind, key, list, format = (item) => item) {
  if (!key) return false
  const id = createKeys.get(`${me.id}:${kind}:${key}`)
  const item = id && list.find((x) => x.id === id && x.user_id === me.id)
  if (!item) return false
  res.setHeader("idempotent-replay", "true")
  send(res, 200, format(versioned(item)))
  return true
}
function rememberKey(me, kind, key, item) {
  if (key) createKeys.set(`${me.id}:${kind}:${key}`, item.id)
}
const sameWords = (fields) => (item, body) => {
  const sent = fields.filter((field) => field in body)
  return sent.length > 0 && sent.every((field) => JSON.stringify(item[field] ?? null) === JSON.stringify(body[field] ?? null))
}
const deckWords = (cards) => (cards || []).map(({ id, front, back }) => ({ id, front, back }))
function sameDeck(item, body) {
  const fields = ["title", "tags", "is_public"].filter((field) => field in body)
  const cardsSame = !("cards" in body) || JSON.stringify(deckWords(item.cards)) === JSON.stringify(deckWords(body.cards))
  return ("cards" in body || fields.length > 0) && cardsSame && fields.every((f) => JSON.stringify(item[f] ?? null) === JSON.stringify(body[f] ?? null))
}
/**
 * expected_version, like cas_update: a stale save gets 409 with the newer row, unless the row
 * already holds what was sent (a retry whose first copy landed): then 200. True when it answered.
 */
function versionClash(res, item, body, same, format = (x) => x) {
  versioned(item)
  const expected = body.expected_version
  if (typeof expected !== "number" || expected === item.version) return false
  if (same(item, body)) send(res, 200, format(item))
  else send(res, 409, { detail: CONFLICT_DETAIL, error_code: "edit_conflict", current: format(item) })
  return true
}
/** The next fault set for this save (never for GET). */
function takeFault(method, pathname) {
  if (method === "GET" || method === "OPTIONS") return null
  const fault = faults.find((f) => f.times > 0 && pathname.startsWith(f.path))
  if (!fault) return null
  fault.times -= 1
  return fault
}

http
  .createServer(async (req, res) => {
    const origin = req.headers.origin || ""
    currentOrigin = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin) ? origin : "http://localhost:5173"
    if (req.method === "OPTIONS") return send(res, 204)
    let raw = ""
    for await (const chunk of req) raw += chunk
    const isJson = (req.headers["content-type"] || "").includes("json")
    const body = raw && isJson ? JSON.parse(raw) : {}
    const url = new URL(req.url, "http://x")
    const parts = url.pathname.split("/").filter(Boolean)

    // --- test helpers (local only) ---
    if (url.pathname === "/__test/expire" && req.method === "POST") {
      const a = accounts.get(String(body.email || "").trim().toLowerCase())
      if (!a) return send(res, 404, { detail: "No fake account with that email." })
      a.version += 1 // every token for this account stops working
      console.log(`[TEST] sign-ins ended for ${a.email}`)
      return send(res, 200, { success: true })
    }
    if (url.pathname === "/__test/slow" && req.method === "POST") {
      faults.push({ path: String(body.path || "/"), ms: Number(body.ms) || 0, mode: null, times: Number(body.times) || 1 })
      return send(res, 200, { success: true })
    }
    if (url.pathname === "/__test/fail" && req.method === "POST") {
      const mode = ["500", "drop-after-commit", "drop-before-commit", "limit", "busy"].includes(body.mode) ? body.mode : "500"
      faults.push({ path: String(body.path || "/"), ms: 0, mode, times: Number(body.times) || 1 })
      return send(res, 200, { success: true })
    }
    if (url.pathname === "/__test/edit-elsewhere" && req.method === "POST") {
      const list = { notes, summaries, flashcards: decks, "study-sessions": studyPlans }[body.kind]
      const item = list?.find((x) => x.id === body.id)
      if (!item) return send(res, 404, { detail: "No fake item with that id." })
      versioned(item)
      Object.assign(item, clientOnly(body.fields || {}), { version: item.version + 1, updated_at: new Date().toISOString() })
      return send(res, 200, body.kind === "flashcards" ? shape(item) : item)
    }
    // A fault set above applies to the next matching save.
    const fault = takeFault(req.method, url.pathname)
    if (fault?.ms) await sleep(fault.ms)
    if (fault?.mode === "500") return send(res, 500, { detail: "Internal Server Error" })
    // AI routes, like the backend: the daily free limit (403) and one AI task at a time (429).
    if (fault?.mode === "limit") return send(res, 403, { error: "You made all your free notes for today. Come back tomorrow." })
    if (fault?.mode === "busy") return send(res, 429, { error: "One AI task at a time. Try again in a moment." })
    // The answer starts, then the connection is cut. (Cutting it before any answer would let the
    // browser quietly send the request again by itself, which is not what we want to test.)
    const cutAnswer = () => {
      res.write("{")
      setTimeout(() => req.socket.destroy(), 20)
    }
    if (fault?.mode === "drop-before-commit") {
      res.writeHead(200, { "content-type": "application/json", "access-control-allow-origin": currentOrigin })
      return cutAnswer()
    }
    // The save happens below (send() writes the head), but its answer never arrives.
    if (fault?.mode === "drop-after-commit") res.end = () => cutAnswer()

    if (url.pathname === "/__test/profile" && req.method === "POST") {
      const a = accounts.get(String(body.email || "").trim().toLowerCase())
      if (!a) return send(res, 404, { detail: "No fake account with that email." })
      profiles.set(a.id, { ...profiles.get(a.id), ...(body.fields || {}) })
      return send(res, 200, { success: true })
    }

    if (url.pathname === "/__test/skip-code-wait" && req.method === "POST") {
      const a = accounts.get(String(body.email || "").trim().toLowerCase())
      if (!a) return send(res, 404, { detail: "No fake account with that email." })
      a.lastSent = 0
      return send(res, 200, { success: true })
    }

    if (url.pathname === "/__test/outbox" && req.method === "GET") {
      return send(res, 200, { messages: outbox.get(String(url.searchParams.get("email") || "").trim().toLowerCase()) || [] })
    }

    // --- maintenance (fake) ---
    // Test hooks (local only):
    //   POST /__test/maintenance {"phase": "...", "start_at": "...", "estimated_end_at": "...", "grace_ends_at": "...",
    //        "drain_started_at": "...", "reason": "...", "note": "...", "reopened_at": "...", "fail_checks": ["storage"]}
    //   POST /__test/maintenance/jobs {"count": 1}   AI or long tasks "still running"
    if (url.pathname === "/__test/maintenance" && req.method === "POST") {
      if (body.phase === "none") Object.assign(maint, MAINT_FIELDS, { reason: "", note: "", reopened_at: null, jobs: 0, failChecks: [] })
      for (const key of ["phase", "start_at", "estimated_end_at", "grace_ends_at", "drain_started_at", "reason", "note", "reopened_at"]) {
        if (key in body) maint[key] = body[key]
      }
      if (Array.isArray(body.fail_checks)) maint.failChecks = body.fail_checks
      maint.rev += 1
      return send(res, 200, maintStatus())
    }
    if (url.pathname === "/__test/maintenance/jobs" && req.method === "POST") {
      maint.jobs = Math.max(0, Number(body.count) || 0)
      return send(res, 200, { running: maint.jobs })
    }
    {
      const blocked = maintGate(req, url.pathname, parts)
      if (blocked) {
        const [error_code, detail, retry_after] = blocked
        res.setHeader("retry-after", String(retry_after))
        return send(res, 503, { detail, error_code, retry_after, maintenance: { phase: maint.phase, estimated_end_at: maint.estimated_end_at } })
      }
    }
    if (url.pathname === "/maintenance/status" && req.method === "GET") return send(res, 200, maintStatus())
    if (url.pathname === "/maintenance/edit-session" && req.method === "POST") {
      if (!accountFor(req)) return send(res, 401, { detail: "Not authenticated" })
      const token = `fake-edit-${randomUUID()}`
      editSessions.set(token, Date.now())
      return send(res, 200, { token, issued_at: isoZ(Date.now()) })
    }
    if (url.pathname === "/admin/maintenance" || url.pathname.startsWith("/admin/maintenance/")) {
      const a = accountFor(req)
      if (!a) return send(res, 401, { detail: "Not authenticated" })
      if (!isAdmin(a)) return send(res, 403, { detail: "Admin access required" })
      if (req.method === "GET" && parts.length === 2) return send(res, 200, maintView())
      if (req.method !== "POST" || parts.length !== 3) return send(res, 404, { detail: "Not Found" })
      const changed = () => send(res, 409, { detail: "Someone else changed the break just now. Look at the page again before you try.", error_code: "maintenance_changed", phase: maint.phase, rev: maint.rev })
      if (body.expected_rev !== maint.rev) return changed()
      const step = parts[2]
      const allowed = { schedule: ["none", "announced"], postpone: ["announced", "draining"], cancel: ["announced", "draining"], drain: ["announced"], activate: ["draining"], checks: ["active", "checking"], reopen: ["checking"] }
      if (!allowed[step]) return send(res, 404, { detail: "Not Found" })
      if (!allowed[step].includes(maint.phase)) return changed()
      if (step === "schedule" || step === "postpone") {
        const times = maintTimes(body)
        if (Array.isArray(times)) return send(res, 422, { detail: times[1], error_code: times[0] })
        if (step === "schedule") {
          if (!["database_update", "website_update", "backup_check", "other"].includes(body.reason)) return send(res, 422, { detail: [{ msg: "Pick a reason." }] })
          maintMove(maint.phase === "none" ? "schedule" : "change", { ...MAINT_FIELDS, phase: "announced", reason: body.reason, note: String(body.note || "").slice(0, 200), reopened_at: null, ...times }, { reason: body.reason })
        } else {
          maintMove("postpone", { ...MAINT_FIELDS, phase: "announced", ...times })
        }
      } else if (step === "cancel") {
        maintMove("cancel", { ...MAINT_FIELDS, phase: "none", reason: "", note: "" })
      } else if (step === "drain") {
        const grace = Number(body.grace_minutes ?? 10)
        if (!Number.isInteger(grace) || grace < 5 || grace > 30) return send(res, 422, { detail: [{ msg: "Pick 5 to 30 minutes." }] })
        maintMove("drain", { phase: "draining", drain_started_at: isoZ(Date.now()), grace_ends_at: isoZ(Date.now() + grace * 60_000) }, { grace_minutes: grace })
      } else if (step === "activate") {
        const reasons = maintSafety(body)
        if (reasons.length) {
          maintLog.push({ at: isoZ(Date.now()), action: "activate_refused", from_phase: "draining", to_phase: "draining", detail: { reasons: reasons.map((r) => r.code) } })
          return send(res, 409, { error_code: "maintenance_not_safe", detail: "It isn't safe to start yet.", reasons })
        }
        const ref = /^[0-9]{8}T[0-9]{6}Z$/.test(String(body.backup_ref || "")) ? body.backup_ref : null
        maintMove("activate", { phase: "active", activated_at: isoZ(Date.now()), counts_at_activation: maintCounts(), backup_ref: ref, checks: null, checks_passed_at: null })
      } else if (step === "checks") {
        const results = ["database", "schema", "records_kept", "log_write", "storage", "code_version"].map((name) => ({ name, passed: !maint.failChecks.includes(name), detail: {} }))
        const passed = results.every((r) => r.passed)
        maintMove("checks", { phase: "checking", checks: { ran_at: isoZ(Date.now()), results }, checks_passed_at: passed ? isoZ(Date.now()) : null }, { failed: results.filter((r) => !r.passed).map((r) => r.name) })
      } else if (step === "reopen") {
        if (!maint.checks_passed_at) return send(res, 409, { detail: "Every check has to pass before Luma can reopen.", error_code: "checks_not_passed" })
        if (Date.now() - msOf(maint.checks_passed_at) > 30 * 60_000) return send(res, 409, { detail: "The checks are more than 30 minutes old. Run them again.", error_code: "checks_too_old" })
        maintMove("reopen", { ...MAINT_FIELDS, phase: "none", reopened_at: isoZ(Date.now()) })
      }
      return send(res, 200, maintView())
    }
    // --- monthly feedback poll (fake) and its test clock ---
    if (url.pathname.startsWith("/__test/clock") || url.pathname.startsWith("/__test/feedback") || parts[0] === "feedback" || (parts[0] === "admin" && parts[1] === "feedback")) {
      const account = accountFor(req)
      let handled
      try {
        handled = handleFeedback({
          method: req.method, pathname: url.pathname, parts, searchParams: url.searchParams, body, account, isAdmin: isAdmin(account),
          writesAllowed: maintWritesAllowed(),
        })
      } catch (error) {
        console.error("[FAKE FEEDBACK] route failed:", error)
        return send(res, 500, { detail: "The fake feedback route failed." })
      }
      if (handled) return send(res, handled[0], handled[1])
    }

    // --- accounts (fake) ---
    if (url.pathname === "/signup" && req.method === "POST") {
      const email = String(body.email || "").trim().toLowerCase()
      const password = String(body.password || "")
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return send(res, 422, { detail: [{ msg: "value is not a valid email address" }] })
      if (password.length < 8) return send(res, 400, err("Use at least 8 characters for your password.", "password_invalid"))
      if (password.length > 128) return send(res, 400, err("Use 128 characters or fewer for your password.", "password_invalid"))
      const taken = [...accounts.values()].find((a) => a.username === body.username && a.email !== email)
      if (taken) return send(res, 400, err("That username is taken. Try another one.", "username_taken"))
      const ticket = randomUUID()
      if (accounts.has(email)) console.log(`[FAKE EMAIL] notice to ${email}: someone tried to sign up`)
      else {
        const p = { email, username: body.username, password, code: null, lastSent: 0 }
        pending.set(ticket, p)
        sendCode(p)
      }
      return send(res, 202, { status: "check_email", email, ticket, resend_after_seconds: 60, code_expires_in_seconds: 600 })
    }
    if (url.pathname === "/auth/verify-email" && req.method === "POST") {
      const loggedIn = body.ticket ? null : accountFor(req)
      const p = body.ticket ? pending.get(body.ticket) : null
      const a = loggedIn || (p && p.email === String(body.email || "").trim().toLowerCase() ? p : null)
      const c = a?.code
      // A code sent for an email change can't check the current address.
      if (!a || !c || c.used || c.email !== a.email) return send(res, 400, CODE_INCORRECT)
      const wrong = checkCode(c, body.code)
      if (wrong) return send(res, 400, wrong)
      if (loggedIn) {
        loggedIn.email_verified = true
        return send(res, 200, newSession(loggedIn))
      }
      if (accounts.has(p.email)) return send(res, 400, err("You already have a Luma account with this email. Log in instead.", "account_exists"))
      pending.delete(body.ticket)
      return send(res, 200, newSession(addAccount(p.email, p.username, p.password, true)))
    }
    if (url.pathname === "/auth/resend-code" && req.method === "POST") {
      const p = body.ticket ? pending.get(body.ticket) : null
      if (p && p.email === String(body.email || "").trim().toLowerCase()) sendCode(p)
      return send(res, 202, { status: "sent_if_possible", resend_after_seconds: 60 })
    }
    if (url.pathname === "/auth/send-verification" && req.method === "POST") {
      const a = accountFor(req)
      if (!a) return send(res, 401, { detail: "Not authenticated" })
      if (a.email_verified) return send(res, 200, { success: true, message: "Your email is already checked." })
      const wait = codeWait(a)
      if (wait) return send(res, 429, COOLDOWN(wait))
      sendCode(a)
      return send(res, 200, { success: true, message: "We sent a new code.", resend_after_seconds: 60 })
    }
    if (url.pathname === "/login" && req.method === "POST") {
      const a = accounts.get(String(body.email || "").trim().toLowerCase())
      if (!a || a.password !== body.password) return send(res, 401, { detail: "That email or password is wrong." })
      return send(res, 200, newSession(a))
    }
    if (url.pathname === "/auth/request-reset" && req.method === "POST") {
      const a = accounts.get(String(body.email || "").trim().toLowerCase())
      if (a) {
        const token = randomUUID().replaceAll("-", "")
        resetTokens.set(token, { id: a.id, expires: Date.now() + 30 * 60_000 })
        console.log(`[FAKE EMAIL] reset link for ${a.email}: ${currentOrigin}/reset-password?token=${token}`)
        deliver(a.email, { kind: "reset", link: `/reset-password?token=${token}` })
      }
      return send(res, 200, { success: true, message: "If an account with that email exists, a reset link has been sent" })
    }
    if (url.pathname === "/auth/reset" && req.method === "POST") {
      const pw = String(body.new_password || "")
      if (pw.length < 8 || pw.length > 128) return send(res, 400, err("Use 8 to 128 characters for your password.", "password_invalid"))
      const t = resetTokens.get(body.token)
      resetTokens.delete(body.token)
      const a = t && Date.now() < t.expires ? byId(t.id) : null
      if (!a) return send(res, 400, err("That reset link doesn't work anymore. Ask for a new one.", "reset_invalid"))
      a.password = pw
      a.version += 1 // signs out old sessions
      a.email_verified = true
      return send(res, 200, { success: true, message: "Password reset successful" })
    }

    // --- public-content reports (fake review queue) ---
    if (url.pathname === "/public/reports" && req.method === "POST") {
      const a = accountFor(req)
      if (!a) return send(res, 401, { detail: "Not authenticated" })
      const item = decks.find((d) => d.id === body.item_id && d.is_public)
      if (!item) return send(res, 404, { detail: "We couldn't find that public item. It may have been removed." })
      if (!reports.some((r) => r.reporter === a.id && r.item_id === body.item_id && r.status === "open")) {
        reports.unshift({ id: randomUUID(), item_type: body.item_type, item_id: body.item_id, item_title: item.title,
          reason: body.reason, details: body.details || null, status: "open", created_at: new Date().toISOString(), reporter: a.id })
        console.log(`[FAKE REPORT] ${body.reason} on ${item.title}`)
      }
      return send(res, 201, { success: true, message: "Thanks. A Luma helper will look at this." })
    }
    if (parts[0] === "admin" && parts[1] === "reports") {
      const a = accountFor(req)
      if (!isAdmin(a)) return send(res, 403, { detail: "Admin access required" })
      const strip = ({ reporter, ...rest }) => rest
      if (req.method === "PATCH" && parts[2]) {
        const r = reports.find((x) => x.id === parts[2])
        if (!r) return send(res, 404, { detail: "Report not found" })
        r.status = body.status
        r.reviewed_at = new Date().toISOString()
        return send(res, 200, strip(r))
      }
      const status = url.searchParams.get("status") || "open"
      return send(res, 200, reports.filter((r) => status === "all" || r.status === status).map(strip))
    }
    if (url.pathname === "/me/account" && req.method === "DELETE") {
      const a = accountFor(req)
      if (!a) return send(res, 401, { detail: "Not authenticated" })
      if (needsPassword(body)) return send(res, 422, MISSING_PASSWORD)
      const refused = checkPassword(a, body.current_password)
      if (refused) return send(res, ...refused)
      accounts.delete(a.email)
      forgetFeedbackUser(a)
      return send(res, 200, { success: true, message: "Your account and study data were deleted.", retained: [
        "If you paid for Premium, payment records stay with Stripe because tax law requires them",
        "Copies already sent to our AI providers follow their own deletion rules",
        "Database backups age out on our hosting provider's schedule",
        "A scrambled code made from your email (not the email itself) stays for a few days, so the free AI limit can't be reset by deleting and making a new account",
        "Reports you sent about shared content stay for safety review, without your name",
        FEEDBACK_RETAINED,
      ] })
    }

    // --- capture endpoints (fake AI) ---
    if (["/api/transcribe", "/api/notes-from-text", "/api/generate-notes", "/api/summarize"].includes(url.pathname)) {
      const blocked = aiGate(req)
      if (blocked) return send(res, blocked[0], blocked[1])
    }
    if (url.pathname === "/api/transcribe") {
      await new Promise((r) => setTimeout(r, 900))
      return send(res, 200, { transcript: "Today we learned about photosynthesis. Plants use sunlight, water, and carbon dioxide to make sugar and oxygen. This happens in the chloroplasts, which contain chlorophyll, the green pigment." })
    }
    if (url.pathname === "/api/notes-from-text") {
      await new Promise((r) => setTimeout(r, 1500))
      if ((body.text || "").length < 20) return send(res, 400, { error: "We need a few more words to make notes." })
      if (process.env.LIMIT === "1") return send(res, 403, { error: "You made all your free notes for today. Come back tomorrow or upgrade to Premium." })
      return send(res, 200, {
        title: "How Plants Make Food",
        summary: "Plants make their own food with sunlight. This is called photosynthesis.",
        notes: "## What is photosynthesis?\n- Plants turn sunlight into food.\n- They need sunlight, water, and carbon dioxide.\n\n## What do they make?\n- Sugar for energy\n- Oxygen that we breathe\n\n## Where does it happen?\n- In chloroplasts\n- Chlorophyll makes leaves green",
        key_terms: ["photosynthesis", "chloroplast", "chlorophyll", "carbon dioxide"],
        flashcards: [
          { front: "What is photosynthesis?", back: "How plants make food from sunlight" },
          { front: "What three things do plants need?", back: "Sunlight, water, and carbon dioxide" },
          { front: "What gas do plants give off?", back: "Oxygen" },
          { front: "Where does photosynthesis happen?", back: "In the chloroplasts" },
          { front: "What makes leaves green?", back: "Chlorophyll" },
        ],
        truncated: false,
      })
    }
    if (url.pathname === "/api/generate-notes") {
      // Like the backend: the same notes shape as /api/notes-from-text, 1 notes turn.
      await new Promise((r) => setTimeout(r, 600))
      if ((body.image || "").length > 21 * 1024 * 1024) return send(res, 413, { error: "That picture is too big. Try one under 15 MB." })
      if (!/^\s*data:image\/(png|jpe?g|webp|gif);base64,[A-Za-z0-9+/]+=*\s*$/i.test(body.image || "")) {
        return send(res, 400, { error: "We couldn't open that picture. Try a PNG, JPG or WEBP photo." })
      }
      if (process.env.LIMIT === "1") return send(res, 403, { error: "You made all your free notes for today. Come back tomorrow." })
      return send(res, 200, {
        title: "Photosynthesis from the board",
        summary: "Plants use sunlight to make food. They give off oxygen.",
        notes: "## Photosynthesis\n- Plants use sunlight to make food.\n- Leaves take in carbon dioxide.\n- Plants give off oxygen.\n\n## Where does it happen?\n- In the chloroplasts",
        key_terms: ["photosynthesis", "chloroplast"],
        flashcards: [
          { front: "What do plants use to make food?", back: "Sunlight" },
          { front: "What gas do leaves take in?", back: "Carbon dioxide" },
          { front: "Where does photosynthesis happen?", back: "In the chloroplasts" },
        ],
        truncated: false,
      })
    }
    if (url.pathname === "/api/summarize") {
      // Like the backend: {text} in, exactly {title, summary} out, 1 notes turn. Nothing is saved
      // here; the page saves it with POST /summaries.
      await new Promise((r) => setTimeout(r, 600))
      if (String(body.text || "").trim().length < 20) return send(res, 400, { error: "We need a few more words to make a summary." })
      if (process.env.LIMIT === "1") return send(res, 403, { error: "You made all your free notes for today. Come back tomorrow." })
      return send(res, 200, {
        title: "Plants in short",
        summary: "Plants make their own food from sunlight, water and air. This happens in the leaves. They give off oxygen that we breathe.",
      })
    }
    if (url.pathname === "/api/import/link") {
      await new Promise((r) => setTimeout(r, 700))
      const target = body.url || ""
      if (/youtu/.test(target)) return send(res, 422, { error: "For YouTube, copy the transcript and paste it.", code: "youtube" })
      if (/localhost|127\.0\.0\.1/.test(target)) return send(res, 400, { error: "We couldn't open that link.", code: "blocked" })
      return send(res, 200, { title: "The Water Cycle", site_name: "Example Science", url: target, truncated: false, text: "Water moves around the Earth in a cycle. The sun heats water in oceans and lakes, and it evaporates into the air as water vapor. The vapor cools and condenses into clouds. When the drops get heavy, they fall as rain or snow. This is called precipitation. The water collects in rivers, lakes, and oceans, and the cycle starts again." })
    }
    // Notes and summaries: create, list, open, change (PUT) and delete, each account only its own.
    if (parts[0] === "notes" || parts[0] === "summaries") {
      const me = accountFor(req)
      if (!me) return send(res, 401, { detail: "Invalid or expired token" })
      const store = parts[0] === "notes" ? notes : summaries
      const kind = parts[0] === "notes" ? "note" : "summary"
      const missing = parts[0] === "notes" ? "Note not found" : "Summary not found"
      if (parts.length === 1 && req.method === "POST") {
        // Like the backend: a note needs a title, a summary may leave it empty.
        if ((kind === "note" && !String(body.title || "").trim()) || !String(body.content || "").trim()) return send(res, 422, { detail: "Title and content are required." })
        const created = createKeyOf(req)
        if (created.bad) return send(res, 422, BAD_KEY)
        if (replayed(res, me, parts[0], created.key, store)) return
        const stamp = new Date().toISOString()
        const item = { id: randomUUID(), created_at: stamp, updated_at: stamp, is_public: false, tags: [], study_type: kind, ...clientOnly(body), user_id: me.id, version: 1 }
        store.unshift(item)
        rememberKey(me, parts[0], created.key, item)
        return send(res, 201, item)
      }
      if (parts.length === 1) return send(res, 200, store.filter((n) => n.user_id === me.id).map(versioned))
      const item = store.find((n) => n.id === parts[1] && n.user_id === me.id)
      if (!item) return send(res, 404, req.method === "PUT" ? { detail: missing, error_code: "item_gone" } : { detail: missing })
      versioned(item)
      if (req.method === "PUT") {
        if (kind === "note" && "title" in body && !String(body.title || "").trim()) return send(res, 422, { detail: "Title can't be empty." })
        if (versionClash(res, item, body, sameWords(["title", "content", "tags", "is_public"]))) return
        Object.assign(item, clientOnly(body), { user_id: me.id, updated_at: new Date().toISOString(), version: item.version + 1 })
      }
      if (req.method === "DELETE") {
        store.splice(store.indexOf(item), 1)
        return send(res, 200, { message: `${kind === "note" ? "Note" : "Summary"} deleted successfully` })
      }
      return send(res, 200, item)
    }

    // --- shared search (fake data, shaped like backend/app/public_search.py) ---
    // Signed in only. Each item carries the owner's CURRENT username and nothing else
    // about them: no user id, no display name, no photo, no counts. The stored
    // published_by is never shown or searched (it can hold an old name).
    if (url.pathname === "/public/topics" || url.pathname === "/public/users") {
      if (!accountFor(req)) return send(res, 401, { detail: "Not authenticated" })
      const nameOf = (userId) => byId(userId)?.username || "student"
      const sharedRows = (ownerIds) => [
        ...notes.filter((n) => n.is_public).map((n) => ({ row: n, study_type: "note", text: [n.content || ""], preview: n.content || "" })),
        ...decks.filter((d) => d.is_public).map((d) => ({ row: d, study_type: "flashcards", text: [d.cards[0]?.front || "", d.cards[0]?.back || ""], preview: d.cards[0]?.front || d.cards[0]?.back || "" })),
        ...summaries.filter((s) => s.is_public).map((s) => ({ row: s, study_type: "summary", text: [s.content || ""], preview: s.content || "" })),
      ]
        .filter(({ row }) => (row.title || "") && (!ownerIds || ownerIds.has(row.user_id)))
        .map(({ row, study_type, text, preview }) => ({
          ownerId: row.user_id,
          haystack: [row.title, ...text, ...(row.tags || [])].join(" ").toLowerCase(),
          item: {
            id: row.id, study_type, title: row.title, preview: clipPreview(preview), tags: row.tags || [],
            username: nameOf(row.user_id), published_at: row.published_at || row.created_at, created_at: row.created_at,
          },
        }))
        .sort((a, b) => String(b.item.published_at).localeCompare(String(a.item.published_at)))
      if (url.pathname === "/public/topics") {
        const q = (url.searchParams.get("query") || "").trim().replace(/^#/, "").toLowerCase()
        return send(res, 200, sharedRows().filter(({ haystack }) => !q || haystack.includes(q)).map(({ item }) => item).slice(0, 80))
      }
      // People: usernames only, 3+ letters, closest name first, never by how much someone shared.
      // Like the server, look the name up first, then fetch only those students' shared items,
      // so someone who shared long ago is still found.
      const wanted = (url.searchParams.get("query") || "").trim().replace(/^@/, "").toLowerCase()
      if (wanted.length < 3 || !/^[a-z0-9_]+$/.test(wanted)) return send(res, 200, [])
      const named = new Set([...accounts.values()].filter((a) => a.username.toLowerCase().includes(wanted)).map((a) => a.id))
      const byOwner = new Map()
      for (const { ownerId, item } of sharedRows(named)) byOwner.set(ownerId, [...(byOwner.get(ownerId) || []), item])
      const rank = (name) => (name === wanted ? 0 : name.startsWith(wanted) ? 1 : 2)
      const users = [...byOwner.entries()]
        .map(([ownerId, items]) => ({ username: nameOf(ownerId), items: items.slice(0, 24) }))
        .sort((a, b) => rank(a.username.toLowerCase()) - rank(b.username.toLowerCase()) || a.username.toLowerCase().localeCompare(b.username.toLowerCase()))
      return send(res, 200, users.slice(0, 40))
    }
    if (url.pathname === "/robots.txt") {
      res.writeHead(200, { "content-type": "text/plain", "x-robots-tag": "noindex, nofollow" })
      return res.end("User-agent: *\nDisallow: /\n")
    }

    if (url.pathname === "/health") return send(res, 200, { status: "ok" })
    // Change email, step 1: the current password, then a code to the NEW address.
    // The answer is the same when that address already has an account, but then
    // the code is saved and never sent (like the real server), so guesses just fail.
    if (url.pathname === "/me/email" && req.method === "PUT") {
      const a = accountFor(req)
      if (!a) return send(res, 401, { detail: "Session expired. Please log in again." })
      const next = String(body.new_email || "").trim().toLowerCase()
      if (!EMAIL_RE.test(next)) return send(res, 422, { detail: [{ loc: ["body", "new_email"], msg: "value is not a valid email address" }] })
      if (needsPassword(body)) return send(res, 422, MISSING_PASSWORD)
      if (a.id === "u1") return send(res, 403, err("The admin email can't be changed here.", "admin_email_locked"))
      // The code cooldown is told before the password is checked, so it uses no password try.
      const wait = codeWait(a)
      if (wait) return send(res, 429, COOLDOWN(wait))
      const refused = checkPassword(a, body.current_password)
      if (refused) return send(res, ...refused)
      if (next === a.email) return send(res, 400, err("That's already your email.", "same_email"))
      sendCode(a, next, { quiet: accounts.has(next) })
      return send(res, 202, CHANGE_STARTED)
    }
    // A new code for the change already started: no password, only the pending address.
    if (url.pathname === "/me/email/resend" && req.method === "POST") {
      const a = accountFor(req)
      if (!a) return send(res, 401, { detail: "Session expired. Please log in again." })
      const next = String(body.new_email || "").trim().toLowerCase()
      if (!EMAIL_RE.test(next)) return send(res, 422, { detail: [{ loc: ["body", "new_email"], msg: "value is not a valid email address" }] })
      const c = a.code
      if (next === a.email || !c || c.used || c.email !== next) {
        return send(res, 400, err("Start again: type your new email and your password.", "no_pending_change"))
      }
      const wait = codeWait(a)
      if (wait) return send(res, 429, COOLDOWN(wait))
      sendCode(a, next, { quiet: accounts.has(next) })
      return send(res, 202, CHANGE_STARTED)
    }
    // Change email, step 2: the code from the new address. The old address is told.
    if (url.pathname === "/me/email/confirm" && req.method === "POST") {
      const a = accountFor(req)
      if (!a) return send(res, 401, { detail: "Session expired. Please log in again." })
      const next = String(body.new_email || "").trim().toLowerCase()
      if (!EMAIL_RE.test(next) || typeof body.code !== "string" || !body.code) {
        return send(res, 422, { detail: [{ loc: ["body"], msg: "Type your new email and the code." }] })
      }
      const c = a.code
      if (next === a.email || !c || c.used || c.email !== next) return send(res, 400, CODE_INCORRECT)
      const wrong = checkCode(c, body.code)
      if (wrong) return send(res, 400, wrong)
      if (accounts.has(next)) return send(res, 400, err("That email already has a Luma account.", "email_taken"))
      const old = a.email
      accounts.delete(old)
      a.email = next
      a.email_verified = true
      accounts.set(next, a)
      console.log(`[FAKE EMAIL] notice to ${old}: your email was changed`)
      deliver(old, { kind: "email_changed" })
      return send(res, 200, { ...profiles.get(a.id), ...publicUser(a), subscription_status: "free", is_admin: a.id === "u1" })
    }
    if (url.pathname === "/me/profile") {
      const a = accountFor(req)
      if (!a) return send(res, 401, { detail: "Session expired. Please log in again." })
      if (req.method === "PUT") {
        // Like the real API: the theme is "light", "dark" or "auto", and a field left out or sent
        // as null keeps what is saved (null never clears it; tests use /__test/profile for that).
        if (body.theme_mode != null && !THEME_MODES.includes(body.theme_mode)) {
          return send(res, 422, { detail: [{ loc: ["body", "theme_mode"], msg: "Input should be 'light', 'dark' or 'auto'", type: "literal_error" }] })
        }
        const changes = Object.fromEntries(Object.entries(body).filter(([, value]) => value != null))
        profiles.set(a.id, { ...profiles.get(a.id), ...changes })
      }
      const profile = profiles.get(a.id)
      // An unknown saved theme reads as Light; an empty one stays empty.
      const theme_mode = profile.theme_mode == null ? null : THEME_MODES.includes(profile.theme_mode) ? profile.theme_mode : "light"
      return send(res, 200, { ...profile, theme_mode, ...publicUser(a), subscription_status: "free", is_admin: isAdmin(a) })
    }
    // Study plans: create, list, open, change and delete, each account only its own.
    if (parts[0] === "study-sessions") {
      const me = accountFor(req)
      if (!me) return send(res, 401, { detail: "Invalid or expired token" })
      if (parts.length === 1 && req.method === "GET") return send(res, 200, studyPlans.filter((p) => p.user_id === me.id))
      if (parts.length === 1 && req.method === "POST") {
        const name = String(body.name || "").trim()
        const seconds = body.duration_seconds ?? 0
        if (!name || name.length > 200) return send(res, 422, { detail: "Name is required." })
        if (!Number.isInteger(seconds) || seconds < 0) return send(res, 422, { detail: "duration_seconds must be a whole number of 0 or more." })
        const created = createKeyOf(req)
        if (created.bad) return send(res, 422, BAD_KEY)
        if (replayed(res, me, "study-sessions", created.key, studyPlans)) return
        const plan = {
          id: randomUUID(), user_id: me.id, name, subject: body.subject ?? null, notes: body.notes ?? null,
          duration_seconds: seconds, created_at: new Date().toISOString(), updated_at: new Date().toISOString(), version: 1,
        }
        studyPlans.unshift(plan)
        rememberKey(me, "study-sessions", created.key, plan)
        return send(res, 201, plan)
      }
      const plan = studyPlans.find((p) => p.id === parts[1] && p.user_id === me.id)
      if (!plan) return send(res, 404, req.method === "PUT" ? { detail: "Study session not found", error_code: "item_gone" } : { detail: "Study session not found" })
      if (req.method === "PUT") {
        if (versionClash(res, plan, body, sameWords(["name", "subject", "notes", "duration_seconds"]))) return
        Object.assign(plan, clientOnly(body), { updated_at: new Date().toISOString(), version: plan.version + 1 })
      }
      if (req.method === "DELETE") {
        studyPlans.splice(studyPlans.indexOf(plan), 1)
        return send(res, 200, { message: "Study session deleted successfully" })
      }
      return send(res, 200, plan)
    }
    if (parts[0] === "flashcards") {
      const me = accountFor(req)
      if (!me) return send(res, 401, { detail: "Invalid or expired token" })
      if (parts.length === 1 && req.method === "GET") return send(res, 200, decks.filter((d) => d.user_id === me.id).map((d) => shape(versioned(d))))
      if (parts.length === 1 && req.method === "POST") {
        const created = createKeyOf(req)
        if (created.bad) return send(res, 422, BAD_KEY)
        if (replayed(res, me, "flashcards", created.key, decks, shape)) return
        const stamp = new Date().toISOString()
        const d = { id: randomUUID(), is_public: false, created_at: stamp, updated_at: stamp, tags: [], ...clientOnly(body), user_id: me.id, version: 1, progress_rev: 0 }
        d.cards = (d.cards || []).map((card) => ({ review: null, ...card }))
        decks.unshift(d)
        rememberKey(me, "flashcards", created.key, d)
        return send(res, 201, shape(d))
      }
      // Review progress: merged per card id. Never changes the words or the version.
      // The real server writes only if both progress_rev and version are still what it read,
      // so an editor save that lands in between is never undone. Here the read and the write
      // are one synchronous step, so nothing can land in between.
      if (parts[2] === "progress" && req.method === "PATCH") {
        const deck = decks.find((x) => x.id === parts[1] && x.user_id === me.id)
        if (!deck) return send(res, 404, { detail: "Flashcard not found", error_code: "item_gone" })
        const reviews = body.reviews
        if (!reviews || typeof reviews !== "object" || Array.isArray(reviews) || !Object.keys(reviews).length || Object.keys(reviews).length > 500) {
          return send(res, 422, { detail: [{ msg: "Send at least one card's progress." }] })
        }
        deck.cards = deck.cards.map((card) => (card.id in reviews ? { ...card, review: reviews[card.id] } : card))
        deck.progress_rev = (deck.progress_rev ?? 0) + 1
        return send(res, 200, { version: versioned(deck).version, progress_rev: deck.progress_rev })
      }
      const d = decks.find((x) => x.id === parts[1] && (x.user_id === me.id || (req.method === "GET" && x.is_public)))
      if (!d) return send(res, 404, req.method === "PUT" ? { detail: "Flashcard not found", error_code: "item_gone" } : { detail: "Flashcard not found" })
      versioned(d)
      if (req.method === "PUT") {
        if (versionClash(res, d, body, sameDeck, shape)) return
        const changes = clientOnly(body)
        if (Array.isArray(changes.cards) && typeof body.expected_version === "number") {
          // The editor never sends progress: keep what studying stored for each card id.
          const stored = new Map(d.cards.map((card) => [card.id, card.review ?? null]))
          changes.cards = changes.cards.map(({ review, ...card }) => ({ ...card, review: stored.get(card.id) ?? null }))
        }
        Object.assign(d, changes, { updated_at: new Date().toISOString(), version: d.version + 1 })
      }
      if (req.method === "DELETE") {
        decks.splice(decks.indexOf(d), 1)
        return send(res, 200, { message: "deleted" })
      }
      return send(res, 200, shape(d))
    }
    send(res, 404, { detail: `Fake server has no route for ${req.method} ${url.pathname}` })
  })
  .listen(PORT, "127.0.0.1", () => console.log(`FAKE Luma API (not real) on http://127.0.0.1:${PORT}`))
