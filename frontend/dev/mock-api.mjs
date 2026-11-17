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
//   GET  /__test/outbox?email=...          the newest fake emails for that address (codes, reset links)
// It follows the account contract in docs/api.md (signup -> code -> session).
import http from "node:http"
import { randomInt, randomUUID } from "node:crypto"

const PORT = Number(process.env.PORT || 8787)
const TOKEN_TTL_MS = Number(process.env.TOKEN_TTL_SECONDS || 0) * 1000
const profiles = new Map() // account id -> saved profile fields (theme etc.)

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
function addAccount(email, username, password, verified, id = randomUUID(), theme_color = "#0f766e") {
  const account = { id, email, username, password, email_verified: verified, code: null, lastSent: 0, version: 1 }
  accounts.set(email, account)
  profiles.set(id, { theme_color, theme_mode: process.env.MODE || "light" })
  return account
}
addAccount("demo@luma.test", "jabari", "demo-password", true, "u1", "#0f766e")
addAccount("second@luma.test", "sam", "demo-password", true, "u2", "#7c3aed")
addAccount("third@luma.test", "lee", "demo-password", true, "u3", "#ea580c")
addAccount("unverified@luma.test", "new_student", "demo-password", false, randomUUID(), "#db2777")
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
function sendCode(account) {
  const now = Date.now()
  if (now - account.lastSent < 60_000) return false
  account.lastSent = now
  account.code = { value: String(randomInt(0, 1_000_000)).padStart(6, "0"), expires: now + 600_000, attempts: 0, used: false }
  console.log(`[FAKE EMAIL] code for ${account.email}: ${account.code.value}`)
  deliver(account.email, { kind: "code", code: account.code.value })
  return true
}
const err = (detail, error_code, extra = {}) => ({ detail, error_code, ...extra })
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

let currentOrigin = "http://localhost:5173"
function send(res, code, body) {
  res.writeHead(code, {
    "content-type": "application/json",
    "access-control-allow-origin": currentOrigin,
    "access-control-allow-credentials": "true",
    "access-control-allow-headers": "authorization, content-type",
    "access-control-allow-methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
  })
  res.end(body === undefined ? "" : JSON.stringify(body))
}

const shape = (d) => ({ ...d, front: d.cards[0]?.front ?? "", back: d.cards[0]?.back ?? "", study_type: "flashcards" })

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

    if (url.pathname === "/__test/outbox" && req.method === "GET") {
      return send(res, 200, { messages: outbox.get(String(url.searchParams.get("email") || "").trim().toLowerCase()) || [] })
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
      const code = String(body.code || "").replace(/\D/g, "")
      const loggedIn = body.ticket ? null : accountFor(req)
      const p = body.ticket ? pending.get(body.ticket) : null
      const a = loggedIn || (p && p.email === String(body.email || "").trim().toLowerCase() ? p : null)
      const c = a?.code
      if (!a || !c || c.used) return send(res, 400, err("That code doesn't match. Check your newest email.", "code_incorrect"))
      if (Date.now() > c.expires) return send(res, 400, err("That code is too old. Send a new one.", "code_expired"))
      if (c.attempts >= 5) return send(res, 400, err("Too many tries. Send a new code.", "code_locked"))
      if (code !== c.value) {
        c.attempts += 1
        return c.attempts >= 5
          ? send(res, 400, err("Too many tries. Send a new code.", "code_locked"))
          : send(res, 400, err("That code doesn't match. Check your newest email.", "code_incorrect"))
      }
      c.used = true
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
      if (!sendCode(a)) {
        const wait = Math.ceil((60_000 - (Date.now() - a.lastSent)) / 1000)
        return send(res, 429, err("Wait a moment before asking for another code.", "resend_cooldown", { retry_after: wait }))
      }
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
      if (!a || a.id !== "u1") return send(res, 403, { detail: "Admin access required" })
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
      accounts.delete(a.email)
      return send(res, 200, { success: true, message: "Your account and study data were deleted.", retained: [
        "If you paid for Premium, payment records stay with Stripe because tax law requires them",
        "Copies already sent to our AI providers follow their own deletion rules",
        "Database backups age out on our hosting provider's schedule",
        "A scrambled code made from your email (not the email itself) stays for a few days, so the free AI limit can't be reset by deleting and making a new account",
        "Reports you sent about public content stay for safety review, without your name",
      ] })
    }

    // --- capture endpoints (fake AI) ---
    if (["/api/transcribe", "/api/notes-from-text", "/api/generate-notes"].includes(url.pathname)) {
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
      await new Promise((r) => setTimeout(r, 600))
      if (!/^data:image\/(png|jpeg|webp);base64,/.test(body.image || "")) return send(res, 400, { error: "Invalid request" })
      return send(res, 200, { notes: "Photosynthesis\n- Plants use sunlight to make food.\n- Leaves take in carbon dioxide.\n- Plants give off oxygen.\nWhere does it happen? :: In the chloroplasts" })
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
        const item = { id: randomUUID(), created_at: new Date().toISOString(), updated_at: null, is_public: false, tags: [], study_type: kind, ...body, user_id: me.id }
        store.unshift(item)
        return send(res, 201, item)
      }
      if (parts.length === 1) return send(res, 200, store.filter((n) => n.user_id === me.id))
      const item = store.find((n) => n.id === parts[1] && n.user_id === me.id)
      if (!item) return send(res, 404, { detail: missing })
      if (req.method === "PUT") {
        if (kind === "note" && "title" in body && !String(body.title || "").trim()) return send(res, 422, { detail: "Title can't be empty." })
        Object.assign(item, body, { user_id: me.id, updated_at: new Date().toISOString() })
      }
      if (req.method === "DELETE") {
        store.splice(store.indexOf(item), 1)
        return send(res, 200, { message: `${kind === "note" ? "Note" : "Summary"} deleted successfully` })
      }
      return send(res, 200, item)
    }

    // --- public search (fake data, shaped like backend/app/public_search.py) ---
    if (url.pathname === "/public/topics" || url.pathname === "/public/users") {
      const q = (url.searchParams.get("query") || "").replace(/^#/, "").toLowerCase()
      const publicItems = decks
        .filter((d) => d.is_public)
        .map((d) => ({
          id: d.id, study_type: "flashcards", title: d.title, preview: d.cards.map((c) => c.front).join(" · ").slice(0, 220),
          tags: d.tags, user_id: d.user_id, username: "jabari", display_name: null, published_at: d.published_at,
          published_by: "jabari", created_at: d.created_at,
        }))
        .filter((item) => !q || `${item.title} ${item.preview} ${item.tags.join(" ")}`.toLowerCase().includes(q))
      if (url.pathname === "/public/topics") return send(res, 200, publicItems)
      const users = publicItems.length && (!q || "jabari".includes(q) || publicItems.length)
        ? [{ id: "u1", username: "jabari", display_name: null, avatar_url: null, public_count: publicItems.length, items: publicItems }]
        : []
      return send(res, 200, users)
    }

    if (url.pathname === "/health") return send(res, 200, { status: "ok" })
    if (url.pathname === "/me/profile") {
      const a = accountFor(req)
      if (!a) return send(res, 401, { detail: "Session expired. Please log in again." })
      if (req.method === "PUT") profiles.set(a.id, { ...profiles.get(a.id), ...body })
      return send(res, 200, { ...profiles.get(a.id), ...publicUser(a), subscription_status: "free", is_admin: a.id === "u1" })
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
        const plan = {
          id: randomUUID(), user_id: me.id, name, subject: body.subject ?? null, notes: body.notes ?? null,
          duration_seconds: seconds, created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
        }
        studyPlans.unshift(plan)
        return send(res, 201, plan)
      }
      const plan = studyPlans.find((p) => p.id === parts[1] && p.user_id === me.id)
      if (!plan) return send(res, 404, { detail: "Study session not found" })
      if (req.method === "PUT") Object.assign(plan, body, { updated_at: new Date().toISOString() })
      if (req.method === "DELETE") {
        studyPlans.splice(studyPlans.indexOf(plan), 1)
        return send(res, 200, { message: "Study session deleted successfully" })
      }
      return send(res, 200, plan)
    }
    if (parts[0] === "flashcards") {
      const me = accountFor(req)
      if (!me) return send(res, 401, { detail: "Invalid or expired token" })
      if (parts.length === 1 && req.method === "GET") return send(res, 200, decks.filter((d) => d.user_id === me.id).map(shape))
      if (parts.length === 1 && req.method === "POST") {
        const d = { id: randomUUID(), is_public: false, created_at: new Date().toISOString(), tags: [], ...body, user_id: me.id }
        decks.unshift(d)
        return send(res, 201, shape(d))
      }
      const d = decks.find((x) => x.id === parts[1] && (x.user_id === me.id || (req.method === "GET" && x.is_public)))
      if (!d) return send(res, 404, { detail: "Flashcard not found" })
      if (req.method === "PUT") Object.assign(d, body, { updated_at: new Date().toISOString() })
      if (req.method === "DELETE") {
        decks.splice(decks.indexOf(d), 1)
        return send(res, 200, { message: "deleted" })
      }
      return send(res, 200, shape(d))
    }
    send(res, 404, { detail: `Fake server has no route for ${req.method} ${url.pathname}` })
  })
  .listen(PORT, "127.0.0.1", () => console.log(`FAKE Luma API (not real) on http://127.0.0.1:${PORT}`))
