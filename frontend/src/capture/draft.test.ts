// Turning the server's notes answer into a workbench draft: the full notes shape
// (text notes and Image to notes share it), and an older `{ notes }`-only answer.
import { describe, it } from "node:test"
import assert from "node:assert/strict"

import { DEFAULT_DRAFT_TITLE, draftHasWords, toNotesDraft } from "./draft.ts"

const source = { kind: "image" as const, label: "Image: board.png" }

describe("toNotesDraft", () => {
  it("keeps every part of the notes answer and keeps all cards", () => {
    const draft = toNotesDraft(
      {
        title: "  Photosynthesis ",
        summary: "Plants make food.",
        notes: "## Plants\n- Light",
        key_terms: ["photosynthesis", "", 4, "chloroplast"],
        flashcards: [
          { front: "What do plants use?", back: "Light" },
          { front: "  ", back: "No question" },
          null,
          { front: "Where?", back: "Chloroplasts" },
        ],
        truncated: false,
      },
      source,
    )
    assert.equal(draft.title, "Photosynthesis")
    assert.equal(draft.summary, "Plants make food.")
    assert.equal(draft.notes, "## Plants\n- Light")
    assert.deepEqual(draft.keyTerms, ["photosynthesis", "chloroplast"])
    assert.deepEqual(
      draft.cards.map(({ front, back, keep }) => ({ front, back, keep })),
      [
        { front: "What do plants use?", back: "Light", keep: true },
        { front: "Where?", back: "Chloroplasts", keep: true },
      ],
    )
    assert.equal(new Set(draft.cards.map((card) => card.id)).size, 2)
    assert.equal(draft.truncated, false)
    assert.deepEqual(draft.source, source)
    assert.equal(draftHasWords(draft), true)
  })

  it("an older server that only sends { notes } still gives a draft, with no cards", () => {
    const draft = toNotesDraft({ notes: "Photosynthesis\n- Plants use sunlight." }, source)
    assert.equal(draft.title, DEFAULT_DRAFT_TITLE)
    assert.equal(draft.notes, "Photosynthesis\n- Plants use sunlight.")
    assert.equal(draft.summary, "")
    assert.deepEqual(draft.keyTerms, [])
    assert.deepEqual(draft.cards, [])
    assert.equal(draftHasWords(draft), true)
  })

  it("an empty or broken answer has no words to save", () => {
    for (const data of [null, undefined, "notes", {}, { notes: "   ", summary: "\n" }]) {
      const draft = toNotesDraft(data, source)
      assert.equal(draftHasWords(draft), false)
      assert.equal(draft.title, DEFAULT_DRAFT_TITLE)
    }
  })

  it("truncated comes from the server or from the page", () => {
    assert.equal(toNotesDraft({ notes: "n", truncated: true }, source).truncated, true)
    assert.equal(toNotesDraft({ notes: "n" }, source, true).truncated, true)
    assert.equal(toNotesDraft({ notes: "n", truncated: "yes" }, source).truncated, false)
  })
})
