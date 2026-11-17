// The old boxy layout classes are gone for good: no component uses them and no
// stylesheet still styles them. If one comes back, this test names the file.
import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative } from "node:path"
import { fileURLToPath } from "node:url"

const SRC = fileURLToPath(new URL(".", import.meta.url))

/** Removed in PR-A7 ("Margins" layout): tiles, the form-beside-list, card grids, boxed panels. */
const DELETED_CLASSES = [
  "tool-grid",
  "tool-tile",
  "split-layout",
  "public-grid",
  "public-card",
  "paper-panel",
  "form-panel",
  "settings-grid",
  "page-header",
] as const

function filesUnder(dir: string, extension: string): string[] {
  const found: string[] = []
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) {
      found.push(...filesUnder(path, extension))
    } else if (path.endsWith(extension) && !path.endsWith(".test.ts")) {
      found.push(path)
    }
  }
  return found
}

/** A class name as a whole word, so "paper-panel" does not match "paper-panels" or "my-paper-panel". */
const wordPattern = (name: string) => new RegExp(`(^|[^\\w-])${name.replace(/-/g, "\\-")}(?![\\w-])`)

describe("deleted layout classes", () => {
  const components = filesUnder(SRC, ".tsx")
  const stylesheets = filesUnder(SRC, ".css")

  it("finds the source files it checks", () => {
    assert.ok(components.length > 20, `only ${components.length} .tsx files found`)
    assert.ok(stylesheets.length >= 4, `only ${stylesheets.length} .css files found`)
  })

  for (const name of DELETED_CLASSES) {
    it(`no component uses .${name}`, () => {
      const users = components.filter((path) => wordPattern(name).test(readFileSync(path, "utf8")))
      assert.deepEqual(users.map((path) => relative(SRC, path)), [])
    })

    it(`no stylesheet styles .${name}`, () => {
      const selector = new RegExp(`\\.${name.replace(/-/g, "\\-")}(?![\\w-])`)
      const styling = stylesheets.filter((path) => selector.test(readFileSync(path, "utf8")))
      assert.deepEqual(styling.map((path) => relative(SRC, path)), [])
    })
  }

  it("the pattern really catches a use (so the checks above can fail)", () => {
    assert.ok(wordPattern("paper-panel").test('<div className="audio-ready paper-panel">'))
    assert.ok(wordPattern("form-panel").test('className="form-panel"'))
    assert.ok(!wordPattern("tab").test('className="tabs"'))
    assert.ok(!wordPattern("paper-panel").test('className="paper-panels"'))
  })
})
