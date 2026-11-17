import { useCallback, useEffect, useRef, useState } from "react"

import { api, getErrorMessage, getTabAccountId } from "../api"
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

/**
 * Saves review progress one request at a time so a slow save never overwrites a newer one.
 */
export function useProgressSaver(deckId: string | undefined, onError: (message: string) => void) {
  const chain = useRef<Promise<unknown>>(Promise.resolve())
  const latest = useRef<DeckCard[] | null>(null)
  // The account this study session belongs to. A save still waiting after a switch
  // must go out with this account's token, never the new one.
  const [accountId] = useState(() => getTabAccountId())

  const save = useCallback(
    (cards: DeckCard[]) => {
      if (!deckId) return chain.current
      latest.current = cards
      chain.current = chain.current.then(async () => {
        const snapshot = latest.current
        if (!snapshot) return
        latest.current = null
        try {
          await api.put(`/flashcards/${deckId}`, { cards: snapshot }, accountId ? { lumaAccountId: accountId } : undefined)
        } catch (err: unknown) {
          onError(getErrorMessage(err, "Your progress could not be saved. Check your connection."))
        }
      })
      return chain.current
    },
    [accountId, deckId, onError],
  )

  return save
}
