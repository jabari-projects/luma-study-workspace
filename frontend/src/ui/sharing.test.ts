// PR-B1 "lock down sharing": the word is "Shared", never "Public" or "Publish", and a
// shared item shows a username and nothing else about the person. Reads the source
// files as text, so no browser is needed.
import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { readFileSync, readdirSync, statSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

const SRC = fileURLToPath(new URL("..", import.meta.url))

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) sourceFiles(path, out)
    else if (/\.(tsx|ts)$/.test(name) && !/\.test\.ts$/.test(name)) out.push(path)
  }
  return out
}

const read = (relative: string) => readFileSync(join(SRC, relative), "utf8")

/** Text a student can see: JSX text, plus quoted strings that read like words (not paths or keys). */
function visibleStrings(source: string): string[] {
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
  const found: string[] = []
  for (const match of code.matchAll(/>([^<>{}]*[A-Za-z][^<>{}]*)</g)) found.push(match[1].trim())
  // Double-quoted and backtick strings are scanned on their own, so a "..." inside a `...` is still seen.
  const strings = [...code.matchAll(/"((?:[^"\\\n]|\\.)*)"/g), ...code.matchAll(/`((?:[^`\\]|\\.)*)`/g)]
  for (const match of strings) {
    const text = match[1].trim()
    // Paths like "/public/reports", import specifiers and css class names are not copy.
    if (!text || text.startsWith("/") || text.startsWith(".") || !/[A-Z]|\s/.test(text)) continue
    found.push(text)
  }
  return found
}

describe("sharing words", () => {
  it('no page says "Public", "Publish" or "Unpublish" to a student', () => {
    const bad: string[] = []
    for (const file of sourceFiles(SRC)) {
      for (const text of visibleStrings(readFileSync(file, "utf8"))) {
        if (/\b(public|publish|published|publishing|unpublish|unpublished)\b/i.test(text)) {
          bad.push(`${file.slice(SRC.length)}: ${text}`)
        }
      }
    }
    assert.deepEqual(bad, [])
  })

  it("the floating Publish button is gone, so nothing covers the study panel", () => {
    for (const file of [...sourceFiles(SRC), join(SRC, "styles.css"), join(SRC, "notes", "notes.css"), join(SRC, "study", "study.css")]) {
      assert.doesNotMatch(readFileSync(file, "utf8"), /floating-publish|PublishActionButton/, file)
    }
  })

  it("notes, summaries and decks share from their own header", () => {
    const note = read("notes/NotePage.tsx")
    const deck = read("study/FlashcardPages.tsx")
    const head = note.slice(note.indexOf('className="page-head-actions"'), note.indexOf("</header>"))
    assert.match(head, /<ShareControl/)
    assert.match(deck, /actions=\{\s*<>\s*<ShareControl/)
    // The hub row menu offers it too.
    assert.match(read("notes/NotesHub.tsx"), /label: "Share"/)
    assert.match(read("notes/NotesHub.tsx"), /label: "Stop sharing"/)
  })

  it("the share box says who can see it and what they see", () => {
    const copy = read("ui/sharing.ts")
    assert.match(copy, /Students signed in to Luma/)
    assert.match(copy, /your username, @\$\{username\}/)
    assert.match(copy, /Nothing else about you/)
    assert.match(copy, /You can stop sharing anytime/)
  })

  it('never makes up a name like "@student" before the profile loads', () => {
    const copy = read("ui/sharing.ts")
    assert.doesNotMatch(copy, /"student"/)
    assert.match(copy, /useShareName\(\): string \| null/)
  })

  it("the owner's page says the same @username other students see, not the stored name", () => {
    for (const file of ["notes/NotePage.tsx", "study/FlashcardPages.tsx"]) {
      const source = read(file)
      assert.doesNotMatch(source, /Shared by \$\{/, file)
      assert.match(source, /sharedLine\(shareName\)/, file)
    }
    assert.match(read("ui/sharing.ts"), /Shared by @\$\{username\}/)
  })
})

describe("search shows a username only", () => {
  const search = read("discover/DiscoverPage.tsx")

  it("never reads ids, names, photos or counts from search results", () => {
    for (const field of ["user_id", "display_name", "avatar_url", "public_count", "published_by"]) {
      assert.ok(!search.includes(field), `DiscoverPage.tsx still mentions ${field}`)
    }
  })

  it("people results show @username with no avatar", () => {
    assert.match(search, /@\{person\.username\}/)
    assert.doesNotMatch(search, /className="avatar"|<img/)
  })
})
