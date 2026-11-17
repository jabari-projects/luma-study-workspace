// The Study hub helpers: the ready line, the review intro, ?deck=a,b for quizzes,
// study plans in minutes, and the /study address.
import { describe, it } from "node:test"
import assert from "node:assert/strict"

import {
  STUDY_HUB,
  STUDY_PLANS,
  STUDY_REDIRECTS,
  deckCountLine,
  introLine,
  minutesFor,
  parseDeckParam,
  pickDecks,
  planMinutesText,
  practiceLine,
  quizHref,
  readyLine,
  secondsFromMinutes,
} from "./hub.ts"

const NBSP = " "
const plain = (text: string) => text.replaceAll(NBSP, " ")

describe("addresses", () => {
  it("/study opens the Study hub on /flashcards", () => {
    const redirects = new Map(STUDY_REDIRECTS)
    assert.equal(STUDY_HUB, "/flashcards")
    assert.equal(redirects.get("/study"), "/flashcards")
    assert.equal(redirects.get("/study-session"), STUDY_PLANS)
  })
})

describe("time estimate", () => {
  it("is about 12 seconds a card, rounded up, at least 1 minute", () => {
    assert.equal(minutesFor(0), 1)
    assert.equal(minutesFor(1), 1)
    assert.equal(minutesFor(5), 1)
    assert.equal(minutesFor(6), 2)
    assert.equal(minutesFor(12), 3)
    assert.equal(minutesFor(15), 3)
    assert.equal(minutesFor(16), 4)
  })
})

describe("ready line", () => {
  it("says how many cards are ready and about how long", () => {
    assert.equal(plain(readyLine(12, false)), "12 cards are ready. About 3 minutes.")
    assert.equal(plain(readyLine(1, false)), "1 card is ready. About 1 minute.")
    assert.equal(plain(readyLine(8, true)), "8 cards are ready across your decks. About 2 minutes.")
  })

  it("keeps the number with its word", () => {
    assert.ok(readyLine(8, true).includes(`2${NBSP}minutes`))
    assert.ok(readyLine(8, true).startsWith(`8${NBSP}cards`))
  })
})

describe("deck count line", () => {
  it("adds the ready count only when cards are ready", () => {
    assert.equal(deckCountLine(24, 8), "24 cards · 8 ready")
    assert.equal(deckCountLine(1, 1), "1 card · 1 ready")
    assert.equal(deckCountLine(5, 0), "5 cards")
  })
})

describe("review intro", () => {
  it("says how many are due and new, and about how long", () => {
    assert.equal(plain(introLine(8, 5)), "8 cards are due and 5 are new. About 3 minutes.")
    assert.equal(plain(introLine(1, 1)), "1 card is due and 1 is new. About 1 minute.")
    assert.equal(plain(introLine(4, 0)), "4 cards are due. About 1 minute.")
    assert.equal(plain(introLine(0, 3)), "3 cards are new. About 1 minute.")
    assert.equal(plain(introLine(0, 1)), "1 card is new. About 1 minute.")
  })

  it("says how many cards a practice round has when nothing is due", () => {
    assert.equal(plain(practiceLine(20)), "20 cards to practice. About 4 minutes.")
    assert.equal(plain(practiceLine(1)), "1 card to practice. About 1 minute.")
  })
})

describe("quiz decks in the link", () => {
  it("reads one id or a comma list, without blanks or repeats", () => {
    assert.deepEqual(parseDeckParam("d1"), ["d1"])
    assert.deepEqual(parseDeckParam("d1,d2"), ["d1", "d2"])
    assert.deepEqual(parseDeckParam(" d1 , ,d2,d1 "), ["d1", "d2"])
    assert.deepEqual(parseDeckParam(""), [])
    assert.deepEqual(parseDeckParam(null), [])
  })

  it("writes the list with plain commas", () => {
    assert.equal(quizHref(["d1", "d2"]), "/quizzes?deck=d1,d2")
    assert.equal(quizHref(["d1"]), "/quizzes?deck=d1")
    assert.equal(quizHref([]), "/quizzes")
    assert.equal(quizHref(["a b"]), "/quizzes?deck=a%20b")
    assert.deepEqual(parseDeckParam(new URLSearchParams("deck=d1,d2").get("deck")), ["d1", "d2"])
  })

  it("starts with the named decks that can be used, or else the first one", () => {
    const usable = ["d1", "d2", "d3"]
    assert.deepEqual(pickDecks(["d2", "d3"], usable), ["d2", "d3"])
    assert.deepEqual(pickDecks(["d2", "nope"], usable), ["d2"])
    assert.deepEqual(pickDecks(["nope"], usable), ["d1"])
    assert.deepEqual(pickDecks([], usable), ["d1"])
    assert.deepEqual(pickDecks(["d1"], []), [])
  })
})

describe("study plans in minutes", () => {
  it("turns minutes into the seconds the server keeps", () => {
    assert.equal(secondsFromMinutes("25"), 1500)
    assert.equal(secondsFromMinutes("1"), 60)
    assert.equal(secondsFromMinutes("1.5"), 90)
    assert.equal(secondsFromMinutes(""), 0)
    assert.equal(secondsFromMinutes("0"), 0)
    assert.equal(secondsFromMinutes("-5"), 0)
    assert.equal(secondsFromMinutes("abc"), 0)
  })

  it("shows saved seconds as minutes, including older plans", () => {
    assert.equal(planMinutesText(1500), "25 min")
    assert.equal(planMinutesText(90), "2 min")
    assert.equal(planMinutesText(30), "Under 1 min")
    assert.equal(planMinutesText(0), null)
    assert.equal(planMinutesText(null), null)
    assert.equal(planMinutesText("600"), "10 min")
  })
})
