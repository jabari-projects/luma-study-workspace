import "./work.css"
import { askToSignInAgain } from "./leave"
import type { SaveSnapshot } from "./saveClient"

function savedAtText(savedAt: number): string {
  const time = new Date(savedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
  return `Saved at ${time}`
}

function statusText(snapshot: SaveSnapshot<unknown>): string {
  switch (snapshot.state) {
    case "dirty":
      return snapshot.held ?? "Not saved yet"
    case "saving":
      return snapshot.slow ? "Still saving..." : "Saving..."
    case "saved":
    case "clean":
      return snapshot.savedAt ? savedAtText(snapshot.savedAt) : ""
    case "offline":
      return "You're offline. We'll save when you're back."
    case "failed":
      return "Couldn't save. Your words are still here."
    case "signed_out":
      return "Sign in again to save."
    case "maintenance":
      return "Luma is taking a short break. Your words are kept in this tab."
    default:
      // conflict and gone: the conflict panel says what happened.
      return ""
  }
}

/**
 * The little line that says whether the work is saved. "Saved" only shows after the
 * server confirmed it. The words are read out politely by screen readers.
 */
export function SaveStatus({
  snapshot,
  onRetry,
  accountId,
  draftProblem,
}: {
  snapshot: SaveSnapshot<unknown>
  onRetry: () => void
  accountId: string | null
  draftProblem?: string | null
}) {
  const text = statusText(snapshot)
  const tone = snapshot.state === "failed" || snapshot.state === "signed_out" ? "bad" : snapshot.state === "saved" ? "good" : "plain"
  return (
    <div className={`save-status ${tone}`} data-state={snapshot.state}>
      <span className="save-status-text" aria-live="polite" role="status">
        {text}
        {snapshot.state === "failed" && snapshot.message ? <span className="save-status-why"> {snapshot.message}</span> : null}
      </span>
      {snapshot.state === "failed" || snapshot.state === "maintenance" ? (
        <button type="button" className="secondary-button small" onClick={onRetry}>
          Try again
        </button>
      ) : null}
      {snapshot.state === "signed_out" ? (
        <button type="button" className="secondary-button small" onClick={() => askToSignInAgain(accountId)}>
          Sign in
        </button>
      ) : null}
      {draftProblem ? <span className="save-status-why">{draftProblem}</span> : null}
    </div>
  )
}
