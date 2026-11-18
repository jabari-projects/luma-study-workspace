import { Rating, State, createEmptyCard, fsrs, generatorParameters } from "ts-fsrs"
import type { Card, Grade } from "ts-fsrs"

/** Review state as it is saved on the server (dates as ISO strings). */
export type ReviewState = {
  due: string
  stability: number
  difficulty: number
  elapsed_days: number
  scheduled_days: number
  learning_steps: number
  reps: number
  lapses: number
  state: number
  last_review?: string | null
}

export type DeckCard = {
  id: string
  front: string
  back: string
  review?: ReviewState | null
}

export type Deck = {
  id: string
  title: string
  front?: string
  back?: string
  cards: DeckCard[]
  tags: string[]
  is_public?: boolean
  published_at?: string | null
  published_by?: string | null
  study_type?: string | null
  created_at?: string
  updated_at?: string | null
  /** Goes up by 1 on every saved edit (the deck editor sends it back as expected_version). */
  version?: number
}

export type Mastery = "new" | "learning" | "shaky" | "solid"

export const glowLevels: Record<Mastery, { name: string; hint: string }> = {
  new: { name: "Spark", hint: "Not studied yet" },
  learning: { name: "Ember", hint: "Just learning it" },
  shaky: { name: "Flame", hint: "Getting there" },
  solid: { name: "Lumen", hint: "You know it" },
}

const scheduler = fsrs(generatorParameters({ enable_fuzz: true, request_retention: 0.9 }))

export const ratingChoices: { grade: Grade; label: string; hint: string; key: string; tone: string }[] = [
  { grade: Rating.Again, label: "Forgot", hint: "Show it again soon", key: "1", tone: "again" },
  { grade: Rating.Hard, label: "Tough", hint: "Got it, barely", key: "2", tone: "hard" },
  { grade: Rating.Good, label: "Got it", hint: "Knew it", key: "3", tone: "good" },
  { grade: Rating.Easy, label: "Easy", hint: "Too easy", key: "4", tone: "easy" },
]

export function newCardId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID().replace(/-/g, "")
  }
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`
}

function toCard(review: ReviewState | null | undefined, now: Date): Card {
  if (!review) {
    return createEmptyCard(now)
  }
  return {
    due: new Date(review.due),
    stability: review.stability,
    difficulty: review.difficulty,
    elapsed_days: review.elapsed_days,
    scheduled_days: review.scheduled_days,
    learning_steps: review.learning_steps ?? 0,
    reps: review.reps,
    lapses: review.lapses,
    state: review.state as State,
    last_review: review.last_review ? new Date(review.last_review) : undefined,
  }
}

function fromCard(card: Card): ReviewState {
  return {
    due: card.due.toISOString(),
    stability: card.stability,
    difficulty: card.difficulty,
    elapsed_days: card.elapsed_days,
    scheduled_days: card.scheduled_days,
    learning_steps: card.learning_steps,
    reps: card.reps,
    lapses: card.lapses,
    state: card.state,
    last_review: card.last_review ? card.last_review.toISOString() : null,
  }
}

/** Grade one card and return its new review state. */
export function gradeCard(card: DeckCard, grade: Grade, now = new Date()): DeckCard {
  const next = scheduler.next(toCard(card.review, now), now, grade)
  return { ...card, review: fromCard(next.card) }
}

/** Friendly "see you in…" text for each button before the student picks it. */
export function previewIntervals(card: DeckCard, now = new Date()): Record<number, string> {
  const preview = scheduler.repeat(toCard(card.review, now), now)
  const result: Record<number, string> = {}
  for (const choice of ratingChoices) {
    result[choice.grade] = formatWait(preview[choice.grade].card.due.getTime() - now.getTime())
  }
  return result
}

export function formatWait(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60000))
  if (minutes < 60) return `${minutes}m`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}h`
  const days = Math.round(hours / 24)
  if (days < 30) return `${days}d`
  const months = Math.round(days / 30)
  if (months < 12) return `${months}mo`
  return `${Math.round(months / 12)}y`
}

export function isDue(card: DeckCard, now = new Date()): boolean {
  return !card.review || new Date(card.review.due).getTime() <= now.getTime()
}

export function masteryOf(card: DeckCard): Mastery {
  const review = card.review
  if (!review || review.reps === 0) return "new"
  if (review.state === State.Learning || review.state === State.Relearning) return "learning"
  if (review.stability < 7) return "shaky"
  return "solid"
}

/** A review takes at most this many never-studied cards, so it stays short. */
export const NEW_PER_SESSION = 15

/**
 * `due` is how many cards the next review will show: every seen card that is due, plus
 * new cards up to NEW_PER_SESSION. It is the same count as buildSession(deck).length.
 */
export function deckStats(deck: Deck, now = new Date()) {
  const counts: Record<Mastery, number> = { new: 0, learning: 0, shaky: 0, solid: 0 }
  let dueSeen = 0
  let fresh = 0
  for (const card of deck.cards) {
    counts[masteryOf(card)] += 1
    if (!card.review) fresh += 1
    else if (isDue(card, now)) dueSeen += 1
  }
  const due = dueSeen + Math.min(fresh, NEW_PER_SESSION)
  const total = deck.cards.length
  const mastered = total === 0 ? 0 : Math.round((counts.solid / total) * 100)
  return { total, due, counts, mastered }
}

/** Cards to study now: due cards first (oldest due first), new cards capped so a session stays short. */
export function buildSession(deck: Deck, { newLimit = NEW_PER_SESSION, now = new Date() } = {}): DeckCard[] {
  const dueSeen = deck.cards
    .filter((card) => card.review && isDue(card, now))
    .sort((a, b) => new Date(a.review!.due).getTime() - new Date(b.review!.due).getTime())
  const fresh = deck.cards.filter((card) => !card.review).slice(0, newLimit)
  return [...dueSeen, ...fresh]
}

export function shuffle<T>(items: T[]): T[] {
  const copy = [...items]
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[copy[i], copy[j]] = [copy[j], copy[i]]
  }
  return copy
}

export function normalizeDeck(raw: Partial<Deck> & { id: string }): Deck {
  const cards = Array.isArray(raw.cards) && raw.cards.length > 0
    ? raw.cards
    : raw.front && raw.back
      ? [{ id: `${raw.id}-0`, front: raw.front, back: raw.back, review: null }]
      : []
  return {
    ...raw,
    title: raw.title || "Untitled deck",
    tags: raw.tags ?? [],
    cards,
  }
}
