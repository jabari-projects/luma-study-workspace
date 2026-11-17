import { useEffect, useRef, useState } from "react"
import type { CSSProperties } from "react"
import { Link, useNavigate } from "react-router-dom"
import { AnimatePresence, motion } from "motion/react"
import { toast } from "sonner"
import { ArrowCounterClockwise, Cards, Check, FloppyDisk, MoonStars, Plus, Sparkle, X } from "@phosphor-icons/react"

import { api, getErrorMessage, getTabAccountId } from "../api"
import { newCardId } from "../study/deck"
import { newDraftCard } from "./capture-api"
import type { DraftCard, NotesDraft } from "./capture-api"

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
    <section className="working-panel paper-panel" aria-busy="true" ref={panelRef} tabIndex={-1} aria-label="Making your notes">
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
}: {
  draft: NotesDraft
  onChange: (draft: NotesDraft) => void
  onStartOver: () => void
}) {
  const navigate = useNavigate()
  const titleRef = useRef<HTMLInputElement>(null)
  const [saving, setSaving] = useState<"note" | "both" | null>(null)
  const [confirmReset, setConfirmReset] = useState(false)
  const [editing, setEditing] = useState<string | null>(null)
  // If the note saved but the deck didn't, remember the note so we only retry the deck.
  const [savedNoteId, setSavedNoteId] = useState<string | null>(null)
  const kept = draft.cards.filter((card) => card.keep && card.front.trim() && card.back.trim())

  useEffect(() => {
    const title = titleRef.current
    if (!title) return
    title.focus({ preventScroll: true })
    // Show the focused title in the middle of the screen. This also stops the waiting
    // panel's smooth scroll, which could leave the title under the phone's top bar.
    title.scrollIntoView({ block: "center" })
  }, [])

  const update = (patch: Partial<NotesDraft>) => onChange({ ...draft, ...patch })
  const updateCard = (id: string, patch: Partial<DraftCard>) =>
    update({ cards: draft.cards.map((card) => (card.id === id ? { ...card, ...patch } : card)) })

  const postDeck = async (title: string, tags: string[], accountId: string | undefined) =>
    api.post<{ id: string }>(
      "/flashcards",
      {
        title,
        tags,
        cards: kept.map((card) => ({ id: newCardId(), front: card.front.trim(), back: card.back.trim(), review: null })),
      },
      { lumaAccountId: accountId },
    )

  const save = async (withDeck: boolean) => {
    const title = draft.title.trim() || "My notes"
    if (!draft.notes.trim() && !draft.summary.trim()) {
      toast.error("Your notes are empty.")
      return
    }
    setSaving(withDeck ? "both" : "note")
    // Save into the account that made these notes, even if this tab switches meanwhile.
    const accountId = getTabAccountId() ?? undefined
    const tags = tagsFrom(draft)
    let noteId = savedNoteId
    try {
      if (!noteId) {
        const note = await api.post<{ id: string }>(
          "/notes",
          { title, content: noteContent(draft), tags },
          { lumaAccountId: accountId },
        )
        noteId = note.data.id
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
      toast.success("Saved your note!")
      navigate(`/notes/${noteId}`)
      return
    }

    try {
      const deck = await postDeck(title, tags, accountId)
      toast.success("Saved your note and deck!", {
        action: { label: "Open note", onClick: () => navigate(`/notes/${noteId}`) },
      })
      navigate(`/flashcards/${deck.data.id}`)
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

      {draft.summary ? (
        <label>
          Short version
          <textarea className="wb-summary" rows={3} value={draft.summary} onChange={(event) => update({ summary: event.target.value })} />
        </label>
      ) : null}

      <label>
        Your notes (you can change them)
        <textarea className="wb-notes" rows={12} value={draft.notes} onChange={(event) => update({ notes: event.target.value })} />
      </label>

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

      <div className="card-tray">
        <div className="tray-head">
          <h3>
            <Sparkle weight="fill" aria-hidden="true" /> Cards we made for you
          </h3>
          <p className="tray-count" aria-live="polite">
            Keeping {kept.length} of {draft.cards.length}
          </p>
        </div>
        <p className="muted small-text">Keep the good ones. Toss the rest. Tap a card to change it.</p>
        <ul className="mini-card-grid" role="list">
          <AnimatePresence initial={false}>
            {draft.cards.map((card, index) => (
              <motion.li
                key={card.id}
                layout
                initial={{ opacity: 0, scale: 0.9 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.9 }}
                className={card.keep ? "mini-card" : "mini-card tossed"}
                style={{ "--tilt": `${[-1, 0.8, -0.5, 1.2][index % 4]}deg` } as CSSProperties}
                aria-label={`Card ${index + 1} of ${draft.cards.length}, ${card.keep ? "kept" : "tossed"}`}
              >
                {editing === card.id ? (
                  <div className="mini-card-edit">
                    <label>
                      Question
                      <textarea rows={2} maxLength={4000} value={card.front} onChange={(event) => updateCard(card.id, { front: event.target.value })} />
                    </label>
                    <label>
                      Answer
                      <textarea rows={2} maxLength={4000} value={card.back} onChange={(event) => updateCard(card.id, { back: event.target.value })} />
                    </label>
                    <button type="button" className="secondary-button small" onClick={() => setEditing(null)}>
                      Done
                    </button>
                  </div>
                ) : (
                  <button type="button" className="mini-card-face" onClick={() => setEditing(card.id)}>
                    {/* Named by the card's own words (WCAG 2.5.3); the hidden text says what a tap does. */}
                    <span className="mini-q">{card.front || "Add a question"}</span>
                    <span className="mini-a">{card.back || "Add an answer"}</span>
                    <span className="sr-only">. Change card {index + 1}</span>
                  </button>
                )}
                <div className="mini-card-actions">
                  <button
                    type="button"
                    className={card.keep ? "keep-button on" : "keep-button"}
                    aria-pressed={card.keep}
                    onClick={() => updateCard(card.id, { keep: true })}
                  >
                    <Check weight="bold" aria-hidden="true" /> Keep
                  </button>
                  <button
                    type="button"
                    className={!card.keep ? "toss-button on" : "toss-button"}
                    aria-pressed={!card.keep}
                    onClick={() => updateCard(card.id, { keep: false })}
                  >
                    <X weight="bold" aria-hidden="true" /> Toss
                  </button>
                </div>
              </motion.li>
            ))}
          </AnimatePresence>
        </ul>
        <div className="tray-actions">
          <button
            type="button"
            className="ghost-button small"
            onClick={() => {
              const card = newDraftCard()
              update({ cards: [...draft.cards, card] })
              setEditing(card.id)
            }}
          >
            <Plus weight="bold" aria-hidden="true" /> Add a card
          </button>
          <button type="button" className="ghost-button small" onClick={() => update({ cards: draft.cards.map((card) => ({ ...card, keep: true })) })}>
            Keep all
          </button>
          <button type="button" className="ghost-button small" onClick={() => update({ cards: draft.cards.map((card) => ({ ...card, keep: false })) })}>
            Toss all
          </button>
        </div>
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
