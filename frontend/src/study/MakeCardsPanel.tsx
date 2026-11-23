// "Make cards from my notes" in the deck editor: paste notes or pick a note, then Luma suggests
// cards (AI, 1 free AI turn) or finds the cards already written as a list (free, in the browser).
// The student keeps, changes or tosses each one before it goes in the deck. Nothing here is saved
// anywhere: the pasted words and the suggestions live only on this page.
import { useEffect, useMemo, useRef, useState } from "react"
import { MagicWand, MagnifyingGlass, Sparkle, X } from "@phosphor-icons/react"

import { api, getErrorMessage } from "../api"
import { CaptureError, makeNotes } from "../capture/capture-api"
import { MAX_TEXT_CHARS } from "../capture/extract"
import { aiCardsToFound, findCardsInNote, newCardsOnly } from "../notes/findCards"
import type { FoundCard } from "../notes/findCards"
import { NoticeBanner } from "../ui/common"
import type { Notice } from "../ui/common"
import { registerWork } from "../work/unsaved"
import { ProblemBox } from "./CardProblems"
import { CardReviewList } from "./CardReviewList"
import { MAX_CARDS_PER_DECK, emptyCardsLabel, keptCardProblems, problemLabel, problemSummary, reviewFieldId } from "./deck"
import { useFocusField } from "./useFocusField"
import type { CardProblem } from "./deck"

type Words = { front: string; back: string }
type NoteRow = { id: string; title?: string | null; content?: string | null; updated_at?: string | null; created_at?: string | null }

/** The AI needs at least this many characters (the server says the same). */
const MIN_AI_CHARS = 20
/** With this many card-like lines, the text is a list: the free button goes first. */
const LIST_LINES = 3
const ID_PREFIX = "make"
let panelCounter = 0

const MAKE_CARDS_MESSAGES = {
  limit: "You used today's free AI turns. You can still find cards for free or add them yourself.",
  tooShort: "Add a few more sentences first.",
  busy: "Luma is still working on your last request. Try again in a moment.",
  down: "We couldn't make cards right now. Try again.",
  noneFree: "We couldn't find cards in that. Try Make cards with AI.",
  noneNew: "No new cards this time. The cards Luma found are already in your deck.",
  tooMany: `A deck can have up to ${MAX_CARDS_PER_DECK} cards. Keep fewer cards.`,
} as const

function aiProblem(error: unknown): Notice {
  if (error instanceof CaptureError) {
    if (error.limitReached) return { type: "info", text: MAKE_CARDS_MESSAGES.limit }
    if (error.status === 400) return { type: "error", text: MAKE_CARDS_MESSAGES.tooShort }
    if (error.status === 429) return { type: "error", text: MAKE_CARDS_MESSAGES.busy }
    // Signed out, maintenance and the like explain themselves; server trouble gets plain words.
    if (error.status !== undefined && error.status < 500 && error.status !== 404) {
      return { type: "error", text: getErrorMessage(error, MAKE_CARDS_MESSAGES.down) }
    }
  }
  return { type: "error", text: MAKE_CARDS_MESSAGES.down }
}

function shortDate(value?: string | null): string {
  if (!value) return ""
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleDateString(undefined, { month: "short", day: "numeric" })
}

export function MakeCardsPanel({
  accountId,
  deckCards,
  onAdd,
  onClose,
}: {
  accountId: string | null
  /** Cards already in the deck with words (suggestions that repeat them are left out). */
  deckCards: Words[]
  /** The kept cards, and the AI's title for the deck (if the AI was used). */
  onAdd: (cards: Words[], aiTitle: string | null) => void
  onClose: () => void
}) {
  const [mode, setMode] = useState<"paste" | "pick">("paste")
  const [text, setText] = useState("")
  const [picked, setPicked] = useState<NoteRow | null>(null)
  const [notes, setNotes] = useState<{ state: "idle" | "loading" | "ready" | "error"; list: NoteRow[] }>({ state: "idle", list: [] })
  const [query, setQuery] = useState("")
  const [suggestions, setSuggestions] = useState<FoundCard[]>([])
  const [editing, setEditing] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<Notice | null>(null)
  const [aiTitle, setAiTitle] = useState<string | null>(null)
  const [showProblems, setShowProblems] = useState(false)
  const focusField = useFocusField()
  const mounted = useRef(true)

  const source = mode === "paste" ? text : (picked?.content ?? "")
  const label = mode === "pick" && picked ? (picked.title?.trim() || "My note") : "Pasted notes"
  const looksLikeList = useMemo(() => findCardsInNote(source, { lists: true }).length >= LIST_LINES, [source])

  const kept = suggestions.filter((card) => card.keep)
  const problems = keptCardProblems(suggestions)
  const shownProblems = showProblems && problems.length > 0 ? problems : null
  const blankKept = problems.filter((problem) => problem.blank)

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  // Cards waiting here count as unsaved work: leaving the page asks first. Nothing is kept in the tab.
  const latest = useRef(suggestions)
  useEffect(() => {
    latest.current = suggestions
  }, [suggestions])
  const registry = useRef<ReturnType<typeof registerWork> | null>(null)
  useEffect(() => {
    const handle = registerWork({
      id: `make-cards-${(panelCounter += 1)}`,
      accountId,
      label: "Cards you haven't added yet",
      state: "clean",
      getText: () => latest.current.map((card) => `${card.front} - ${card.back}`).join("\n"),
      flush: () => Promise.resolve(latest.current.length === 0),
      resume: () => undefined,
      discard: () => setSuggestions([]),
    })
    registry.current = handle
    return () => {
      handle.unregister()
      registry.current = null
    }
  }, [accountId])
  useEffect(() => {
    registry.current?.update(suggestions.length > 0 ? "dirty" : "clean")
  }, [suggestions])

  // "Pick a note" loads the student's notes once (again only after "Try again").
  const loadNotes = () => {
    setNotes({ state: "loading", list: [] })
    api
      .get<NoteRow[]>("/notes")
      .then((response) => mounted.current && setNotes({ state: "ready", list: Array.isArray(response.data) ? response.data : [] }))
      .catch(() => mounted.current && setNotes({ state: "error", list: [] }))
  }
  const openPick = () => {
    setMode("pick")
    if (notes.state === "idle") loadNotes()
  }

  const shownNotes = notes.list
    .filter((note) => (note.content ?? "").trim())
    .filter((note) => !query.trim() || (note.title ?? "").toLowerCase().includes(query.trim().toLowerCase()))

  const changeSuggestions = (next: FoundCard[]) => {
    if (showProblems && keptCardProblems(next).length === 0) setShowProblems(false)
    setSuggestions(next)
  }

  const addSuggestions = (fresh: FoundCard[]) => {
    setSuggestions((current) => [...current, ...newCardsOnly(fresh, current)])
  }

  const findFree = () => {
    setMessage(null)
    const fresh = newCardsOnly(findCardsInNote(source, { lists: true }), [...deckCards, ...suggestions])
    if (fresh.length === 0) {
      setMessage({ type: "info", text: MAKE_CARDS_MESSAGES.noneFree })
      return
    }
    addSuggestions(fresh)
  }

  const askAi = async () => {
    if (busy) return
    setMessage(null)
    if (source.trim().length < MIN_AI_CHARS) {
      setMessage({ type: "error", text: MAKE_CARDS_MESSAGES.tooShort })
      return
    }
    setBusy(true)
    try {
      const draft = await makeNotes(source, "paste", label)
      if (!mounted.current) return
      const fresh = aiCardsToFound(draft.cards, [...deckCards, ...suggestions])
      if (fresh.length === 0) {
        setMessage({ type: "info", text: MAKE_CARDS_MESSAGES.noneNew })
      } else {
        addSuggestions(fresh)
        if (draft.title.trim()) setAiTitle(draft.title.trim())
      }
    } catch (error: unknown) {
      if (mounted.current) setMessage(aiProblem(error))
    } finally {
      if (mounted.current) setBusy(false)
    }
  }

  const goToProblem = (problem: CardProblem) => {
    setEditing(problem.id)
    focusField(reviewFieldId(ID_PREFIX, problem.index, problem.front ? "front" : "back"))
  }

  const tossBlank = () => {
    const blankIds = new Set(blankKept.map((problem) => problem.id))
    changeSuggestions(suggestions.map((card) => (blankIds.has(card.id) ? { ...card, keep: false } : card)))
  }

  const addKept = () => {
    setMessage(null)
    if (problems.length > 0) {
      setShowProblems(true)
      goToProblem(problems[0])
      return
    }
    if (deckCards.length + kept.length > MAX_CARDS_PER_DECK) {
      setMessage({ type: "error", text: MAKE_CARDS_MESSAGES.tooMany })
      return
    }
    const cards = kept.map((card) => ({ front: card.front.trim(), back: card.back.trim() }))
    setSuggestions([])
    onAdd(cards, aiTitle)
  }

  const aiButton = (
    <div className="make-cards-choice">
      <button type="button" className={looksLikeList ? "secondary-button" : "primary-button"} onClick={() => void askAi()} disabled={busy}>
        <MagicWand weight="bold" aria-hidden="true" /> {busy ? "Making cards..." : "Make cards with AI"}
      </button>
      <p className="small-print">Uses 1 of your free AI turns today.</p>
    </div>
  )
  const freeButton = (
    <div className="make-cards-choice">
      <button type="button" className={looksLikeList ? "primary-button" : "secondary-button"} onClick={findFree} disabled={busy}>
        <MagnifyingGlass weight="bold" aria-hidden="true" /> Find cards for free
      </button>
      <p className="small-print">Works on lines like Question - Answer.</p>
    </div>
  )

  return (
    <section className="make-cards ruled-block" id="make-cards" aria-labelledby="make-cards-title">
      <div className="make-cards-head">
        <h2 id="make-cards-title">
          <Sparkle weight="fill" aria-hidden="true" /> Make cards from my notes
        </h2>
        <button type="button" className="icon-button" aria-label="Close Make cards from my notes" onClick={onClose}>
          <X weight="bold" aria-hidden="true" />
        </button>
      </div>
      <p className="field-hint">Paste your notes or pick a note. Luma suggests cards. You choose which ones to add.</p>

      <div className="choice-chips" role="group" aria-label="Where your words come from">
        <button type="button" className="chip" aria-pressed={mode === "paste"} onClick={() => setMode("paste")}>
          Paste notes
        </button>
        <button type="button" className="chip" aria-pressed={mode === "pick"} onClick={openPick}>
          Pick a note
        </button>
      </div>

      {mode === "paste" ? (
        <label>
          Your notes
          <textarea
            value={text}
            onChange={(event) => setText(event.target.value)}
            rows={8}
            maxLength={MAX_TEXT_CHARS}
            placeholder="Paste class notes, a list of terms, or Question - Answer lines"
          />
        </label>
      ) : picked ? (
        <div className="make-cards-picked">
          <p className="make-cards-picked-title">
            From your note: <strong>{picked.title?.trim() || "My note"}</strong>{" "}
            <button type="button" className="link-button" onClick={() => setPicked(null)}>
              Pick another
            </button>
          </p>
          <p className="make-cards-preview">{(picked.content ?? "").slice(0, 600)}</p>
        </div>
      ) : (
        <div className="make-cards-pick">
          <label>
            Find a note
            <input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Note title" />
          </label>
          {notes.state === "loading" ? (
            <p className="muted" role="status">
              Finding your notes...
            </p>
          ) : null}
          {notes.state === "error" ? (
            <p className="make-cards-pick-error">
              We couldn't load your notes.{" "}
              <button type="button" className="link-button" onClick={loadNotes}>
                Try again
              </button>
            </p>
          ) : null}
          {notes.state === "ready" && shownNotes.length === 0 ? (
            <p className="muted">{notes.list.length === 0 ? "You don't have notes yet. Paste your notes instead." : "No notes match that."}</p>
          ) : null}
          {notes.state === "ready" && shownNotes.length > 0 ? (
            <ul className="make-cards-notes" aria-label="Your notes">
              {shownNotes.map((note) => (
                <li key={note.id}>
                  <button type="button" className="make-cards-note" onClick={() => setPicked(note)}>
                    <span>{note.title?.trim() || "Untitled"}</span>
                    <small>{shortDate(note.updated_at ?? note.created_at)}</small>
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      )}

      {source.trim() ? (
        <>
          {looksLikeList ? <p className="field-hint">This looks like a list of cards. You can add them for free.</p> : null}
          <div className="make-cards-actions">
            {looksLikeList ? (
              <>
                {freeButton}
                {aiButton}
              </>
            ) : (
              <>
                {aiButton}
                {freeButton}
              </>
            )}
          </div>
        </>
      ) : null}

      <NoticeBanner notice={message} />

      {suggestions.length > 0 ? (
        <div className="make-cards-review card-tray">
          <div className="tray-head">
            <h3>Cards Luma suggests</h3>
            <p className="tray-count" aria-live="polite">
              Keeping {kept.length} of {suggestions.length}
            </p>
          </div>
          <p className="muted small-text">Keep the good ones. Toss the rest. Tap a card to change it. AI cards can be wrong, so check them.</p>
          {shownProblems ? (
            <ProblemBox
              lines={[problemSummary(shownProblems)]}
              jumps={shownProblems.map((problem) => ({ key: problem.id, label: problemLabel(problem), onJump: () => goToProblem(problem) }))}
              removeLabel={blankKept.length > 0 ? emptyCardsLabel("Toss", blankKept.length) : null}
              onRemove={tossBlank}
            />
          ) : null}
          <CardReviewList cards={suggestions} onChange={changeSuggestions} editing={editing} onEditing={setEditing} idPrefix={ID_PREFIX} problems={shownProblems} />
          <div className="button-row">
            <button type="button" className="primary-button" onClick={addKept} disabled={kept.length === 0}>
              Add {kept.length} card{kept.length === 1 ? "" : "s"}
            </button>
          </div>
        </div>
      ) : null}
    </section>
  )
}
