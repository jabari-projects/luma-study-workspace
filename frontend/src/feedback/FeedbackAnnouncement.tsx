import { useEffect, useId, useRef, useState } from "react"
import type { ReactNode } from "react"
import { Link } from "react-router-dom"

import { api } from "../api"
import { useAuth } from "../auth"
import { POLL_TITLE, formatCentral, hasAnswered } from "./feedback"
import type { CurrentFeedback } from "./feedback"
import { readResultsSeen, rememberResultsSeen } from "./skip"

/**
 * A small note on Home about the monthly poll. Never a pop-up: it doesn't move focus by itself,
 * isn't a live region and sits under the next study step. If the poll can't load, it shows nothing.
 */
export function FeedbackAnnouncement() {
  const { activeAccountId, user } = useAuth()
  const [data, setData] = useState<CurrentFeedback | null>(null)
  // "skipped": the student just tapped Skip, so the note says so in one short line they can close.
  const [state, setState] = useState<"shown" | "skipped" | "hidden">("shown")
  const [skipping, setSkipping] = useState(false)
  const [skipFailed, setSkipFailed] = useState(false)
  const titleId = useId()
  const confirmRef = useRef<HTMLParagraphElement>(null)

  useEffect(() => {
    let active = true
    api
      .get<CurrentFeedback>("/feedback/current")
      .then((response) => {
        if (active && response.data && typeof response.data === "object") setData(response.data)
      })
      .catch(() => {
        // No note when the poll can't load. Home keeps working.
      })
    return () => {
      active = false
    }
  }, [])

  // After Skip, focus goes to the short "Okay" line (the button that had focus is gone).
  useEffect(() => {
    if (state === "skipped") confirmRef.current?.focus()
  }, [state])

  if (!data || state === "hidden") return null
  const poll = data.poll

  const skipButton = (pollId: string) => {
    const skip = async () => {
      if (skipping) return
      setSkipping(true)
      setSkipFailed(false)
      try {
        // The server remembers the skip, so Home stops asking on every device.
        await api.post(`/feedback/polls/${pollId}/skip`)
        setState("skipped")
      } catch {
        setSkipFailed(true)
      } finally {
        setSkipping(false)
      }
    }
    return (
      <button type="button" className="ghost-button small" onClick={skip} disabled={skipping}>
        {skipping ? "Skipping..." : "Skip this poll"}
      </button>
    )
  }

  const skipError = skipFailed ? (
    <p role="alert" className="feedback-note-error">
      We couldn't skip the poll just now. Try again.
    </p>
  ) : null

  let body: ReactNode = null
  if (state === "skipped") {
    body = (
      <>
        <p ref={confirmRef} tabIndex={-1} role="status" className="feedback-note-status">
          Okay, we won't ask about this poll again.
        </p>
        <div className="feedback-note-actions">
          <button type="button" className="ghost-button small" onClick={() => setState("hidden")}>
            OK
          </button>
        </div>
      </>
    )
  } else if (poll) {
    if (hasAnswered(data)) {
      body = <p>Thanks! We got your answers. Results come out {formatCentral(poll.closes_at)} Central time.</p>
    } else if (data.skipped) {
      return null
    } else if (data.blocked_reason === "email_unverified") {
      body = (
        <>
          <p>Verify your email to answer the poll. You can skip it.</p>
          <div className="feedback-note-actions">
            <Link className="secondary-button small" to={user?.email ? `/verify-email?email=${encodeURIComponent(user.email)}` : "/verify-email"}>
              Enter code
            </Link>
            {skipButton(poll.id)}
          </div>
          {skipError}
        </>
      )
    } else {
      body = (
        <>
          <p>
            Our monthly poll is open until {formatCentral(poll.closes_at)} Central time. It takes about 2 minutes. You can skip it.
          </p>
          <div className="feedback-note-actions">
            <Link className="secondary-button small" to="/feedback">
              Answer the poll
            </Link>
            {skipButton(poll.id)}
          </div>
          {skipError}
        </>
      )
    }
  } else if (data.latest_results) {
    const resultsId = data.latest_results.poll_id
    if (activeAccountId && readResultsSeen(activeAccountId, resultsId)) return null
    const gotIt = () => {
      if (activeAccountId) rememberResultsSeen(activeAccountId, resultsId)
      setState("hidden")
    }
    body = (
      <>
        <p>Poll results are in. See what students asked for.</p>
        <div className="feedback-note-actions">
          <Link className="secondary-button small" to={`/feedback/results/${resultsId}`}>
            See the results
          </Link>
          <button type="button" className="ghost-button small" onClick={gotIt}>
            Got it
          </button>
        </div>
      </>
    )
  }
  if (!body) return null

  return (
    <aside className="feedback-note" aria-labelledby={titleId}>
      <img className="feedback-note-star" src="/luma-star.png" alt="" />
      <div className="feedback-note-copy">
        <p className="next-label">Monthly poll</p>
        <h2 id={titleId}>{POLL_TITLE}</h2>
        {body}
      </div>
    </aside>
  )
}
