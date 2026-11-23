// Suggested cards to look over before they are used: Keep or Toss each one, tap one to change
// its words. The Import/Voice/Image workbench and "Make cards from my notes" both use it.
import type { CSSProperties } from "react"
import { AnimatePresence, motion } from "motion/react"
import { Check, Plus, X } from "@phosphor-icons/react"

import { FieldProblem } from "./CardProblems"
import { reviewFieldId } from "./deck"
import type { CardProblem, ReviewCard } from "./deck"

export function CardReviewList<T extends ReviewCard>({
  cards,
  onChange,
  editing,
  onEditing,
  idPrefix,
  problems,
  newCard,
}: {
  cards: T[]
  onChange: (cards: T[]) => void
  /** The card whose words are open for changing. */
  editing: string | null
  onEditing: (id: string | null) => void
  /** Unique per page, for the box ids. */
  idPrefix: string
  /** Shown in red (after the student tried to use the cards). */
  problems: CardProblem[] | null
  /** Shows "Add a card" when given. */
  newCard?: () => T
}) {
  const problemFor = new Map((problems ?? []).map((problem) => [problem.id, problem]))
  const updateCard = (id: string, patch: Partial<ReviewCard>) =>
    onChange(cards.map((card) => (card.id === id ? { ...card, ...patch } : card)))

  return (
    <>
      <ul className="mini-card-grid" role="list">
        <AnimatePresence initial={false}>
          {cards.map((card, index) => {
            const problem = problemFor.get(card.id)
            const frontId = reviewFieldId(idPrefix, index, "front")
            const backId = reviewFieldId(idPrefix, index, "back")
            return (
              <motion.li
                key={card.id}
                layout
                initial={{ opacity: 0, scale: 0.9 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.9 }}
                className={["mini-card", card.keep ? "" : "tossed", problem ? "has-problem" : ""].filter(Boolean).join(" ")}
                style={{ "--tilt": `${[-1, 0.8, -0.5, 1.2][index % 4]}deg` } as CSSProperties}
                aria-label={`Card ${index + 1} of ${cards.length}, ${card.keep ? "kept" : "tossed"}`}
              >
                {editing === card.id ? (
                  <div className="mini-card-edit">
                    <label>
                      Question
                      <textarea
                        id={frontId}
                        rows={2}
                        maxLength={4000}
                        value={card.front}
                        aria-invalid={problem?.front || undefined}
                        aria-describedby={problem?.front ? `${frontId}-problem` : undefined}
                        onChange={(event) => updateCard(card.id, { front: event.target.value })}
                      />
                    </label>
                    {problem?.front ? <FieldProblem id={`${frontId}-problem`} /> : null}
                    <label>
                      Answer
                      <textarea
                        id={backId}
                        rows={2}
                        maxLength={4000}
                        value={card.back}
                        aria-invalid={problem?.back || undefined}
                        aria-describedby={problem?.back ? `${backId}-problem` : undefined}
                        onChange={(event) => updateCard(card.id, { back: event.target.value })}
                      />
                    </label>
                    {problem?.back ? <FieldProblem id={`${backId}-problem`} /> : null}
                    <button type="button" className="secondary-button small" onClick={() => onEditing(null)}>
                      Done
                    </button>
                  </div>
                ) : (
                  <button type="button" className="mini-card-face" onClick={() => onEditing(card.id)}>
                    {/* Named by the card's own words (WCAG 2.5.3); the hidden text says what a tap does. */}
                    <span className="mini-q">{card.front || "Add a question"}</span>
                    <span className="mini-a">{card.back || "Add an answer"}</span>
                    {problem ? <FieldProblem /> : null}
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
            )
          })}
        </AnimatePresence>
      </ul>
      <div className="tray-actions">
        {newCard ? (
          <button
            type="button"
            className="ghost-button small"
            onClick={() => {
              const card = newCard()
              onChange([...cards, card])
              onEditing(card.id)
            }}
          >
            <Plus weight="bold" aria-hidden="true" /> Add a card
          </button>
        ) : null}
        <button type="button" className="ghost-button small" onClick={() => onChange(cards.map((card) => ({ ...card, keep: true })))}>
          Keep all
        </button>
        <button type="button" className="ghost-button small" onClick={() => onChange(cards.map((card) => ({ ...card, keep: false })))}>
          Toss all
        </button>
      </div>
    </>
  )
}
