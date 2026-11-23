// The one card finder: cards written in a note, and lists pasted into "Make cards from my notes".
import { describe, it } from "node:test"
import assert from "node:assert/strict"

import { aiCardsToFound, findCardsInNote } from "./findCards.ts"

const pairs = (text: string, lists = false) => findCardsInNote(text, { lists }).map((card) => [card.front, card.back])

describe("findCardsInNote", () => {
  it("reads :: lines and term bullets in a note", () => {
    assert.deepEqual(pairs("Capital of France :: Paris\n- **Cell** — the smallest living unit\nJust a sentence."), [
      ["Capital of France", "Paris"],
      ["Cell", "the smallest living unit"],
    ])
  })

  it("leaves plain dash and tab lines alone in a note", () => {
    assert.deepEqual(pairs("Chapter 3 - Cells\nWord\tMeaning"), [])
  })

  it("reads Question - Answer, dash, colon and tab lines in a pasted list", () => {
    assert.deepEqual(pairs("Capital of Spain - Madrid\nTwo times eight — Sixteen\nmitosis: cell division\nperro\tdog\nnot a card line", true), [
      ["Capital of Spain", "Madrid"],
      ["Two times eight", "Sixteen"],
      ["mitosis", "cell division"],
      ["perro", "dog"],
    ])
  })

  it("keeps short math facts but not sums with an equals sign or plain numbers", () => {
    assert.deepEqual(pairs("2 x 8 - 16\n5 - 3 = 2\n10 - 3 = 7\n1999 - 2001\n## Unit 2 - Plants", true), [["2 x 8", "16"]])
  })

  it("drops repeats", () => {
    assert.deepEqual(pairs("Sun - Star\nsun - star\nSun :: Star", true), [["Sun", "Star"]])
  })
})

describe("aiCardsToFound", () => {
  it("cleans AI cards and leaves out ones already in the deck or repeated", () => {
    const found = aiCardsToFound(
      [
        { front: "  What is **H2O**? ", back: "Water" },
        { front: "What is H2O?", back: "Water" },
        { front: "Capital of France", back: "Paris" },
        { front: "", back: "No question" },
      ],
      [{ front: "capital of france", back: "paris" }],
    )
    assert.deepEqual(
      found.map((card) => [card.front, card.back, card.source, card.keep]),
      [["What is H2O?", "Water", "ai", true]],
    )
  })
})
