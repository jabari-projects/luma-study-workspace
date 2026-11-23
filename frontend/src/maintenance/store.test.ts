// The maintenance store and its rules: reading a status safely, when to check again (a
// different rev in a response header, focus after a minute), and the status page's bounded
// backoff (it stops by itself). Also the words students see. No network.
// The viewer is in Chicago here, so no "your time" note is added to the sentences.
process.env.TZ = "America/Chicago"

import { afterEach, describe, it } from "node:test"
import assert from "node:assert/strict"

import {
  FOCUS_RECHECK_MS,
  STATUS_BACKOFF_MS,
  breakIsOn,
  getMaintenanceSnapshot,
  needsRefresh,
  nextBackoff,
  parseStatus,
  resetMaintenanceForTests,
  shouldRecheckOnFocus,
  subscribeMaintenance,
  updateMaintenance,
} from "./store.ts"
import type { MaintenanceStatus } from "./store.ts"
import {
  CANT_REACH,
  announcedText,
  estimateText,
  safetyWords,
  statusHeadline,
  workLine,
} from "./words.ts"

const base: MaintenanceStatus = {
  phase: "announced",
  rev: 4,
  reason: "website_update",
  note: "",
  start_at: "2026-12-01T11:00:00Z",
  estimated_end_at: "2026-12-01T12:00:00Z",
  drain_started_at: null,
  grace_ends_at: null,
  recently_reopened: false,
  server_time: "2026-11-29T11:00:00Z",
}

afterEach(() => resetMaintenanceForTests())

describe("parseStatus", () => {
  it("keeps a good status", () => {
    assert.deepEqual(parseStatus({ ...base }), base)
  })

  it("drops anything that isn't a status", () => {
    for (const bad of [null, "x", 3, {}, { phase: "reopened" }, { phase: 1 }]) {
      assert.equal(parseStatus(bad), null)
    }
  })

  it("never keeps unknown fields (no instances or jobs reach the UI)", () => {
    const parsed = parseStatus({ ...base, instances: ["host-1"], jobs: 3 }) as Record<string, unknown>
    assert.equal("instances" in parsed, false)
    assert.equal("jobs" in parsed, false)
  })
})

describe("when to check again", () => {
  it("checks when a response carries a newer rev, never an older one", () => {
    assert.equal(needsRefresh(base, 5, false), true)
    assert.equal(needsRefresh(base, 4, false), false)
    assert.equal(needsRefresh(base, 3, false), false)
    assert.equal(needsRefresh(base, 0, false), false)
    assert.equal(needsRefresh(null, 1, false), true)
  })

  it("never piles up checks, and ignores answers without the header", () => {
    assert.equal(needsRefresh(base, 5, true), false)
    assert.equal(needsRefresh(base, null, false), false)
    assert.equal(needsRefresh(base, Number.NaN, false), false)
  })

  it("checks on focus at most once a minute", () => {
    assert.equal(shouldRecheckOnFocus(null, 0), true)
    assert.equal(shouldRecheckOnFocus(1_000, 1_000 + FOCUS_RECHECK_MS - 1), false)
    assert.equal(shouldRecheckOnFocus(1_000, 1_000 + FOCUS_RECHECK_MS), true)
  })

  it("the status page backoff is 30 s, 1, 2 and 4 minutes, then stops", () => {
    assert.deepEqual([...STATUS_BACKOFF_MS], [30_000, 60_000, 120_000, 240_000])
    assert.deepEqual([0, 1, 2, 3, 4, 5].map(nextBackoff), [30_000, 60_000, 120_000, 240_000, null, null])
  })

  it("only checks by itself while a break is close or on", () => {
    assert.equal(breakIsOn(null), false)
    assert.equal(breakIsOn(base), false)
    assert.equal(breakIsOn({ ...base, phase: "none" }), false)
    for (const phase of ["draining", "active", "checking"] as const) assert.equal(breakIsOn({ ...base, phase }), true)
  })
})

describe("the store", () => {
  it("tells listeners about changes and stops when they leave", () => {
    let calls = 0
    const leave = subscribeMaintenance(() => {
      calls += 1
    })
    updateMaintenance({ status: base, checkedAt: 1 })
    assert.equal(getMaintenanceSnapshot().status?.rev, 4)
    leave()
    updateMaintenance({ failed: true })
    assert.equal(calls, 1)
  })
})

describe("words", () => {
  it("announces the break in Central time", () => {
    assert.match(announcedText(base), /^Luma will take a short break on Tue, Dec 1 at 5:00 AM CST/)
    assert.match(announcedText(base), /Your saved work is safe\.$/)
  })

  it("never promises an end time", () => {
    assert.match(estimateText(base), /We hope to be back around 6:00 AM CST.*This is a guess, not a promise\.$/)
    assert.equal(estimateText({ ...base, estimated_end_at: null }), "We don't know yet when Luma will be back. Check again soon.")
  })

  it("says how much work in this tab isn't saved", () => {
    assert.equal(workLine({ unsaved: 0, saving: 0, failed: 0 }), "All your work in this tab is saved.")
    assert.equal(workLine({ unsaved: 0, saving: 1, failed: 0 }), "Saving your work...")
    assert.equal(workLine({ unsaved: 1, saving: 0, failed: 0 }), "1 thing isn't saved yet. Open it and tap Save.")
    assert.equal(workLine({ unsaved: 1, saving: 1, failed: 1 }), "2 things aren't saved yet. Open them and tap Save.")
  })

  it("has a headline for every phase", () => {
    assert.equal(statusHeadline({ ...base, phase: "none" }), "Luma is working")
    assert.equal(statusHeadline({ ...base, phase: "none", recently_reopened: true }), "Luma is back. Thanks for waiting!")
    assert.equal(statusHeadline(base), "A short break is coming")
    assert.equal(statusHeadline({ ...base, phase: "draining" }), "Luma is getting ready for a short break")
    assert.equal(statusHeadline({ ...base, phase: "active" }), "Luma is taking a short break")
    assert.equal(statusHeadline({ ...base, phase: "checking" }), "Luma is taking a short break")
  })

  it("explains each not-safe reason to the admin in plain words", () => {
    assert.equal(safetyWords({ code: "grace_not_over", seconds_left: 61 }), "Students still have about 2 minutes to save.")
    assert.equal(safetyWords({ code: "grace_not_over", seconds_left: 10 }), "Students still have about 1 minute to save.")
    assert.equal(safetyWords({ code: "jobs_running", count: 1 }), "1 AI or long task is still running.")
    assert.equal(safetyWords({ code: "requests_in_flight", count: 3 }), "3 requests are still being answered.")
    assert.match(safetyWords({ code: "backup_missing" }), /stamp of a backup/)
  })

  it("has no technical text in anything a student reads", () => {
    const all = [
      CANT_REACH,
      announcedText(base),
      estimateText(base),
      ...["none", "announced", "draining", "active", "checking"].map((phase) => statusHeadline({ ...base, phase: phase as MaintenanceStatus["phase"] })),
    ].join(" ")
    for (const bad of ["http", "localhost", "127.0.0.1", "HTTP 5", "status code", "Error:", "503"]) {
      assert.equal(all.includes(bad), false, bad)
    }
  })
})
