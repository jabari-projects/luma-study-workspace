// What every card editor shows when cards aren't filled in: a box above the cards that says
// how many and links to each one, and red "Not filled in" under each empty box.
// Used by the deck editor, the Import/Voice/Image workbench and "Make cards from my notes".
import { WarningCircle } from "@phosphor-icons/react"

/** How many problems the box links to before it says "...and 4 more." */
const MAX_JUMPS = 5

export type ProblemJump = { key: string; label: string; onJump: () => void }

export function ProblemBox({
  lines,
  jumps,
  removeLabel,
  onRemove,
}: {
  /** The first line is the heading ("2 cards aren't filled in."). */
  lines: string[]
  jumps: ProblemJump[]
  /** Shown only when some cards are fully empty, like "Remove 2 empty cards". */
  removeLabel?: string | null
  onRemove?: () => void
}) {
  const more = jumps.length - MAX_JUMPS
  return (
    <div className="card-problems" role="alert">
      <WarningCircle className="card-problems-icon" size={24} weight="fill" aria-hidden="true" />
      <div className="card-problems-body">
        {lines.map((line, index) => (
          <p key={line} className={index === 0 ? "card-problems-title" : "card-problems-line"}>
            {line}
          </p>
        ))}
        {jumps.length > 0 ? (
          <ul className="card-problems-list" aria-label="Go to">
            {jumps.slice(0, MAX_JUMPS).map((jump) => (
              <li key={jump.key}>
                <button type="button" className="link-button" onClick={jump.onJump}>
                  {jump.label}
                </button>
              </li>
            ))}
          </ul>
        ) : null}
        {more > 0 ? <p className="card-problems-line">...and {more} more.</p> : null}
        {removeLabel && onRemove ? (
          <button type="button" className="secondary-button small" onClick={onRemove}>
            {removeLabel}
          </button>
        ) : null}
      </div>
    </div>
  )
}

/** Red words under an empty box. Give the box `aria-describedby={id}` and `aria-invalid`. */
export function FieldProblem({ id }: { id?: string }) {
  return (
    <span className="field-problem" id={id}>
      <WarningCircle weight="fill" aria-hidden="true" /> Not filled in
    </span>
  )
}
