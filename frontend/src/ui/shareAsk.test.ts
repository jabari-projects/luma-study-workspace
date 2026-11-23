// "Share with the crowd?" is asked once per new item, per tab and per account.
import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"

import { forgetShareAsk, markJustMade, shouldAskToShare } from "./shareAsk.ts"

describe("asking once", () => {
  it("asks for an item just made, until the page has asked", () => {
    markJustMade("acct-1", "flashcards", "deck-1")
    assert.equal(shouldAskToShare("acct-1", "flashcards", "deck-1"), true)
    // Reading it twice (React may render twice) changes nothing.
    assert.equal(shouldAskToShare("acct-1", "flashcards", "deck-1"), true)
    forgetShareAsk("acct-1", "flashcards", "deck-1")
    assert.equal(shouldAskToShare("acct-1", "flashcards", "deck-1"), false)
  })

  it("is per account and per kind", () => {
    markJustMade("acct-1", "note", "n-1")
    assert.equal(shouldAskToShare("acct-2", "note", "n-1"), false)
    assert.equal(shouldAskToShare("acct-1", "summary", "n-1"), false)
    assert.equal(shouldAskToShare("acct-1", "note", "n-1"), true)
    forgetShareAsk("acct-1", "note", "n-1")
  })

  it("never asks about unknown items", () => {
    assert.equal(shouldAskToShare("acct-1", "note", "never-made"), false)
    assert.equal(shouldAskToShare("acct-1", "note", undefined), false)
  })

  it("is memory only: nothing goes in storage", () => {
    const source = readFileSync(new URL("./shareAsk.ts", import.meta.url), "utf8")
    assert.doesNotMatch(source, /localStorage|sessionStorage|indexedDB/)
  })
})

describe("the prompt's words", () => {
  it("say who will see it, in plain words", () => {
    // sharing.ts needs the browser API client, so its words are read as text here.
    const copy = readFileSync(new URL("./sharing.ts", import.meta.url), "utf8")
    assert.match(copy, /promptTitle: "Share with the crowd\?"/)
    assert.match(
      copy,
      /promptBody: `People can learn from you\. Students signed in to Luma will see this \$\{noun\} and \$\{who\}\. Nothing else about you\. You can stop sharing anytime\.`/,
    )
    const share = readFileSync(new URL("./Share.tsx", import.meta.url), "utf8")
    assert.match(share, /title=\{prompt \? copy\.promptTitle : copy\.title\}/)
    assert.match(share, /cancelLabel="Not now"/)
  })

  it("is asked where each new item first opens", () => {
    const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8")
    assert.match(read("../study/FlashcardPages.tsx"), /markJustMade\(accountId, "flashcards", now\.itemId\)/)
    assert.match(read("../notes/NoteEditorPage.tsx"), /markJustMade\(accountId, kind, now\.itemId\)/)
    assert.match(read("../notes/NotePage.tsx"), /markJustMade\(accountId, "summary", summary\.id\)/)
    assert.match(read("../capture/Workbench.tsx"), /markJustMade\(accountId, "flashcards", deck\.id\)/)
    assert.match(read("../study/FlashcardPages.tsx"), /askNow=\{askShare\}/)
    assert.match(read("../notes/NotePage.tsx"), /askNow=\{askShare\}/)
  })
})
