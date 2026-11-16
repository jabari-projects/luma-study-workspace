import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import type { CSSProperties, FormEvent, KeyboardEvent as ReactKeyboardEvent } from "react"
import { Link, useNavigate, useParams } from "react-router-dom"
import { AnimatePresence, motion } from "motion/react"
import { useAutoAnimate } from "@formkit/auto-animate/react"
import {
  ArrowLeft,
  ArrowsClockwise,
  Cards,
  ListChecks,
  PencilSimple,
  Play,
  Plus,
  Sparkle,
  Trash,
  UploadSimple,
} from "@phosphor-icons/react"

import { api, getErrorMessage } from "../api"
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

const tilt = (index: number) => [-1.2, 0.8, -0.4, 1.1, -0.9, 0.5][index % 6]

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
  const [listRef] = useAutoAnimate<HTMLDivElement>()
  const totalDue = decks.reduce((sum, deck) => sum + deckStats(deck).due, 0)

  return (
    <>
      <PageHeader
        eyebrow="Study"
        title={
          <>
            <Scribble type="underline">Flashcards</Scribble>
          </>
        }
        description="Practice remembering what you learned."
        actions={
          <Link className="primary-button" to="/flashcards/new">
            <Plus weight="bold" aria-hidden="true" /> New deck
          </Link>
        }
      />
      <p className="hand-note">Challenge your mind to remember.</p>
      <NoticeBanner notice={error ? { type: "error", text: error } : null} />

      {loading ? <LoadingCard text="Finding your decks..." /> : null}

      {!loading && !error && decks.length === 0 ? (
        <section className="empty-state">
          <div className="empty-stack" aria-hidden="true">
            <span />
            <span />
            <span />
          </div>
          <h2>No decks yet</h2>
          <p>Make your first deck. Add a question on the front and the answer on the back.</p>
          <Link className="primary-button" to="/flashcards/new">
            <Plus weight="bold" aria-hidden="true" /> Make a deck
          </Link>
        </section>
      ) : null}

      {!loading && decks.length > 0 ? (
        <>
          <div className="due-ribbon">
            <Sparkle weight="duotone" aria-hidden="true" />
            {totalDue > 0 ? (
              <span>
                <strong>{totalDue}</strong> card{totalDue === 1 ? " is" : "s are"} ready for review.
              </span>
            ) : (
              <span>All caught up. Your cards are glowing!</span>
            )}
          </div>
          <div className="deck-grid" ref={listRef}>
            {decks.map((deck, index) => {
              const stats = deckStats(deck)
              return (
                <article className="deck-card" key={deck.id} style={{ "--tilt": `${tilt(index)}deg` } as CSSProperties}>
                  <Link className="deck-card-main" to={`/flashcards/${deck.id}`}>
                    <span className="deck-count">
                      <Cards weight="duotone" aria-hidden="true" /> {stats.total} card{stats.total === 1 ? "" : "s"}
                    </span>
                    <h2>{deck.title}</h2>
                    {deck.tags.length > 0 ? (
                      <p className="tag-row">
                        {deck.tags.slice(0, 3).map((tag) => (
                          <span key={tag}>#{tag}</span>
                        ))}
                      </p>
                    ) : null}
                    <GlowBar deck={deck} />
                    <span className="deck-meta">
                      {stats.mastered}% Lumen · {deck.is_public ? "Public" : "Private"}
                    </span>
                  </Link>
                  <div className="deck-actions">
                    <Link className={stats.due > 0 ? "primary-button small" : "secondary-button small"} to={`/flashcards/${deck.id}/study`}>
                      <Play weight="fill" aria-hidden="true" /> {stats.due > 0 ? `Study ${stats.due}` : "Practice"}
                    </Link>
                    <Link className="ghost-button small" to={`/quizzes?deck=${deck.id}`}>
                      <ListChecks weight="bold" aria-hidden="true" /> Quiz
                    </Link>
                  </div>
                </article>
              )
            })}
          </div>
        </>
      ) : null}
    </>
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
        <Link className="secondary-button" to="/flashcards">
          Back to decks
        </Link>
      </>
    )
  }

  const stats = deckStats(deck)

  const remove = async () => {
    try {
      await api.delete(`/flashcards/${deck.id}`)
      navigate("/flashcards", { replace: true })
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
          <Link className="ghost-button" to="/flashcards">
            <ArrowLeft weight="bold" aria-hidden="true" /> Decks
          </Link>
        }
      />
      <NoticeBanner notice={notice} />

      <section className="deck-hero">
        <div className="deck-hero-stack" aria-hidden="true">
          <span />
          <span />
          <div className="index-card">
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
              <small>Lumen</small>
            </div>
          </div>
          <GlowBar deck={deck} />
          <GlowLegend />
          <div className="button-row">
            <Link className="primary-button" to={`/flashcards/${deck.id}/study`}>
              <Play weight="fill" aria-hidden="true" /> {stats.due > 0 ? "Study now" : "Practice anyway"}
            </Link>
            <Link className="secondary-button" to={`/quizzes?deck=${deck.id}`}>
              <ListChecks weight="bold" aria-hidden="true" /> Quiz me
            </Link>
            <Link className="ghost-button" to={`/flashcards/${deck.id}/edit`}>
              <PencilSimple weight="bold" aria-hidden="true" /> Edit
            </Link>
          </div>
        </div>
      </section>

      <section className="card-list-section">
        <h2>Cards</h2>
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

export function StudyPage() {
  const { itemId } = useParams()
  const { deck, loading, error } = useDeck(itemId)
  const [run, setRun] = useState<{ key: number; cards: DeckCard[] | null }>({ key: 0, cards: null })

  if (loading) return <LoadingCard text="Shuffling your cards..." />
  if (!deck) {
    return <NoticeBanner notice={{ type: "error", text: error ?? "We could not find this deck." }} />
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

function firstQueue(deck: Deck, practiceAll: boolean): DeckCard[] {
  const session = practiceAll ? [] : buildSession(deck)
  return session.length > 0 ? session : shuffle(deck.cards).slice(0, 20)
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
        recordStudy(reviewCount + 1)
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
        <p className="eyebrow">Session done</p>
        <h1>
          <Scribble type="highlight">Nice work!</Scribble>
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
          <div className="paper-panel">
            <h2>Cards to keep practicing</h2>
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
          </div>
        ) : null}
        <NoticeBanner notice={notice} />
        <div className="button-row center">
          <button type="button" className="secondary-button" onClick={() => onRestart(cards)}>
            <ArrowsClockwise weight="bold" aria-hidden="true" /> Practice more
          </button>
          <Link className="primary-button" to={`/quizzes?deck=${deck.id}`}>
            <ListChecks weight="bold" aria-hidden="true" /> Quiz me next
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
                aria-label={flipped ? `Answer: ${current.back}. Tap to see the question.` : `Question: ${current.front}. Tap to see the answer.`}
              >
                <span className="flip-face front">
                  <GlowChip card={cards.find((card) => card.id === current.id) ?? current} />
                  <span className="face-text">{current.front}</span>
                  <span className="face-hint">Tap to flip</span>
                </span>
                <span className="flip-face back">
                  <span className="face-label">Answer</span>
                  <span className="face-text">{current.back}</span>
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

