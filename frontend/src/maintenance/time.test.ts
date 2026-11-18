// Central (Chicago) time for maintenance breaks: CST/CDT on both sides of a clock change,
// skipped and doubled times refused (the same rule as the server), and the viewer's own
// time shown only when it differs. Made-up times only; no network.
import { describe, it } from "node:test"
import assert from "node:assert/strict"

import { centralChoice, centralParts, centralPreview, formatCentral, toCentralInput, viewerTimeNote } from "./time.ts"

describe("formatCentral", () => {
  it("shows CST in winter and CDT in summer", () => {
    assert.equal(formatCentral("2026-12-01T11:00:00Z"), "Tue, Dec 1, 5:00 AM CST")
    assert.equal(formatCentral("2027-06-01T10:00:00Z"), "Tue, Jun 1, 5:00 AM CDT")
  })

  it("shows the right zone on both sides of spring forward and fall back", () => {
    assert.equal(formatCentral("2027-03-14T07:59:00Z"), "Sun, Mar 14, 1:59 AM CST")
    assert.equal(formatCentral("2027-03-14T08:00:00Z"), "Sun, Mar 14, 3:00 AM CDT")
    assert.equal(formatCentral("2027-11-07T06:30:00Z"), "Sun, Nov 7, 1:30 AM CDT")
    assert.equal(formatCentral("2027-11-07T07:30:00Z"), "Sun, Nov 7, 1:30 AM CST")
  })

  it("splits day and time for sentences", () => {
    assert.deepEqual(centralParts("2026-12-01T11:00:00Z"), { day: "Tue, Dec 1", time: "5:00 AM CST" })
  })

  it("is empty for nothing or nonsense", () => {
    assert.equal(formatCentral(null), "")
    assert.equal(formatCentral("not a date"), "")
    assert.deepEqual(centralParts(undefined), { day: "", time: "" })
  })
})

describe("centralChoice (the admin's typed Central time)", () => {
  it("turns normal times into the right moment", () => {
    const winter = centralChoice("2026-12-01T05:00")
    assert.equal(winter.kind, "ok")
    assert.equal(winter.kind === "ok" && winter.utc.toISOString(), "2026-12-01T11:00:00.000Z")
    const summer = centralChoice("2027-06-01T05:00")
    assert.equal(summer.kind === "ok" && summer.utc.toISOString(), "2027-06-01T10:00:00.000Z")
    const midnight = centralChoice("2027-01-01T00:00")
    assert.equal(midnight.kind === "ok" && midnight.utc.toISOString(), "2027-01-01T06:00:00.000Z")
  })

  it("refuses times skipped when clocks spring forward", () => {
    for (const local of ["2027-03-14T02:00", "2027-03-14T02:30", "2027-03-14T02:59"]) {
      assert.equal(centralChoice(local).kind, "skipped", local)
    }
    assert.equal(centralChoice("2027-03-14T03:00").kind, "ok")
  })

  it("refuses times that happen twice when clocks fall back", () => {
    for (const local of ["2027-11-07T01:00", "2027-11-07T01:30", "2027-11-07T01:59"]) {
      assert.equal(centralChoice(local).kind, "twice", local)
    }
    assert.equal(centralChoice("2027-11-07T02:00").kind, "ok")
    assert.equal(centralChoice("2027-11-07T00:59").kind, "ok")
  })

  it("refuses things that aren't a day and a time", () => {
    for (const local of ["", "2027-02-30T05:00", "2027-01-01 05:00", "2027-01-01T5:00", "2027-01-01T24:00"]) {
      assert.equal(centralChoice(local).kind, "invalid", local)
    }
  })

  it("gives the admin a plain preview line", () => {
    assert.equal(centralPreview("2026-12-01T05:00"), "That is Tue, Dec 1, 5:00 AM CST.")
    assert.equal(centralPreview("2027-03-14T02:30"), "That time is skipped when clocks change. Pick another time.")
    assert.equal(centralPreview("2027-11-07T01:30"), "That time happens twice when clocks change. Pick another time.")
    assert.equal(centralPreview(""), "")
  })

  it("round-trips a stored time back into the form", () => {
    assert.equal(toCentralInput("2026-12-01T11:00:00Z"), "2026-12-01T05:00")
    assert.equal(toCentralInput("2027-06-01T10:00:00Z"), "2027-06-01T05:00")
    assert.equal(toCentralInput(null), "")
  })
})

describe("viewerTimeNote", () => {
  it("adds the viewer's own time only when it is different", () => {
    assert.equal(viewerTimeNote("2026-12-01T11:00:00Z", "America/Chicago"), "")
    assert.equal(viewerTimeNote("2026-12-01T11:00:00Z", "America/New_York"), "6:00 AM your time")
    assert.equal(viewerTimeNote("2026-12-01T11:00:00Z", "America/Los_Angeles"), "3:00 AM your time")
    // Same clock time as Chicago in another zone: nothing to add.
    assert.equal(viewerTimeNote("2026-12-01T11:00:00Z", "America/Mexico_City"), "")
  })
})
