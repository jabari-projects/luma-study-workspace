// Notes that Luma made (or words it heard) wait for the student to check and save them.
// Until then they count as unsaved work in this tab, and a text-only copy is kept in this tab
// (never the picture, the sound or the file).
import { useMemo, useState } from "react"

import { getTabAccountId } from "../api"
import { newCreateKey } from "../work/useAutosave"
import { useExplicitWork } from "../work/useExplicitWork"
import type { DraftKind } from "../work/drafts"
import type { NotesDraft } from "./draft"

/** One Idempotency-Key for the note and one for the deck, so a retry never makes copies. */
export type CaptureKeys = { note: string; deck: string }
export type CaptureData = { draft: NotesDraft | null; words: string; keys: CaptureKeys }

export const freshCaptureKeys = (): CaptureKeys => ({ note: newCreateKey(), deck: newCreateKey() })

function isDraft(value: unknown): value is NotesDraft {
  const v = value as Partial<NotesDraft> | null
  return Boolean(
    v &&
      typeof v.title === "string" &&
      typeof v.summary === "string" &&
      typeof v.notes === "string" &&
      Array.isArray(v.keyTerms) &&
      Array.isArray(v.cards) &&
      v.source &&
      typeof v.source.label === "string",
  )
}

function isCaptureData(value: unknown): value is CaptureData {
  const v = value as Partial<CaptureData> | null
  return Boolean(
    v &&
      typeof v.words === "string" &&
      (v.draft === null || isDraft(v.draft)) &&
      v.keys &&
      typeof v.keys.note === "string" &&
      typeof v.keys.deck === "string",
  )
}

function captureText(data: CaptureData): string {
  const draft = data.draft
  if (!draft) return data.words
  const cards = draft.cards.filter((card) => card.keep).map((card) => `${card.front} - ${card.back}`)
  return [draft.title, draft.summary, draft.notes, ...cards].filter((part) => part.trim()).join("\n\n")
}

/**
 * For Image, Voice and Import to notes. `draft` is the notes on the workbench, `words` the
 * words heard (voice only). `onDiscard` is "Throw it away" from the sign-in-again box.
 */
export function useCaptureWork(kind: Extract<DraftKind, `capture-${string}`>, draft: NotesDraft | null, words: string, onDiscard: () => void) {
  const [accountId] = useState(() => getTabAccountId())
  const [keys, setKeys] = useState<CaptureKeys>(freshCaptureKeys)
  const data = useMemo<CaptureData | null>(() => (draft || words.trim() ? { draft, words, keys } : null), [draft, words, keys])
  const work = useExplicitWork<CaptureData>({
    label: "Your new notes",
    accountId,
    kind,
    data,
    saving: false,
    textOf: captureText,
    accept: isCaptureData,
    onDiscard,
  })
  return {
    keys,
    /** After a save, or "Start over": the next notes get new keys. */
    renewKeys: () => setKeys(freshCaptureKeys()),
    offer: work.offer,
    takeOffer: () => {
      const restored = work.takeOffer()
      if (restored) setKeys(restored.keys)
      return restored
    },
    dropOffer: work.dropOffer,
    draftProblem: work.draftProblem,
  }
}
