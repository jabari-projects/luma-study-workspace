// Words, types and small helpers for the monthly feedback poll ("If it ain't broke why fix it?!").
// No window, React or axios here, so `node --test` can run it.

export const POLL_TITLE = "If it ain't broke why fix it?!"
export const POLL_INTRO =
  "Help us make Luma better! Answer a few quick questions about what should change. You can skip this poll. Your answers help us choose what to work on next."
export const PRIVACY_LINE = "Admins can't see who wrote your answers."
export const ONE_VOTE_LINE = "Your answers are saved with your account, so you can answer once. Everyone sees the results after the poll closes."
export const COMMENT_MAX = 500
export const COMMENT_LABEL = "Anything else you'd like us to add or change?"
export const COMMENT_HINT = "Please don't include passwords or private information."
export const YES_LABEL = "Yes, I want this change"
export const NO_LABEL = "No, keep it as it is"
/** A question left blank. "Skip" means only skipping the whole poll. */
export const LEFT_BLANK_LABEL = "Left blank"
/** Students see no percentages for a question until this many students answered it (the server decides). */
export const MIN_ANSWERS_SHOWN = 5
export const NOT_ENOUGH_LINE = "Not enough answers yet"
export const NO_RESULTS_LINE = "Not enough students answered this poll to show results. Thanks to everyone who did!"
export const AFTER_CLOSE_LINE = "Totals and comments show up after the poll closes, so no one can tell who wrote what."
export const NO_UPDATE_LINE = "We're reviewing your feedback."
/** Students see the newest 24 closed polls (about 2 years). Admins keep older ones. */
export const ARCHIVE_LIMIT = 24
export const SCHEDULE_TZ = "America/Chicago"
/** setTimeout can't wait longer than this. */
export const MAX_TIMER_MS = 2 ** 31 - 1

export type Choice = "yes" | "no"
export type Question = { id: string; position: number; label: string }
export type OpenPoll = {
  id: string
  title: string
  intro: string
  opens_at: string
  closes_at: string
  status: "open"
  /** The server also sends its copy of these lines; the pages use the same words from this file. */
  privacy_note?: string
  comment_label?: string
  comment_hint?: string
  comment_max: number
  questions: Question[]
}
export type MyResponse = { submitted_at: string; answers: { question_id: string; choice: Choice }[]; comment: string | null }
export type CurrentFeedback = {
  server_now: string
  schedule_tz: string
  poll: OpenPoll | null
  /** Set (answers may be empty) when this account, or a deleted account with the same email, already answered. */
  my_response: MyResponse | null
  /** The server remembers "Skip this poll" for this account. */
  skipped: boolean
  can_vote: boolean
  blocked_reason: "email_unverified" | null
  next_opens_at: string | null
  latest_results: { poll_id: string; closed_at: string } | null
}
export type UpdateStatus = "reviewing" | "planned" | "keeping" | "done"
export type StudentUpdate = { title: string; status: UpdateStatus; note: string | null }
export type StudentResultRow = { id: string; position: number; label: string; yes_pct: number | null; no_pct: number | null }
export type StudentResults = {
  poll: { id: string; title: string; period_month: string; opens_at: string; closes_at: string }
  questions: StudentResultRow[]
  updates: StudentUpdate[]
  update_summary: string | null
}
export type ArchiveItem = { id: string; title?: string; period_month: string; opens_at: string; closes_at: string }

export type PollStatus = "draft" | "missed" | "scheduled" | "open" | "closed"
export type AdminPollRow = {
  id: string
  period_month: string
  opens_at: string
  closes_at: string
  opens_local?: string
  closes_local?: string
  approved_at?: string | null
  status: PollStatus
  question_count: number
  participants: number
}
/** One poll for admins. The server sends it flat (the list fields plus these). */
export type AdminPoll = AdminPollRow & {
  approved_at: string | null
  title?: string
  intro?: string
  can_approve?: boolean
  can_unapprove?: boolean
  default_opens_local?: string
  default_closes_local?: string
  questions: Question[]
  can_edit_questions: boolean
  can_edit_dates: boolean
  lint: { position: number; message: string }[]
}
export type AdminResultRow = StudentResultRow & { yes: number; no: number; answered: number; skipped: number }
/** While the poll is open, `final` is false and `questions` is empty: admins see only how many answered. */
export type AdminTotals = { participants: number; no_votes: boolean; as_of: string; final?: boolean; questions: AdminResultRow[] }
export type UrgentFlag = "security" | "accessibility" | "privacy"
export type AdminComment = {
  response_ref: string
  response_id: string
  comment: string
  urgent_flags: UrgentFlag[]
  urgent_set_by_admin?: boolean
  theme_ids: string[]
}
export type AdminTheme = { id: string; label: string; source: "auto" | "admin"; count: number; response_ids: string[] }
export type AdminThemes = { urgent: AdminComment[]; themes: AdminTheme[]; other_response_ids?: string[]; other_count: number }

/** Has this account already answered? (my_response is also set, with no answers, for a ballot from a deleted account with the same email.) */
export function hasAnswered(data: Pick<CurrentFeedback, "my_response">): boolean {
  return Boolean(data.my_response)
}
export type AdminUpdate = {
  id: string
  position: number
  title: string
  status: UpdateStatus
  note: string | null
  published: boolean
}

// ----------------------------------------------------------------- dates and times

const centralFormat = new Intl.DateTimeFormat("en-US", {
  timeZone: SCHEDULE_TZ,
  weekday: "long",
  month: "long",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
})

const timeFormat = new Intl.DateTimeFormat("en-US", { timeZone: SCHEDULE_TZ, hour: "numeric", minute: "2-digit" })

/** "1:05 PM" in Chicago time, no seconds. */
export function formatCentralTime(iso: string): string {
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? "" : timeFormat.format(date)
}

/** "Sunday, December 6 at 12:00 PM" in Chicago time (the poll's own time zone). */
export function formatCentral(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ""
  const parts = Object.fromEntries(centralFormat.formatToParts(date).map((part) => [part.type, part.value]))
  return `${parts.weekday}, ${parts.month} ${parts.day} at ${parts.hour}:${parts.minute} ${parts.dayPeriod}`
}

const monthFormat = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "long", year: "numeric" })

/** "2026-11-01" -> "November 2026". */
export function monthLabel(periodMonth: string): string {
  const match = /^(\d{4})-(\d{2})/.exec(periodMonth)
  if (!match) return periodMonth
  return monthFormat.format(new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, 1)))
}

const wallFormat = new Intl.DateTimeFormat("en-US", {
  timeZone: SCHEDULE_TZ,
  hourCycle: "h23",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
})

/** An instant as Chicago wall-clock time, "YYYY-MM-DDTHH:MM" (the value a datetime-local input takes). */
export function chicagoWallTime(iso: string | number): string {
  const parts = Object.fromEntries(wallFormat.formatToParts(new Date(iso)).map((part) => [part.type, part.value]))
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`
}

export type LocalTimeResult =
  | { ok: true; iso: string }
  | { ok: false; reason: "bad_time" | "nonexistent_local_time" | "ambiguous_local_time" }

/**
 * Chicago wall-clock time to an instant. A time skipped by the spring change (2:30 AM) or
 * one that happens twice in the fall (1:30 AM) is refused, never guessed.
 */
export function chicagoLocalToUtc(local: string): LocalTimeResult {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(local)
  if (!match) return { ok: false, reason: "bad_time" }
  const [, y, mo, d, h, mi] = match.map(Number)
  const base = Date.UTC(y, mo - 1, d, h, mi)
  // Chicago is 5 hours (summer) or 6 hours (winter) behind UTC. Keep the ones that read back the same.
  const hits = [base + 5 * 3600e3, base + 6 * 3600e3].filter((ms) => chicagoWallTime(ms) === local)
  if (hits.length === 0) return { ok: false, reason: "nonexistent_local_time" }
  if (hits.length === 2) return { ok: false, reason: "ambiguous_local_time" }
  return { ok: true, iso: new Date(hits[0]).toISOString() }
}

const pad = (n: number) => String(n).padStart(2, "0")

/** The last Sunday of a month (month is 1-12), as "YYYY-MM-DD". */
export function lastSunday(year: number, month: number): string {
  const last = new Date(Date.UTC(year, month, 0))
  return `${year}-${pad(month)}-${pad(last.getUTCDate() - last.getUTCDay())}`
}

/**
 * The default poll window for a month, in Chicago wall-clock time: the last Sunday at 12:00 noon
 * until the next Sunday at 12:00 noon. Seven calendar days, not 168 hours, so daylight saving is handled.
 */
export function defaultWindowLocal(periodMonth: string): { opens_local: string; closes_local: string } {
  const [year, month] = periodMonth.split("-").map(Number)
  const open = lastSunday(year, month)
  const [oy, om, od] = open.split("-").map(Number)
  const close = new Date(Date.UTC(oy, om - 1, od + 7))
  return {
    opens_local: `${open}T12:00`,
    closes_local: `${close.getUTCFullYear()}-${pad(close.getUTCMonth() + 1)}-${pad(close.getUTCDate())}T12:00`,
  }
}

/** How long to wait before checking the poll again at its close time (setTimeout's limit applied). */
export function msUntil(iso: string, now: number): number {
  const at = new Date(iso).getTime()
  if (Number.isNaN(at)) return MAX_TIMER_MS
  return Math.min(Math.max(at - now, 0), MAX_TIMER_MS)
}

// ----------------------------------------------------------------- the ballot

/** Length the way the server counts it (an emoji is one character). */
export function codePointLength(text: string): number {
  return [...text].length
}

export function charactersLeftLine(text: string, max = COMMENT_MAX): string {
  const left = max - codePointLength(text)
  if (left >= 0) return `${left} character${left === 1 ? "" : "s"} left`
  return `Please cut ${-left} character${left === -1 ? "" : "s"}.`
}

export const tooLongLine = (max = COMMENT_MAX) => `Please shorten your comment to ${max} characters or fewer.`

export function choiceLabel(choice: Choice | undefined): string {
  if (choice === "yes") return YES_LABEL
  if (choice === "no") return NO_LABEL
  return LEFT_BLANK_LABEL
}

/** One line per question for the "Check your answers" step, in question order. */
export function reviewSummary(questions: Question[], answers: Record<string, Choice | undefined>) {
  return [...questions]
    .sort((a, b) => a.position - b.position)
    .map((question, index) => ({ id: question.id, number: index + 1, label: question.label, answer: choiceLabel(answers[question.id]) }))
}

/** The answers the server takes: only answered questions, in question order. */
export function answerList(questions: Question[], answers: Record<string, Choice | undefined>) {
  return [...questions]
    .sort((a, b) => a.position - b.position)
    .filter((question) => answers[question.id] === "yes" || answers[question.id] === "no")
    .map((question) => ({ question_id: question.id, choice: answers[question.id] as Choice }))
}

/** Is there anything to send? Skipping everything is done with the Skip button, not Send. */
export function hasSomething(questions: Question[], answers: Record<string, Choice | undefined>, comment: string): boolean {
  return answerList(questions, answers).length > 0 || comment.trim().length > 0
}

// ----------------------------------------------------------------- results

/** Has this row got percentages to show? (The server sends null when too few students answered.) */
export function hasPercentages(row: Pick<StudentResultRow, "yes_pct" | "no_pct">): boolean {
  return row.yes_pct != null && row.no_pct != null
}

/**
 * What students see for a question: percentages only, never how many people answered.
 * With too few answers (null from the server) it says so in words, never 0% or a count.
 */
export function studentResultLine(row: Pick<StudentResultRow, "yes_pct" | "no_pct">): string {
  if (!hasPercentages(row)) return NOT_ENOUGH_LINE
  return `Yes ${row.yes_pct}% · No ${row.no_pct}%`
}

/** What admins see: counts and percentages, or "No votes yet". */
export function adminResultLine(row: AdminResultRow): string {
  if (!row.answered || row.yes_pct == null || row.no_pct == null) return "No votes yet"
  return `Yes ${row.yes_pct}% (${row.yes}) · No ${row.no_pct}% (${row.no}) · ${row.answered} answered · ${row.skipped} left blank`
}

export function studentsLine(count: number): string {
  return count === 0 ? "No votes yet" : `${count} student${count === 1 ? "" : "s"} answered`
}

const UPDATE_LABELS: Record<UpdateStatus, string> = {
  reviewing: "Reviewing",
  planned: "Planned",
  keeping: "Keeping it",
  done: "Done",
}
export const UPDATE_STATUSES = Object.keys(UPDATE_LABELS) as UpdateStatus[]

export function updateStatusLabel(status: string): string {
  return UPDATE_LABELS[status as UpdateStatus] ?? "Reviewing"
}

const POLL_STATUS_LABELS: Record<PollStatus, string> = {
  draft: "Draft",
  missed: "Missed",
  scheduled: "Scheduled",
  open: "Open",
  closed: "Closed",
}

export function pollStatusLabel(status: string): string {
  return POLL_STATUS_LABELS[status as PollStatus] ?? "Draft"
}

/** Warnings for a question's wording (the same rules as the server). They never block saving. */
export function questionLint(label: string): string | null {
  const text = ` ${label.toLowerCase()} `
  if (text.includes(" and ") || text.includes(" or ") || text.includes("/")) return "Is this two changes in one? Split it."
  if (/^\s*(don't|dont|stop|remove|keep|no longer)\b/.test(text)) {
    return "Yes must mean 'I want this change'. Write the change itself."
  }
  return null
}

export const FLAG_LABELS: Record<UrgentFlag, string> = {
  security: "Security",
  accessibility: "Accessibility",
  privacy: "Privacy",
}

// ----------------------------------------------------------------- saved on this device

/** Unsent answers, kept for this tab only so a reload doesn't lose them. Cleared on sign-out. */
export const DRAFT_PREFIX = "luma.feedbackDraft:"
export const draftKey = (accountId: string, pollId: string) => `${DRAFT_PREFIX}${accountId}:${pollId}`

/** Removes every unsent poll draft from a storage area (sign-out on a shared computer). */
export function clearDrafts(storage: Pick<Storage, "length" | "key" | "removeItem">): void {
  const keys: string[] = []
  for (let i = 0; i < storage.length; i += 1) {
    const key = storage.key(i)
    if (key && key.startsWith(DRAFT_PREFIX)) keys.push(key)
  }
  keys.forEach((key) => storage.removeItem(key))
}
/** "Poll results are in" on Home: hidden once seen or dismissed, per poll. */
export const RESULTS_SEEN_PREFIX = "luma.feedbackResultsSeen:"
export const resultsSeenKey = (accountId: string, pollId: string) => `${RESULTS_SEEN_PREFIX}${accountId}:${pollId}`

export type Draft = { answers: Record<string, Choice>; comment: string }

/** Reads a saved draft, ignoring anything that doesn't look right. */
export function parseDraft(raw: string | null, questions: Question[]): Draft | null {
  if (!raw) return null
  try {
    const data = JSON.parse(raw) as { answers?: unknown; comment?: unknown }
    const ids = new Set(questions.map((q) => q.id))
    const answers: Record<string, Choice> = {}
    if (data.answers && typeof data.answers === "object") {
      for (const [id, value] of Object.entries(data.answers as Record<string, unknown>)) {
        if (ids.has(id) && (value === "yes" || value === "no")) answers[id] = value
      }
    }
    return { answers, comment: typeof data.comment === "string" ? data.comment : "" }
  } catch {
    return null
  }
}
