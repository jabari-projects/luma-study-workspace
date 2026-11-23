// The notes answer from Luma's server, turned into a draft the student can change
// on the Notes workbench. No window or React here, so `node --test` can run it.

/** Where text notes come from (the kinds /api/notes-from-text accepts). */
export type SourceKind = "audio" | "paste" | "file" | "link" | "youtube"

/** Where a draft came from: any text source, or a picture (Image to notes). */
export type DraftSourceKind = SourceKind | "image"

import type { SubjectChoice } from "../subjects/subjects"

export type DraftCard = { id: string; front: string; back: string; keep: boolean }

export type NotesDraft = {
  title: string
  summary: string
  notes: string
  keyTerms: string[]
  cards: DraftCard[]
  truncated: boolean
  source: { kind: DraftSourceKind; label: string }
  /** The subject the student picked for the note and its deck. Older tab drafts have none. */
  subject?: SubjectChoice
}

/** The notes shape both /api/notes-from-text and /api/generate-notes answer with. */
export type NotesResponse = {
  title: string
  summary: string
  notes: string
  key_terms: string[]
  flashcards: { front: string; back: string }[]
  truncated: boolean
}

export const DEFAULT_DRAFT_TITLE = "My notes"

let cardCounter = 0
export const nextDraftCardId = () => `draft-${Date.now().toString(36)}-${(cardCounter += 1)}`

const text = (value: unknown) => (typeof value === "string" ? value : "")

/**
 * A draft from the server's answer. Anything missing or the wrong type becomes empty,
 * so an older server that only sends `{ notes }` still gives a draft (with no cards).
 */
export function toNotesDraft(data: unknown, source: NotesDraft["source"], truncated = false): NotesDraft {
  const raw = (data && typeof data === "object" ? data : {}) as Partial<Record<keyof NotesResponse, unknown>>
  const cards = Array.isArray(raw.flashcards) ? raw.flashcards : []
  const terms = Array.isArray(raw.key_terms) ? raw.key_terms : []
  return {
    title: text(raw.title).trim() || DEFAULT_DRAFT_TITLE,
    summary: text(raw.summary),
    notes: text(raw.notes),
    keyTerms: terms.filter((term): term is string => typeof term === "string" && term.trim() !== ""),
    cards: cards
      .map((card) => (card && typeof card === "object" ? (card as Record<string, unknown>) : {}))
      .filter((card) => text(card.front).trim() && text(card.back).trim())
      .map((card) => ({ id: nextDraftCardId(), front: text(card.front), back: text(card.back), keep: true })),
    truncated: raw.truncated === true || truncated,
    source,
  }
}

/** True when the draft has words to save as a note. */
export function draftHasWords(draft: NotesDraft): boolean {
  return Boolean(draft.notes.trim() || draft.summary.trim())
}
