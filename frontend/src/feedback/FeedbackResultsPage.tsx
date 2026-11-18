import { useEffect, useState } from "react"
import { Link, useParams } from "react-router-dom"

import { api, getErrorCode } from "../api"
import { useAuth } from "../auth"
import { PageHeader } from "../ui/common"
import { Scribble } from "../ui/Scribble"
import { PollTitle } from "./FeedbackPage"
import {
  NOT_ENOUGH_LINE,
  NO_RESULTS_LINE,
  NO_UPDATE_LINE,
  formatCentral,
  hasPercentages,
  monthLabel,
  updateStatusLabel,
} from "./feedback"
import type { ArchiveItem, StudentResults } from "./feedback"
import { rememberResultsSeen } from "./skip"

/** Past poll results: the newest 24 closed polls. */
export function FeedbackArchivePage() {
  const [items, setItems] = useState<ArchiveItem[] | null>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let active = true
    api
      .get<ArchiveItem[]>("/feedback/results")
      .then((response) => {
        if (active) setItems(Array.isArray(response.data) ? response.data : [])
      })
      .catch(() => {
        if (active) setFailed(true)
      })
    return () => {
      active = false
    }
  }, [])

  return (
    <div className="feedback-page">
      <PageHeader
        eyebrow="Monthly poll"
        title={
          <>
            Past poll <Scribble type="underline">results</Scribble>
          </>
        }
        description="See what students asked for and what Luma is doing about it. The last 2 years are here."
      />
      {failed ? (
        <div className="notice error" role="alert">
          We couldn't load past results. Try again soon.
        </div>
      ) : items === null ? (
        <p className="muted" aria-busy="true">
          Loading results...
        </p>
      ) : items.length === 0 ? (
        <p className="muted">No results yet.</p>
      ) : (
        <ul className="row-list feedback-archive">
          {items.map((item) => (
            <li key={item.id} className="row">
              <span className="row-main">
                <Link className="row-link" to={`/feedback/results/${item.id}`}>
                  {monthLabel(item.period_month)} poll
                </Link>
                <small>Closed {formatCentral(item.closes_at)} Central time</small>
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

type DetailState =
  | { kind: "loading" }
  | { kind: "ready"; data: StudentResults }
  | { kind: "not_ready"; closesAt: string | null }
  | { kind: "missing" }
  | { kind: "error" }

/** One poll's results for students: Yes % and No % per question, and the admin's update. */
export function FeedbackResultsPage() {
  const { pollId = "" } = useParams()
  const { activeAccountId } = useAuth()
  const [state, setState] = useState<DetailState>({ kind: "loading" })

  // Once a student has seen these results, Home stops saying "Poll results are in".
  useEffect(() => {
    if (state.kind === "ready" && activeAccountId) rememberResultsSeen(activeAccountId, state.data.poll.id)
  }, [state, activeAccountId])

  useEffect(() => {
    let active = true
    api
      .get<StudentResults>(`/feedback/results/${encodeURIComponent(pollId)}`)
      .then((response) => {
        if (active) setState({ kind: "ready", data: response.data })
      })
      .catch((error: unknown) => {
        if (!active) return
        const code = getErrorCode(error)
        const status = (error as { response?: { status?: number; data?: { closes_at?: string } } })?.response
        if (code === "results_not_ready" || status?.status === 409) {
          setState({ kind: "not_ready", closesAt: status?.data?.closes_at ?? null })
        } else if (status?.status === 404) {
          setState({ kind: "missing" })
        } else {
          setState({ kind: "error" })
        }
      })
    return () => {
      active = false
    }
  }, [pollId])

  const back = (
    <div className="button-row">
      <Link className="secondary-button" to="/feedback/results">
        All past results
      </Link>
    </div>
  )

  if (state.kind !== "ready") {
    return (
      <div className="feedback-page">
        <PageHeader eyebrow="Poll results" title={<PollTitle />} />
        {state.kind === "loading" ? (
          <p className="muted" aria-busy="true">
            Loading results...
          </p>
        ) : state.kind === "not_ready" ? (
          <p className="feedback-lead">
            {state.closesAt ? `Results come out ${formatCentral(state.closesAt)} Central time.` : "Results come out when the poll closes."}
          </p>
        ) : state.kind === "missing" ? (
          <p className="feedback-lead">We couldn't find those results. Older polls drop off after 2 years.</p>
        ) : (
          <div className="notice error" role="alert">
            We couldn't load these results. Try again soon.
          </div>
        )}
        {back}
      </div>
    )
  }

  const { data } = state
  return (
    <div className="feedback-page">
      <PageHeader
        eyebrow={`${monthLabel(data.poll.period_month)} poll results`}
        title={<PollTitle />}
        description={`Closed ${formatCentral(data.poll.closes_at)} Central time.`}
      />
      <section aria-labelledby="results-title">
        <div className="section-head">
          <h2 id="results-title">What students said</h2>
        </div>
        {data.questions.some(hasPercentages) ? (
          <>
            <p className="muted small-text">
              Yes means "I want this change." The changes most students asked for are first. A question needs at least 5
              answers to show results.
            </p>
            <ol className="feedback-results">
              {data.questions.map((row) => (
                <li key={row.id} className="feedback-result">
                  <p className="feedback-result-label">{row.label}</p>
                  {hasPercentages(row) ? (
                    <>
                      <div className="poll-bar" aria-hidden="true">
                        <span style={{ width: `${row.yes_pct}%` }} />
                      </div>
                      <p className="feedback-result-line">
                        Yes {row.yes_pct}%<span aria-hidden="true"> · </span>No {row.no_pct}%
                      </p>
                    </>
                  ) : (
                    <p className="feedback-result-line muted">{NOT_ENOUGH_LINE}</p>
                  )}
                </li>
              ))}
            </ol>
          </>
        ) : (
          <p className="feedback-lead">{NO_RESULTS_LINE}</p>
        )}
      </section>
      <section aria-labelledby="doing-title" className="feedback-doing">
        <div className="section-head">
          <h2 id="doing-title">What we're doing</h2>
        </div>
        {data.updates.length ? (
          <ul className="feedback-updates">
            {data.updates.map((update, index) => (
              <li key={`${update.title}-${index}`}>
                <span className={`status-chip ${update.status}`}>{updateStatusLabel(update.status)}</span>
                <div>
                  <p className="feedback-update-title">{update.title}</p>
                  {update.note ? <p className="feedback-text muted">{update.note}</p> : null}
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <p>{data.update_summary ?? NO_UPDATE_LINE}</p>
        )}
      </section>
      {back}
    </div>
  )
}
