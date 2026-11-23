import { CARD_LINE } from "./cardLine.ts"

export type FoundCard = { id: string; front: string; back: string; keep: boolean; source: "card-line" | "term" | "list" | "ai" }

const TERM_LINE = /^\s*[-*•]\s+(?:\*\*|__)?([^:*_—–]{2,60}?)(?:\*\*|__)?\s*(?::|—|–|\s-\s)\s+(.{3,400})$/
/** "Question - Answer", "Question — Answer" or "Term: meaning", one per line (what people paste as a list). */
const LIST_LINE = /^\s*(?:[-*•]\s+)?(.{2,300}?)\s*(?:\s[-–—]\s|:\s)\s*(.{1,600})$/
/** "Question<tab>Answer" (what Quizlet and spreadsheets copy out). */
const TAB_LINE = /^\s*([^\t]{1,300}?)\s*\t+\s*([^\t]{1,600}?)\s*$/

const clean = (text: string) =>
  text
    .replace(/\*\*|__|`/g, "")
    .replace(/\s+/g, " ")
    .trim()

const hasLetter = (text: string) => /\p{L}/u.test(text)

let counter = 0
const nextId = () => `found-${Date.now().toString(36)}-${(counter += 1)}`

/**
 * Finds flashcards already written in a note, right in the browser (free, private):
 *  - "Question :: Answer" lines
 *  - bullet lines like "- Term: what it means" or "- **Term** — what it means"
 * With `lists` (text pasted to make cards), also one card per line:
 *  - "Question - Answer" (or "—", or "Term: meaning")
 *  - "Question<tab>Answer"
 * Math like "10 - 3 = 7", plain numbers like "1999 - 2001" and headings are not cards.
 */
export function findCardsInNote(content: string, { lists = false }: { lists?: boolean } = {}): FoundCard[] {
  const seen = new Set<string>()
  const cards: FoundCard[] = []
  for (const line of content.replace(/\r\n?/g, "\n").split("\n")) {
    const cardLine = line.match(CARD_LINE)
    const term = cardLine ? null : line.match(TERM_LINE)
    const listLine = cardLine || term || !lists || /^\s*#/.test(line) ? null : (line.match(TAB_LINE) ?? line.match(LIST_LINE))
    const match = cardLine ?? term ?? listLine
    if (!match) continue
    const front = clean(match[1])
    const back = clean(match[2])
    if (!front || !back) continue
    if (listLine) {
      if (front.includes("=") || back.includes("=")) continue
      if (!hasLetter(front) && !hasLetter(back)) continue
    } else {
      // Skip things that look like times ("Time: 3:00") or one-word answers to "Key words:" lists.
      if (/^\d/.test(back) && back.length < 6) continue
      if (term && back.split(" ").length < 2) continue
    }
    const key = `${front.toLowerCase()}|${back.toLowerCase()}`
    if (seen.has(key)) continue
    seen.add(key)
    cards.push({ id: nextId(), front, back, keep: true, source: cardLine ? "card-line" : term ? "term" : "list" })
  }
  return cards
}

type Words = { front: string; back: string }
const cardKey = (card: Words) => `${clean(card.front).toLowerCase()}|${clean(card.back).toLowerCase()}`

/** Only cards with both sides that are not repeats and not already in `existing` (same question and answer). */
export function newCardsOnly<T extends Words>(cards: T[], existing: Words[]): T[] {
  const seen = new Set(existing.map(cardKey))
  return cards.filter((card) => {
    const key = cardKey(card)
    if (!clean(card.front) || !clean(card.back) || seen.has(key)) return false
    seen.add(key)
    return true
  })
}

/** Cards from the AI, cleaned, without repeats or any already in `existing`. */
export function aiCardsToFound(cards: Words[], existing: Words[]): FoundCard[] {
  return newCardsOnly(
    cards.map((card) => ({ front: clean(card.front), back: clean(card.back) })),
    existing,
  ).map((card) => ({ id: nextId(), ...card, keep: true, source: "ai" as const }))
}
