// The ready count on the hub, the deck tile and the deck page must match what the review shows.
import { describe, it } from "node:test"
import assert from "node:assert/strict"

import { NEW_PER_SESSION, buildSession, deckStats } from "./deck.ts"
import type { Deck, DeckCard } from "./deck.ts"

const now = new Date("2026-03-10T12:00:00Z")

function freshCards(count: number): DeckCard[] {
  return Array.from({ length: count }, (_, i) => ({ id: `n${i}`, front: `Q${i}`, back: `A${i}`, review: null }))
}

function seenCard(id: string, due: string): DeckCard {
  return {
    id,
    front: id,
    back: id,
    review: {
      due,
      stability: 3,
      difficulty: 5,
      elapsed_days: 1,
      scheduled_days: 1,
      learning_steps: 0,
      reps: 2,
      lapses: 0,
      state: 2,
      last_review: "2026-03-08T12:00:00Z",
    },
  }
}

function deckOf(cards: DeckCard[]): Deck {
  return { id: "d1", title: "Test", cards, tags: [] }
}

describe("deckStats due count", () => {
  it("caps new cards the same way the review does", () => {
    const deck = deckOf(freshCards(30))
    const stats = deckStats(deck, now)
    assert.equal(stats.total, 30)
    assert.equal(stats.due, NEW_PER_SESSION)
    assert.equal(stats.due, buildSession(deck, { now }).length)
  })

  it("counts every due card seen before, plus capped new cards", () => {
    const deck = deckOf([
      ...freshCards(20),
      seenCard("late", "2026-03-09T12:00:00Z"),
      seenCard("later", "2026-03-10T11:00:00Z"),
      seenCard("future", "2026-03-20T12:00:00Z"),
    ])
    const stats = deckStats(deck, now)
    assert.equal(stats.due, 2 + NEW_PER_SESSION)
    assert.equal(stats.due, buildSession(deck, { now }).length)
  })

  it("matches the review when there are fewer new cards than the cap", () => {
    const deck = deckOf([...freshCards(3), seenCard("late", "2026-03-09T12:00:00Z")])
    assert.equal(deckStats(deck, now).due, 4)
    assert.equal(buildSession(deck, { now }).length, 4)
  })

  it("is 0 when nothing is due and nothing is new", () => {
    const deck = deckOf([seenCard("future", "2026-03-20T12:00:00Z")])
    assert.equal(deckStats(deck, now).due, 0)
    assert.equal(buildSession(deck, { now }).length, 0)
  })
})
