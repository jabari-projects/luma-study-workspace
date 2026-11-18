// The monthly feedback poll helpers: the last-Sunday schedule in Chicago time (daylight saving
// included), the comment limit, the review step and the results lines.
import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { readdirSync, readFileSync } from "node:fs"

import {
  ARCHIVE_LIMIT,
  COMMENT_HINT,
  COMMENT_MAX,
  MAX_TIMER_MS,
  NO_LABEL,
  POLL_INTRO,
  POLL_TITLE,
  YES_LABEL,
  adminResultLine,
  clearDrafts,
  hasPercentages,
  resultsSeenKey,
  answerList,
  charactersLeftLine,
  chicagoLocalToUtc,
  chicagoWallTime,
  codePointLength,
  defaultWindowLocal,
  draftKey,
  formatCentral,
  formatCentralTime,
  hasAnswered,
  normalizeAdminPoll,
  hasSomething,
  lastSunday,
  monthLabel,
  msUntil,
  parseDraft,
  pollStatusLabel,
  questionLint,
  reviewSummary,
  skipKey,
  studentResultLine,
  studentsLine,
  updateStatusLabel,
} from "./feedback.ts"

const toUtc = (local: string) => {
  const result = chicagoLocalToUtc(local)
  assert.ok(result.ok, `${local} should be a real Chicago time`)
  return result.iso
}
const hours = (a: string, b: string) => (new Date(b).getTime() - new Date(a).getTime()) / 3600e3
const windowUtc = (period: string) => {
  const local = defaultWindowLocal(period)
  return { opens: toUtc(local.opens_local), closes: toUtc(local.closes_local), ...local }
}

describe("exact words from the spec", () => {
  it("keeps the title, intro and comment hint", () => {
    assert.equal(POLL_TITLE, "If it ain't broke why fix it?!")
    assert.match(POLL_INTRO, /^Help us make Luma better! .* You can skip this poll\./)
    assert.equal(COMMENT_HINT, "Please don't include passwords or private information.")
    assert.equal(COMMENT_MAX, 500)
    assert.equal(YES_LABEL, "Yes, I want this change")
    assert.equal(NO_LABEL, "No, keep it as it is")
    assert.equal(ARCHIVE_LIMIT, 24)
  })
})

describe("last Sunday of the month", () => {
  it("finds it whatever weekday the month ends on", () => {
    assert.equal(lastSunday(2026, 11), "2026-11-29") // November 2026 has five Sundays (1, 8, 15, 22, 29)
    assert.equal(lastSunday(2026, 5), "2026-05-31") // the month ends on a Sunday
    assert.equal(lastSunday(2026, 2), "2026-02-22") // February, 28 days
    assert.equal(lastSunday(2028, 2), "2028-02-27") // leap year
    assert.equal(lastSunday(2026, 12), "2026-12-27")
    assert.equal(lastSunday(2027, 1), "2027-01-31")
  })

  it("is always a Sunday in the last 7 days of the month (2026-2045)", () => {
    for (let year = 2026; year <= 2045; year += 1) {
      for (let month = 1; month <= 12; month += 1) {
        const [y, m, d] = lastSunday(year, month).split("-").map(Number)
        const date = new Date(Date.UTC(y, m - 1, d))
        assert.equal(date.getUTCDay(), 0)
        assert.equal(m, month)
        assert.ok(new Date(Date.UTC(y, m - 1, d + 7)).getUTCMonth() !== month - 1, `${year}-${month}: a later Sunday exists`)
      }
    }
  })
})

describe("default poll window in Chicago time", () => {
  it("opens the last Sunday at noon and closes the next Sunday at noon", () => {
    assert.deepEqual(defaultWindowLocal("2026-11-01"), { opens_local: "2026-11-29T12:00", closes_local: "2026-12-06T12:00" })
    // December rolls into the new year.
    assert.deepEqual(defaultWindowLocal("2026-12-01"), { opens_local: "2026-12-27T12:00", closes_local: "2027-01-03T12:00" })
  })

  it("handles a month with five Sundays (November 2026)", () => {
    const w = windowUtc("2026-11-01")
    assert.equal(w.opens, "2026-11-29T18:00:00.000Z")
    assert.equal(w.closes, "2026-12-06T18:00:00.000Z")
    assert.equal(hours(w.opens, w.closes), 168)
  })

  it("handles March: the spring change is before the last Sunday, so noon is CDT at both ends", () => {
    const w = windowUtc("2026-03-01")
    assert.equal(w.opens, "2026-03-29T17:00:00.000Z")
    assert.equal(w.closes, "2026-04-05T17:00:00.000Z")
    assert.equal(hours(w.opens, w.closes), 168)
    const w27 = windowUtc("2027-03-01")
    assert.equal(w27.opens, "2027-03-28T17:00:00.000Z")
    assert.equal(w27.closes, "2027-04-04T17:00:00.000Z")
  })

  it("handles October into November: clocks fall back on the closing Sunday, so the window is 169 hours", () => {
    const w = windowUtc("2026-10-01")
    assert.equal(w.opens, "2026-10-25T17:00:00.000Z") // CDT
    assert.equal(w.closes, "2026-11-01T18:00:00.000Z") // CST
    assert.equal(hours(w.opens, w.closes), 169)
    assert.notEqual(w.closes, new Date(new Date(w.opens).getTime() + 168 * 3600e3).toISOString())
    const w27 = windowUtc("2027-10-01")
    assert.equal(w27.opens, "2027-10-31T17:00:00.000Z")
    assert.equal(w27.closes, "2027-11-07T18:00:00.000Z")
  })

  it("is noon Chicago at both ends and never overlaps the next month's window (2026-2045)", () => {
    let previousClose = ""
    for (let year = 2026; year <= 2045; year += 1) {
      for (let month = 1; month <= 12; month += 1) {
        const w = windowUtc(`${year}-${String(month).padStart(2, "0")}-01`)
        assert.equal(chicagoWallTime(w.opens).slice(11), "12:00")
        assert.equal(chicagoWallTime(w.closes).slice(11), "12:00")
        assert.ok([168, 169].includes(hours(w.opens, w.closes)), `${year}-${month}`)
        if (hours(w.opens, w.closes) === 169) assert.equal(month, 10)
        if (previousClose) assert.ok(previousClose <= w.opens, `${year}-${month} overlaps`)
        previousClose = w.closes
      }
    }
  })
})

describe("Chicago wall-clock times", () => {
  it("refuses the hour skipped in spring and the hour that happens twice in fall", () => {
    assert.deepEqual(chicagoLocalToUtc("2027-03-14T02:30"), { ok: false, reason: "nonexistent_local_time" })
    assert.deepEqual(chicagoLocalToUtc("2026-03-08T02:00"), { ok: false, reason: "nonexistent_local_time" })
    assert.deepEqual(chicagoLocalToUtc("2026-11-01T01:30"), { ok: false, reason: "ambiguous_local_time" })
    assert.deepEqual(chicagoLocalToUtc("2027-11-07T01:30"), { ok: false, reason: "ambiguous_local_time" })
    assert.deepEqual(chicagoLocalToUtc("tomorrow"), { ok: false, reason: "bad_time" })
  })

  it("accepts the minutes on either side of the change", () => {
    assert.equal(toUtc("2026-03-08T01:59"), "2026-03-08T07:59:00.000Z")
    assert.equal(toUtc("2026-03-08T03:00"), "2026-03-08T08:00:00.000Z")
    assert.equal(toUtc("2026-11-01T12:00"), "2026-11-01T18:00:00.000Z")
  })

  it("reads an instant back as the input value", () => {
    assert.equal(chicagoWallTime("2026-12-06T18:00:00Z"), "2026-12-06T12:00")
    assert.equal(chicagoWallTime("2026-07-01T05:00:00Z"), "2026-07-01T00:00")
  })

  it("formats dates as noon Central for winter and summer", () => {
    assert.equal(formatCentral("2026-12-06T18:00:00Z"), "Sunday, December 6 at 12:00 PM")
    assert.equal(formatCentralTime("2026-12-06T19:05:42Z"), "1:05 PM")
    assert.equal(formatCentral("2026-04-05T17:00:00Z"), "Sunday, April 5 at 12:00 PM")
    assert.equal(formatCentral("2026-11-01T18:00:00Z"), "Sunday, November 1 at 12:00 PM")
    assert.equal(formatCentral("not a date"), "")
  })

  it("names the poll month", () => {
    assert.equal(monthLabel("2026-11-01"), "November 2026")
    assert.equal(monthLabel("2027-01-01"), "January 2027")
  })

  it("caps the close timer at what setTimeout allows", () => {
    const now = Date.parse("2026-11-17T00:00:00Z")
    assert.equal(msUntil("2026-11-17T00:00:01Z", now), 1000)
    assert.equal(msUntil("2026-11-16T00:00:00Z", now), 0)
    assert.equal(msUntil("2030-01-01T00:00:00Z", now), MAX_TIMER_MS)
  })
})

describe("the comment", () => {
  it("counts characters the way the server does (an emoji is one)", () => {
    assert.equal(codePointLength("abc"), 3)
    assert.equal(codePointLength("😀😀"), 2)
    assert.equal(codePointLength("😀".repeat(COMMENT_MAX)), COMMENT_MAX)
  })

  it("says how many characters are left, or how many too many", () => {
    assert.equal(charactersLeftLine(""), "500 characters left")
    assert.equal(charactersLeftLine("x".repeat(499)), "1 character left")
    assert.equal(charactersLeftLine("x".repeat(501)), "Please cut 1 character.")
    assert.equal(charactersLeftLine("😀".repeat(510)), "Please cut 10 characters.")
  })
})

describe("the review step", () => {
  const questions = [
    { id: "b", position: 2, label: "Second" },
    { id: "a", position: 1, label: "First" },
    { id: "c", position: 3, label: "Third" },
  ]

  it("lists every question in order with the answer or Left blank", () => {
    assert.deepEqual(reviewSummary(questions, { a: "no", c: "yes" }), [
      { id: "a", number: 1, label: "First", answer: NO_LABEL },
      { id: "b", number: 2, label: "Second", answer: "Left blank" },
      { id: "c", number: 3, label: "Third", answer: YES_LABEL },
    ])
  })

  it("sends only answered questions", () => {
    assert.deepEqual(answerList(questions, { c: "yes", a: "no" }), [
      { question_id: "a", choice: "no" },
      { question_id: "c", choice: "yes" },
    ])
    assert.equal(hasSomething(questions, {}, "   "), false)
    assert.equal(hasSomething(questions, {}, "More colors"), true)
    assert.equal(hasSomething(questions, { b: "no" }, ""), true)
  })

  it("restores a saved draft but drops anything that doesn't fit this poll", () => {
    assert.deepEqual(parseDraft(JSON.stringify({ answers: { a: "yes", b: "maybe", zz: "no" }, comment: "hi" }), questions), {
      answers: { a: "yes" },
      comment: "hi",
    })
    assert.equal(parseDraft("{not json", questions), null)
    assert.equal(parseDraft(null, questions), null)
  })

  it("keeps drafts and skips per account and poll", () => {
    assert.equal(draftKey("u1", "p1"), "luma.feedbackDraft:u1:p1")
    assert.notEqual(skipKey("u1", "p1"), skipKey("u2", "p1"))
    assert.notEqual(resultsSeenKey("u1", "p1"), skipKey("u1", "p1"))
  })

  it("clears every unsent poll draft on sign-out, and nothing else", () => {
    const data = new Map<string, string>([
      [draftKey("u1", "p1"), "{}"],
      [draftKey("u2", "p2"), "{}"],
      ["luma.tabAccount", "u1"],
    ])
    const storage = {
      get length() {
        return data.size
      },
      key: (i: number) => [...data.keys()][i] ?? null,
      removeItem: (key: string) => void data.delete(key),
    }
    clearDrafts(storage)
    assert.deepEqual([...data.keys()], ["luma.tabAccount"])
  })
})

describe("results", () => {
  it("shows students percentages only", () => {
    assert.equal(studentResultLine({ yes_pct: 75, no_pct: 25 }), "Yes 75% · No 25%")
    assert.equal(studentResultLine({ yes_pct: null, no_pct: null }), "Not enough answers yet")
    assert.equal(hasPercentages({ yes_pct: null, no_pct: null }), false)
    assert.equal(hasPercentages({ yes_pct: 0, no_pct: 100 }), true)
    assert.doesNotMatch(studentResultLine({ yes_pct: 13, no_pct: 87 }), /answered|skipped|\(\d+\)/)
  })

  it("shows admins counts, or No votes yet", () => {
    const row = { id: "q", position: 1, label: "Q", yes: 3, no: 1, answered: 4, skipped: 2, yes_pct: 75, no_pct: 25 }
    assert.equal(adminResultLine(row), "Yes 75% (3) · No 25% (1) · 4 answered · 2 left blank")
    assert.equal(adminResultLine({ ...row, yes: 0, no: 0, answered: 0, skipped: 6, yes_pct: null, no_pct: null }), "No votes yet")
    assert.equal(studentsLine(0), "No votes yet")
    assert.equal(studentsLine(1), "1 student answered")
    assert.equal(studentsLine(6), "6 students answered")
  })

  it("names statuses in plain words", () => {
    assert.equal(updateStatusLabel("reviewing"), "Reviewing")
    assert.equal(updateStatusLabel("planned"), "Planned")
    assert.equal(updateStatusLabel("keeping"), "Keeping it")
    assert.equal(updateStatusLabel("done"), "Done")
    assert.equal(pollStatusLabel("missed"), "Missed")
    assert.equal(pollStatusLabel("scheduled"), "Scheduled")
  })
})

describe("question wording checks", () => {
  it("warns about two changes in one, and about a No-means-change question", () => {
    assert.equal(questionLint("Add dark mode and bigger buttons"), "Is this two changes in one? Split it.")
    assert.equal(questionLint("Add sounds or music"), "Is this two changes in one? Split it.")
    assert.equal(questionLint("Add a pause/stop button"), "Is this two changes in one? Split it.")
    assert.match(questionLint("Don't change the Home page") ?? "", /^Yes must mean/)
    assert.match(questionLint("Remove the timer") ?? "", /^Yes must mean/)
    assert.equal(questionLint("Add a dark mode for the review screen"), null)
    assert.equal(questionLint("Show a random quote on Home"), null) // "random" holds "and" but not as a word
  })
})

describe("safety", () => {
  it("never renders raw HTML in the feedback pages", () => {
    const dir = new URL(".", import.meta.url)
    for (const name of readdirSync(dir)) {
      if (!name.endsWith(".tsx")) continue
      assert.doesNotMatch(readFileSync(new URL(name, dir), "utf8"), /dangerouslySetInnerHTML/, name)
    }
  })

  it("never calls the poll anonymous", () => {
    const dir = new URL(".", import.meta.url)
    for (const name of readdirSync(dir)) {
      if (!/\.(tsx|ts)$/.test(name) || name.endsWith(".test.ts")) continue
      assert.doesNotMatch(readFileSync(new URL(name, dir), "utf8"), /anonymous/i, name)
    }
  })
})

describe("server shapes", () => {
  it("treats a ballot with no answers (from a deleted account with the same email) as answered", () => {
    assert.equal(hasAnswered({ my_response: null }), false)
    assert.equal(hasAnswered({ my_response: { submitted_at: "2026-11-30T00:00:00Z", answers: [], comment: null } }), true)
    assert.equal(hasAnswered({ my_response: null, already_answered: true }), true)
  })

  it("reads the flat admin poll the server sends, and the older nested shape", () => {
    const flat = {
      id: "p", period_month: "2026-11-01", opens_at: "a", closes_at: "b", status: "draft" as const, question_count: 0, participants: 0,
      approved_at: null, questions: [], can_edit_questions: true, can_edit_dates: true, lint: [],
    }
    assert.equal(normalizeAdminPoll(flat), flat)
    const nested = normalizeAdminPoll({
      poll: flat, questions: [{ id: "q", position: 1, label: "Add a thing" }], can_edit_questions: true, can_edit_dates: true, lint: [],
    })
    assert.equal(nested.id, "p")
    assert.equal(nested.question_count, 1)
  })
})
