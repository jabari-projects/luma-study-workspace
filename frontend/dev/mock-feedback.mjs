// FAKE monthly feedback poll routes for the fake Luma API (dev/mock-api.mjs).
// Made-up data in memory only. It follows the feedback contract in the build plan, with the
// owner's answers applied:
// - polls open on the LAST Sunday of the month at 12:00 noon America/Chicago and close the
//   following Sunday at noon (date math, so daylight saving time is handled);
// - students see percentages only (never counts), only for questions 5+ students answered,
//   and only the last 24 closed polls;
// - one "Skip" skips the whole poll and is remembered (it is not a vote);
// - admins see comment text only, never who wrote it, and while a poll is open only how many
//   answered (counts, comments and themes after it closes);
// - a deleted account's answers stay in the totals without a user id, its comments are deleted,
//   and a voter key made from the email stops a re-made account voting twice in the same poll
//   (cleared once that poll has closed).
// The open, scheduled and missed scenarios use the real last-Sunday-noon window; "open" moves
// the fake clock into that window when needed.
// Test helpers (local only):
//   POST /__test/clock {now: iso | null}         sets the fake server clock
//   POST /__test/feedback {scenario}             none | scheduled | open | open_voted | closed |
//                                                closed_empty | draft_missed | archive
//   GET  /__test/feedback/counts                 {pollId: {responses, answers}} (counts only)
import { createHmac, randomBytes, randomUUID } from "node:crypto"

// ---------------------------------------------------------------- clock
let clockOverride = null
export const mockNow = () => clockOverride ?? Date.now()
const iso = (ms) => (ms == null ? null : new Date(ms).toISOString())
const HOUR = 3600e3
const DAY = 24 * HOUR

// ---------------------------------------------------------------- Chicago time
const CHI = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/Chicago",
  hourCycle: "h23",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
})
/** "YYYY-MM-DDTHH:MM" wall-clock time in Chicago for an instant. */
export function chicagoWall(ms) {
  const p = Object.fromEntries(CHI.formatToParts(new Date(ms)).map((x) => [x.type, x.value]))
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`
}
/** Chicago wall-clock "YYYY-MM-DDTHH:MM" to an instant, refusing skipped or doubled times. */
export function chicagoToUtc(local) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(String(local || ""))
  if (!m) return { error: "bad_time" }
  const base = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5])
  // Chicago is UTC-5 (CDT) or UTC-6 (CST): try both and keep those that read back the same.
  const hits = [base + 5 * HOUR, base + 6 * HOUR].filter((c) => chicagoWall(c) === local)
  if (hits.length === 0) return { error: "nonexistent_local_time" }
  if (hits.length === 2) return { error: "ambiguous_local_time" }
  return { ms: hits[0] }
}
const pad = (n) => String(n).padStart(2, "0")
/** The last Sunday of a month (month 1-12), as a UTC date at midnight. */
function lastSunday(year, month) {
  const last = new Date(Date.UTC(year, month, 0))
  return new Date(Date.UTC(year, month - 1, last.getUTCDate() - last.getUTCDay()))
}
const day = (d) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`
/** Default window for a poll month: last Sunday 12:00 noon Chicago to the next Sunday 12:00 noon. */
export function defaultWindow(year, month) {
  const open = lastSunday(year, month)
  const close = new Date(Date.UTC(open.getUTCFullYear(), open.getUTCMonth(), open.getUTCDate() + 7))
  return { opens: chicagoToUtc(`${day(open)}T12:00`).ms, closes: chicagoToUtc(`${day(close)}T12:00`).ms }
}
function chicagoMonth(ms) {
  const [y, mo] = chicagoWall(ms).split("-")
  return { year: +y, month: +mo }
}
const periodKey = (year, month) => `${year}-${pad(month)}-01`

// ---------------------------------------------------------------- text rules
const TITLE = "If it ain't broke why fix it?!"
const INTRO =
  "Help us make Luma better! Answer a few quick questions about what should change. You can skip this poll. Your answers help us choose what to work on next."
const COMMENT_MAX = 500
const PRIVACY_NOTE = "Admins can't see who wrote your answers."
const COMMENT_LABEL = "Anything else you'd like us to add or change?"
const COMMENT_HINT = "Please don't include passwords or private information."
const MSG_ALREADY = "We already have your answers for this poll. Thanks!"
const MSG_WORDING_STARTED = "Voting has started, so the wording is locked."
const MSG_OPENS_IN_PAST = "The opening time has already passed. Pick a later time."
const MSG_OVERLAP = "Another scheduled poll is already open at that time."
const MSG_BAD_WINDOW = "The poll must close after it opens, and stay open 31 days or less."
const ARCHIVE_LIMIT = 24
const MIN_ANSWERS_SHOWN = 5
const MSG_AFTER_CLOSE = "Totals and comments show up after the poll closes, so no one can tell who wrote what."
const UPDATE_STATUSES = ["reviewing", "planned", "keeping", "done"]
const FLAGS = ["security", "accessibility", "privacy"]
const URGENT_WORDS = {
  security: ["password", "hacked", "hack", "someone else's account", "logged in as", "phishing", "scam", "leak", "breach", "stolen"],
  privacy: ["private", "personal info", "can see my", "my email", "exposed", "made public", "tracking", "doxx", "phone number", "address"],
  accessibility: ["screen reader", "blind", "low vision", "dyslex", "colorblind", "contrast", "keyboard", "font size", "zoom", "caption", "deaf", "seizure", "flashing", "can't read"],
}
function urgentFlags(text) {
  const lower = String(text || "").toLowerCase().replace(/’/g, "'")
  return FLAGS.filter((flag) => URGENT_WORDS[flag].some((word) => lower.includes(word)))
}
const codePoints = (s) => [...s].length
function cleanComment(raw) {
  if (raw == null) return { value: null }
  let s = String(raw).normalize("NFC").replace(/\r\n?/g, "\n")
  s = s.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, "")
  s = s.replace(/[​-‏‪-‮⁦-⁩﻿]/g, "")
  s = s.replace(/\n{3,}/g, "\n\n").trim()
  if (!s) return { value: null }
  if (codePoints(s) > COMMENT_MAX) return { error: true }
  return { value: s }
}
function lint(label) {
  const text = ` ${String(label).toLowerCase()} `
  if (text.includes(" and ") || text.includes(" or ") || text.includes("/")) return "Is this two changes in one? Split it."
  if (/^\s*(don't|dont|stop|remove|keep|no longer)\b/.test(text)) return "Yes must mean 'I want this change'. Write the change itself."
  return null
}

// ---------------------------------------------------------------- math
function pct(yes, answered) {
  if (!answered) return { yes_pct: null, no_pct: null }
  const yes_pct = Math.floor((200 * yes + answered) / (2 * answered))
  return { yes_pct, no_pct: 100 - yes_pct }
}
function sortRows(rows) {
  return [...rows].sort((a, b) => {
    if (!a.answered !== !b.answered) return a.answered ? -1 : 1
    if (a.answered && b.answered) {
      const diff = b.yes * a.answered - a.yes * b.answered // exact ratio, no rounding
      if (diff) return diff
    }
    return b.answered - a.answered || a.position - b.position
  })
}

// ---------------------------------------------------------------- state
let polls = [] // {id, period_month, opens_at, closes_at, approved_at, questions:[{id, position, label}]}
let responses = [] // {id, poll_id, user_id, voter_key, comment, urgent_flags, urgent_set_by_admin, submitted_at, answers: {qid: bool}}
let skips = new Set() // `${poll}:${user}`
let themes = [] // {id, poll_id, label, term, source, members: Set(responseId)}
let updates = [] // {id, poll_id, position, title, status, note, published}
const VOTER_SECRET = randomBytes(32)
const voterKey = (email) => createHmac("sha256", VOTER_SECRET).update(String(email).trim().toLowerCase()).digest("hex")

function status(p, now = mockNow()) {
  if (!p.approved_at) return now >= p.opens_at ? "missed" : "draft"
  if (now < p.opens_at) return "scheduled"
  if (now < p.closes_at) return "open"
  return "closed"
}
const pollById = (id) => polls.find((p) => p.id === id)
// The email key is only matched for a verified email (an unverified sign-up learns nothing).
const ballotFor = (pollId, account) =>
  responses.find(
    (r) => r.poll_id === pollId && (r.user_id === account.id || (account.email_verified && r.voter_key === voterKey(account.email))),
  )
/** A deleted account's ballot keeps its email key only while its poll is open. */
function forgetClosedVoterKeys() {
  for (const r of responses) {
    const p = pollById(r.poll_id)
    if (r.user_id === null && r.voter_key && p && status(p) === "closed") r.voter_key = null
  }
}

function totals(p) {
  const ballots = responses.filter((r) => r.poll_id === p.id)
  const rows = p.questions.map((q) => {
    const yes = ballots.filter((r) => r.answers[q.id] === true).length
    const no = ballots.filter((r) => r.answers[q.id] === false).length
    const answered = yes + no
    return { id: q.id, position: q.position, label: q.label, yes, no, answered, skipped: ballots.length - answered, ...pct(yes, answered) }
  })
  return { participants: ballots.length, questions: sortRows(rows) }
}

// ---------------------------------------------------------------- local theme grouping (no AI)
const STOP = new Set(
  "a an the and or but if of to in on for with at by from is are was were be been it its this that these those i me my we you your they them he she his her our so too very can could should would will just not no yes do does did have has had am as about into than then there here what when where which who how all any some more most other such only own same also get got make like want really please add better change feature luma app site".split(" "),
)
const SYNONYMS = [
  [/\bnight mode\b|\bdark theme\b/g, "dark mode"],
  [/\bflash cards?\b|\bcards\b|\bdecks?\b/g, "flashcard"],
  [/\bphones?\b|\bmobile\b/g, "mobile"],
  [/\bslow\b|\blag\w*\b|\bloading\b/g, "speed"],
]
/** Map of term -> the student's own wording for it (unigrams and adjacent pairs). */
function terms(text) {
  let s = String(text).normalize("NFKC").toLowerCase().replace(/https?:\/\/\S+|\S+@\S+|\d+/g, " ")
  for (const [re, to] of SYNONYMS) s = s.replace(re, to)
  const words = (s.match(/[a-z']+/g) || [])
    .map((w) => w.replace(/'s$/, ""))
    .filter((w) => w.length > 2 && !STOP.has(w))
    .map((raw) => ({
      raw,
      term: raw.endsWith("ies") && raw.length > 4 ? `${raw.slice(0, -3)}y` : raw.length > 4 && raw.endsWith("s") && !raw.endsWith("ss") ? raw.slice(0, -1) : raw,
    }))
  const out = new Map()
  for (const w of words) if (!out.has(w.term)) out.set(w.term, w.raw)
  for (let i = 0; i + 1 < words.length; i += 1) {
    const key = `${words[i].term} ${words[i + 1].term}`
    if (!out.has(key)) out.set(key, `${words[i].raw} ${words[i + 1].raw}`)
  }
  return out
}
function regroup(pollId) {
  const commented = responses.filter((r) => r.poll_id === pollId && r.comment)
  // Keep admin themes and the comments in them; drop auto themes. A merged or renamed theme's
  // term never comes back as a new auto theme, and admin-placed comments aren't grouped again.
  themes = themes.filter((t) => t.poll_id !== pollId || t.source === "admin")
  const kept = themes.filter((t) => t.poll_id === pollId)
  const keptTerms = new Set(kept.map((t) => t.term).filter(Boolean))
  const keptLabels = new Set(kept.map((t) => t.label.toLowerCase()))
  const placed = new Set(kept.flatMap((t) => [...t.members]))
  const byTerm = new Map()
  const wording = new Map()
  for (const r of commented) {
    for (const [t, raw] of terms(r.comment)) {
      byTerm.set(t, [...(byTerm.get(t) || []), r.id])
      const counts = wording.get(t) || new Map()
      counts.set(raw, (counts.get(raw) || 0) + 1)
      wording.set(t, counts)
    }
  }
  const candidates = [...byTerm.entries()]
    .filter(([, ids]) => ids.length >= 2)
    .sort((a, b) => b[1].length - a[1].length || (b[0].includes(" ") ? 1 : 0) - (a[0].includes(" ") ? 1 : 0) || a[0].localeCompare(b[0]))
  const made = []
  for (const [term, ids] of candidates) {
    const set = new Set(ids)
    const same = made.find((m) => {
      const inter = [...set].filter((id) => m.members.has(id)).length
      return inter / new Set([...set, ...m.members]).size >= 0.6
    })
    if (same) {
      ids.forEach((id) => same.members.add(id))
      continue
    }
    if (made.length >= 30) break
    const raw = [...wording.get(term).entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0][0]
    made.push({ id: randomUUID(), poll_id: pollId, label: raw.charAt(0).toUpperCase() + raw.slice(1), term, source: "auto", members: set })
  }
  for (const m of made) {
    if (keptTerms.has(m.term) || keptLabels.has(m.label.toLowerCase())) continue
    m.members = new Set([...m.members].filter((id) => !placed.has(id)))
    if (m.members.size >= 2) themes.push(m)
  }
}
function commentView(r) {
  return {
    response_ref: r.id.slice(0, 8),
    response_id: r.id,
    comment: r.comment,
    urgent_flags: r.urgent_flags,
    urgent_set_by_admin: r.urgent_set_by_admin,
    theme_ids: themes.filter((t) => t.members.has(r.id)).map((t) => t.id),
  }
}

// ---------------------------------------------------------------- scenarios
const QUESTIONS = [
  "Add a dark mode for the flashcard review screen",
  "Show a timer while you take a quiz",
  "Let you pick a color for each deck",
  "Add sound effects when you get a card right",
  "Show how many cards you studied this month",
  "Make the Home page show your next quiz",
  "Add bigger buttons on phones",
  "Let you print a deck as paper cards",
  "Send a weekly study reminder email",
  "Add a calm music player while you study",
]
function addPoll({ period, opens, closes, approved = true, questions = QUESTIONS }) {
  const p = {
    id: randomUUID(),
    period_month: period,
    opens_at: opens,
    closes_at: closes,
    approved_at: approved ? opens - 3 * DAY : null,
    questions: questions.map((label, i) => ({ id: randomUUID(), position: i + 1, label })),
  }
  polls.push(p)
  return p
}
function addBallot(p, userId, choices, comment = null) {
  const answers = {}
  Array.from(choices).forEach((c, i) => {
    if (c === "y") answers[p.questions[i].id] = true
    if (c === "n") answers[p.questions[i].id] = false
  })
  const r = {
    id: randomUUID(), poll_id: p.id, user_id: userId, voter_key: voterKey(`${userId}@seed.test`), comment,
    urgent_flags: urgentFlags(comment), urgent_set_by_admin: false, submitted_at: p.opens_at + HOUR, answers,
  }
  responses.push(r)
  return r
}
const periodOf = (ms) => {
  const { year, month } = chicagoMonth(ms)
  return periodKey(year, month)
}
/** The next real poll window (last Sunday noon to next Sunday noon) that hasn't closed yet. */
function currentWindow(now) {
  let { year, month } = chicagoMonth(now)
  for (let i = 0; i < 3; i += 1) {
    const w = defaultWindow(year, month)
    if (w.closes > now) return { ...w, period: periodKey(year, month) }
    month += 1
    if (month === 13) {
      month = 1
      year += 1
    }
  }
  throw new Error("no window")
}
/** A poll window that is open right now: the real one, with the fake clock moved into it if needed. */
function openWindow() {
  const w = currentWindow(mockNow())
  if (mockNow() < w.opens) clockOverride = w.opens + DAY // Monday noon, Central time
  return w
}

function seed(scenario) {
  polls = []
  responses = []
  skips = new Set()
  themes = []
  updates = []
  const now = mockNow()
  if (scenario === "scheduled") {
    let w = currentWindow(now)
    if (w.opens <= now) w = currentWindow(w.closes)
    addPoll({ period: w.period, opens: w.opens, closes: w.closes })
  }
  if (scenario === "open" || scenario === "open_voted") {
    const w = openWindow()
    const p = addPoll({ period: w.period, opens: w.opens, closes: w.closes })
    if (scenario === "open_voted") {
      addBallot(p, "u2", "yyn-ynyy-n", "Please add a dark mode for flash cards")
      addBallot(p, "u3", "ynnyyn-y--", null)
    }
  }
  if (scenario === "closed") {
    const p = addPoll({ period: periodOf(now - 8 * DAY), opens: now - 7 * DAY - HOUR, closes: now - HOUR })
    // Question 1: 3 yes, 1 no, 2 skipped (75/25). Question 3: everyone skipped.
    addBallot(p, "seed-1", "yy-nyyyyyy", "Please add a dark mode for flash cards. SENTINEL-COMMENT-7")
    addBallot(p, "seed-2", "yn-nyyynny", "Dark mode please, my eyes hurt at night")
    addBallot(p, "seed-3", "yy-nnynnyn", "<img src=x onerror=\"window.__pwned=1\"><script>window.__pwned=2</script>")
    addBallot(p, "seed-4", "nn-nnynnyn", "Someone got my password and my account got hacked")
    addBallot(p, "seed-5", "-y-ynynyyn", "The timer on quizzes is too slow to load")
    addBallot(p, "seed-6", "-n-ynnyyyy", "Quizzes need a timer that is slow to load")
    regroup(p.id)
  }
  if (scenario === "closed_empty") addPoll({ period: periodOf(now - 8 * DAY), opens: now - 7 * DAY - HOUR, closes: now - HOUR })
  if (scenario === "draft_missed") {
    const w = openWindow()
    addPoll({ period: w.period, opens: w.opens, closes: w.closes, approved: false })
  }
  if (scenario === "archive") {
    // 30 closed monthly polls: students see the newest 24, admins see them all.
    let { year, month } = chicagoMonth(now)
    for (let i = 0; i < 30; i += 1) {
      month -= 1
      if (month === 0) {
        month = 12
        year -= 1
      }
      const w = defaultWindow(year, month)
      if (w.closes > now) continue
      const p = addPoll({ period: periodKey(year, month), opens: w.opens, closes: w.closes, questions: QUESTIONS.slice(0, 3) })
      addBallot(p, `arch-${i}`, "yny")
    }
  }
}

function ensureDrafts() {
  const now = mockNow()
  let { year, month } = chicagoMonth(now)
  for (let i = 0; i < 2; i += 1) {
    const key = periodKey(year, month)
    if (!polls.some((p) => p.period_month === key)) {
      const w = defaultWindow(year, month)
      addPoll({ period: key, opens: w.opens, closes: w.closes, approved: false, questions: [] })
    }
    month += 1
    if (month === 13) {
      month = 1
      year += 1
    }
  }
}

/** Called by DELETE /me/account: answers stay without a user id, comments go. */
export function forgetFeedbackUser(account) {
  for (const r of responses) {
    if (r.user_id !== account.id) continue
    r.user_id = null
    r.comment = null
    for (const t of themes) t.members.delete(r.id)
  }
  forgetClosedVoterKeys()
  skips = new Set([...skips].filter((k) => !k.endsWith(`:${account.id}`)))
}
export const FEEDBACK_RETAINED = "Your answers to monthly feedback polls stay in the totals, without your name. Your poll comments are deleted."

// ---------------------------------------------------------------- routes
const fail = (detail, error_code, extra = {}) => ({ detail, error_code, ...extra })
/** A request-body error, shaped like FastAPI's own 422 (no error_code). */
const invalid = (field) => ({ detail: [{ loc: ["body", field], msg: "Invalid value", type: "value_error" }] })

/** The admin list fields (the backend's _admin_summary). */
function adminSummary(p) {
  const st = status(p)
  return {
    id: p.id, period_month: p.period_month, opens_at: iso(p.opens_at), closes_at: iso(p.closes_at),
    opens_local: chicagoWall(p.opens_at), closes_local: chicagoWall(p.closes_at), approved_at: iso(p.approved_at),
    status: st, question_count: p.questions.length,
    participants: st === "open" || st === "closed" ? responses.filter((r) => r.poll_id === p.id).length : 0,
  }
}
/** One poll for the admin editor (the backend's _admin_detail), flat. */
function adminDetail(p) {
  const [y, mo] = p.period_month.split("-").map(Number)
  const d = defaultWindow(y, mo)
  const st = status(p)
  return {
    ...adminSummary(p),
    title: TITLE,
    intro: INTRO,
    questions: p.questions.map(({ id, position, label }) => ({ id, position, label })),
    can_edit_questions: !p.approved_at,
    can_edit_dates: !(st === "open" || st === "closed") || !p.approved_at,
    can_approve: !p.approved_at,
    can_unapprove: st === "scheduled",
    lint: p.questions.map((q) => ({ position: q.position, message: lint(q.label) })).filter((x) => x.message),
    default_opens_local: chicagoWall(d.opens),
    default_closes_local: chicagoWall(d.closes),
  }
}
/** The backend's themes body: urgent comments, themes and the rest. */
function themesBody(pollId) {
  // Response-id order (random), never newest first.
  const commented = responses.filter((r) => r.poll_id === pollId && r.comment).sort((a, b) => a.id.localeCompare(b.id))
  const mine = themes.filter((t) => t.poll_id === pollId)
  const inTheme = new Set(mine.flatMap((t) => [...t.members]))
  const other = commented.filter((r) => !inTheme.has(r.id)).map((r) => r.id)
  return {
    urgent: commented.filter((r) => r.urgent_flags.length).map(commentView),
    themes: mine
      .map((t) => ({ id: t.id, label: t.label, source: t.source, count: t.members.size, response_ids: [...t.members] }))
      .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label)),
    other_count: other.length,
    other_response_ids: other,
  }
}
function studentRows(rows) {
  const out = rows.map(({ id, position, label, yes_pct, no_pct, answered }) =>
    answered >= MIN_ANSWERS_SHOWN ? { id, position, label, yes_pct, no_pct } : { id, position, label, yes_pct: null, no_pct: null },
  )
  return [...out.filter((r) => r.yes_pct !== null), ...out.filter((r) => r.yes_pct === null).sort((a, b) => a.position - b.position)]
}
const studentResults = () =>
  polls
    .filter((p) => status(p) === "closed")
    .sort((a, b) => b.closes_at - a.closes_at)
    .slice(0, ARCHIVE_LIMIT)

/**
 * Handles /__test/clock, /__test/feedback*, /feedback/* and /admin/feedback/*.
 * Returns [status, body] or null when the path is not a feedback route.
 */
export function handleFeedback({ method, pathname, parts, searchParams, body, account, isAdmin }) {
  if (pathname === "/__test/clock" && method === "POST") {
    clockOverride = body.now ? Date.parse(body.now) : null
    return [200, { now: iso(mockNow()) }]
  }
  if (pathname === "/__test/feedback" && method === "POST") {
    seed(String(body.scenario || "none"))
    return [200, { scenario: body.scenario || "none", polls: polls.map((p) => ({ id: p.id, status: status(p), opens_at: iso(p.opens_at), closes_at: iso(p.closes_at) })) }]
  }
  if (pathname === "/__test/feedback/counts" && method === "GET") {
    const out = {}
    for (const p of polls) {
      const mine = responses.filter((r) => r.poll_id === p.id)
      out[p.id] = { responses: mine.length, answers: mine.reduce((n, r) => n + Object.keys(r.answers).length, 0) }
    }
    return [200, out]
  }

  // ------------------------------------------------------------ student routes
  if (parts[0] === "feedback") {
    if (!account) return [401, { detail: "Not authenticated" }]
    const now = mockNow()
    if (pathname === "/feedback/current" && method === "GET") {
      forgetClosedVoterKeys()
      const p = polls.find((x) => status(x) === "open")
      const ballot = p ? ballotFor(p.id, account) : null
      const next = polls.filter((x) => status(x) === "scheduled").sort((a, b) => a.opens_at - b.opens_at)[0]
      const latest = studentResults().find((x) => now - x.closes_at < 14 * DAY)
      return [200, {
        server_now: iso(now),
        schedule_tz: "America/Chicago",
        poll: p ? { id: p.id, title: TITLE, intro: INTRO, privacy_note: PRIVACY_NOTE, comment_label: COMMENT_LABEL, comment_hint: COMMENT_HINT, comment_max: COMMENT_MAX, opens_at: iso(p.opens_at), closes_at: iso(p.closes_at), status: "open", questions: p.questions.map(({ id, position, label }) => ({ id, position, label })) } : null,
        // A ballot from an earlier, deleted account with the same email stays anonymous: no answers shown.
        my_response: ballot
          ? ballot.user_id === account.id
            ? {
                submitted_at: iso(ballot.submitted_at),
                answers: p.questions.filter((q) => q.id in ballot.answers).map((q) => ({ question_id: q.id, choice: ballot.answers[q.id] ? "yes" : "no" })),
                comment: ballot.comment,
              }
            : { submitted_at: iso(ballot.submitted_at), answers: [], comment: null }
          : null,
        skipped: Boolean(p && skips.has(`${p.id}:${account.id}`)),
        can_vote: Boolean(p && account.email_verified && !ballot),
        blocked_reason: p && !ballot && !account.email_verified ? "email_unverified" : null,
        next_opens_at: next ? iso(next.opens_at) : null,
        latest_results: latest ? { poll_id: latest.id, closed_at: iso(latest.closes_at) } : null,
      }]
    }
    if (parts[1] === "polls" && parts[3] === "skip" && method === "POST") {
      const p = pollById(parts[2])
      if (!p || !p.approved_at) return [404, fail("We couldn't find that poll.", "poll_not_found")]
      // Like the backend: a poll that isn't open yet or has closed is refused, and a student who voted gets already_received.
      if (status(p) === "scheduled") return [409, fail("This poll isn't open yet.", "poll_not_open")]
      if (status(p) === "closed") return [409, fail("This poll is already closed.", "poll_closed")]
      if (responses.some((r) => r.poll_id === p.id && r.user_id === account.id)) return [200, { status: "already_received", message: MSG_ALREADY }]
      skips.add(`${p.id}:${account.id}`)
      return [200, { status: "skipped", message: "Okay! We skipped this poll for you." }]
    }
    if (parts[1] === "polls" && parts[3] === "responses" && method === "POST") {
      if (!account.email_verified) return [403, fail("Verify your email to answer the poll.", "email_unverified")]
      const p = pollById(parts[2])
      if (!p || !p.approved_at) return [404, fail("We couldn't find that poll.", "poll_not_found")]
      const existing = ballotFor(p.id, account)
      if (existing) return [200, { status: "already_received", message: MSG_ALREADY, submitted_at: iso(existing.submitted_at) }]
      const st = status(p)
      if (st === "scheduled") return [409, fail("This poll isn't open yet.", "poll_not_open")]
      if (st === "closed") return [409, fail("This poll closed before your answers arrived.", "poll_closed", { closes_at: iso(p.closes_at) })]
      const extra = Object.keys(body).filter((k) => k !== "answers" && k !== "comment")
      const list = body.answers ?? []
      if (extra.length || !Array.isArray(list) || list.length > 12) return [422, invalid("answers")]
      const answers = {}
      for (const a of list) {
        if (!a || (a.choice !== "yes" && a.choice !== "no")) return [422, invalid("answers")]
        if (!p.questions.some((q) => q.id === a.question_id)) return [422, fail("One of those questions isn't in this poll. Reload the page and try again.", "unknown_question")]
        if (a.question_id in answers) return [422, fail("Something was wrong with those answers. Reload the page and try again.", "bad_answers")]
        answers[a.question_id] = a.choice === "yes"
      }
      const cleaned = cleanComment(body.comment)
      if (cleaned.error) return [422, fail(`Please shorten your comment to ${COMMENT_MAX} characters or fewer.`, "comment_too_long")]
      if (!Object.keys(answers).length && !cleaned.value) return [422, fail("Answer at least one question, or skip the poll.", "empty_response")]
      const r = {
        id: randomUUID(), poll_id: p.id, user_id: account.id, voter_key: voterKey(account.email), comment: cleaned.value,
        urgent_flags: urgentFlags(cleaned.value), urgent_set_by_admin: false, submitted_at: now, answers,
      }
      responses.push(r)
      console.log(`[FAKE FEEDBACK] ballot answers=${Object.keys(answers).length} has_comment=${Boolean(cleaned.value)}`)
      return [201, { status: "received", message: "Thanks! We got your answers.", submitted_at: iso(now) }]
    }
    if (pathname === "/feedback/results" && method === "GET") {
      return [200, studentResults().map((p) => ({ id: p.id, title: TITLE, period_month: p.period_month, opens_at: iso(p.opens_at), closes_at: iso(p.closes_at) }))]
    }
    if (parts[1] === "results" && parts[2] && method === "GET") {
      const p = pollById(parts[2])
      if (!p || !p.approved_at) return [404, fail("We couldn't find those results.", "poll_not_found")]
      if (status(p) !== "closed") return [409, fail("Results come out when the poll closes.", "results_not_ready", { closes_at: iso(p.closes_at) })]
      if (!studentResults().includes(p)) return [404, fail("We couldn't find those results.", "poll_not_found")]
      const published = updates.filter((u) => u.poll_id === p.id && u.published).sort((a, b) => a.position - b.position)
      return [200, {
        poll: { id: p.id, title: TITLE, period_month: p.period_month, opens_at: iso(p.opens_at), closes_at: iso(p.closes_at) },
        // Percentages only: never counts, participants, comments or names. Too few answers: null, last.
        questions: studentRows(totals(p).questions),
        updates: published.map(({ title, status: s, note }) => ({ title, status: s, note })),
        update_summary: published.length ? null : "We're reviewing your feedback.",
      }]
    }
    return [404, { detail: `Fake server has no route for ${method} ${pathname}` }]
  }

  // ------------------------------------------------------------ admin routes
  if (parts[0] !== "admin" || parts[1] !== "feedback") return null
  if (!account) return [401, { detail: "Not authenticated" }]
  if (!isAdmin) return [403, { detail: "Admin access required" }]
  const now = mockNow()

  if (pathname === "/admin/feedback/polls" && method === "GET") {
    ensureDrafts()
    forgetClosedVoterKeys()
    return [200, [...polls]
      .sort((a, b) => b.period_month.localeCompare(a.period_month) || b.opens_at - a.opens_at)
      .map(adminSummary)]
  }

  if (parts[2] === "polls" && parts[3]) {
    const p = pollById(parts[3])
    if (!p) return [404, fail("We couldn't find that poll.", "poll_not_found")]
    const started = p.approved_at && now >= p.opens_at
    const closedNow = status(p) === "closed"
    const sub = parts[4]
    const afterClose = [409, fail(MSG_AFTER_CLOSE, "after_close", { closes_at: iso(p.closes_at) })]
    if (!sub && method === "GET") return [200, adminDetail(p)]
    if (!sub && method === "PATCH") {
      const o = chicagoToUtc(body.opens_local)
      const c = chicagoToUtc(body.closes_local)
      const bad = o.error || c.error
      if (bad === "nonexistent_local_time" || bad === "ambiguous_local_time") {
        return [422, fail("That time is skipped or happens twice in Central time because of daylight saving. Pick another time.", bad)]
      }
      if (bad) return [422, fail("Use a date and time like 2026-11-29T12:00.", "bad_local_time")]
      if (c.ms <= o.ms || c.ms - o.ms > 31 * DAY) return [422, fail(MSG_BAD_WINDOW, "bad_window")]
      // Like the backend: the times are checked first, then the poll's state.
      if (started) return [409, fail(MSG_WORDING_STARTED, "wording_locked")]
      if (p.approved_at && o.ms <= now) return [409, fail(MSG_OPENS_IN_PAST, "opens_in_past")]
      if (p.approved_at && polls.some((x) => x !== p && x.approved_at && x.opens_at < c.ms && o.ms < x.closes_at)) {
        return [409, fail(MSG_OVERLAP, "overlap")]
      }
      p.opens_at = o.ms
      p.closes_at = c.ms
      return [200, adminDetail(p)]
    }
    if (sub === "questions" && method === "PUT") {
      if (!Array.isArray(body.questions)) return [422, invalid("questions")]
      // Like the backend: whitespace collapsed and labels checked before the poll's state.
      const labels = body.questions.map((q) => String(q?.label ?? "").split(/\s+/).filter(Boolean).join(" "))
      if (labels.length < 1 || labels.length > 12) return [422, fail("Use 1 to 12 questions.", "bad_questions")]
      if (labels.some((l) => codePoints(l) < 3 || codePoints(l) > 160)) return [422, fail("Each question needs 3 to 160 characters.", "bad_questions")]
      if (new Set(labels.map((l) => l.toLowerCase())).size !== labels.length) return [422, fail("Two questions are the same. Change or remove one.", "bad_questions")]
      if (p.approved_at) {
        return started
          ? [409, fail(MSG_WORDING_STARTED, "wording_locked")]
          : [409, fail("Move it back to draft to edit questions.", "wording_locked")]
      }
      p.questions = labels.map((label, i) => ({ id: randomUUID(), position: i + 1, label }))
      return [200, adminDetail(p)]
    }
    if (sub === "approve" && method === "POST") {
      const check = body.checklist || {}
      if (check.one_change_each !== true || check.yes_means_change !== true) return [422, fail("Check both boxes to approve.", "checklist")]
      if (p.approved_at) return [200, adminDetail(p)]
      if (!p.questions.length) return [422, fail("Add at least one question first.", "no_questions")]
      if (p.opens_at <= now) return [409, fail(MSG_OPENS_IN_PAST, "opens_in_past")]
      if (polls.some((x) => x !== p && x.approved_at && x.opens_at < p.closes_at && p.opens_at < x.closes_at)) {
        return [409, fail(MSG_OVERLAP, "overlap")]
      }
      p.approved_at = now
      return [200, adminDetail(p)]
    }
    if (sub === "unapprove" && method === "POST") {
      if (!p.approved_at) return [200, adminDetail(p)]
      if (started) return [409, fail(MSG_WORDING_STARTED, "wording_locked")]
      p.approved_at = null
      return [200, adminDetail(p)]
    }
    if (sub === "totals" && method === "GET") {
      if (!started) return [409, fail("Totals show up once the poll opens.", "not_open_yet")]
      const t = totals(p)
      // While open: only how many answered.
      return [200, { participants: t.participants, no_votes: t.participants === 0, as_of: iso(now), final: closedNow, questions: closedNow ? t.questions : [] }]
    }
    if ((sub === "comments" || sub === "themes") && !closedNow) return afterClose
    if (sub === "comments" && method === "GET") {
      const theme = searchParams.get("theme_id")
      const urgent = searchParams.get("urgent") === "true"
      const list = responses
        .filter((r) => r.poll_id === p.id && r.comment)
        .filter((r) => !theme || themes.some((t) => t.id === theme && t.members.has(r.id)))
        .filter((r) => !urgent || r.urgent_flags.length)
        .sort((a, b) => a.id.localeCompare(b.id))
      return [200, list.map(commentView)]
    }
    if (sub === "themes" && !parts[5] && method === "GET") return [200, themesBody(p.id)]
    if (sub === "themes" && parts[5] === "regroup" && method === "POST") {
      regroup(p.id)
      return [200, themesBody(p.id)]
    }
    if (sub === "updates" && method === "GET") {
      return [200, updates.filter((u) => u.poll_id === p.id).sort((a, b) => a.position - b.position)]
    }
    if (sub === "updates" && method === "POST") {
      const title = String(body.title || "").trim()
      if (!title || title.length > 160) return [422, invalid("title")]
      if (!UPDATE_STATUSES.includes(body.status ?? "reviewing")) return [422, invalid("status")]
      const u = {
        id: randomUUID(), poll_id: p.id, position: updates.filter((x) => x.poll_id === p.id).length + 1, title,
        status: body.status ?? "reviewing", note: body.note ? String(body.note).slice(0, 600) : null, published: Boolean(body.published),
      }
      updates.push(u)
      return [201, u]
    }
    return [404, { detail: `Fake server has no route for ${method} ${pathname}` }]
  }

  const pollClosed = (pollId) => {
    const p = pollById(pollId)
    return Boolean(p && status(p) === "closed")
  }
  const afterClose = [409, fail(MSG_AFTER_CLOSE, "after_close")]
  if (parts[2] === "themes" && parts[3] === "merge" && method === "POST") {
    if (!pollClosed(body.poll_id)) return afterClose
    const into = themes.find((t) => t.id === body.into_theme_id && t.poll_id === body.poll_id)
    const from = themes.filter((t) => (body.from_theme_ids || []).includes(t.id) && t.poll_id === body.poll_id && t !== into)
    if (!into) return [404, fail("We couldn't find that theme.", "theme_not_found")]
    for (const t of from) t.members.forEach((id) => into.members.add(id))
    themes = themes.filter((t) => !from.includes(t))
    into.source = "admin"
    return [200, themesBody(into.poll_id)]
  }
  if (parts[2] === "themes" && parts[3]) {
    const t = themes.find((x) => x.id === parts[3])
    if (!t) return [404, fail("We couldn't find that theme.", "theme_not_found")]
    if (!pollClosed(t.poll_id)) return afterClose
    if (parts[4] === "split" && method === "POST") {
      const asked = Array.isArray(body.response_ids) ? body.response_ids : []
      const ids = asked.filter((id) => t.members.has(id))
      const label = String(body.label || "").trim()
      if (!label) return [422, fail("Give the new theme a name.", "bad_label")]
      if (!asked.length || ids.length !== asked.length) return [422, fail("Pick comments that are in this theme.", "bad_members")]
      const made = { id: randomUUID(), poll_id: t.poll_id, label: label.slice(0, 80), term: null, source: "admin", members: new Set(ids) }
      ids.forEach((id) => t.members.delete(id))
      t.source = "admin"
      themes.push(made)
      return [200, themesBody(t.poll_id)]
    }
    if (!parts[4] && method === "PATCH") {
      const label = String(body.label || "").trim()
      if (!label || label.length > 80) return [422, fail("Give the theme a name.", "bad_label")]
      t.label = label
      t.source = "admin"
      return [200, themesBody(t.poll_id)]
    }
    if (!parts[4] && method === "DELETE") {
      themes = themes.filter((x) => x !== t)
      return [200, themesBody(t.poll_id)]
    }
  }
  if (parts[2] === "responses" && parts[3] && method === "PATCH") {
    const r = responses.find((x) => x.id === parts[3])
    if (!r || !r.comment) return [404, fail("We couldn't find that comment.", "response_not_found")]
    if (!pollClosed(r.poll_id)) return afterClose
    const flags = Array.isArray(body.urgent_flags) ? body.urgent_flags : null
    if (!flags || flags.length > 3 || flags.some((f) => !FLAGS.includes(f))) return [422, invalid("urgent_flags")]
    r.urgent_flags = [...new Set(flags)]
    r.urgent_set_by_admin = true
    return [200, commentView(r)]
  }
  if (parts[2] === "updates" && parts[3]) {
    const u = updates.find((x) => x.id === parts[3])
    if (!u) return [404, fail("We couldn't find that update.", "update_not_found")]
    if (method === "PATCH") {
      if (body.status != null && !UPDATE_STATUSES.includes(body.status)) return [422, invalid("status")]
      if (body.title != null && !String(body.title).trim()) return [422, invalid("title")]
      for (const key of ["title", "status", "note", "published", "position"]) if (body[key] !== undefined) u[key] = key === "title" ? String(body.title).trim() : body[key]
      return [200, u]
    }
    if (method === "DELETE") {
      updates = updates.filter((x) => x !== u)
      return [200, { deleted: true }]
    }
  }
  return [404, { detail: `Fake server has no route for ${method} ${pathname}` }]
}
