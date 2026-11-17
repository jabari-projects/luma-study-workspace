// The Notes hub helpers: old addresses that redirect (keeping ?query), the tabs,
// merging notes and summaries by date, previews, "Find in my notes", and the new-note title.
import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { readFileSync, readdirSync, statSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

import {
  IMAGE_NOTES,
  IMPORT_NOTES,
  NOTE_REDIRECTS,
  SUMMARIES_TAB,
  VOICE_NOTES,
  defaultNoteTitle,
  matchesFind,
  mergeByChanged,
  parseTags,
  previewLine,
  redirectTarget,
  tabFromQuery,
} from "./paths.ts"
import type { HubItem } from "./paths.ts"

describe("old note addresses", () => {
  const redirects = new Map(NOTE_REDIRECTS)

  it("each old page has a new home inside Notes", () => {
    assert.equal(redirects.get("/import"), IMPORT_NOTES)
    assert.equal(redirects.get("/voice-input"), VOICE_NOTES)
    assert.equal(redirects.get("/audio-to-notes"), VOICE_NOTES)
    assert.equal(redirects.get("/image-to-notes"), IMAGE_NOTES)
    assert.equal(redirects.get("/notes/picture"), IMAGE_NOTES)
    assert.equal(redirects.get("/summaries"), SUMMARIES_TAB)
    assert.equal(IMAGE_NOTES, "/notes/image")
  })

  it("keeps the query string and #hash", () => {
    assert.equal(redirectTarget(IMPORT_NOTES, "?from=link"), "/notes/import?from=link")
    assert.equal(redirectTarget(VOICE_NOTES, "", "#top"), "/notes/voice#top")
    assert.equal(redirectTarget(SUMMARIES_TAB, ""), "/notes?show=summaries")
    assert.equal(redirectTarget(SUMMARIES_TAB, "?q=cells"), "/notes?show=summaries&q=cells")
  })

  it("the new address's own query wins", () => {
    assert.equal(redirectTarget(SUMMARIES_TAB, "?show=notes"), "/notes?show=summaries")
  })
})

describe("hub tabs", () => {
  it("reads ?show=, and anything else means All", () => {
    assert.equal(tabFromQuery("summaries"), "summaries")
    assert.equal(tabFromQuery("notes"), "notes")
    assert.equal(tabFromQuery(null), "all")
    assert.equal(tabFromQuery("decks"), "all")
  })
})

describe("one list of notes and summaries", () => {
  const note = (id: string, created: string, updated: string | null = null): HubItem => ({
    id,
    kind: "note",
    created_at: created,
    updated_at: updated,
  })

  it("puts the most recently changed first, using created_at when never edited", () => {
    const merged = mergeByChanged(
      [note("old", "2026-11-01T10:00:00Z"), note("edited", "2026-10-01T10:00:00Z", "2026-11-15T10:00:00Z")],
      [{ id: "sum", kind: "summary", created_at: "2026-11-10T10:00:00Z" }],
    )
    assert.deepEqual(
      merged.map((item) => item.id),
      ["edited", "sum", "old"],
    )
  })

  it("does not throw on missing or bad dates", () => {
    const merged = mergeByChanged([note("a", "not a date"), { id: "b", kind: "note" }], [])
    assert.equal(merged.length, 2)
  })
})

describe("row preview", () => {
  it("is one line of plain text without Markdown marks", () => {
    assert.equal(previewLine("## What is it?\n- Plants make food.\n- **Sun** helps."), "What is it? Plants make food. Sun helps.")
  })

  it("reads each line as its own sentence", () => {
    assert.equal(
      previewLine("Apple :: Manzana\nBread :: Pan\n\n## Parts of a cell\n- The nucleus"),
      "Apple → Manzana. Bread → Pan. Parts of a cell. The nucleus",
    )
  })

  it("shows card lines with an arrow and skips Source and Key words lines", () => {
    assert.equal(previewLine("Capital of France :: Paris\nSource: Pasted text\nKey words: city"), "Capital of France → Paris")
  })

  it("is cut short with an ellipsis", () => {
    const line = previewLine("word ".repeat(100), 40)
    assert.ok(line.length <= 40)
    assert.ok(line.endsWith("…"))
  })

  it("is empty for an empty note", () => {
    assert.equal(previewLine(undefined), "")
  })
})

describe("Find in my notes", () => {
  const item: HubItem = { id: "1", kind: "note", title: "Cell parts", content: "The nucleus holds DNA." }

  it("matches every word in the title or text, ignoring case", () => {
    assert.equal(matchesFind(item, ""), true)
    assert.equal(matchesFind(item, "cell"), true)
    assert.equal(matchesFind(item, "NUCLEUS dna"), true)
    assert.equal(matchesFind(item, "nucleus plants"), false)
  })
})

describe("new note", () => {
  it("starts with a title like 'Notes for Nov 16' (the server needs a title)", () => {
    assert.equal(defaultNoteTitle(new Date(2026, 10, 16, 9, 30)), "Notes for Nov 16")
  })

  it("turns typed tags into a clean list", () => {
    assert.deepEqual(parseTags(" biology, #cells,, "), ["biology", "cells"])
  })

  it("keeps every tag, even a long list", () => {
    const many = Array.from({ length: 25 }, (_, index) => `tag${index}`)
    assert.deepEqual(parseTags(many.join(", ")), many)
  })
})

describe("copy", () => {
  const srcDir = fileURLToPath(new URL("..", import.meta.url))
  const files: string[] = []
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name)
      if (statSync(path).isDirectory()) walk(path)
      else if (/\.tsx?$/.test(name) && !name.endsWith(".test.ts")) files.push(path)
    }
  }
  walk(srcDir)

  it("never says 'summarys' or builds a plural by adding s to a label", () => {
    for (const file of files) {
      const text = readFileSync(file, "utf8")
      assert.doesNotMatch(text, /summarys/i, file)
      assert.doesNotMatch(text, /\{kindLabel\.toLowerCase\(\)\}s\b/, file)
    }
  })

  it("says 'Image to notes', not 'Picture to notes'", () => {
    for (const file of files) {
      assert.doesNotMatch(readFileSync(file, "utf8"), /Picture to notes/i, file)
    }
  })
})
