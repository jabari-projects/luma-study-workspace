// FAKE Luma API for local visual checks only. Nothing here is real:
// no database, no email, no AI. Data lives in memory and vanishes on restart.
//
//   npm run mock-api            (port 8787; PORT=8789 npm run mock-api for another)
//   VITE_API_BASE_URL=http://127.0.0.1:8787 npm run dev
//
// "Emails" are printed to this console, e.g. [FAKE EMAIL] code for a@b.test: 123456
// Seeded accounts: demo@luma.test / demo-password (verified),
//                  unverified@luma.test / demo-password (not verified yet).
// It follows the account contract in docs/api.md (signup -> code -> session).
import http from "node:http"
import { randomInt, randomUUID } from "node:crypto"

const PORT = Number(process.env.PORT || 8787)
const user = { id: "u1", email: "demo@luma.test", username: "jabari" }
let profile = { ...user, theme_color: "#0f766e", theme_mode: process.env.MODE || "light", subscription_status: "free", email_verified: true }

// ---------- fake accounts ----------
const accounts = new Map() // email -> account
const sessions = new Map() // token -> account id
const resetTokens = new Map() // token -> { id, expires }
const pending = new Map() // signup ticket -> { email, username, password, code } (no account yet)
function addAccount(email, username, password, verified, id = randomUUID()) {
  const account = { id, email, username, password, email_verified: verified, code: null, lastSent: 0, version: 1 }
  accounts.set(email, account)
  return account
}
addAccount("demo@luma.test", "jabari", "demo-password", true, "u1")
addAccount("unverified@luma.test", "new_student", "demo-password", false)
const byId = (id) => [...accounts.values()].find((a) => a.id === id)
const publicUser = (a) => ({ id: a.id, email: a.email, username: a.username, email_verified: a.email_verified })
function newSession(account) {
  const token = `fake-${randomUUID()}`
  sessions.set(token, { id: account.id, version: account.version })
  return { access_token: token, user: publicUser(account) }
}
function accountFor(req) {
  const token = (req.headers.authorization || "").replace(/^Bearer /, "")
  if (token === "mock") return byId("u1") // old demo token
  const s = sessions.get(token)
  const a = s && byId(s.id)
  return a && a.version === s.version ? a : null
}
function sendCode(account) {
  const now = Date.now()
  if (now - account.lastSent < 60_000) return false
  account.lastSent = now
  account.code = { value: String(randomInt(0, 1_000_000)).padStart(6, "0"), expires: now + 600_000, attempts: 0, used: false }
  console.log(`[FAKE EMAIL] code for ${account.email}: ${account.code.value}`)
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
const lists = { summaries: [{ id: "x" }], "study-sessions": [] }

let currentOrigin = "http://localhost:5173"
function send(res, code, body) {
  res.writeHead(code, {
    "content-type": "application/json",
    "access-control-allow-origin": currentOrigin,
    "access-control-allow-credentials": "true",
    "access-control-allow-headers": "authorization, content-type",
    "access-control-allow-methods": "GET,POST,PUT,DELETE,OPTIONS",
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
    if (url.pathname === "/api/import/link") {
      await new Promise((r) => setTimeout(r, 700))
      const target = body.url || ""
      if (/youtu/.test(target)) return send(res, 422, { error: "For YouTube, copy the transcript and paste it.", code: "youtube" })
      if (/localhost|127\.0\.0\.1/.test(target)) return send(res, 400, { error: "We couldn't open that link.", code: "blocked" })
      return send(res, 200, { title: "The Water Cycle", site_name: "Example Science", url: target, truncated: false, text: "Water moves around the Earth in a cycle. The sun heats water in oceans and lakes, and it evaporates into the air as water vapor. The vapor cools and condenses into clouds. When the drops get heavy, they fall as rain or snow. This is called precipitation. The water collects in rivers, lakes, and oceans, and the cycle starts again." })
    }
    if (url.pathname === "/notes" && req.method === "POST") {
      const note = { id: randomUUID(), user_id: "u1", created_at: new Date().toISOString(), is_public: false, ...body }
      notes.unshift(note)
      return send(res, 201, note)
    }
    if (parts[0] === "notes" && parts[1]) {
      const note = notes.find((n) => n.id === parts[1])
      return note ? send(res, 200, note) : send(res, 404, { detail: "Note not found" })
    }
    if (url.pathname === "/notes") return send(res, 200, notes)

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
      if (a.id !== "u1") return send(res, 200, { ...publicUser(a), subscription_status: "free", theme_mode: "light" })
      if (req.method === "PUT") profile = { ...profile, ...body }
      return send(res, 200, { ...profile, email_verified: a.email_verified })
    }
    if (parts[0] === "flashcards") {
      if (parts.length === 1 && req.method === "GET") return send(res, 200, decks.map(shape))
      if (parts.length === 1 && req.method === "POST") {
        const d = { id: randomUUID(), user_id: "u1", is_public: false, created_at: new Date().toISOString(), tags: [], ...body }
        decks.unshift(d)
        return send(res, 201, shape(d))
      }
      const d = decks.find((x) => x.id === parts[1])
      if (!d) return send(res, 404, { detail: "Flashcard not found" })
      if (req.method === "PUT") Object.assign(d, body, { updated_at: new Date().toISOString() })
      if (req.method === "DELETE") {
        decks.splice(decks.indexOf(d), 1)
        return send(res, 200, { message: "deleted" })
      }
      return send(res, 200, shape(d))
    }
    if (lists[parts[0]]) return send(res, 200, lists[parts[0]])
    send(res, 404, { detail: `Fake server has no route for ${req.method} ${url.pathname}` })
  })
  .listen(PORT, "127.0.0.1", () => console.log(`FAKE Luma API (not real) on http://127.0.0.1:${PORT}`))
