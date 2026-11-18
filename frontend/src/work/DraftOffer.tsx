import "./work.css"

/** "You have changes from earlier in this tab." with Use them / Throw them away. */
export function DraftOffer({
  text = "You have changes from earlier in this tab.",
  onUse,
  onThrowAway,
}: {
  text?: string
  onUse: () => void
  onThrowAway: () => void
}) {
  return (
    <div className="work-draft-offer" role="region" aria-label="Changes from earlier">
      <p>{text}</p>
      <div className="button-row">
        <button type="button" className="primary-button small" onClick={onUse}>
          Use them
        </button>
        <button type="button" className="ghost-button small" onClick={onThrowAway}>
          Throw them away
        </button>
      </div>
    </div>
  )
}
