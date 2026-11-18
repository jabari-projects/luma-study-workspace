// Drafts stay in this tab, per account, and are never read by another account.
import { describe, it } from "node:test"
import assert from "node:assert/strict"

import { NOTE_DRAFT_PREFIX, removeLegacyNoteDrafts } from "../accounts.ts"
import {
  DRAFT_MAX_AGE_MS,
  MAX_DRAFT_CHARS,
  clearDraft,
  draftKey,
  readDraft,
  sweepAccountDrafts,
  sweepAllDrafts,
  writeDraft,
} from "./drafts.ts"
import type { Draft, DraftStore } from "./drafts.ts"

function memoryStore(initial: Record<string, string> = {}): DraftStore & { data: Map<string, string> } {
  const data = new Map(Object.entries(initial))
  return {
    data,
    get length() {
      return data.size
    },
    key: (index: number) => [...data.keys()][index] ?? null,
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => {
      data.set(key, value)
    },
    removeItem: (key: string) => {
      data.delete(key)
    },
  }
}

function blockedStore(): DraftStore {
  const fail = () => {
    throw new Error("SecurityError")
  }
  return { length: 0, key: fail, getItem: fail, setItem: fail, removeItem: fail }
}

const NOW = 1_800_000_000_000
const draft = (accountId: string, data: unknown, extra: Partial<Draft> = {}): Draft => ({
  v: 1,
  accountId,
  kind: "note",
  itemId: "new",
  baseVersion: null,
  savedAt: NOW,
  data,
  ...extra,
})

describe("drafts", () => {
  it("uses the luma.draft:v1:<account>:<kind>:<item> key", () => {
    assert.equal(draftKey("u1", "note", "new"), "luma.draft:v1:u1:note:new")
    assert.equal(draftKey("u1", "deck", "d9"), "luma.draft:v1:u1:deck:d9")
  })

  it("writes and reads back the tab account's own draft", () => {
    const store = memoryStore()
    assert.equal(writeDraft(store, draft("u1", { title: "T", content: "SYNTH words", tags: "" }, { createKey: "k1" })), "ok")
    const back = readDraft<{ content: string }>(store, "u1", "u1", "note", "new", NOW + 1000)
    assert.equal(back?.data.content, "SYNTH words")
    assert.equal(back?.createKey, "k1")
  })

  it("another account never reads it: not by switching, not with a forged key", () => {
    const store = memoryStore()
    writeDraft(store, draft("u1", { content: "SYNTH private" }))
    // The tab now uses account u2.
    assert.equal(readDraft(store, "u2", "u1", "note", "new", NOW), null)
    assert.equal(readDraft(store, "u2", "u2", "note", "new", NOW), null)
    // A value saved under u2's key that names u1 is not shown to u2 (and is left alone).
    store.setItem(draftKey("u2", "note", "new"), JSON.stringify(draft("u1", { content: "SYNTH forged" })))
    assert.equal(readDraft(store, "u2", "u2", "note", "new", NOW), null)
    assert.ok(store.getItem(draftKey("u1", "note", "new")), "account A's own draft stays for when the tab switches back")
  })

  it("no account, or the editor's account differs from the tab's: nothing is read", () => {
    const store = memoryStore()
    writeDraft(store, draft("u1", { content: "x" }))
    assert.equal(readDraft(store, null, "u1", "note", "new", NOW), null)
    assert.equal(readDraft(store, "u1", null, "note", "new", NOW), null)
  })

  it("drops drafts older than 24 hours and broken ones", () => {
    const store = memoryStore()
    writeDraft(store, draft("u1", { content: "old" }))
    assert.equal(readDraft(store, "u1", "u1", "note", "new", NOW + DRAFT_MAX_AGE_MS + 1), null)
    assert.equal(store.getItem(draftKey("u1", "note", "new")), null)
    store.setItem(draftKey("u1", "deck", "d1"), "{not json")
    assert.equal(readDraft(store, "u1", "u1", "deck", "d1", NOW), null)
    assert.equal(store.getItem(draftKey("u1", "deck", "d1")), null)
  })

  it("refuses drafts over the size cap instead of throwing", () => {
    const store = memoryStore()
    assert.equal(writeDraft(store, draft("u1", { content: "x".repeat(MAX_DRAFT_CHARS) })), "too_big")
    assert.equal(store.data.size, 0)
  })

  it("blocked or missing storage never throws", () => {
    assert.equal(writeDraft(blockedStore(), draft("u1", {})), "blocked")
    assert.equal(writeDraft(null, draft("u1", {})), "blocked")
    assert.equal(readDraft(blockedStore(), "u1", "u1", "note", "new", NOW), null)
    assert.doesNotThrow(() => clearDraft(blockedStore(), "u1", "note", "new"))
    assert.doesNotThrow(() => sweepAccountDrafts(blockedStore(), "u1"))
    assert.doesNotThrow(() => sweepAllDrafts(null))
  })

  it("sign-out sweeps one account's drafts; sign out of all sweeps every draft only", () => {
    const store = memoryStore({ "luma.tabAccount": "u1", "other.key": "keep" })
    writeDraft(store, draft("u1", { content: "a" }))
    writeDraft(store, draft("u1", { content: "b" }, { kind: "deck", itemId: "d1" }))
    writeDraft(store, draft("u2", { content: "c" }))
    // An account id that starts the same must not be swept by mistake.
    writeDraft(store, draft("u10", { content: "d" }))
    sweepAccountDrafts(store, "u1")
    assert.deepEqual([...store.data.keys()].sort(), ["luma.draft:v1:u10:note:new", "luma.draft:v1:u2:note:new", "luma.tabAccount", "other.key"])
    sweepAllDrafts(store)
    assert.deepEqual([...store.data.keys()].sort(), ["luma.tabAccount", "other.key"])
  })

  it("clearDraft removes only that item", () => {
    const store = memoryStore()
    writeDraft(store, draft("u1", {}, { itemId: "a" }))
    writeDraft(store, draft("u1", {}, { itemId: "b" }))
    clearDraft(store, "u1", "note", "a")
    assert.deepEqual([...store.data.keys()], ["luma.draft:v1:u1:note:b"])
  })
})

describe("old device drafts (luma.noteDraft:*)", () => {
  it("are removed from localStorage once, and nothing else is", () => {
    const local = memoryStore({ [`${NOTE_DRAFT_PREFIX}u1`]: "{}", [`${NOTE_DRAFT_PREFIX}u2`]: "{}", "luma.auth": "{}" })
    removeLegacyNoteDrafts(local)
    assert.deepEqual([...local.data.keys()], ["luma.auth"])
    assert.doesNotThrow(() => removeLegacyNoteDrafts(blockedStore()))
    assert.doesNotThrow(() => removeLegacyNoteDrafts(null))
  })
})
