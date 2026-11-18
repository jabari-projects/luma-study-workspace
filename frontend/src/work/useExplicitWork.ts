// Work that is saved only with its own button (study plan form, notes made by Luma waiting
// for review, a made summary): it counts as unsaved while it exists, so leaving, switching or
// signing out asks first, and a text-only copy is kept in this tab until it is saved or
// thrown away. Nothing here saves by itself: generated content always waits for the student.
import { useEffect, useRef, useState } from "react"

import { getTabAccountId, readBook } from "../api"
import { DRAFT_BLOCKED_MESSAGE, clearDraft, readDraft, sessionDraftStore, writeDraft } from "./drafts"
import type { Draft, DraftKind } from "./drafts"
import { registerWork } from "./unsaved"

const DRAFT_WRITE_DELAY_MS = 500
let explicitCounter = 0

export type ExplicitWorkOptions<T> = {
  label: string
  /** The account the page saves to, captured when it opened. */
  accountId: string | null
  kind: DraftKind
  itemId?: string
  /** The unsaved work (text only), or null when there is nothing unsaved. */
  data: T | null
  /** True while its Save button is working. */
  saving: boolean
  textOf: (data: T) => string
  /** Checks a draft read back from this tab (drop anything that doesn't fit). */
  accept: (value: unknown) => value is T
  /** "Throw it away" from the sign-in-again box. */
  onDiscard: () => void
}

export function useExplicitWork<T>(options: ExplicitWorkOptions<T>) {
  const { accountId, kind, itemId = "new", data, saving } = options
  const optionsRef = useRef(options)
  useEffect(() => {
    optionsRef.current = options
  })
  const [offer, setOffer] = useState<Draft<T> | null>(() => {
    const draft = readDraft<unknown>(sessionDraftStore(), getTabAccountId(), accountId, kind, itemId)
    return draft && options.accept(draft.data) ? (draft as Draft<T>) : null
  })
  const [draftProblem, setDraftProblem] = useState<string | null>(null)
  const registry = useRef<ReturnType<typeof registerWork> | null>(null)
  const latest = useRef<T | null>(data)

  useEffect(() => {
    latest.current = data
  }, [data])

  useEffect(() => {
    const handle = registerWork({
      id: `explicit-${(explicitCounter += 1)}`,
      accountId,
      label: optionsRef.current.label,
      state: "clean",
      getText: () => (latest.current === null ? "" : optionsRef.current.textOf(latest.current)),
      // Leaving can't save this kind of work: it waits for its own button.
      flush: () => Promise.resolve(latest.current === null),
      resume: () => undefined,
      discard: () => optionsRef.current.onDiscard(),
    })
    registry.current = handle
    return () => {
      handle.unregister()
      registry.current = null
      // The page is closing (another page or another account in this tab): keep the newest
      // words in this tab if the account is still on this device. After a sign-out it isn't.
      const value = latest.current
      if (value !== null && accountId && readBook().accounts[accountId]) {
        const { kind: draftKind, itemId: draftItem = "new" } = optionsRef.current
        writeDraft(sessionDraftStore(), { v: 1, accountId, kind: draftKind, itemId: draftItem, baseVersion: null, savedAt: Date.now(), data: value })
      }
    }
  }, [accountId])

  useEffect(() => {
    registry.current?.update(saving ? "saving" : data !== null ? "dirty" : "clean")
  }, [data, saving])

  // A text-only copy in this tab, a moment after each change. Gone when there is nothing unsaved.
  useEffect(() => {
    const store = sessionDraftStore()
    if (!accountId) return
    if (data === null) {
      // Keep a copy that is still offered ("Use them" / "Throw them away") until the student picks.
      if (!offer) clearDraft(store, accountId, kind, itemId)
      return
    }
    const timer = window.setTimeout(() => {
      const result = writeDraft(store, { v: 1, accountId, kind, itemId, baseVersion: null, savedAt: Date.now(), data })
      setDraftProblem(result === "ok" ? null : DRAFT_BLOCKED_MESSAGE)
    }, DRAFT_WRITE_DELAY_MS)
    return () => window.clearTimeout(timer)
  }, [accountId, data, itemId, kind, offer])

  return {
    /** A copy from earlier in this tab, if any (until used or thrown away). */
    offer,
    dropOffer: () => {
      setOffer(null)
      clearDraft(sessionDraftStore(), accountId, kind, itemId)
    },
    takeOffer: () => {
      const value = offer?.data ?? null
      setOffer(null)
      return value
    },
    draftProblem,
  }
}
