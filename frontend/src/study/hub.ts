// Words and small helpers for the Study hub, the review intro, quizzes and study plans.
// No window, React or ts-fsrs here, so `node --test` can run it.

/** The Study hub stays on /flashcards. /study sends you there. */
export const STUDY_HUB = "/flashcards"
export const STUDY_PLANS = "/study-sessions"

/** Old or short addresses that still work: each one sends you to its new place. */
export const STUDY_REDIRECTS: ReadonlyArray<readonly [from: string, to: string]> = [
  ["/study", STUDY_HUB],
  ["/study-session", STUDY_PLANS],
]

/** About 12 seconds a card, rounded up to whole minutes, at least 1. */
export function minutesFor(cards: number): number {
  return Math.max(1, Math.ceil((Math.max(0, cards) * 12) / 60))
}

/** "1 minute", "3 minutes". A no-break space keeps the number and word on one line. */
export function minutesText(minutes: number): string {
  return `${minutes}\u00a0minute${minutes === 1 ? "" : "s"}`
}

/**
 * "8 cards are ready across your decks. About 2 minutes." The time is for the same count
 * as the sentence. A no-break space keeps "2 minutes" together on one line.
 */
export function readyLine(total: number, manyDecks: boolean): string {
  const cards = `${total}\u00a0card${total === 1 ? " is" : "s are"} ready${manyDecks ? " across your decks" : ""}.`
  return `${cards} About ${minutesText(minutesFor(total))}.`
}

/** "24 cards · 8 ready" on a deck. */
export function deckCountLine(total: number, due: number): string {
  const cards = `${total} card${total === 1 ? "" : "s"}`
  return due > 0 ? `${cards} · ${due} ready` : cards
}

/**
 * What the review will have, before it starts: "8 cards are due and 5 are new. About 3 minutes."
 * `due` are cards seen before that are due again; `fresh` are cards never studied.
 */
export function introLine(due: number, fresh: number): string {
  const parts: string[] = []
  const be = (count: number) => (count === 1 ? "is" : "are")
  if (due > 0 && fresh > 0) {
    parts.push(`${due} card${due === 1 ? "" : "s"} ${be(due)} due and ${fresh} ${be(fresh)} new.`)
  } else if (due > 0) {
    parts.push(`${due} card${due === 1 ? "" : "s"} ${be(due)} due.`)
  } else if (fresh > 0) {
    parts.push(`${fresh} card${fresh === 1 ? "" : "s"} ${be(fresh)} new.`)
  }
  parts.push(`About ${minutesText(minutesFor(due + fresh))}.`)
  return parts.join(" ")
}

/** Practice when nothing is due: "20 cards to practice. About 4 minutes." */
export function practiceLine(cards: number): string {
  return `${cards} card${cards === 1 ? "" : "s"} to practice. About ${minutesText(minutesFor(cards))}.`
}

/** How a review works, said once before the first card. */
export const REVIEW_STEPS = "Look at the front. Think of the answer. Flip it. Then tap how well you knew it."

/** Practicing cards that are not due yet still changes when they come back. */
export const PRACTICE_NOTE = "These cards aren't due yet. Your answers still change when they come back."

/** Deck ids from ?deck=a,b. Also takes one id. Blank and repeated ids are dropped. */
export function parseDeckParam(value: string | null | undefined): string[] {
  if (!value) return []
  const ids: string[] = []
  for (const part of value.split(",")) {
    const id = part.trim()
    if (id && !ids.includes(id)) ids.push(id)
  }
  return ids
}

/** The quiz page for these decks: /quizzes?deck=a,b. The commas stay readable. */
export function quizHref(ids: readonly string[]): string {
  const list = ids.filter(Boolean).map((id) => encodeURIComponent(id))
  return list.length > 0 ? `/quizzes?deck=${list.join(",")}` : "/quizzes"
}

/**
 * Which decks a quiz starts with: the ones the link named that can be used,
 * or else the first usable deck (the newest one, since the list is newest first).
 */
export function pickDecks(requested: readonly string[], usable: readonly string[]): string[] {
  const matched = requested.filter((id) => usable.includes(id))
  if (matched.length > 0) return matched
  return usable.length > 0 ? [usable[0]] : []
}

/** Study plans are typed in minutes; the server keeps seconds. */
export function secondsFromMinutes(value: string): number {
  const minutes = Number.parseFloat(value)
  if (!Number.isFinite(minutes) || minutes <= 0) return 0
  return Math.round(minutes * 60)
}

/** "25 min" for a plan. Older plans saved in odd seconds round to the nearest minute. */
export function planMinutesText(seconds: unknown): string | null {
  const value = typeof seconds === "number" ? seconds : Number(seconds)
  if (!Number.isFinite(value) || value <= 0) return null
  return value < 60 ? "Under 1 min" : `${Math.round(value / 60)} min`
}
