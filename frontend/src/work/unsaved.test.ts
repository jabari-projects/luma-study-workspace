// The tab's unsaved-work registry: what leaving, switching and the maintenance notices ask.
import { describe, it } from "node:test"
import assert from "node:assert/strict"

import {
  copyUnsavedText,
  discardWork,
  flushAllWork,
  getUnsavedSummary,
  hasUnsavedWork,
  hasUnsavedWorkFor,
  registerWork,
  resumeWork,
  subscribeUnsaved,
} from "./unsaved.ts"
import type { WorkEntry, WorkState } from "./unsaved.ts"

function entry(id: string, overrides: Partial<WorkEntry> = {}): WorkEntry {
  return {
    id,
    accountId: "u1",
    label: "Your note",
    state: "clean",
    getText: () => "",
    flush: async () => true,
    resume: () => undefined,
    discard: () => undefined,
    ...overrides,
  }
}

describe("unsaved work registry", () => {
  it("is clean with nothing open, and while everything is saved", () => {
    const handle = registerWork(entry("a"))
    assert.equal(hasUnsavedWork(), false)
    handle.update("saved")
    assert.equal(hasUnsavedWork(), false)
    handle.unregister()
  })

  it("counts dirty, saving, failed, signed out, maintenance, conflict and gone as unsaved", () => {
    const handle = registerWork(entry("b"))
    for (const state of ["dirty", "saving", "failed", "signed_out", "maintenance", "conflict", "gone", "offline"] as WorkState[]) {
      handle.update(state)
      assert.equal(hasUnsavedWork(), true, state)
    }
    handle.unregister()
    assert.equal(hasUnsavedWork(), false, "closing the editor removes it")
  })

  it("keeps the summary object the same until a count changes, and tells listeners", () => {
    let calls = 0
    const stop = subscribeUnsaved(() => (calls += 1))
    const one = registerWork(entry("c"))
    const two = registerWork(entry("d"))
    const before = getUnsavedSummary()
    one.update("dirty")
    two.update("saving")
    const summary = getUnsavedSummary()
    assert.deepEqual(summary, { unsaved: 1, saving: 1, failed: 0 })
    assert.notEqual(summary, before)
    one.update("dirty")
    assert.equal(getUnsavedSummary(), summary, "no change, same object")
    two.update("failed")
    assert.deepEqual(getUnsavedSummary(), { unsaved: 1, saving: 0, failed: 1 })
    assert.ok(calls >= 4)
    stop()
    one.unregister()
    two.unregister()
    assert.deepEqual(getUnsavedSummary(), { unsaved: 0, saving: 0, failed: 0 })
  })

  it("is per account", () => {
    const handle = registerWork(entry("e", { accountId: "u7", state: "dirty" }))
    assert.equal(hasUnsavedWorkFor("u7"), true)
    assert.equal(hasUnsavedWorkFor("u8"), false)
    handle.unregister()
  })

  it("Copy my text joins the unsaved editors' words with their labels", () => {
    const a = registerWork(entry("f", { state: "dirty", label: "Your note", getText: () => "SYNTH note words" }))
    const b = registerWork(entry("g", { state: "saved", label: "Your deck", getText: () => "already saved" }))
    const c = registerWork(entry("h", { state: "conflict", label: "Your deck", getText: () => "Q - A" }))
    assert.equal(copyUnsavedText(), "Your note\nSYNTH note words\n\nYour deck\nQ - A")
    a.unregister()
    b.unregister()
    c.unregister()
  })

  it("flushAllWork is true only when every save was confirmed", async () => {
    const good = registerWork(entry("i", { state: "dirty", flush: async () => true }))
    assert.equal(await flushAllWork(), false, "the entry still says dirty")
    good.update("saved")
    assert.equal(await flushAllWork(), true)
    const bad = registerWork(entry("j", { state: "dirty", flush: async () => false }))
    assert.equal(await flushAllWork(), false)
    good.unregister()
    bad.unregister()
  })

  it("resume and discard only touch that account's waiting work", () => {
    const resumed: string[] = []
    const thrown: string[] = []
    const mine = registerWork(entry("k", { accountId: "u1", state: "signed_out", resume: () => resumed.push("k"), discard: () => thrown.push("k") }))
    const theirs = registerWork(entry("l", { accountId: "u2", state: "signed_out", resume: () => resumed.push("l"), discard: () => thrown.push("l") }))
    resumeWork("u1")
    discardWork("u2")
    assert.deepEqual(resumed, ["k"])
    assert.deepEqual(thrown, ["l"])
    mine.unregister()
    theirs.unregister()
  })
})
