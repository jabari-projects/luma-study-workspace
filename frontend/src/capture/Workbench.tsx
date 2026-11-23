import { useEffect, useRef, useState } from "react"
import { Link, useNavigate } from "react-router-dom"
import { toast } from "sonner"
import { ArrowCounterClockwise, Cards, FloppyDisk, MoonStars, Sparkle, X } from "@phosphor-icons/react"

import { getErrorMessage, getTabAccountId } from "../api"
import { ProblemBox } from "../study/CardProblems"
import { CardReviewList } from "../study/CardReviewList"
import { emptyCardsLabel, keptCardProblems, newCardId, problemLabel, problemSummary, reviewFieldId } from "../study/deck"
import { useFocusField } from "../study/useFocusField"
import type { CardProblem } from "../study/deck"
import { createWithApi } from "../work/apiCreate"
import { sameCards, sameText } from "../work/createOnce"
import { LEAVE_ANYWAY_STATE } from "../work/leave"
import { useEditSession } from "../work/useAutosave"
import { markJustMade } from "../ui/shareAsk"
import { SubjectPicker } from "../subjects/SubjectPicker"
import { NO_SUBJECT, choiceFrom, subjectBody } from "../subjects/subjects"
import { newDraftCard } from "./capture-api"
import type { DraftCard, NotesDraft } from "./capture-api"
import type { CaptureKeys } from "./useCaptureWork"

/* ------------------------------------------------------------------ */
/* Waiting steps                                                      */
/* ------------------------------------------------------------------ */

export function WorkingSteps({ steps, current }: { steps: string[]; current: number }) {
  const panelRef = useRef<HTMLElement>(null)
  useEffect(() => {
    const panel = panelRef.current
    if (!panel) return
    panel.focus({ preventScroll: true })
    panel.scrollIntoView({ block: "center", behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" })
  }, [])
  return (
    <section className="working-panel" aria-busy="true" ref={panelRef} tabIndex={-1} aria-label="Making your notes">
      <ol className="working-steps">
        {steps.map((step, index) => (
          <li key={step} className={index < current ? "done" : index === current ? "now" : ""}>
            <span className="step-dot" aria-hidden="true" />
            <span>{step}</span>
          </li>
        ))}
      </ol>
      <p className="hand-note">This can take a little while. You can stay on this page.</p>
      <p className="sr-only" role="status" aria-live="polite">
        {steps[Math.min(current, steps.length - 1)]}
      </p>
    </section>
  )
}

/* ------------------------------------------------------------------ */
/* Daily limit                                                        */
/* ------------------------------------------------------------------ */

export function LimitNudge({ message, onClose }: { message: string; onClose: () => void }) {
  return (
    <section className="limit-nudge" role="alert">
      <MoonStars size={40} weight="duotone" aria-hidden="true" />
      <div>
        <h2>That's all for today!</h2>
        <p>{message} Your work is still here.</p>
      </div>
      <div className="button-row">
        <button type="button" className="primary-button small" onClick={onClose}>
          Okay
        </button>
      </div>
    </section>
  )
}

/* ------------------------------------------------------------------ */
/* Workbench                                                          */
/* ------------------------------------------------------------------ */

function noteContent(draft: NotesDraft): string {
  const parts = []
  if (draft.summary.trim()) parts.push(draft.summary.trim())
  if (draft.notes.trim()) parts.push(draft.notes.trim())
  if (draft.keyTerms.length > 0) parts.push(`Key words: ${draft.keyTerms.join(", ")}`)
  if (draft.source.label) parts.push(`Source: ${draft.source.label}`)
  return parts.join("\n\n")
}

function tagsFrom(draft: NotesDraft): string[] {
  return draft.keyTerms
    .map((term) => term.toLowerCase().replace(/[^a-z0-9 -]/g, "").trim())
    .filter((term) => term && term.length <= 24)
    .slice(0, 5)
}

export function NotesWorkbench({
  draft,
  onChange,
  onStartOver,
  keys,
  onSaved,
}: {
  draft: NotesDraft
  onChange: (draft: NotesDraft) => void
  onStartOver: () => void
  /** One Idempotency-Key for the note and one for the deck: a retry never makes copies. */
  keys: CaptureKeys
  /** Everything the student asked for is saved: the page can let go of its draft. */
  onSaved: () => void
}) {
  const navigate = useNavigate()
  const titleRef = useRef<HTMLInputElement>(null)
  const [saving, setSaving] = useState<"note" | "both" | null>(null)
  const [confirmReset, setConfirmReset] = useState(false)
  const [editing, setEditing] = useState<string | null>(null)
  // If the note saved but the deck didn't, remember the note so we only retry the deck.
  const [savedNoteId, setSavedNoteId] = useState<string | null>(null)
  // Kept cards go in the deck. One with an empty side stops "Save + make deck" and is marked.
  const kept = draft.cards.filter((card) => card.keep)
  const problems = keptCardProblems(draft.cards)
  const [showProblems, setShowProblems] = useState(false)
  const shownProblems = showProblems && problems.length > 0 ? problems : null
  const focusField = useFocusField()
  // Saves send the maintenance edit-session headers, like the other editors.
  const { headers: sessionHeaders } = useEditSession()

  useEffect(() => {
    const title = titleRef.current
    if (!title) return
    title.focus({ preventScroll: true })
    // Show the focused title in the middle of the screen. This also stops the waiting
    // panel's smooth scroll, which could leave the title under the phone's top bar.
    title.scrollIntoView({ block: "center" })
  }, [])

  const update = (patch: Partial<NotesDraft>) => {
    const next = { ...draft, ...patch }
    if (showProblems && keptCardProblems(next.cards).length === 0) setShowProblems(false)
    onChange(next)
  }

  const goToProblem = (problem: CardProblem) => {
    setEditing(problem.id)
    focusField(reviewFieldId("wb", problem.index, problem.front ? "front" : "back"))
  }

  const blankKept = problems.filter((problem) => problem.blank)
  const tossBlank = () => {
    const blankIds = new Set(blankKept.map((problem) => problem.id))
    update({ cards: draft.cards.map((card) => (blankIds.has(card.id) ? { ...card, keep: false } : card)) })
    toast.success(blankKept.length === 1 ? "Tossed 1 empty card." : `Tossed ${blankKept.length} empty cards.`)
  }

  // One subject for the note and its deck.
  const subject = choiceFrom(draft.subject?.subject, draft.subject?.subtopic)

  const postDeck = async (title: string, tags: string[], accountId: string | undefined) => {
    const body = {
      title,
      tags,
      ...subjectBody(subject),
      cards: kept.map((card) => ({ id: newCardId(), front: card.front.trim(), back: card.back.trim(), review: null })),
    }
    return createWithApi<{ id: string; version: number; title?: string; cards?: unknown }>(
      "/flashcards",
      body,
      (row) => sameText(row.title, body.title) && sameCards(row.cards, body.cards),
      keys.deck,
      { lumaAccountId: accountId, timeout: 30_000, headers: sessionHeaders() },
    )
  }

  const save = async (withDeck: boolean) => {
    const title = draft.title.trim() || "My notes"
    if (!draft.notes.trim() && !draft.summary.trim()) {
      toast.error("Your notes are empty.")
      return
    }
    if (withDeck && problems.length > 0) {
      // Nothing is saved until every kept card has a question and an answer.
      setShowProblems(true)
      goToProblem(problems[0])
      return
    }
    setSaving(withDeck ? "both" : "note")
    // Save into the account that made these notes, even if this tab switches meanwhile.
    const accountId = getTabAccountId() ?? undefined
    const tags = tagsFrom(draft)
    let noteId = savedNoteId
    try {
      if (!noteId) {
        const body = { title, content: noteContent(draft), tags, ...subjectBody(subject) }
        const note = await createWithApi<{ id: string; version: number; title?: string; content?: string }>(
          "/notes",
          body,
          (row) => sameText(row.title, body.title) && sameText(row.content, body.content),
          keys.note,
          { lumaAccountId: accountId, timeout: 30_000, headers: sessionHeaders() },
        )
        noteId = note.id
      }
    } catch (error: unknown) {
      toast.error(getErrorMessage(error, "We couldn't save that. Your work is still here."))
      setSaving(null)
      return
    }

    if ((getTabAccountId() ?? undefined) !== accountId) {
      // The tab moved to another account: keep the saved note, don't add a deck.
      setSaving(null)
      return
    }

    if (!withDeck || kept.length === 0) {
      setSaving(null)
      onSaved()
      markJustMade(accountId, "note", noteId)
      toast.success("Saved your note!")
      // Saved and confirmed, so leaving needs no "are you sure?".
      navigate(`/notes/${noteId}`, { state: LEAVE_ANYWAY_STATE })
      return
    }

    try {
      const deck = await postDeck(title, tags, accountId)
      onSaved()
      markJustMade(accountId, "flashcards", deck.id)
      toast.success("Saved your note and deck!", {
        action: { label: "Open note", onClick: () => navigate(`/notes/${noteId}`) },
      })
      navigate(`/flashcards/${deck.id}`, { state: LEAVE_ANYWAY_STATE })
    } catch (error: unknown) {
      // Stay here so the cards aren't lost. The note is already saved.
      setSavedNoteId(noteId)
      const reason = getErrorMessage(error).trim().replace(/[.!?]?$/, ".")
      toast.error(`Your note is saved, but the deck was not: ${reason} Your cards are still here.`)
    } finally {
      setSaving(null)
    }
  }

  return (
    <section className="workbench" aria-labelledby="wb-heading">
      <h2 id="wb-heading" className="sr-only">
        Your new notes
      </h2>
      {draft.truncated ? (
        <p className="notice info">That was a lot of words! We used the first part.</p>
      ) : null}

      {/* The draft is a sheet of note paper; the cards sit beside it in the margin on wide screens. */}
      <div className="with-margin wb-layout">
        <div className="wb-main">
          <label className="wb-title-label">
            Name your notes
            <input
              ref={titleRef}
              className="wb-title"
              value={draft.title}
              maxLength={200}
              onChange={(event) => update({ title: event.target.value })}
            />
          </label>

          <div className="wb-subject">
            <SubjectPicker value={subject} onChange={(next) => update({ subject: next.subject ? next : NO_SUBJECT })} />
          </div>

          {draft.summary ? (
            <label>
              Short version
              <textarea className="wb-summary" rows={3} value={draft.summary} onChange={(event) => update({ summary: event.target.value })} />
            </label>
          ) : null}

          <div className="wb-notes-field">
            <label htmlFor="wb-notes">Your notes (you can change them)</label>
            <div className="sheet-note editor-sheet">
              <textarea id="wb-notes" className="wb-notes" rows={12} value={draft.notes} onChange={(event) => update({ notes: event.target.value })} />
            </div>
          </div>

          {draft.keyTerms.length > 0 ? (
            <div className="wb-terms">
              <h3>Key words</h3>
              <ul className="term-chips">
                {draft.keyTerms.map((term) => (
                  <li key={term}>
                    <span>{term}</span>
                    <button
                      type="button"
                      aria-label={`Remove ${term}`}
                      onClick={() => update({ keyTerms: draft.keyTerms.filter((item) => item !== term) })}
                    >
                      <X weight="bold" aria-hidden="true" />
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>

        <aside className="margin card-tray" aria-labelledby="tray-title">
          <div className="tray-head">
            <h3 id="tray-title">
              <Sparkle weight="fill" aria-hidden="true" /> Cards we made for you
            </h3>
            <p className="tray-count" aria-live="polite">
              Keeping {kept.length} of {draft.cards.length}
            </p>
          </div>
          <p className="muted small-text">Keep the good ones. Toss the rest. Tap a card to change it.</p>
          {shownProblems ? (
            <ProblemBox
              lines={[problemSummary(shownProblems)]}
              jumps={shownProblems.map((problem) => ({ key: problem.id, label: problemLabel(problem), onJump: () => goToProblem(problem) }))}
              removeLabel={blankKept.length > 0 ? emptyCardsLabel("Toss", blankKept.length) : null}
              onRemove={tossBlank}
            />
          ) : null}
          <CardReviewList
            cards={draft.cards}
            onChange={(cards: DraftCard[]) => update({ cards })}
            editing={editing}
            onEditing={setEditing}
            idPrefix="wb"
            problems={shownProblems}
            newCard={newDraftCard}
          />
        </aside>
      </div>

      <div className="wb-actions">
        {confirmReset ? (
          <div className="reset-confirm">
            <span>Throw this away?</span>
            <button type="button" className="danger-button small" onClick={onStartOver}>
              Yes
            </button>
            <button type="button" className="ghost-button small" onClick={() => setConfirmReset(false)}>
              No
            </button>
          </div>
        ) : (
          <button type="button" className="ghost-button small" onClick={() => setConfirmReset(true)}>
            <ArrowCounterClockwise weight="bold" aria-hidden="true" /> Start over
          </button>
        )}
        <div className="wb-save">
          {savedNoteId ? (
            <Link className="secondary-button" to={`/notes/${savedNoteId}`}>
              <FloppyDisk weight="bold" aria-hidden="true" /> Open my note
            </Link>
          ) : (
            <button type="button" className="secondary-button" onClick={() => void save(false)} disabled={saving !== null}>
              <FloppyDisk weight="bold" aria-hidden="true" /> {saving === "note" ? "Saving..." : "Save note"}
            </button>
          )}
          <button
            type="button"
            className="primary-button"
            onClick={() => void save(true)}
            disabled={saving !== null || kept.length === 0}
            title={kept.length === 0 ? "Keep at least 1 card" : undefined}
          >
            <Cards weight="bold" aria-hidden="true" /> {saving === "both" ? "Saving..." : savedNoteId ? `Try the deck again (${kept.length})` : `Save + make deck (${kept.length})`}
          </button>
        </div>
      </div>
    </section>
  )
}
