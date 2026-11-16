import { CARD_LINE } from "./cardLine"

export type FoundCard = { id: string; front: string; back: string; keep: boolean; source: "card-line" | "term" | "ai" }

const TERM_LINE = /^\s*[-*•]\s+(?:\*\*|__)?([^:*_—–]{2,60}?)(?:\*\*|__)?\s*(?::|—|–|\s-\s)\s+(.{3,400})$/

const clean = (text: string) =>
  text
    .replace(/\*\*|__|`/g, "")
    .replace(/\s+/g, " ")
    .trim()

let counter = 0
const nextId = () => `found-${Date.now().toString(36)}-${(counter += 1)}`

/**
 * Finds flashcards already written in a note, right in the browser (free, private):
 *  - "Question :: Answer" lines
 *  - bullet lines like "- Term: what it means" or "- **Term** — what it means"
 */
export function findCardsInNote(content: string): FoundCard[] {
  const seen = new Set<string>()
  const cards: FoundCard[] = []
  for (const line of content.replace(/\r\n?/g, "\n").split("\n")) {
    const cardLine = line.match(CARD_LINE)
    const term = cardLine ? null : line.match(TERM_LINE)
    const match = cardLine ?? term
    if (!match) continue
    const front = clean(match[1])
    const back = clean(match[2])
    // Skip things that look like times ("Time: 3:00") or one-word answers to "Key words:" lists.
    if (!front || !back || (/^\d/.test(back) && back.length < 6)) continue
    if (term && back.split(" ").length < 2) continue
    const key = `${front.toLowerCase()}|${back.toLowerCase()}`
    if (seen.has(key)) continue
    seen.add(key)
    cards.push({ id: nextId(), front, back, keep: true, source: cardLine ? "card-line" : "term" })
  }
  return cards
}

export function aiCardsToFound(cards: { front: string; back: string }[], existing: FoundCard[]): FoundCard[] {
  const seen = new Set(existing.map((card) => `${card.front.toLowerCase()}|${card.back.toLowerCase()}`))
  return cards
    .map((card) => ({ front: clean(card.front), back: clean(card.back) }))
    .filter((card) => card.front && card.back && !seen.has(`${card.front.toLowerCase()}|${card.back.toLowerCase()}`))
    .map((card) => ({ id: nextId(), ...card, keep: true, source: "ai" as const }))
}
