import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import type { FormEvent, KeyboardEvent as ReactKeyboardEvent } from "react"
import { Link, useNavigate, useParams } from "react-router-dom"
import { AnimatePresence, motion } from "motion/react"
import { useAutoAnimate } from "@formkit/auto-animate/react"
import {
  ArrowLeft,
  ArrowRight,
  ArrowsClockwise,
  CalendarBlank,
  Cards,
  Check,
  ListChecks,
  PencilSimple,
  Play,
  Plus,
  Sparkle,
  Trash,
  UploadSimple,
} from "@phosphor-icons/react"

import { api, getErrorMessage, getTabAccountId } from "../api"
import { studyIntroKey } from "../accounts"
import { NoticeBanner, PageHeader, PublishActionButton } from "../ui/common"
import type { Notice } from "../ui/common"
import { Scribble } from "../ui/Scribble"
import {
  buildSession,
  deckStats,
  gradeCard,
  masteryOf,
  newCardId,
  normalizeDeck,
  previewIntervals,
  ratingChoices,
  shuffle,
} from "./deck"
import type { Deck, DeckCard, Mastery } from "./deck"
import { GlowBar, GlowChip, GlowLegend } from "./glow"
import { celebrate, recordStudy } from "./celebrate"
import { useDeck, useDecks, useProgressSaver } from "./useDecks"
import {
  PRACTICE_NOTE,
  REVIEW_STEPS,
  STUDY_HUB,
  STUDY_PLANS,
  deckCountLine,
  introLine,
  pickDecks,
  practiceLine,
  quizHref,
  readyLine,
} from "./hub"

function LoadingCard({ text }: { text: string }) {
  return (
    <div className="loading-card" role="status">
      <span className="spinner" />
      <p>{text}</p>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Deck shelf                                                         */
/* ------------------------------------------------------------------ */

export function DecksPage() {
  const { decks, loading, error } = useDecks()
  const navigate = useNavigate()
  const [listRef] = useAutoAnimate<HTMLUListElement>()
  const [picked, setPicked] = useState<string[] | null>(null)

  const ranked = decks.map((deck) => ({ deck, stats: deckStats(deck) }))
  // The deck with the most cards ready. Ties keep the shelf order (newest first).
  const top = ranked.reduce<(typeof ranked)[number] | null>(
    (best, entry) => (!best || entry.stats.due > best.stats.due ? entry : best),
    null,
  )
  const totalDue = ranked.reduce((sum, entry) => sum + entry.stats.due, 0)
  const usable = decks.filter((deck) => deck.cards.length > 0)
  const usableIds = usable.map((deck) => deck.id)
  const selected = (picked ?? pickDecks([], usableIds)).filter((id) => usableIds.includes(id))
  const pickedCards = usable.filter((deck) => selected.includes(deck.id)).reduce((sum, deck) => sum + deck.cards.length, 0)

  return (
    <div className="study-hub">
      <header className="page-head">
        <div>
          <h1>
            <Scribble type="underline">Study</Scribble>
          </h1>
          <p className="lede">Review your cards or quiz yourself.</p>
          <p className="hand-note">Challenge your mind to remember.</p>
        </div>
        <div className="page-head-actions">
          <Link className="secondary-button" to="/flashcards/new">
            <Plus weight="bold" aria-hidden="true" /> New deck
          </Link>
        </div>
      </header>
      <NoticeBanner notice={error ? { type: "error", text: error } : null} />

      {loading ? <LoadingCard text="Finding your decks..." /> : null}

      {!loading && !error && decks.length === 0 ? (
        <section className="empty-state">
          <div className="empty-stack" aria-hidden="true">
            <span />
            <span />
            <span />
          </div>
          <h2>Make a deck first</h2>
          <p>Your quizzes use your cards. Put a question on the front and the answer on the back.</p>
          <Link className="primary-button" to="/flashcards/new">
            <Plus weight="bold" aria-hidden="true" /> Make a deck
          </Link>
        </section>
      ) : null}

      {!loading && decks.length > 0 ? (
        <>
          <section className="ready-strip" aria-label="Cards to review">
            <span className="ready-icon" aria-hidden="true">
              <Sparkle weight="fill" />
            </span>
            {top && totalDue > 0 ? (
              <>
                <div className="ready-copy">
                  <p className="ready-line">{readyLine(totalDue, totalDue > top.stats.due)}</p>
                  {totalDue > top.stats.due ? (
                    <p className="ready-start" id="ready-start">
                      Starts with {top.deck.title} ({top.stats.due}).
                    </p>
                  ) : null}
                  <p className="ready-help">Flip each card. Tell Luma how well you knew it. Luma picks when you see it again.</p>
                </div>
                <Link
                  className="primary-button"
                  to={`/flashcards/${top.deck.id}/study`}
                  aria-describedby={totalDue > top.stats.due ? "ready-start" : undefined}
                >
                  <Play weight="fill" aria-hidden="true" /> Review cards
                </Link>
              </>
            ) : (
              <>
                <div className="ready-copy">
                  <p className="ready-line">Nothing to review right now.</p>
                  <p className="ready-help">Luma will show your cards again when it's time.</p>
                </div>
                {usable.length > 0 ? (
                  <Link className="secondary-button" to={quizHref(usableIds)}>
                    <ListChecks weight="bold" aria-hidden="true" /> Quiz yourself
                  </Link>
                ) : null}
              </>
            )}
          </section>

          <section className="deck-shelf" aria-labelledby="deck-shelf-title">
            <div className="section-head">
              <h2 id="deck-shelf-title">Your decks</h2>
            </div>
            <ul className="deck-grid" ref={listRef}>
              {ranked.map(({ deck, stats }) => (
                <li className="index-card deck deck-tile" key={deck.id}>
                  <div className="deck-tile-main">
                    <h3>
                      <Link className="deck-link" to={`/flashcards/${deck.id}`}>
                        {deck.title}
                      </Link>
                    </h3>
                    <p className="deck-count">
                      <Cards weight="duotone" aria-hidden="true" /> {deckCountLine(stats.total, stats.due)}
                    </p>
                    {deck.tags.length > 0 ? (
                      <p className="tag-row">
                        {deck.tags.slice(0, 3).map((tag) => (
                          <span key={tag}>#{tag}</span>
                        ))}
                      </p>
                    ) : null}
                    <GlowBar deck={deck} />
                    <p className="deck-known">
                      <span>{stats.mastered}% known</span>
                      {deck.is_public ? <span className="shared-pill">Shared</span> : null}
                    </p>
                  </div>
                  <div className="deck-tile-actions">
                    {stats.total > 0 ? (
                      <>
                        <Link className="secondary-button small" to={`/flashcards/${deck.id}/study`}>
                          <Play weight="fill" aria-hidden="true" /> {stats.due > 0 ? `Review ${stats.due}` : "Practice"}
                        </Link>
                        <Link className="ghost-button small" to={quizHref([deck.id])}>
                          <ListChecks weight="bold" aria-hidden="true" /> Quiz yourself
                        </Link>
                      </>
                    ) : (
                      <Link className="secondary-button small" to={`/flashcards/${deck.id}/edit`}>
                        <Plus weight="bold" aria-hidden="true" /> Add cards
                      </Link>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          </section>

          <section className="quiz-pick" aria-labelledby="quiz-pick-title">
            <div className="section-head">
              <h2 id="quiz-pick-title">Quiz yourself</h2>
            </div>
            <p className="section-lede">Luma makes quiz questions from your flashcards. Pick one deck or more.</p>
            {usable.length === 0 ? (
              <p className="muted">Add cards to a deck first. Your quizzes use your cards.</p>
            ) : (
              <>
                <div className="choice-chips" role="group" aria-label="Decks for your quiz">
                  {usable.map((deck) => {
                    const on = selected.includes(deck.id)
                    return (
                      <button
                        key={deck.id}
                        type="button"
                        className="chip"
                        aria-pressed={on}
                        onClick={() => setPicked(on ? selected.filter((id) => id !== deck.id) : [...selected, deck.id])}
                      >
                        {on ? <Check weight="bold" aria-hidden="true" /> : null}
                        {deck.title}
                        <small>{deck.cards.length}</small>
                      </button>
                    )
                  })}
                </div>
                <div className="quiz-pick-go">
                  <button
                    type="button"
                    className={totalDue > 0 ? "secondary-button" : "primary-button"}
                    disabled={selected.length === 0}
                    aria-describedby="quiz-pick-status"
                    onClick={() => navigate(quizHref(selected))}
                  >
                    <Play weight="fill" aria-hidden="true" /> Start quiz
                  </button>
                  <p id="quiz-pick-status" className="quiz-pick-status" aria-live="polite">
                    {selected.length === 0
                      ? "Pick at least one deck."
                      : `${pickedCards} card${pickedCards === 1 ? "" : "s"} from ${selected.length} deck${selected.length === 1 ? "" : "s"}.`}
                  </p>
                </div>
                <p className="small-print">A quiz doesn't change when your cards come back.</p>
              </>
            )}
          </section>
        </>
      ) : null}

      <p className="page-footer-link">
        <Link to={STUDY_PLANS}>
          <CalendarBlank weight="duotone" aria-hidden="true" /> Study plans
          <ArrowRight weight="bold" aria-hidden="true" />
        </Link>
      </p>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Deck editor                                                        */
/* ------------------------------------------------------------------ */

type DraftCard = DeckCard

function emptyCard(): DraftCard {
  return { id: newCardId(), front: "", back: "", review: null }
}

function parsePastedCards(text: string): DraftCard[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line): DraftCard | null => {
      const match = line.split(/\s*(?:\t|::| - | — |: )\s*/)
      if (match.length < 2) return null
      const [front, ...rest] = match
      const back = rest.join(" ").trim()
      return front && back ? { id: newCardId(), front, back, review: null } : null
    })
    .filter((card): card is DraftCard => card !== null)
}

export function DeckEditorPage() {
  const { itemId } = useParams()
  const isNew = !itemId
  const navigate = useNavigate()
  const { deck, loading, error } = useDeck(isNew ? null : itemId)
  const [title, setTitle] = useState("")
  const [tags, setTags] = useState("")
  const [cards, setCards] = useState<DraftCard[]>(() => [emptyCard(), emptyCard()])
  const [pasteOpen, setPasteOpen] = useState(false)
  const [pasteText, setPasteText] = useState("")
  const [notice, setNotice] = useState<Notice | null>(null)
  const [saving, setSaving] = useState(false)
  const [listRef] = useAutoAnimate<HTMLOListElement>()

  useEffect(() => {
    if (!isNew && deck) {
      setTitle(deck.title === "Untitled deck" ? "" : deck.title)
      setTags(deck.tags.join(", "))
      setCards(deck.cards.length > 0 ? deck.cards : [emptyCard()])
    }
  }, [deck, isNew])

  const updateCard = (id: string, side: "front" | "back", value: string) => {
    setCards((current) => current.map((card) => (card.id === id ? { ...card, [side]: value } : card)))
  }

  const addPasted = () => {
    const parsed = parsePastedCards(pasteText)
    if (parsed.length === 0) {
      setNotice({ type: "error", text: "Put one card on each line, like: Question - Answer" })
      return
    }
    setCards((current) => [...current.filter((card) => card.front.trim() || card.back.trim()), ...parsed])
    setPasteText("")
    setPasteOpen(false)
    setNotice({ type: "success", text: `Added ${parsed.length} card${parsed.length === 1 ? "" : "s"}.` })
  }

  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setNotice(null)
    const ready = cards
      .map((card) => ({ ...card, front: card.front.trim(), back: card.back.trim() }))
      .filter((card) => card.front && card.back)
    const half = cards.filter((card) => Boolean(card.front.trim()) !== Boolean(card.back.trim()))

    if (!title.trim()) {
      setNotice({ type: "error", text: "Give your deck a title." })
      return
    }
    if (half.length > 0) {
      setNotice({ type: "error", text: "Some cards are missing a question or an answer." })
      return
    }
    if (ready.length === 0) {
      setNotice({ type: "error", text: "Add at least one card with a question and an answer." })
      return
    }

    const payload = {
      title: title.trim(),
      tags: tags
        .split(",")
        .map((tag) => tag.trim().replace(/^#/, ""))
        .filter(Boolean),
      cards: ready,
    }

    setSaving(true)
    try {
      const response = isNew
        ? await api.post<Deck>("/flashcards", payload)
        : await api.put<Deck>(`/flashcards/${itemId}`, payload)
      navigate(`/flashcards/${response.data.id}`, { replace: true })
    } catch (err: unknown) {
      setNotice({ type: "error", text: getErrorMessage(err, "Could not save this deck.") })
    } finally {
      setSaving(false)
    }
  }

  if (!isNew && loading) return <LoadingCard text="Opening your deck..." />

  return (
    <>
      <PageHeader
        eyebrow={isNew ? "New deck" : "Edit deck"}
        title={isNew ? "Make a deck" : "Edit your deck"}
        description="Question on the front. Answer on the back."
        actions={
          <Link className="ghost-button" to={isNew ? "/flashcards" : `/flashcards/${itemId}`}>
            <ArrowLeft weight="bold" aria-hidden="true" /> Back
          </Link>
        }
      />
      <NoticeBanner notice={!isNew && error ? { type: "error", text: error } : notice} />
      <form className="deck-editor" onSubmit={save}>
        <section className="paper-panel editor-head">
          <label>
            Title
            <input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Title" maxLength={200} />
          </label>
          <label>
            Tags
            <input value={tags} onChange={(event) => setTags(event.target.value)} placeholder="Add tags (optional)" />
          </label>
        </section>

        <ol className="card-editor-list" ref={listRef}>
          {cards.map((card, index) => (
            <li className="card-editor-row" key={card.id}>
              <span className="card-number" aria-hidden="true">
                {index + 1}
              </span>
              <label>
                <span className="sr-only">Question {index + 1}</span>
                <textarea
                  value={card.front}
                  onChange={(event) => updateCard(card.id, "front", event.target.value)}
                  placeholder="Question"
                  rows={2}
                />
              </label>
              <label>
                <span className="sr-only">Answer {index + 1}</span>
                <textarea
                  value={card.back}
                  onChange={(event) => updateCard(card.id, "back", event.target.value)}
                  placeholder="Answer"
                  rows={2}
                />
              </label>
              <button
                type="button"
                className="icon-button"
                aria-label={`Remove card ${index + 1}`}
                onClick={() => setCards((current) => (current.length > 1 ? current.filter((c) => c.id !== card.id) : [emptyCard()]))}
              >
                <Trash aria-hidden="true" />
              </button>
            </li>
          ))}
        </ol>

        <div className="editor-tools">
          <button type="button" className="secondary-button" onClick={() => setCards((current) => [...current, emptyCard()])}>
            <Plus weight="bold" aria-hidden="true" /> Add card
          </button>
          <button type="button" className="ghost-button" onClick={() => setPasteOpen((open) => !open)} aria-expanded={pasteOpen}>
            <UploadSimple weight="bold" aria-hidden="true" /> Paste a list
          </button>
        </div>

        {pasteOpen ? (
          <section className="paper-panel paste-panel">
            <label>
              One card per line, like <code>Question - Answer</code>
              <textarea
                value={pasteText}
                onChange={(event) => setPasteText(event.target.value)}
                rows={6}
                placeholder={"Capital of France - Paris\n2 x 8 - 16"}
              />
            </label>
            <button type="button" className="secondary-button" onClick={addPasted}>
              Add these cards
            </button>
          </section>
        ) : null}

        <div className="sticky-save">
          <span>{cards.filter((card) => card.front.trim() && card.back.trim()).length} cards ready</span>
          <button type="submit" className="primary-button" disabled={saving}>
            {saving ? "Saving..." : "Save deck"}
          </button>
        </div>
      </form>
    </>
  )
}

/* ------------------------------------------------------------------ */
/* Saved deck view                                                    */
/* ------------------------------------------------------------------ */

export function DeckPage() {
  const { itemId } = useParams()
  const navigate = useNavigate()
  const { deck, setDeck, loading, error } = useDeck(itemId)
  const [notice, setNotice] = useState<Notice | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)

  if (loading) return <LoadingCard text="Opening your deck..." />
  if (!deck) {
    return (
      <>
        <PageHeader title="Deck not found" />
        <NoticeBanner notice={{ type: "error", text: error ?? "We could not find this deck." }} />
        <Link className="secondary-button" to={STUDY_HUB}>
          Back to Study
        </Link>
      </>
    )
  }

  const stats = deckStats(deck)

  const remove = async () => {
    try {
      await api.delete(`/flashcards/${deck.id}`)
      navigate(STUDY_HUB, { replace: true })
    } catch (err: unknown) {
      setNotice({ type: "error", text: getErrorMessage(err, "Could not delete this deck.") })
    }
  }

  return (
    <>
      <PageHeader
        eyebrow={`Flashcards · ${deck.is_public ? "Public" : "Private"}`}
        title={deck.title}
        description={deck.published_by && deck.is_public ? `Shared by ${deck.published_by}` : "Your deck"}
        actions={
          <Link className="ghost-button" to={STUDY_HUB}>
            <ArrowLeft weight="bold" aria-hidden="true" /> Back to Study
          </Link>
        }
      />
      <NoticeBanner notice={notice} />

      <section className="deck-hero">
        <div className="deck-hero-stack" aria-hidden="true">
          <span />
          <span />
          <div className="deck-hero-card">
            <p>{deck.cards[0]?.front ?? "Add a card"}</p>
          </div>
        </div>
        <div className="deck-hero-info">
          <div className="stat-row">
            <div>
              <strong>{stats.total}</strong>
              <small>cards</small>
            </div>
            <div>
              <strong>{stats.due}</strong>
              <small>ready now</small>
            </div>
            <div>
              <strong>{stats.mastered}%</strong>
              <small>known</small>
            </div>
          </div>
          <GlowBar deck={deck} />
          <GlowLegend />
          <div className="button-row">
            {stats.total > 0 ? (
              <Link
                className="primary-button"
                to={`/flashcards/${deck.id}/study`}
                aria-describedby={stats.due > 0 ? undefined : "deck-practice-note"}
              >
                <Play weight="fill" aria-hidden="true" />{" "}
                {stats.due > 0 ? `Review ${stats.due} card${stats.due === 1 ? "" : "s"}` : "Practice anyway"}
              </Link>
            ) : null}
            {stats.total > 0 ? (
              <Link className="secondary-button" to={quizHref([deck.id])} aria-describedby="deck-quiz-note">
                <ListChecks weight="bold" aria-hidden="true" /> Quiz yourself
              </Link>
            ) : null}
            <Link className="ghost-button" to={`/flashcards/${deck.id}/edit`}>
              <PencilSimple weight="bold" aria-hidden="true" /> Edit
            </Link>
          </div>
          {stats.total > 0 ? (
            <div className="deck-notes">
              {stats.due === 0 ? <p id="deck-practice-note">{PRACTICE_NOTE}</p> : null}
              <p id="deck-quiz-note">
                Questions come from the {stats.total} card{stats.total === 1 ? "" : "s"} in this deck.
              </p>
            </div>
          ) : null}
        </div>
      </section>

      <section className="card-list-section" aria-labelledby="deck-cards-title">
        <div className="section-head">
          <h2 id="deck-cards-title">Cards</h2>
        </div>
        <ul className="card-list">
          {deck.cards.map((card) => (
            <li key={card.id}>
              <div>
                <p className="card-q">{card.front}</p>
                <p className="card-a">{card.back}</p>
              </div>
              <GlowChip card={card} />
            </li>
          ))}
        </ul>
      </section>

      <section className="quiet-zone">
        {confirmDelete ? (
          <div className="button-row">
            <span>Delete this deck for good?</span>
            <button type="button" className="danger-button small" onClick={() => void remove()}>
              Yes, delete
            </button>
            <button type="button" className="ghost-button small" onClick={() => setConfirmDelete(false)}>
              Keep it
            </button>
          </div>
        ) : (
          <button type="button" className="ghost-button small danger-text" onClick={() => setConfirmDelete(true)}>
            <Trash aria-hidden="true" /> Delete deck
          </button>
        )}
      </section>

      <PublishActionButton
        endpoint="/flashcards"
        studyType="flashcards"
        item={deck}
        onUpdated={(updated) => setDeck(normalizeDeck(updated))}
        setNotice={setNotice}
      />
    </>
  )
}

/* ------------------------------------------------------------------ */
/* Study session                                                      */
/* ------------------------------------------------------------------ */

type SessionResult = { card: DeckCard; before: Mastery; after: Mastery; missed: boolean }

/** True when this account chose "Don't show this again" on the review intro. */
function introHidden(accountId: string | null): boolean {
  if (!accountId) return false
  try {
    return window.localStorage.getItem(studyIntroKey(accountId)) === "1"
  } catch {
    return false
  }
}

function hideIntro(accountId: string | null) {
  if (!accountId) return
  try {
    window.localStorage.setItem(studyIntroKey(accountId), "1")
  } catch {
    // Storage is blocked: the intro shows again next time, which is fine.
  }
}

export function StudyPage() {
  const { itemId } = useParams()
  const { deck, loading, error } = useDeck(itemId)
  const [run, setRun] = useState<{ key: number; cards: DeckCard[] | null }>({ key: 0, cards: null })
  const [started, setStarted] = useState(() => introHidden(getTabAccountId()))

  if (loading) return <LoadingCard text="Shuffling your cards..." />
  if (!deck) {
    return <NoticeBanner notice={{ type: "error", text: error ?? "We could not find this deck." }} />
  }

  if (!started) {
    return (
      <StudyIntro
        deck={deck}
        onStart={(remember) => {
          if (remember) hideIntro(getTabAccountId())
          setStarted(true)
        }}
      />
    )
  }

  const source = run.cards ? { ...deck, cards: run.cards } : deck
  return (
    <StudySession
      key={run.key}
      deck={source}
      practiceAll={run.cards !== null}
      onRestart={(cards) => setRun((previous) => ({ key: previous.key + 1, cards }))}
    />
  )
}

/** Before the first card: what this review has, about how long, and how it works. */
function StudyIntro({ deck, onStart }: { deck: Deck; onStart: (remember: boolean) => void }) {
  const [remember, setRemember] = useState(false)
  const headingRef = useRef<HTMLHeadingElement>(null)
  const session = buildSession(deck)
  const due = session.filter((card) => card.review).length
  const fresh = session.length - due
  const practice = session.length === 0
  const practiceCount = Math.min(PRACTICE_LIMIT, deck.cards.length)

  // Focus the heading so a screen reader reads the count, the time and the steps in order.
  useEffect(() => {
    headingRef.current?.focus()
  }, [])

  return (
    <section className="study-intro" aria-labelledby="study-intro-title">
      <div className="study-intro-card">
        <p className="kicker">{deck.title}</p>
        <h1 id="study-intro-title" ref={headingRef} tabIndex={-1}>
          {practice ? "Ready to practice" : "Ready to review"}
        </h1>
        <p className="intro-count">{practice ? practiceLine(practiceCount) : introLine(due, fresh)}</p>
        {practice ? <p>{PRACTICE_NOTE}</p> : null}
        <p>{REVIEW_STEPS}</p>
        <label className="check-row">
          <input type="checkbox" checked={remember} onChange={(event) => setRemember(event.target.checked)} />
          Don't show this again
        </label>
        <div className="button-row">
          <button type="button" className="primary-button" onClick={() => onStart(remember)}>
            <Play weight="fill" aria-hidden="true" /> Start
          </button>
          <Link className="ghost-button" to={`/flashcards/${deck.id}`}>
            Back to deck
          </Link>
        </div>
      </div>
    </section>
  )
}

/** A practice round when nothing is due takes up to this many cards. */
const PRACTICE_LIMIT = 20

function firstQueue(deck: Deck, practiceAll: boolean): DeckCard[] {
  const session = practiceAll ? [] : buildSession(deck)
  return session.length > 0 ? session : shuffle(deck.cards).slice(0, PRACTICE_LIMIT)
}

function StudySession({
  deck,
  practiceAll,
  onRestart,
}: {
  deck: Deck
  practiceAll: boolean
  onRestart: (cards: DeckCard[]) => void
}) {
  const [notice, setNotice] = useState<Notice | null>(null)
  const onSaveError = useCallback((message: string) => setNotice({ type: "error", text: message }), [])
  const saveProgress = useProgressSaver(deck.id, onSaveError)

  const [queue, setQueue] = useState<DeckCard[]>(() => firstQueue(deck, practiceAll))
  const [cards, setCards] = useState<DeckCard[]>(deck.cards)
  const [flipped, setFlipped] = useState(false)
  const [showMore, setShowMore] = useState(false)
  const [results, setResults] = useState<Map<string, SessionResult>>(new Map())
  const [reviewCount, setReviewCount] = useState(0)
  const [finished, setFinished] = useState(false)
  const [nextDueAt, setNextDueAt] = useState<number | null>(null)
  const stageRef = useRef<HTMLDivElement>(null)

  const current = queue[0]
  const intervals = useMemo(() => (current ? previewIntervals(current) : {}), [current])

  const grade = useCallback(
    (gradeValue: (typeof ratingChoices)[number]["grade"]) => {
      if (!current) return
      const before = masteryOf(results.get(current.id)?.card ?? current)
      const updated = gradeCard(current, gradeValue)
      const missed = gradeValue === ratingChoices[0].grade

      const nextCards = cards.map((card) => (card.id === updated.id ? updated : card))
      setCards(nextCards)
      void saveProgress(nextCards)
      setReviewCount((count) => count + 1)

      setResults((prev) => {
        const next = new Map(prev)
        const first = prev.get(current.id)
        next.set(current.id, {
          card: updated,
          before: first?.before ?? before,
          after: masteryOf(updated),
          missed: (first?.missed ?? false) || missed,
        })
        return next
      })

      const rest = queue.slice(1)
      // Missed cards come back a few cards later in the same session.
      const nextQueue = missed ? [...rest.slice(0, 3), updated, ...rest.slice(3)] : rest
      setQueue(nextQueue)
      setFlipped(false)
      setShowMore(false)

      if (nextQueue.length === 0) {
        const now = Date.now()
        const upcoming = nextCards
          .filter((card) => card.review)
          .map((card) => new Date(card.review!.due).getTime())
          .filter((time) => time > now)
          .sort((a, b) => a - b)[0]
        setNextDueAt(upcoming ?? null)
        setFinished(true)
        recordStudy(getTabAccountId(), reviewCount + 1)
        const accent = getComputedStyle(document.documentElement).getPropertyValue("--accent").trim()
        celebrate(accent || undefined)
      }
    },
    [cards, current, queue, results, reviewCount, saveProgress],
  )

  useEffect(() => {
    stageRef.current?.focus()
  }, [current?.id])

  const onKey = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (finished || !current) return
    if (event.key === " " || event.key === "Enter") {
      event.preventDefault()
      setFlipped((value) => !value)
      return
    }
    if (flipped) {
      const choice = ratingChoices.find((option) => option.key === event.key)
      if (choice) {
        event.preventDefault()
        grade(choice.grade)
      }
    }
  }

  const total = results.size + (queue.filter((card) => !results.has(card.id)).length)
  const done = Array.from(results.values()).length
  const progress = total === 0 ? 0 : Math.round((done / total) * 100)

  if (finished) {
    const list = Array.from(results.values())
    const brighter = list.filter((result) => rank(result.after) > rank(result.before)).length
    const missed = list.filter((result) => result.missed)
    const nextDue = nextDueAt

    return (
      <section className="session-recap">
        <p className="eyebrow">Nice work!</p>
        <h1>
          <Scribble type="highlight">Review done</Scribble>
        </h1>
        <div className="stat-row big">
          <div>
            <strong>{list.length}</strong>
            <small>cards studied</small>
          </div>
          <div>
            <strong>{brighter}</strong>
            <small>got brighter</small>
          </div>
          <div>
            <strong>{missed.length}</strong>
            <small>to practice</small>
          </div>
        </div>
        {nextDue ? (
          <p className="hand-note">Next review: {new Date(nextDue).toLocaleString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" })}</p>
        ) : null}
        {missed.length > 0 ? (
          <section className="recap-list" aria-labelledby="recap-missed-title">
            <div className="section-head">
              <h2 id="recap-missed-title">Cards to keep practicing</h2>
            </div>
            <ul className="card-list compact">
              {missed.map((result) => (
                <li key={result.card.id}>
                  <div>
                    <p className="card-q">{result.card.front}</p>
                    <p className="card-a">{result.card.back}</p>
                  </div>
                  <GlowChip card={result.card} />
                </li>
              ))}
            </ul>
          </section>
        ) : null}
        <NoticeBanner notice={notice} />
        <div className="button-row center">
          <button type="button" className="secondary-button" onClick={() => onRestart(cards)}>
            <ArrowsClockwise weight="bold" aria-hidden="true" /> Practice more
          </button>
          <Link className="primary-button" to={quizHref([deck.id])}>
            <ListChecks weight="bold" aria-hidden="true" /> Quiz yourself
          </Link>
          <Link className="ghost-button" to={`/flashcards/${deck.id}`}>
            Back to deck
          </Link>
        </div>
      </section>
    )
  }

  return (
    <section className="study-room">
      <h1 className="sr-only">Studying {deck.title || "your deck"}</h1>
      <header className="study-top">
        <Link className="icon-button" to={`/flashcards/${deck.id}`} aria-label="Stop studying">
          <ArrowLeft weight="bold" aria-hidden="true" />
        </Link>
        <div className="progress-track" role="progressbar" aria-label="Cards done" aria-valuenow={progress} aria-valuemin={0} aria-valuemax={100}>
          <span style={{ width: `${progress}%` }} />
        </div>
        <span className="study-count">{queue.length} left</span>
      </header>
      <NoticeBanner notice={notice} />

      <div className="study-stage" ref={stageRef} tabIndex={0} onKeyDown={onKey} aria-label="Flashcard. Press space to flip.">
        <AnimatePresence mode="popLayout" initial={false}>
          {current ? (
            <motion.div
              key={`${current.id}-${reviewCount}`}
              className="flip-wrap"
              initial={{ opacity: 0, y: 40, rotate: 3 }}
              animate={{ opacity: 1, y: 0, rotate: 0 }}
              exit={{ opacity: 0, x: -120, rotate: -8 }}
              transition={{ type: "spring", stiffness: 260, damping: 24 }}
            >
              <div
                role="button"
                aria-pressed={flipped}
                className={flipped ? "flip-card flipped" : "flip-card"}
                onClick={() => setFlipped((value) => !value)}
              >
                {/* Named by the face that shows (WCAG 2.5.3), so voice users can say what they see. */}
                <span className="flip-face front" aria-hidden={flipped}>
                  <GlowChip card={cards.find((card) => card.id === current.id) ?? current} />
                  <span className="sr-only">Question: </span>
                  <span className="face-text">{current.front}</span>
                  <span className="face-hint">Tap to flip</span>
                </span>
                <span className="flip-face back" aria-hidden={!flipped}>
                  <span className="face-label">Answer</span>
                  <span className="sr-only">: </span>
                  <span className="face-text">{current.back}</span>
                  <span className="sr-only">. Tap to see the question.</span>
                </span>
              </div>
            </motion.div>
          ) : null}
        </AnimatePresence>
      </div>

      <div className="grade-dock">
        {flipped ? (
          <>
            <div className="grade-main">
              <button type="button" className="grade-button again" onClick={() => grade(ratingChoices[0].grade)}>
                <strong>{ratingChoices[0].label}</strong>
                <small>{intervals[ratingChoices[0].grade]}</small>
              </button>
              <button type="button" className="grade-button good" onClick={() => grade(ratingChoices[2].grade)}>
                <strong>{ratingChoices[2].label}</strong>
                <small>{intervals[ratingChoices[2].grade]}</small>
              </button>
            </div>
            {showMore ? (
              <div className="grade-extra">
                <button type="button" className="grade-button hard" onClick={() => grade(ratingChoices[1].grade)}>
                  <strong>{ratingChoices[1].label}</strong>
                  <small>{intervals[ratingChoices[1].grade]}</small>
                </button>
                <button type="button" className="grade-button easy" onClick={() => grade(ratingChoices[3].grade)}>
                  <strong>{ratingChoices[3].label}</strong>
                  <small>{intervals[ratingChoices[3].grade]}</small>
                </button>
              </div>
            ) : (
              <button type="button" className="link-button" onClick={() => setShowMore(true)}>
                More choices
              </button>
            )}
            <p className="key-hint">Keys: 1 Forgot · 2 Tough · 3 Got it · 4 Easy</p>
          </>
        ) : (
          <>
            <button type="button" className="primary-button wide" onClick={() => setFlipped(true)}>
              Show answer
            </button>
            <p className="key-hint">Press space to flip</p>
          </>
        )}
      </div>
    </section>
  )
}

function rank(level: Mastery): number {
  return { new: 0, learning: 1, shaky: 2, solid: 3 }[level]
}

