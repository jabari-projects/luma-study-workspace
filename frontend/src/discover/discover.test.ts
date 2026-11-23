// PR-B2 Discover v0: where it lives, the old /search address, where a brand-new student
// lands, and the small row helpers. Reads source files as text, so no browser is needed.
import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"

import {
  DISCOVER,
  DISCOVER_REDIRECTS,
  FIRST_TIME_LANDING,
  NO_FILTERS,
  TOP_SUBJECTS,
  discoverStatus,
  filtersFromParams,
  hasFilters,
  isOwnItem,
  kindLabel,
  paramsFromFilters,
  peopleQuery,
  sharedDate,
  subjectChips,
  typeChipLabel,
  typeChips,
} from "./discover.ts"
import type { DiscoverState } from "./discover.ts"

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8")

describe("Discover address", () => {
  it("lives at /discover, and the old /search opens it", () => {
    assert.equal(DISCOVER, "/discover")
    assert.deepEqual(new Map(DISCOVER_REDIRECTS).get("/search"), "/discover")
  })

  it("the app routes /discover to the Discover page and redirects /search keeping its query", () => {
    const app = read("../App.tsx")
    assert.match(app, /<Route path=\{DISCOVER\} element=\{<DiscoverPage \/>\} \/>/)
    assert.match(app, /\.\.\.DISCOVER_REDIRECTS\]\.map\(/)
    assert.doesNotMatch(app, /path="\/search"/)
  })

  it("the nav says Search but goes to /discover", () => {
    const nav = read("../ui/Nav.tsx")
    assert.match(nav, /const SEARCH: NavItem = \{ to: DISCOVER, label: "Search"/)
  })

  it("the page heading is Discover (it holds notes, decks and summaries)", () => {
    const page = read("./DiscoverPage.tsx")
    assert.match(page, /<Scribble type="underline">Discover<\/Scribble>/)
    assert.match(page, /Notes, flashcards and summaries other students shared/)
  })
})

describe("where a new student lands", () => {
  it("finishing signup opens Discover; an older account checking its email goes Home", () => {
    assert.equal(FIRST_TIME_LANDING, DISCOVER)
    const pages = read("../account/AccountPages.tsx")
    assert.match(pages, /const next = ticket \? FIRST_TIME_LANDING : "\/dashboard"/)
    assert.match(pages, /navigate\(next, \{ replace: true \}\)/)
  })

  it("an ordinary login still goes Home", () => {
    const pages = read("../account/AccountPages.tsx")
    assert.match(pages, /navigate\(adding \? "\/dashboard" : params\.get\("redirect"\) \|\| "\/dashboard"/)
  })
})

describe("shared rows", () => {
  it("label each kind in plain words", () => {
    assert.equal(kindLabel("note"), "Note")
    assert.equal(kindLabel("flashcards"), "Deck")
    assert.equal(kindLabel("summary"), "Summary")
  })

  it("people search needs 3 letters of a real username", () => {
    assert.equal(peopleQuery("sa"), null)
    assert.equal(peopleQuery("  @sa "), null)
    assert.equal(peopleQuery("sam"), "sam")
    assert.equal(peopleQuery(" @Sam_1 "), "Sam_1")
    assert.equal(peopleQuery("sam smith"), null)
    assert.equal(peopleQuery("50%"), null)
  })

  it("dates are short, with the year only when it is not this year", () => {
    const today = new Date("2026-11-17T12:00:00")
    assert.equal(sharedDate("2026-11-14T12:00:00", today), "Nov 14")
    assert.equal(sharedDate("2025-03-02T12:00:00", today), "Mar 2, 2025")
    assert.equal(sharedDate("", today), "")
    assert.equal(sharedDate("not a date", today), "")
    assert.equal(sharedDate(null, today), "")
  })
})

describe("the status line screen readers hear", () => {
  const base: DiscoverState = { tab: "topics", busy: "idle", topic: "", itemCount: null, personAsked: null, peopleCount: 0 }

  it("says what each panel is loading, then that Luma is waking up", () => {
    assert.equal(discoverStatus({ ...base, busy: "loading" }), "Loading shared notes…")
    assert.equal(discoverStatus({ ...base, tab: "people", busy: "loading" }), "Looking for people…")
    assert.equal(discoverStatus({ ...base, busy: "slow" }), "Waking up Luma… This can take a minute.")
  })

  it("says how many shared items were found, or that none were", () => {
    assert.equal(discoverStatus(base), "")
    assert.equal(discoverStatus({ ...base, itemCount: 1 }), "1 shared item.")
    assert.equal(discoverStatus({ ...base, itemCount: 4, topic: "cells" }), "4 shared items for “cells”.")
    assert.equal(discoverStatus({ ...base, itemCount: 0, topic: "x" }), "Nothing found for “x”.")
    assert.equal(discoverStatus({ ...base, itemCount: 0 }), "Nothing here yet. No one has shared notes or flashcards yet.")
  })

  it("says how the filters narrow it: 312, then 10 in Math, then 2 decks in Math › Algebra 1", () => {
    assert.equal(discoverStatus({ ...base, itemCount: 312, topic: "1+1" }), "312 shared items for “1+1”.")
    assert.equal(discoverStatus({ ...base, itemCount: 10, topic: "1+1", place: "Math" }), "10 shared items for “1+1” in Math.")
    assert.equal(
      discoverStatus({ ...base, itemCount: 2, topic: "1+1", place: "Math › Algebra 1", type: "flashcards" }),
      "2 shared decks for “1+1” in Math › Algebra 1.",
    )
    assert.equal(discoverStatus({ ...base, itemCount: 1, type: "summary" }), "1 shared summary.")
    assert.equal(discoverStatus({ ...base, itemCount: 0, topic: "x", place: "Math" }), "Nothing here with these filters.")
  })

  it("people: nothing before a search, then who was found", () => {
    const people: DiscoverState = { ...base, tab: "people", itemCount: 3 }
    assert.equal(discoverStatus(people), "")
    assert.equal(discoverStatus({ ...people, personAsked: "sam" }), "No one with that username has shared anything yet.")
    assert.equal(discoverStatus({ ...people, personAsked: "sam", peopleCount: 1 }), "Found 1 person.")
    assert.equal(discoverStatus({ ...people, personAsked: "sa_", peopleCount: 2 }), "Found 2 people.")
  })
})

describe("filters in the address", () => {
  it("read and write q, subject, subtopic and type", () => {
    const filters = filtersFromParams(new URLSearchParams("q=1%2B1&subject=math&subtopic=algebra&type=flashcards"))
    assert.deepEqual(filters, { q: "1+1", subject: "math", subtopic: "algebra", type: "flashcards" })
    assert.equal(paramsFromFilters(filters).toString(), "q=1%2B1&subject=math&subtopic=algebra&type=flashcards")
    assert.equal(paramsFromFilters(NO_FILTERS).toString(), "")
    assert.equal(hasFilters(filters), true)
    assert.equal(hasFilters({ ...NO_FILTERS, q: "x" }), false)
  })

  it("drop bad values quietly", () => {
    assert.deepEqual(filtersFromParams(new URLSearchParams("subject=Math!&subtopic=algebra&type=quiz")), NO_FILTERS)
    assert.deepEqual(filtersFromParams(new URLSearchParams("subtopic=algebra")), NO_FILTERS)
    assert.equal(filtersFromParams(new URLSearchParams(`q=${"x".repeat(200)}`)).q.length, 80)
  })

  it("a subtopic never goes in the address without its subject", () => {
    assert.equal(paramsFromFilters({ ...NO_FILTERS, subtopic: "algebra" }).toString(), "")
  })
})

describe("filter chips", () => {
  const counts = [
    { slug: "math", count: 120 },
    ...Array.from({ length: 9 }, (_, n) => ({ slug: `s${n}`, count: 50 - n })),
    { slug: null, count: 40 },
  ]

  it("show the 8 most shared subjects, then More subjects", () => {
    const { chips, more } = subjectChips(counts, null, false)
    assert.equal(chips.length, TOP_SUBJECTS)
    assert.equal(chips[0].slug, "math")
    assert.equal(more, 2)
  })

  it("never make No subject a chip (it can't be chosen)", () => {
    assert.ok(!subjectChips(counts, null, true).chips.some((chip) => chip.slug === null))
    assert.equal(subjectChips(counts, null, true).chips.length, 10)
  })

  it("keep a chosen subject in view even when it is not in the top 8", () => {
    const { chips } = subjectChips(counts, "s8", false)
    assert.equal(chips.at(-1)?.slug, "s8")
  })

  it("list types in a fixed order, zero counts hidden", () => {
    assert.deepEqual(
      typeChips([{ type: "note", count: 90 }, { type: "flashcards", count: 200 }]).map((chip) => typeChipLabel(chip.type)),
      ["Flashcards", "Notes"],
    )
    assert.deepEqual(typeChips([{ type: "summary", count: 0 }]), [])
  })

  it("are toggle buttons that wrap, never a sideways scroller", () => {
    const page = readFileSync(new URL("./DiscoverPage.tsx", import.meta.url), "utf8")
    assert.match(page, /className="filter-chip"\s+aria-pressed=\{pressed\}/)
    const css = readFileSync(new URL("../subjects/subjects.css", import.meta.url), "utf8")
    assert.match(css, /\.chip-list \{[^}]*flex-wrap: wrap;/)
    assert.doesNotMatch(css, /overflow-x: (auto|scroll)/)
  })
})

describe("your own shared items", () => {
  it("match your username, ignoring case", () => {
    assert.equal(isOwnItem("jabari", "jabari"), true)
    assert.equal(isOwnItem("Jabari", "jabari"), true)
    assert.equal(isOwnItem("sam", "jabari"), false)
    assert.equal(isOwnItem("sam", null), false)
    assert.equal(isOwnItem("", ""), false)
  })

  it("show You shared this instead of a Report button", () => {
    const page = read("./DiscoverPage.tsx")
    assert.match(page, /\{mine \? null : <ReportButton /)
  })
})
