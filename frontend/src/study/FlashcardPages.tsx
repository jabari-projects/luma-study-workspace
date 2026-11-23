import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import type { FocusEvent, FormEvent, KeyboardEvent as ReactKeyboardEvent } from "react"
import { Link, useNavigate, useParams } from "react-router-dom"
import { AnimatePresence, motion } from "motion/react"
import { toast } from "sonner"
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
  WarningCircle,
} from "@phosphor-icons/react"

import { api, getErrorMessage, getTabAccountId } from "../api"
import { studyIntroKey } from "../accounts"
import { NoticeBanner, PageHeader } from "../ui/common"
import { ShareAskAfterMaking, ShareControl } from "../ui/Share"
import { forgetShareAsk, markJustMade, shouldAskToShare } from "../ui/shareAsk"
import { sharedLine, useShareName } from "../ui/sharing"
import { SubjectLine } from "../subjects/SubjectLine"
import { SubjectPicker } from "../subjects/SubjectPicker"
import { NO_SUBJECT, choiceFrom, subjectBody, subjectLabel } from "../subjects/subjects"
import type { SubjectChoice } from "../subjects/subjects"
import { useSubjects } from "../subjects/useSubjects"
import type { Notice } from "../ui/common"
import { Scribble } from "../ui/Scribble"
import { ConflictPanel, YourVersionBox } from "../work/ConflictPanel"
import { DraftOffer } from "../work/DraftOffer"
import { SaveStatus } from "../work/SaveStatus"
import { clearDraft, readDraft, sessionDraftStore } from "../work/drafts"
import type { Draft } from "../work/drafts"
import { newCreateKey, toReply, useAutosave } from "../work/useAutosave"
import {
  buildSession,
  cardProblems,
  emptyCardsLabel,
  deckStats,
  gradeCard,
  masteryOf,
  newCardId,
  normalizeDeck,
  previewIntervals,
  problemLabel,
  problemSummary,
  ratingChoices,
  shuffle,
  withoutBlankCards,
} from "./deck"
import type { CardProblem, Deck, DeckCard, Mastery } from "./deck"
import { FieldProblem, ProblemBox } from "./CardProblems"
import { useFocusField } from "./useFocusField"
import { MAKE_CARDS_ADD_ID, MakeCardsPanel } from "./MakeCardsPanel"
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
                    <SubjectLine subject={deck.subject_slug} subtopic={deck.subtopic_slug} />
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

type DeckFields = { title: string; tags: string; subject: SubjectChoice; cards: DraftCard[] }

/** Autosave waits this long after the last change (B.4). */
const DECK_AUTOSAVE_MS = 2000

// A new deck becomes its edit page after the first save, with its words and version.
const justCreatedDecks = new Map<string, { fields: DeckFields; version: number; savedAt: number | null }>()

function deckFieldsFrom(deck: Deck): DeckFields {
  return {
    title: deck.title === "Untitled deck" ? "" : deck.title,
    tags: deck.tags.join(", "),
    subject: choiceFrom(deck.subject_slug, deck.subtopic_slug),
    cards: deck.cards.length > 0 ? deck.cards.map(({ id, front, back }) => ({ id, front, back, review: null })) : [emptyCard()],
  }
}

function isDeckFields(value: unknown): value is DeckFields {
  const v = value as Partial<DeckFields> | null
  return Boolean(
    v &&
      typeof v.title === "string" &&
      typeof v.tags === "string" &&
      Array.isArray(v.cards) &&
      v.cards.every((card) => card && typeof card.id === "string" && typeof card.front === "string" && typeof card.back === "string"),
  )
}

const NO_CARDS = "Add at least one card with a question and an answer."
const NO_TITLE = "Give your deck a title."

/**
 * What stops "Save deck": an empty title and every card with an empty side. Fully empty cards
 * count too (the student can remove them with one tap). A deck with no words on any card shows
 * one line and marks the first card.
 */
function deckCheck(fields: DeckFields): { titleMissing: boolean; noCards: boolean; problems: CardProblem[]; ok: boolean } {
  const titleMissing = !fields.title.trim()
  const all = cardProblems(fields.cards)
  const noCards = withoutBlankCards(fields.cards).length === 0
  const problems = noCards ? all.slice(0, 1) : all
  return { titleMissing, noCards, problems, ok: !titleMissing && problems.length === 0 }
}

/**
 * Why autosave waits (a saved deck), or null. Fully empty cards are skipped, not a reason: the
 * student may have just tapped "Add card".
 */
function deckHoldReason(fields: DeckFields): string | null {
  if (!fields.title.trim()) return NO_TITLE
  const half = fields.cards.findIndex((card) => Boolean(card.front.trim()) !== Boolean(card.back.trim()))
  if (half >= 0) return `Finish card ${half + 1}.`
  if (withoutBlankCards(fields.cards).length === 0) return NO_CARDS
  return null
}

// By card id, not place: a removed row can stay on screen a moment while it fades out.
const cardFieldId = (cardId: string, side: "front" | "back") => `deck-card-${cardId.replace(/[^\w-]/g, "_")}-${side}`
const TITLE_ID = "deck-title"
const SAVE_BUTTON_ID = "deck-save"

/** What the server stores: cards with words only. Review progress is never sent from here. */
function deckBody(fields: DeckFields) {
  return {
    title: fields.title.trim(),
    ...subjectBody(fields.subject),
    tags: fields.tags
      .split(",")
      .map((tag) => tag.trim().replace(/^#/, ""))
      .filter(Boolean),
    cards: fields.cards
      .map((card) => ({ id: card.id, front: card.front.trim(), back: card.back.trim() }))
      .filter((card) => card.front && card.back),
  }
}

const deckText = (fields: DeckFields) =>
  [fields.title.trim(), ...fields.cards.filter((card) => card.front.trim() || card.back.trim()).map((card) => `${card.front} - ${card.back}`)]
    .filter(Boolean)
    .join("\n")

/** Only the words, as a draft in this tab (text only). */
const deckDraftData = (fields: DeckFields) => ({
  title: fields.title,
  tags: fields.tags,
  subject: fields.subject,
  cards: fields.cards.map(({ id, front, back }) => ({ id, front, back })),
})

/** A tab draft's words. Drafts from before subjects have none, and still open (with no subject). */
function fromDraft(value: unknown): DeckFields | null {
  if (!isDeckFields(value)) return null
  const subject = (value as { subject?: Partial<SubjectChoice> | null }).subject
  return {
    title: value.title,
    tags: value.tags,
    subject: choiceFrom(subject?.subject, subject?.subtopic),
    cards: value.cards.map(({ id, front, back }) => ({ id, front, back, review: null })),
  }
}

/**
 * Make a deck (/flashcards/new) or change one (/flashcards/:id/edit). A saved deck saves by
 * itself a moment after each change. A new deck is saved with "Save deck" first.
 */
export function DeckEditorPage() {
  const { itemId } = useParams()
  // This tab's account when the page opened. Saving goes to it, even if the tab switches.
  const [accountId] = useState(() => getTabAccountId())
  if (!itemId) return <NewDeck key="new" accountId={accountId} />
  return <LoadDeck key={itemId} accountId={accountId} itemId={itemId} />
}

function NewDeck({ accountId }: { accountId: string | null }) {
  const [start, setStart] = useState(() => {
    const draft = readDraft(sessionDraftStore(), getTabAccountId(), accountId, "deck", "new")
    const fields = draft ? fromDraft(draft.data) : null
    return { round: 0, draft: draft && fields ? { ...draft, data: fields } : null, createKey: (draft && fields && draft.createKey) || newCreateKey() }
  })
  return (
    <DeckForm
      key={start.round}
      accountId={accountId}
      itemId={null}
      version={null}
      createKey={start.createKey}
      initial={{ title: "", tags: "", subject: NO_SUBJECT, cards: [emptyCard(), emptyCard()] }}
      offer={start.draft}
      onThrowAwayOffer={() => {
        clearDraft(sessionDraftStore(), accountId, "deck", "new")
        setStart((current) => ({ round: current.round + 1, draft: null, createKey: newCreateKey() }))
      }}
    />
  )
}

function LoadDeck({ accountId, itemId }: { accountId: string | null; itemId: string }) {
  const [handoff] = useState(() => justCreatedDecks.get(itemId) ?? null)
  const { deck, loading, error } = useDeck(handoff ? null : itemId)
  useEffect(() => {
    justCreatedDecks.delete(itemId)
  }, [itemId])
  const [draft] = useState(() => {
    const found = handoff ? null : readDraft(sessionDraftStore(), getTabAccountId(), accountId, "deck", itemId)
    const fields = found ? fromDraft(found.data) : null
    return found && fields ? { ...found, data: fields } : null
  })

  if (handoff) {
    return (
      <DeckForm
        accountId={accountId}
        itemId={itemId}
        version={handoff.version}
        savedAt={handoff.savedAt}
        createKey={null}
        initial={handoff.fields}
        offer={null}
      />
    )
  }
  if (loading) return <LoadingCard text="Opening your deck..." />
  if (!deck) {
    return (
      <>
        <PageHeader eyebrow="Edit deck" title="Deck not found" />
        <NoticeBanner notice={{ type: "error", text: error ?? "We could not find this deck." }} />
        <Link className="secondary-button" to={STUDY_HUB}>
          Back to Study
        </Link>
      </>
    )
  }
  return (
    <DeckForm
      accountId={accountId}
      itemId={itemId}
      version={typeof deck.version === "number" ? deck.version : 1}
      createKey={null}
      initial={deckFieldsFrom(deck)}
      currentDeck={deck}
      offer={draft}
    />
  )
}

function DeckForm({
  accountId,
  itemId,
  version,
  createKey,
  initial,
  currentDeck,
  offer,
  onThrowAwayOffer,
  savedAt = null,
}: {
  accountId: string | null
  itemId: string | null
  version: number | null
  savedAt?: number | null
  createKey: string | null
  initial: DeckFields
  currentDeck?: Deck
  offer: Draft<DeckFields> | null
  onThrowAwayOffer?: () => void
}) {
  const isNew = itemId === null
  const navigate = useNavigate()
  const [fields, setFields] = useState<DeckFields>(initial)
  const { title, tags, subject, cards } = fields
  // "Make cards from my notes": opened from the big button above the cards (an empty deck) or
  // from the link under them. Closed: null.
  const [makeAt, setMakeAt] = useState<"top" | "bottom" | null>(null)
  // Kept suggestions in that panel that aren't in the deck yet.
  const [madeWaiting, setMadeWaiting] = useState(0)
  const [showWaiting, setShowWaiting] = useState(false)
  // The red marks show after "Save deck" was pressed, until everything is filled in.
  const [showProblems, setShowProblems] = useState(false)
  // Made a moment ago in this tab: ask "Share with the crowd?" here, right after "Saved at".
  // The mark is forgotten at once, so the deck's page never asks later (ui/shareAsk.ts).
  const [askShare, setAskShare] = useState(() => !isNew && shouldAskToShare(accountId, "flashcards", itemId))
  useEffect(() => forgetShareAsk(accountId, "flashcards", itemId), [accountId, itemId])
  const focusField = useFocusField()
  const [notice, setNotice] = useState<Notice | null>(null)
  const [saving, setSaving] = useState(false)
  const [mine, setMine] = useState<string | null>(null)
  const [pendingOffer, setPendingOffer] = useState<Draft<DeckFields> | null>(() =>
    offer && (offer.baseVersion ?? null) === (version ?? null) ? offer : null,
  )
  const [draftConflict, setDraftConflict] = useState<DeckFields | null>(() =>
    offer && (offer.baseVersion ?? null) !== (version ?? null) ? offer.data : null,
  )
  const [copyBusy, setCopyBusy] = useState(false)
  const copyKey = useRef<string | null>(null)
  const [listRef] = useAutoAnimate<HTMLOListElement>()

  const autosave = useAutosave<DeckFields, Deck>({
    label: "Your deck",
    accountId,
    itemId,
    version,
    createKey,
    savedAt,
    debounceMs: DECK_AUTOSAVE_MS,
    autosave: true,
    textOf: deckText,
    rowHas: (row, sent) => {
      const stored = normalizeDeck(row)
      const sentBody = deckBody(sent)
      return (
        stored.title === sentBody.title &&
        (stored.subject_slug ?? null) === sentBody.subject_slug &&
        (stored.subtopic_slug ?? null) === sentBody.subtopic_slug &&
        JSON.stringify(stored.cards.map(({ id, front, back }) => ({ id, front, back }))) === JSON.stringify(sentBody.cards)
      )
    },
    draft: { kind: "deck", data: deckDraftData },
    hold: (content) => {
      const why = deckHoldReason(content)
      return why ? `Not saved yet. ${why}` : null
    },
    send: (request, config) => {
      if (request.mode === "create") {
        return toReply(() =>
          api.post<Deck>("/flashcards", deckBody(request.content), {
            ...config,
            headers: { ...config.headers, "Idempotency-Key": request.createKey ?? newCreateKey() },
          }),
        )
      }
      return toReply(() =>
        api.put<Deck>(`/flashcards/${request.itemId}`, { ...deckBody(request.content), expected_version: request.expectedVersion }, config),
      )
    },
  })
  const { snapshot } = autosave
  const showConflict = snapshot.state === "conflict" || snapshot.state === "gone" || draftConflict !== null
  const conflictDeck = snapshot.state === "conflict" ? snapshot.current : draftConflict ? (currentDeck ?? null) : null

  const check = deckCheck(fields)
  const shown = showProblems && !check.ok ? check : null
  const problemFor = new Map((shown?.problems ?? []).map((problem) => [problem.id, problem]))
  const blankCount = shown && !shown.noCards ? shown.problems.filter((problem) => problem.blank).length : 0
  // One wording everywhere: the box, the sticky bar and (on phones) "Fix 2".
  const problemLines = shown
    ? [shown.noCards ? NO_CARDS : shown.problems.length > 0 ? problemSummary(shown.problems) : null, shown.titleMissing ? NO_TITLE : null].filter(
        (line): line is string => line !== null,
      )
    : []
  const fixCount = shown ? (shown.titleMissing ? 1 : 0) + (shown.noCards ? 1 : shown.problems.length) : 0
  const deckEmpty = withoutBlankCards(cards).length === 0
  const waitingLine = `You have ${madeWaiting} suggested card${madeWaiting === 1 ? "" : "s"}. Tap Add ${madeWaiting} card${madeWaiting === 1 ? "" : "s"} first.`

  const update = (next: DeckFields) => {
    if (showProblems && deckCheck(next).ok) setShowProblems(false)
    setFields(next)
    autosave.change(next)
  }
  const updateCard = (id: string, side: "front" | "back", value: string) =>
    update({ ...fields, cards: cards.map((card) => (card.id === id ? { ...card, [side]: value } : card)) })

  const goToProblem = (problem: CardProblem) => focusField(cardFieldId(problem.id, problem.front ? "front" : "back"))

  /** Shows the red marks and moves to the first thing to fill in. True when the deck can be saved. */
  const checkBeforeSave = (): boolean => {
    if (check.ok) return true
    setShowProblems(true)
    if (check.titleMissing) focusField(TITLE_ID)
    else goToProblem(check.problems[0])
    return false
  }

  const removeEmptyCards = () => {
    const kept = withoutBlankCards(cards)
    const removed = cards.length - kept.length
    const next = { ...fields, cards: kept.length > 0 ? kept : [emptyCard()] }
    update(next)
    toast.success(removed === 1 ? "Removed 1 empty card." : `Removed ${removed} empty cards.`)
    const left = deckCheck(next)
    if (left.titleMissing) focusField(TITLE_ID)
    else if (left.problems[0]) goToProblem(left.problems[0])
    else focusField(SAVE_BUTTON_ID)
  }

  const closeMake = () => {
    setMakeAt(null)
    setMadeWaiting(0)
    setShowWaiting(false)
  }

  const addMadeCards = (made: { front: string; back: string }[], aiTitle: string | null) => {
    const kept = withoutBlankCards(cards)
    const added = made.map((card): DraftCard => ({ id: newCardId(), front: card.front, back: card.back, review: null }))
    update({ ...fields, title: fields.title.trim() || !aiTitle ? fields.title : aiTitle.slice(0, 200), cards: [...kept, ...added] })
    closeMake()
    toast.success(added.length === 1 ? "Added 1 card." : `Added ${added.length} cards.`)
    if (added[0]) focusField(cardFieldId(added[0].id, "front"))
  }

  // Leaving the form (not just moving between its fields) saves right away.
  const onBlur = (event: FocusEvent<HTMLFormElement>) => {
    if (isNew) return
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) void autosave.flush()
  }

  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setNotice(null)
    // Suggested cards still waiting in "Make cards from my notes": say so, instead of pointing
    // at an empty card (the student would think the suggestions were lost).
    if (madeWaiting > 0) {
      setShowWaiting(true)
      focusField(MAKE_CARDS_ADD_ID)
      return
    }
    // Nothing is sent until every card is filled in (the box above the cards says which).
    if (!checkBeforeSave()) return
    setSaving(true)
    if (isNew) autosave.change(fields)
    const saved = await autosave.flush({ allowCreate: true })
    setSaving(false)
    if (!saved) return // The save line says why, and the cards stay here.
    if ((getTabAccountId() ?? null) !== accountId) return
    if (isNew) {
      const now = autosave.peek()
      if (!now?.itemId || now.version === null) return
      markJustMade(accountId, "flashcards", now.itemId)
      justCreatedDecks.set(now.itemId, { fields, version: now.version, savedAt: now.savedAt })
      navigate(`/flashcards/${now.itemId}/edit`, { replace: true })
      return
    }
    navigate(`/flashcards/${itemId}`, { replace: true })
  }

  const saveMineAsNew = async () => {
    const words = draftConflict ?? fields
    const why = deckHoldReason(words)
    if (why) {
      setNotice({ type: "error", text: `We can't save a copy yet. ${why}` })
      return
    }
    setCopyBusy(true)
    copyKey.current = copyKey.current ?? newCreateKey()
    const key = copyKey.current
    const reply = await toReply(() =>
      api.post<Deck>("/flashcards", deckBody(words), { lumaAccountId: accountId ?? undefined, headers: { "Idempotency-Key": key } }),
    )
    setCopyBusy(false)
    if (reply.kind !== "ok" || !reply.row || typeof reply.row.version !== "number") {
      setNotice({ type: "error", text: "We couldn't save a copy. Your cards are still here. Try again." })
      return
    }
    autosave.discard()
    if (draftConflict) clearDraft(sessionDraftStore(), accountId, "deck", itemId ?? "new")
    toast.success("Saved yours as a new deck.")
    const created = normalizeDeck(reply.row)
    justCreatedDecks.set(created.id, { fields: deckFieldsFrom(created), version: reply.row.version, savedAt: Date.now() })
    navigate(`/flashcards/${created.id}/edit`, { replace: true })
  }

  const seeNewer = () => {
    const row = conflictDeck
    if (!row) return
    setMine(deckText(draftConflict ?? fields))
    setFields(deckFieldsFrom(normalizeDeck(row)))
    if (draftConflict) {
      clearDraft(sessionDraftStore(), accountId, "deck", itemId ?? "new")
      setDraftConflict(null)
    } else {
      autosave.takeTheirs(row)
    }
  }

  const keepMine = () => {
    if (draftConflict) {
      update(draftConflict)
      setDraftConflict(null)
      return
    }
    const current = snapshot.current
    if (current && typeof current.version === "number") autosave.keepMine(current.version)
  }

  return (
    <>
      <PageHeader
        eyebrow={isNew ? "New deck" : "Edit deck"}
        title={
          <>
            {isNew ? "Make a " : "Edit your "}
            <Scribble type="underline">deck</Scribble>
          </>
        }
        description={isNew ? "Question on the front. Answer on the back." : "Luma saves your changes as you go."}
        actions={
          <Link className="ghost-button" to={isNew ? "/flashcards" : `/flashcards/${itemId}`}>
            <ArrowLeft weight="bold" aria-hidden="true" /> Back
          </Link>
        }
      />
      <NoticeBanner notice={notice} />
      {showConflict ? (
        <ConflictPanel
          noun="deck"
          gone={snapshot.state === "gone"}
          busy={copyBusy}
          onSeeNewer={seeNewer}
          onKeepMine={keepMine}
          onSaveAsNew={() => void saveMineAsNew()}
          onThrowAway={() => {
            autosave.discard()
            navigate(STUDY_HUB, { replace: true })
          }}
        />
      ) : null}
      {mine !== null ? <YourVersionBox text={mine} onClose={() => setMine(null)} /> : null}
      {pendingOffer ? (
        <DraftOffer
          onUse={() => {
            update(pendingOffer.data)
            setPendingOffer(null)
          }}
          onThrowAway={() => {
            setPendingOffer(null)
            if (onThrowAwayOffer) onThrowAwayOffer()
            else clearDraft(sessionDraftStore(), accountId, "deck", itemId ?? "new")
          }}
        />
      ) : null}
      {askShare && itemId ? (
        <ShareAskAfterMaking<Deck>
          endpoint="/flashcards"
          studyType="flashcards"
          noun="deck"
          latest={async () => {
            if (!(await autosave.flush())) return null
            const now = autosave.peek()
            return now?.itemId && typeof now.version === "number" ? { id: now.itemId, title: fields.title, version: now.version, is_public: false } : null
          }}
          onShared={(row) => autosave.adopt(row)}
          setNotice={setNotice}
          onClose={() => setAskShare(false)}
          returnFocus={() => document.getElementById(SAVE_BUTTON_ID)}
        />
      ) : null}
      <form className="deck-editor" onSubmit={save} onBlur={onBlur}>
        <section className="editor-head">
          <div className="editor-field">
            <label>
              Title
              <input
                id={TITLE_ID}
                value={title}
                onChange={(event) => update({ ...fields, title: event.target.value })}
                placeholder="Title"
                maxLength={200}
                aria-invalid={shown?.titleMissing || undefined}
                aria-describedby={shown?.titleMissing ? `${TITLE_ID}-problem` : undefined}
              />
            </label>
            {shown?.titleMissing ? <FieldProblem id={`${TITLE_ID}-problem`} /> : null}
          </div>
          <SubjectPicker value={subject} onChange={(next) => update({ ...fields, subject: next })} />
          <label>
            Tags
            <input value={tags} onChange={(event) => update({ ...fields, tags: event.target.value })} placeholder="Add tags (optional)" />
          </label>
        </section>

        {deckEmpty || makeAt === "top" ? (
          <div className="make-cards-start">
            <button
              type="button"
              className="secondary-button"
              onClick={() => (makeAt === "top" ? closeMake() : setMakeAt("top"))}
              aria-expanded={makeAt === "top"}
              aria-controls={makeAt === "top" ? "make-cards" : undefined}
            >
              <Sparkle weight="fill" aria-hidden="true" /> Make cards from my notes
            </button>
            <p className="field-hint">Paste notes and Luma suggests cards. Or type your own cards below.</p>
          </div>
        ) : null}
        {makeAt === "top" ? (
          <MakeCardsPanel
            accountId={accountId}
            deckCards={withoutBlankCards(cards)}
            onAdd={addMadeCards}
            onClose={closeMake}
            onWaiting={(count) => {
              setMadeWaiting(count)
              if (count === 0) setShowWaiting(false)
            }}
          />
        ) : null}

        {shown ? (
          <ProblemBox
            lines={problemLines}
            jumps={[
              ...(shown.titleMissing ? [{ key: "title", label: "Title", onJump: () => focusField(TITLE_ID) }] : []),
              ...shown.problems.map((problem) => ({ key: problem.id, label: problemLabel(problem), onJump: () => goToProblem(problem) })),
            ]}
            removeLabel={blankCount > 0 ? emptyCardsLabel("Remove", blankCount) : null}
            onRemove={removeEmptyCards}
          />
        ) : null}

        <ol className="card-editor-list" ref={listRef}>
          {cards.map((card, index) => {
            const problem = problemFor.get(card.id)
            const frontId = cardFieldId(card.id, "front")
            const backId = cardFieldId(card.id, "back")
            return (
              <li className={problem ? "card-editor-row has-problem" : "card-editor-row"} key={card.id}>
                <span className="card-number" aria-hidden="true">
                  {index + 1}
                </span>
                <div className="card-side">
                  <label>
                    <span className="sr-only">Question {index + 1}</span>
                    <textarea
                      id={frontId}
                      value={card.front}
                      onChange={(event) => updateCard(card.id, "front", event.target.value)}
                      placeholder="Question"
                      rows={2}
                      aria-invalid={problem?.front || undefined}
                      aria-describedby={problem?.front ? `${frontId}-problem` : undefined}
                    />
                  </label>
                  {problem?.front ? <FieldProblem id={`${frontId}-problem`} /> : null}
                </div>
                <div className="card-side">
                  <label>
                    <span className="sr-only">Answer {index + 1}</span>
                    <textarea
                      id={backId}
                      value={card.back}
                      onChange={(event) => updateCard(card.id, "back", event.target.value)}
                      placeholder="Answer"
                      rows={2}
                      aria-invalid={problem?.back || undefined}
                      aria-describedby={problem?.back ? `${backId}-problem` : undefined}
                    />
                  </label>
                  {problem?.back ? <FieldProblem id={`${backId}-problem`} /> : null}
                </div>
                <button
                  type="button"
                  className="icon-button"
                  aria-label={`Remove card ${index + 1}`}
                  onClick={() => update({ ...fields, cards: cards.length > 1 ? cards.filter((c) => c.id !== card.id) : [emptyCard()] })}
                >
                  <Trash aria-hidden="true" />
                </button>
              </li>
            )
          })}
        </ol>

        <div className="editor-tools">
          <button type="button" className="secondary-button" onClick={() => setFields({ ...fields, cards: [...cards, emptyCard()] })}>
            <Plus weight="bold" aria-hidden="true" /> Add card
          </button>
          {deckEmpty || makeAt === "top" ? null : (
            <button
              type="button"
              className="ghost-button"
              onClick={() => (makeAt === "bottom" ? closeMake() : setMakeAt("bottom"))}
              aria-expanded={makeAt === "bottom"}
              aria-controls={makeAt === "bottom" ? "make-cards" : undefined}
            >
              <Sparkle weight="fill" aria-hidden="true" /> Make cards from my notes
            </button>
          )}
        </div>

        {makeAt === "bottom" ? (
          <MakeCardsPanel
            accountId={accountId}
            deckCards={withoutBlankCards(cards)}
            onAdd={addMadeCards}
            onClose={closeMake}
            onWaiting={(count) => {
              setMadeWaiting(count)
              if (count === 0) setShowWaiting(false)
            }}
          />
        ) : null}

        {showWaiting && madeWaiting > 0 ? (
          <ProblemBox
            lines={[waitingLine]}
            jumps={[{ key: "add", label: `Go to Add ${madeWaiting} card${madeWaiting === 1 ? "" : "s"}`, onJump: () => focusField(MAKE_CARDS_ADD_ID) }]}
            removeLabel="Skip them"
            onRemove={closeMake}
          />
        ) : null}

        {/* On a phone the bar steps aside while "Make cards from my notes" is open (it has its own Add button). */}
        <div className={`sticky-save${shown ? " has-problem" : ""}${makeAt ? " is-making" : ""}`}>
          {shown ? (
            <span className="sticky-problem">
              <WarningCircle weight="fill" aria-hidden="true" />
              <span className="sticky-long">{problemLines.join(" ")}</span>
              <span className="sticky-short" aria-hidden="true">
                Fix {fixCount}
              </span>
            </span>
          ) : madeWaiting > 0 ? (
            <span>
              {madeWaiting} suggested card{madeWaiting === 1 ? "" : "s"} not added yet
            </span>
          ) : (
            <span>{cards.filter((card) => card.front.trim() && card.back.trim()).length} cards ready</span>
          )}
          <SaveStatus snapshot={snapshot} onRetry={autosave.retry} accountId={accountId} draftProblem={autosave.draftProblem} />
          <button
            type="submit"
            id={SAVE_BUTTON_ID}
            className="primary-button"
            disabled={saving || showConflict || (isNew && Boolean(autosave.editBlocked))}
          >
            {saving ? "Saving..." : "Save deck"}
          </button>
        </div>
        {autosave.editBlocked ? <p className="field-hint">{autosave.editBlocked}</p> : null}
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
  const shareName = useShareName()
  const { list: subjectList } = useSubjects()
  const [accountId] = useState(() => getTabAccountId())
  // Made in this tab a moment ago: ask "Share with the crowd?" once (ui/shareAsk.ts).
  const [askShare] = useState(() => shouldAskToShare(accountId, "flashcards", itemId))
  useEffect(() => forgetShareAsk(accountId, "flashcards", itemId), [accountId, itemId])

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
      // Delete it in the account that showed this deck, even if the tab switches meanwhile.
      await api.delete(`/flashcards/${deck.id}`, { lumaAccountId: getTabAccountId() ?? undefined })
      navigate(STUDY_HUB, { replace: true })
    } catch (err: unknown) {
      setNotice({ type: "error", text: getErrorMessage(err, "Could not delete this deck.") })
    }
  }

  return (
    <>
      <PageHeader
        eyebrow={`Flashcards · ${deck.is_public ? "Shared" : "Private"}`}
        title={deck.title}
        description={[subjectLabel(subjectList, deck.subject_slug, deck.subtopic_slug), deck.is_public ? sharedLine(shareName) : "Your deck"]
          .filter(Boolean)
          .join(" · ")}
        actions={
          <>
            <ShareControl
              endpoint="/flashcards"
              studyType="flashcards"
              noun="deck"
              item={deck}
              onUpdated={(updated) => setDeck(normalizeDeck(updated))}
              setNotice={setNotice}
              askNow={askShare}
            />
            <Link className="ghost-button" to={STUDY_HUB}>
              <ArrowLeft weight="bold" aria-hidden="true" /> Back to Study
            </Link>
          </>
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
  const progressSaver = useProgressSaver(deck.id)
  const saveProgress = progressSaver.record
  // Show the save line only when a grade could not be saved (offline, failed, signed out...).
  const progressProblem = !["clean", "saved", "saving", "dirty"].includes(progressSaver.snapshot.state)

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
      saveProgress(updated)
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
        celebrate()
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
        {progressProblem ? (
          <SaveStatus snapshot={progressSaver.snapshot} onRetry={progressSaver.retry} accountId={progressSaver.accountId} />
        ) : null}
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
      {progressProblem ? (
          <SaveStatus snapshot={progressSaver.snapshot} onRetry={progressSaver.retry} accountId={progressSaver.accountId} />
        ) : null}

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

