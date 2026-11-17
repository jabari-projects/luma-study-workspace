// Checks the words in the navigation (ui/Nav.tsx): sentence case everywhere
// ("Voice to notes", never "Voice to Notes"), the four places plus Settings,
// and the five things you can make. Reads the file as text, so no browser is needed.
import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"

const nav = readFileSync(new URL("./Nav.tsx", import.meta.url), "utf8")

// Words that keep a capital letter in the middle of a sentence.
const PROPER_NOUNS = new Set(["Luma", "Word", "I"])

/** Every piece of text a student can see or hear in Nav.tsx. */
function visibleStrings(source: string): string[] {
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "")
  const found: string[] = []
  const patterns = [
    /\b(?:label|hint|title):\s*"([^"]+)"/g, // nav and menu items
    /\b(?:aria-label|title)="([^"]+)"/g, // JSX attributes
    /\bconst [A-Z_]+ = "([^"]+)"/g, // shared labels like NEW_LABEL
    />([^<>{}]*[A-Za-z][^<>{}]*)</g, // JSX text
  ]
  for (const pattern of patterns) {
    for (const match of code.matchAll(pattern)) {
      const text = match[1].trim()
      if (text && !/^[\w.-]+\(/.test(text)) found.push(text)
    }
  }
  return found
}

/** Words that look like Title Case: a capital letter that does not start a sentence. */
function titleCaseWords(text: string): string[] {
  const bad: string[] = []
  for (const sentence of text.split(/[.?!:]\s+/)) {
    const words = sentence.split(/[\s,]+/).filter(Boolean)
    for (const word of words.slice(1)) {
      const clean = word.replace(/[^A-Za-z]/g, "")
      if (!clean || PROPER_NOUNS.has(clean)) continue
      if (/^[A-Z]{2,}$/.test(clean)) continue // short forms like PDF
      if (/^[A-Z]/.test(clean)) bad.push(word)
    }
  }
  return bad
}

/** The `label:` values of one array literal in Nav.tsx, in order. */
function labelsOf(name: string): string[] {
  const start = nav.indexOf(`const ${name}`)
  assert.ok(start >= 0, `${name} is defined`)
  const body = nav.slice(start, nav.indexOf("]\n", start))
  return [...body.matchAll(/label: "([^"]+)"/g)].map((match) => match[1])
}

describe("navigation words", () => {
  it("the checker itself spots Title Case and lets sentence case through", () => {
    assert.deepEqual(titleCaseWords("Voice to Notes"), ["Notes"])
    assert.deepEqual(titleCaseWords("Study Sessions"), ["Sessions"])
    assert.deepEqual(titleCaseWords("Image to notes"), [])
    assert.deepEqual(titleCaseWords("PDF, Word, a web page or a video."), [])
    assert.deepEqual(titleCaseWords("Accounts. Using"), [])
  })

  it("finds the labels in Nav.tsx", () => {
    const strings = visibleStrings(nav)
    for (const expected of ["Home", "Study", "Notes", "Search", "Settings", "Voice to notes", "What do you want to make?"]) {
      assert.ok(strings.includes(expected), `expected to find "${expected}" in ${JSON.stringify(strings)}`)
    }
  })

  it("every label is in sentence case", () => {
    const offenders = visibleStrings(nav)
      .map((text) => ({ text, words: titleCaseWords(text) }))
      .filter((entry) => entry.words.length > 0)
    assert.deepEqual(offenders, [])
  })

  it("the places are Home, Study, Notes and Search, and Settings sits apart", () => {
    assert.deepEqual(
      [...nav.matchAll(/^const [A-Z]+: NavItem = \{[^}]*label: "([^"]+)"/gm)].map((match) => match[1]),
      ["Home", "Study", "Notes", "Search", "Settings"],
    )
    assert.match(nav, /const placeItems: NavItem\[\] = \[HOME, STUDY, NOTES, SEARCH\]/)
    assert.doesNotMatch(nav, /label: "(Today|Me|Summaries|Quizzes|Flashcards)"/)
  })

  it("the + menu has exactly the five things you can make, and no quiz or study plan", () => {
    assert.deepEqual(labelsOf("createItems"), [
      "Write a note",
      "Import a file or link",
      "Voice to notes",
      "Image to notes",
      "New flashcard deck",
    ])
  })

  it("the note tools open their pages inside Notes (/notes/new, /notes/import, /notes/voice, /notes/image)", () => {
    const start = nav.indexOf("const createItems")
    const body = nav.slice(start, nav.indexOf("]\n", start))
    assert.deepEqual(
      [...body.matchAll(/to: ([A-Z_]+|"[^"]+")/g)].map((match) => match[1]),
      ["NEW_NOTE", "IMPORT_NOTES", "VOICE_NOTES", "IMAGE_NOTES", '"/flashcards/new"'],
    )
    assert.match(nav, /import \{ IMAGE_NOTES, IMPORT_NOTES, NEW_NOTE, VOICE_NOTES \} from "\.\.\/notes\/paths"/)
    assert.doesNotMatch(nav, /"\/(import|voice-input|image-to-notes)"/)
  })
})
