import { useCallback, useEffect, useState } from "react"

import { api, getErrorMessage, getTabAccountId } from "../api"
import { toReply, useAutosave } from "../work/useAutosave"
import { normalizeDeck } from "./deck"
import type { Deck, DeckCard } from "./deck"

export function useDecks() {
  const [decks, setDecks] = useState<Deck[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const reload = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const response = await api.get<Deck[]>("/flashcards")
      setDecks(response.data.map(normalizeDeck))
    } catch (err: unknown) {
      setError(getErrorMessage(err, "Could not load your decks."))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void reload()
  }, [reload])

  return { decks, loading, error, reload }
}

/** Load one deck. Pass `null` to skip loading (for example on the "new deck" screen). */
export function useDeck(deckId: string | null | undefined) {
  const [state, setState] = useState<{ id: string | null | undefined; deck: Deck | null; error: string | null }>({
    id: undefined,
    deck: null,
    error: null,
  })

  useEffect(() => {
    if (!deckId) return
    let active = true
    api
      .get<Deck>(`/flashcards/${deckId}`)
      .then((response) => {
        if (active) setState({ id: deckId, deck: normalizeDeck(response.data), error: null })
      })
      .catch((err: unknown) => {
        if (active) setState({ id: deckId, deck: null, error: getErrorMessage(err, "Could not load this deck.") })
      })
    return () => {
      active = false
    }
  }, [deckId])

  const setDeck = useCallback((deck: Deck) => setState({ id: deckId, deck, error: null }), [deckId])

  if (deckId === null) return { deck: null, setDeck, loading: false, error: null }
  if (!deckId) return { deck: null, setDeck, loading: false, error: "We could not find this deck." }
  const ready = state.id === deckId
  return { deck: ready ? state.deck : null, setDeck, loading: !ready, error: ready ? state.error : null }
}

type ProgressReviews = Record<string, DeckCard["review"] | null>

/**
 * Saves each grade right away with PATCH /flashcards/:id/progress, one request at a time.
 * Grades made while one is saving wait and go next, keeping only the newest review per card.
 * Progress never changes the deck's words or version, so studying here never conflicts with
 * the deck editor open in another tab.
 */
export function useProgressSaver(deckId: string) {
  // The account this study session belongs to. A save still waiting after a switch
  // must go out with this account's token, never the new one.
  const [accountId] = useState(() => getTabAccountId())
  const autosave = useAutosave<ProgressReviews, { version?: number; progress_rev?: number }>({
    label: "Your review progress",
    accountId,
    itemId: deckId,
    version: null,
    createKey: null,
    debounceMs: 0,
    autosave: true,
    textOf: () => "",
    merge: (older, newer) => ({ ...older, ...newer }),
    send: (request, config) =>
      toReply(() => api.patch(`/flashcards/${request.itemId}/progress`, { reviews: request.content }, config)),
  })
  const { change } = autosave

  /** Saves one card's new review state. */
  const record = useCallback((card: DeckCard) => change({ [card.id]: card.review ?? null }), [change])

  return { record, snapshot: autosave.snapshot, retry: autosave.retry, accountId }
}
