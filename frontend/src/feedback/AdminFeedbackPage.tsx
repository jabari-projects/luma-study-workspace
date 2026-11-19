import { useCallback, useEffect, useId, useRef, useState } from "react"
import type { FormEvent } from "react"
import { Link, useParams } from "react-router-dom"

import { api, getErrorMessage } from "../api"
import { ConfirmDialog } from "../ui/ConfirmDialog"
import { NoticeBanner, PageHeader } from "../ui/common"
import type { Notice } from "../ui/common"
import { Scribble } from "../ui/Scribble"
import {
  AFTER_CLOSE_LINE,
  FLAG_LABELS,
  UPDATE_STATUSES,
  adminResultLine,
  chicagoLocalToUtc,
  chicagoWallTime,
  defaultWindowLocal,
  formatCentral,
  formatCentralTime,
  monthLabel,
  pollStatusLabel,
  questionLint,
  studentsLine,
  updateStatusLabel,
} from "./feedback"
import type {
  AdminComment,
  AdminPoll,
  AdminPollRow,
  AdminThemes,
  AdminTotals,
  AdminUpdate,
  UpdateStatus,
  UrgentFlag,
} from "./feedback"

const MAX_QUESTIONS = 12
/** A draft that opens within this long (or already missed its start) gets a "needs" hint. */
const SOON_MS = 14 * 24 * 3600e3
const statusOf = (error: unknown) => (error as { response?: { status?: number } })?.response?.status

function Forbidden() {
  return <PageHeader title="Student feedback" description="Only Luma helpers can see this page." />
}

/** Admin list of monthly polls. Loading it makes the drafts for this month and next (never published by itself). */
export function AdminFeedbackPage() {
  const [polls, setPolls] = useState<AdminPollRow[] | null>(null)
  const [forbidden, setForbidden] = useState(false)
  const [notice, setNotice] = useState<Notice | null>(null)

  useEffect(() => {
    let active = true
    api
      .get<AdminPollRow[]>("/admin/feedback/polls")
      .then((response) => {
        if (active) setPolls(response.data)
      })
      .catch((error: unknown) => {
        if (!active) return
        if (statusOf(error) === 403) setForbidden(true)
        else setNotice({ type: "error", text: getErrorMessage(error, "We couldn't load the polls.") })
      })
    return () => {
      active = false
    }
  }, [])

  if (forbidden) return <Forbidden />

  return (
    <>
      <PageHeader
        eyebrow="Luma helpers"
        title={
          <>
            Student <Scribble type="underline">feedback</Scribble>
          </>
        }
        description="Monthly polls. A draft never opens by itself: you approve each one."
      />
      <NoticeBanner notice={notice} />
      {polls === null ? (
        notice ? null : (
          <p className="muted" aria-busy="true">
            Loading polls...
          </p>
        )
      ) : polls.length === 0 ? (
        <p className="muted">No polls yet.</p>
      ) : (
        <ul className="report-list feedback-poll-list">
          {polls.map((poll) => (
            <li key={poll.id} className="report-row">
              <div className="report-main">
                <h2>
                  <Link to={`/admin/feedback/${poll.id}`}>{monthLabel(poll.period_month)} poll</Link>
                </h2>
                <p className="report-kind">
                  Opens {formatCentral(poll.opens_at)} Central time · {poll.question_count} question{poll.question_count === 1 ? "" : "s"}
                  {poll.status === "open" || poll.status === "closed" ? ` · ${studentsLine(poll.participants)}` : ""}
                </p>
                {needsHint(poll) ? <p className="feedback-needs">{needsHint(poll)}</p> : null}
              </div>
              <span className={`status-chip ${poll.status}`}>{pollStatusLabel(poll.status)}</span>
            </li>
          ))}
        </ul>
      )}
    </>
  )
}

/** What a draft still needs, when it opens soon (or its start time has passed). */
function needsHint(poll: AdminPollRow): string | null {
  if (poll.status !== "draft" && poll.status !== "missed") return null
  const soon = poll.status === "missed" || new Date(poll.opens_at).getTime() - Date.now() < SOON_MS
  if (!soon) return null
  if (poll.status === "missed") return "Start time passed. Pick new dates, then approve."
  return poll.question_count ? "Needs approval" : "Needs questions and approval"
}

/** One poll: dates, questions, approval, live totals, comments and themes, and the update for students. */
export function AdminPollPage() {
  const { pollId = "" } = useParams()
  const [data, setData] = useState<AdminPoll | null>(null)
  const [problem, setProblem] = useState<"forbidden" | "missing" | "error" | null>(null)
  const [reloadKey, setReloadKey] = useState(0)
  const [questionsDirty, setQuestionsDirty] = useState(false)
  const reload = useCallback(() => setReloadKey((key) => key + 1), [])

  useEffect(() => {
    let active = true
    api
      .get<AdminPoll>(`/admin/feedback/polls/${encodeURIComponent(pollId)}`)
      .then((response) => {
        if (active) setData(response.data)
      })
      .catch((error: unknown) => {
        if (!active) return
        const code = statusOf(error)
        setProblem(code === 403 ? "forbidden" : code === 404 ? "missing" : "error")
      })
    return () => {
      active = false
    }
  }, [pollId, reloadKey])

  if (problem === "forbidden") return <Forbidden />
  if (problem) {
    return (
      <>
        <PageHeader title="Student feedback" description={problem === "missing" ? "We couldn't find that poll." : "We couldn't load that poll."} />
        <Link className="secondary-button" to="/admin/feedback">
          All polls
        </Link>
      </>
    )
  }
  if (!data) {
    return (
      <>
        <PageHeader title="Student feedback" />
        <p className="muted" aria-busy="true">
          Loading the poll...
        </p>
      </>
    )
  }

  const poll = data
  const started = poll.status === "open" || poll.status === "closed"
  const closed = poll.status === "closed"
  return (
    <div className="feedback-admin">
      <PageHeader
        eyebrow="Student feedback"
        title={`${monthLabel(poll.period_month)} poll`}
        description={
          <>
            <span className={`status-chip ${poll.status}`}>{pollStatusLabel(poll.status)}</span>{" "}
            {formatCentral(poll.opens_at)} to {formatCentral(poll.closes_at)} Central time
          </>
        }
        actions={
          <Link className="secondary-button" to="/admin/feedback">
            All polls
          </Link>
        }
      />
      <nav className="feedback-admin-toc" aria-label="On this page">
        <a href="#dates">Dates</a>
        <a href="#questions">Questions</a>
        {poll.approved_at ? null : <a href="#approve">Approve</a>}
        {started ? <a href="#totals">Totals</a> : null}
        {closed ? <a href="#comments">Comments</a> : null}
        <a href="#updates">Update for students</a>
      </nav>
      <DatesSection data={data} onSaved={reload} />
      <QuestionsSection data={data} onSaved={reload} onDirty={setQuestionsDirty} />
      {poll.approved_at ? null : <ApproveSection data={data} questionsDirty={questionsDirty} onSaved={reload} />}
      {started ? <TotalsSection pollId={poll.id} closed={closed} /> : null}
      {closed ? <CommentsSection pollId={poll.id} /> : null}
      <UpdatesSection pollId={poll.id} />
    </div>
  )
}

// ------------------------------------------------------------------- dates

function DatesSection({ data, onSaved }: { data: AdminPoll; onSaved: () => void }) {
  const poll = data
  const [opens, setOpens] = useState(() => poll.opens_local ?? chicagoWallTime(poll.opens_at))
  const [closes, setCloses] = useState(() => poll.closes_local ?? chicagoWallTime(poll.closes_at))
  const [notice, setNotice] = useState<Notice | null>(null)
  const [saving, setSaving] = useState(false)
  const locked = !data.can_edit_dates

  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    for (const value of [opens, closes]) {
      const check = chicagoLocalToUtc(value)
      if (!check.ok) {
        setNotice({
          type: "error",
          text:
            check.reason === "bad_time"
              ? "Pick a date and a time."
              : "That time is skipped or happens twice in Central time because of daylight saving. Pick another time.",
        })
        return
      }
    }
    setSaving(true)
    setNotice(null)
    try {
      await api.patch(`/admin/feedback/polls/${poll.id}`, { opens_local: opens, closes_local: closes })
      setNotice({ type: "success", text: "Dates saved." })
      onSaved()
    } catch (error: unknown) {
      setNotice({ type: "error", text: getErrorMessage(error, "We couldn't save the dates.") })
    } finally {
      setSaving(false)
    }
  }

  return (
    <section className="feedback-admin-section" aria-labelledby="dates">
      <h2 id="dates">Dates</h2>
      <p className="muted small-text">
        The default is the last Sunday of the month at 12:00 noon until the next Sunday at noon, Central time.
      </p>
      {locked ? <p>Voting has started, so the dates are locked.</p> : null}
      <form className="feedback-dates" onSubmit={save}>
        <label>
          Opens (Central time)
          <input type="datetime-local" value={opens} disabled={locked} onChange={(event) => setOpens(event.target.value)} />
        </label>
        <label>
          Closes (Central time)
          <input type="datetime-local" value={closes} disabled={locked} onChange={(event) => setCloses(event.target.value)} />
        </label>
        {locked ? null : (
          <div className="button-row">
            <button type="submit" className="secondary-button" disabled={saving}>
              {saving ? "Saving..." : "Save dates"}
            </button>
            <button
              type="button"
              className="ghost-button"
              onClick={() => {
                const w = defaultWindowLocal(poll.period_month)
                setNotice(null)
                setOpens(poll.default_opens_local ?? w.opens_local)
                setCloses(poll.default_closes_local ?? w.closes_local)
              }}
            >
              Use default dates
            </button>
          </div>
        )}
      </form>
      <NoticeBanner notice={notice} />
    </section>
  )
}

// ------------------------------------------------------------------- questions

function QuestionsSection({ data, onSaved, onDirty }: { data: AdminPoll; onSaved: () => void; onDirty: (dirty: boolean) => void }) {
  const saved = [...data.questions].sort((a, b) => a.position - b.position).map((q) => q.label)
  const [labels, setLabels] = useState<string[]>(() => (saved.length ? saved : [""]))
  const [notice, setNotice] = useState<Notice | null>(null)
  const [busy, setBusy] = useState(false)
  const dirty = data.can_edit_questions && JSON.stringify(labels) !== JSON.stringify(saved)

  useEffect(() => {
    onDirty(dirty)
  }, [dirty, onDirty])

  const move = (index: number, by: number) => {
    setLabels((current) => {
      const next = [...current]
      const [item] = next.splice(index, 1)
      next.splice(index + by, 0, item)
      return next
    })
  }

  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const trimmed = labels.map((label) => label.trim()).filter(Boolean)
    if (!trimmed.length) {
      setNotice({ type: "error", text: "Add at least one question." })
      return
    }
    setBusy(true)
    setNotice(null)
    try {
      await api.put(`/admin/feedback/polls/${data.id}/questions`, { questions: trimmed.map((label) => ({ label })) })
      setNotice({ type: "success", text: "Questions saved." })
      setLabels(trimmed)
      onSaved()
    } catch (error: unknown) {
      setNotice({ type: "error", text: getErrorMessage(error, "We couldn't save the questions.") })
    } finally {
      setBusy(false)
    }
  }

  const unapprove = async () => {
    setBusy(true)
    try {
      await api.post(`/admin/feedback/polls/${data.id}/unapprove`)
      onSaved()
    } catch (error: unknown) {
      setNotice({ type: "error", text: getErrorMessage(error, "We couldn't move it back to draft.") })
    } finally {
      setBusy(false)
    }
  }

  if (!data.can_edit_questions) {
    const started = data.status === "open" || data.status === "closed"
    return (
      <section className="feedback-admin-section" aria-labelledby="questions">
        <h2 id="questions">Questions</h2>
        <ol className="feedback-admin-questions read-only">
          {saved.map((label, index) => (
            <li key={`${index}-${label}`}>{label}</li>
          ))}
        </ol>
        {started ? (
          <p>Voting has started, so the wording is locked.</p>
        ) : (
          <>
            <p>Move it back to draft to edit questions.</p>
            <div className="button-row">
              <button type="button" className="secondary-button" disabled={busy} onClick={() => void unapprove()}>
                Move back to draft
              </button>
            </div>
          </>
        )}
        <NoticeBanner notice={notice} />
      </section>
    )
  }

  return (
    <section className="feedback-admin-section" aria-labelledby="questions">
      <h2 id="questions">Questions</h2>
      <p className="muted small-text">One change per question. Yes always means "I want this change." About 10 is plenty (12 at most).</p>
      <form onSubmit={save}>
        <ol className="feedback-admin-questions">
          {labels.map((label, index) => {
            const warning = label.trim() ? questionLint(label) : null
            const warningId = `q-warn-${index}`
            return (
              <li key={index}>
                <label>
                  Question {index + 1}
                  <input
                    value={label}
                    maxLength={160}
                    aria-describedby={warning ? warningId : undefined}
                    onChange={(event) => setLabels((current) => current.map((item, i) => (i === index ? event.target.value : item)))}
                  />
                </label>
                {warning ? (
                  <p id={warningId} className="feedback-lint">
                    {warning}
                  </p>
                ) : null}
                <div className="button-row feedback-row-tools">
                  <button type="button" className="ghost-button small" disabled={index === 0} onClick={() => move(index, -1)}>
                    Move up<span className="sr-only"> question {index + 1}</span>
                  </button>
                  <button type="button" className="ghost-button small" disabled={index === labels.length - 1} onClick={() => move(index, 1)}>
                    Move down<span className="sr-only"> question {index + 1}</span>
                  </button>
                  <button
                    type="button"
                    className="ghost-button small"
                    disabled={labels.length === 1}
                    onClick={() => setLabels((current) => current.filter((_, i) => i !== index))}
                  >
                    Remove<span className="sr-only"> question {index + 1}</span>
                  </button>
                </div>
              </li>
            )
          })}
        </ol>
        <div className="button-row">
          <button
            type="button"
            className="secondary-button"
            disabled={labels.length >= MAX_QUESTIONS}
            onClick={() => setLabels((current) => [...current, ""])}
          >
            Add a question
          </button>
          <button type="submit" className="primary-button" disabled={busy}>
            {busy ? "Saving..." : "Save questions"}
          </button>
        </div>
      </form>
      <NoticeBanner notice={notice} />
    </section>
  )
}

// ------------------------------------------------------------------- approve

function ApproveSection({ data, questionsDirty, onSaved }: { data: AdminPoll; questionsDirty: boolean; onSaved: () => void }) {
  const [oneChange, setOneChange] = useState(false)
  const [yesMeans, setYesMeans] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<Notice | null>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const ready = oneChange && yesMeans && data.questions.length > 0 && !questionsDirty

  const approve = async () => {
    setBusy(true)
    try {
      await api.post(`/admin/feedback/polls/${data.id}/approve`, {
        checklist: { one_change_each: true, yes_means_change: true },
      })
      setConfirming(false)
      onSaved()
    } catch (error: unknown) {
      setConfirming(false)
      setNotice({ type: "error", text: getErrorMessage(error, "We couldn't approve this poll.") })
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="feedback-admin-section" aria-labelledby="approve">
      <h2 id="approve">Approve</h2>
      {data.status === "missed" ? (
        <p className="notice info">This poll's start time has passed. Pick new dates above to schedule it.</p>
      ) : null}
      <p className="muted small-text">Students only see a poll after you approve it. Check the wording first.</p>
      <div className="feedback-checks">
        <label className="check-row">
          <input type="checkbox" checked={oneChange} onChange={(event) => setOneChange(event.target.checked)} />
          Each question asks about one change
        </label>
        <label className="check-row">
          <input type="checkbox" checked={yesMeans} onChange={(event) => setYesMeans(event.target.checked)} />
          Yes always means "I want this change"
        </label>
      </div>
      {questionsDirty ? <p className="feedback-lint">Save your questions first.</p> : null}
      {data.questions.length === 0 ? <p className="feedback-lint">Add and save at least one question first.</p> : null}
      <div className="button-row">
        <button ref={buttonRef} type="button" className="primary-button" disabled={!ready} onClick={() => setConfirming(true)}>
          Approve and schedule
        </button>
      </div>
      <NoticeBanner notice={notice} />
      {confirming ? (
        <ConfirmDialog
          title="Approve this poll?"
          body={`Students will see this on ${formatCentral(data.opens_at)} Central time. Wording can't change once voting starts.`}
          confirmLabel="Approve and schedule"
          cancelLabel="Not yet"
          busyLabel="Approving..."
          busy={busy}
          onConfirm={() => void approve()}
          onCancel={() => setConfirming(false)}
          returnFocus={() => buttonRef.current}
        />
      ) : null}
    </section>
  )
}

// ------------------------------------------------------------------- totals

function TotalsSection({ pollId, closed }: { pollId: string; closed: boolean }) {
  const [totals, setTotals] = useState<AdminTotals | null>(null)
  const [notice, setNotice] = useState<Notice | null>(null)
  const [reloadKey, setReloadKey] = useState(0)

  useEffect(() => {
    let active = true
    api
      .get<AdminTotals>(`/admin/feedback/polls/${pollId}/totals`)
      .then((response) => {
        if (active) setTotals(response.data)
      })
      .catch((error: unknown) => {
        if (active) setNotice({ type: "error", text: getErrorMessage(error, "We couldn't load the totals.") })
      })
    return () => {
      active = false
    }
  }, [pollId, reloadKey])

  const final = closed && totals?.final === true
  return (
    <section className="feedback-admin-section" aria-labelledby="totals">
      <h2 id="totals">{closed ? "Final totals" : "Live totals"}</h2>
      <NoticeBanner notice={notice} />
      {totals ? (
        <>
          <p className="feedback-lead">
            <strong>
              {studentsLine(totals.participants)}
              {final || totals.participants === 0 ? "" : " so far"}
            </strong>
          </p>
          {final ? (
            <>
              <p className="muted small-text">Sorted by Yes %. Percentages count only the students who answered that question.</p>
              <ol className="feedback-results">
                {totals.questions.map((row) => (
                  <li key={row.id} className="feedback-result">
                    <p className="feedback-result-label">{row.label}</p>
                    <div className="poll-bar" aria-hidden="true">
                      <span style={{ width: `${row.yes_pct ?? 0}%` }} />
                    </div>
                    <p className="feedback-result-line">{adminResultLine(row)}</p>
                  </li>
                ))}
              </ol>
            </>
          ) : (
            <p className="muted">{AFTER_CLOSE_LINE}</p>
          )}
          <div className="button-row">
            <p className="muted small-text">Updated {formatCentralTime(totals.as_of)} Central time</p>
            {closed ? null : (
              <button type="button" className="secondary-button small" onClick={() => setReloadKey((key) => key + 1)}>
                Refresh
              </button>
            )}
          </div>
        </>
      ) : notice ? null : (
        <p className="muted" aria-busy="true">
          Loading totals...
        </p>
      )}
    </section>
  )
}

// ------------------------------------------------------------------- comments and themes

function CommentText({ comment }: { comment: AdminComment }) {
  return (
    <>
      <p className="feedback-text">{comment.comment}</p>
      <p className="muted small-text">
        Comment {comment.response_ref}
        {comment.urgent_flags.length ? ` · ${comment.urgent_flags.map((flag) => FLAG_LABELS[flag]).join(", ")}` : ""}
      </p>
    </>
  )
}

function FlagTools({ comment, onChange }: { comment: AdminComment; onChange: (flags: UrgentFlag[]) => void }) {
  if (comment.urgent_flags.length) {
    return (
      <button type="button" className="ghost-button small" onClick={() => onChange([])}>
        Clear flag<span className="sr-only"> on comment {comment.response_ref}</span>
      </button>
    )
  }
  return (
    <details className="feedback-flag-menu">
      <summary>
        Set flag<span className="sr-only"> on comment {comment.response_ref}</span>
      </summary>
      <div className="button-row">
        {(Object.keys(FLAG_LABELS) as UrgentFlag[]).map((flag) => (
          <button key={flag} type="button" className="secondary-button small" onClick={() => onChange([flag])}>
            {FLAG_LABELS[flag]}
          </button>
        ))}
      </div>
    </details>
  )
}

function CommentsSection({ pollId }: { pollId: string }) {
  const [comments, setComments] = useState<AdminComment[] | null>(null)
  const [themes, setThemes] = useState<AdminThemes | null>(null)
  const [notice, setNotice] = useState<Notice | null>(null)
  const [reloadKey, setReloadKey] = useState(0)
  const [mergePick, setMergePick] = useState<string[]>([])
  const [mergeInto, setMergeInto] = useState("")
  const mergeSelectId = useId()
  const reload = () => setReloadKey((key) => key + 1)

  useEffect(() => {
    let active = true
    Promise.all([
      api.get<AdminComment[]>(`/admin/feedback/polls/${pollId}/comments`),
      api.get<AdminThemes>(`/admin/feedback/polls/${pollId}/themes`),
    ])
      .then(([c, t]) => {
        if (!active) return
        setComments(c.data)
        setThemes(t.data)
      })
      .catch((error: unknown) => {
        if (active) setNotice({ type: "error", text: getErrorMessage(error, "We couldn't load the comments.") })
      })
    return () => {
      active = false
    }
  }, [pollId, reloadKey])

  const act = async (work: () => Promise<unknown>, done: string) => {
    try {
      await work()
      setNotice({ type: "success", text: done })
      reload()
    } catch (error: unknown) {
      setNotice({ type: "error", text: getErrorMessage(error, "That didn't work. Try again.") })
    }
  }

  const setFlags = (comment: AdminComment, flags: UrgentFlag[]) =>
    void act(() => api.patch(`/admin/feedback/responses/${comment.response_id}`, { urgent_flags: flags }), flags.length ? "Flag set." : "Flag cleared.")

  const byId = new Map((comments ?? []).map((c) => [c.response_id, c]))
  // A flagged comment is shown once, under Needs attention, not again in Other comments.
  const urgentIds = new Set((themes?.urgent ?? []).map((c) => c.response_id))
  const otherIds = (themes?.other_response_ids ?? (comments ?? []).filter((c) => !c.theme_ids.length).map((c) => c.response_id)).filter(
    (id) => !urgentIds.has(id),
  )

  return (
    <section className="feedback-admin-section" aria-labelledby="comments">
      <h2 id="comments">Comments</h2>
      <p className="muted small-text">You see what students wrote, never who wrote it. Grouping happens here on Luma, with no AI service.</p>
      <NoticeBanner notice={notice} />
      {!comments || !themes ? (
        notice ? null : (
          <p className="muted" aria-busy="true">
            Loading comments...
          </p>
        )
      ) : (
        <>
          <section className="feedback-urgent" aria-labelledby="urgent-title">
            <h3 id="urgent-title">Needs attention: security, accessibility or privacy</h3>
            {themes.urgent.length ? (
              <ul className="feedback-comment-list">
                {themes.urgent.map((comment) => (
                  <li key={comment.response_id}>
                    <CommentText comment={comment} />
                    <FlagTools comment={comment} onChange={(flags) => setFlags(comment, flags)} />
                  </li>
                ))}
              </ul>
            ) : (
              <p className="muted">Nothing flagged.</p>
            )}
          </section>

          <section aria-labelledby="themes-title">
            <div className="feedback-themes-head">
              <h3 id="themes-title">Themes</h3>
              <button
                type="button"
                className="secondary-button small"
                onClick={() => void act(() => api.post(`/admin/feedback/polls/${pollId}/themes/regroup`), "Comments regrouped.")}
              >
                Regroup
              </button>
            </div>
            <p className="muted small-text">Most-mentioned first. Each count is the number of different students.</p>
            {themes.themes.length ? (
              <ul className="feedback-theme-list">
                {themes.themes.map((theme) => (
                  <ThemeItem
                    key={theme.id}
                    theme={theme}
                    comments={theme.response_ids.map((id) => byId.get(id)).filter((c): c is AdminComment => Boolean(c))}
                    picked={mergePick.includes(theme.id)}
                    onPick={(on) => setMergePick((current) => (on ? [...current, theme.id] : current.filter((id) => id !== theme.id)))}
                    act={act}
                    onFlag={setFlags}
                  />
                ))}
              </ul>
            ) : (
              <p className="muted">No themes yet.</p>
            )}
            {themes.themes.length > 1 ? (
              <div className="feedback-merge">
                <label htmlFor={mergeSelectId}>Merge picked themes into</label>
                <select id={mergeSelectId} value={mergeInto} onChange={(event) => setMergeInto(event.target.value)}>
                  <option value="">Pick a theme</option>
                  {themes.themes.map((theme) => (
                    <option key={theme.id} value={theme.id}>
                      {theme.label}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  className="secondary-button small"
                  disabled={!mergeInto || !mergePick.some((id) => id !== mergeInto)}
                  onClick={() =>
                    void act(async () => {
                      await api.post("/admin/feedback/themes/merge", {
                        poll_id: pollId,
                        into_theme_id: mergeInto,
                        from_theme_ids: mergePick.filter((id) => id !== mergeInto),
                      })
                      setMergePick([])
                    }, "Themes merged.")
                  }
                >
                  Merge
                </button>
              </div>
            ) : null}
          </section>

          <section aria-labelledby="other-title">
            <h3 id="other-title">Other comments ({otherIds.length})</h3>
            {otherIds.length ? (
              <ul className="feedback-comment-list">
                {otherIds
                  .map((id) => byId.get(id))
                  .filter((c): c is AdminComment => Boolean(c))
                  .map((comment) => (
                    <li key={comment.response_id}>
                      <CommentText comment={comment} />
                      <FlagTools comment={comment} onChange={(flags) => setFlags(comment, flags)} />
                    </li>
                  ))}
              </ul>
            ) : (
              <p className="muted">None.</p>
            )}
          </section>
        </>
      )}
    </section>
  )
}

function ThemeItem({
  theme,
  comments,
  picked,
  onPick,
  act,
  onFlag,
}: {
  theme: AdminThemes["themes"][number]
  comments: AdminComment[]
  picked: boolean
  onPick: (on: boolean) => void
  act: (work: () => Promise<unknown>, done: string) => Promise<void>
  onFlag: (comment: AdminComment, flags: UrgentFlag[]) => void
}) {
  const [name, setName] = useState(theme.label)
  const [splitPick, setSplitPick] = useState<string[]>([])
  const [splitName, setSplitName] = useState("")
  const nameId = useId()
  const splitId = useId()

  return (
    <li className="feedback-theme">
      <label className="check-row">
        <input type="checkbox" checked={picked} onChange={(event) => onPick(event.target.checked)} />
        <span>
          Pick <strong>{theme.label}</strong> to merge
        </span>
      </label>
      <details>
        <summary className="feedback-theme-summary">
          <span className="feedback-theme-name">{theme.label}</span> · {theme.count} student{theme.count === 1 ? "" : "s"}
        </summary>
        <div className="feedback-theme-body">
          <ul className="feedback-comment-list">
            {comments.map((comment) => (
              <li key={comment.response_id}>
                <label className="check-row">
                  <input
                    type="checkbox"
                    checked={splitPick.includes(comment.response_id)}
                    onChange={(event) =>
                      setSplitPick((current) =>
                        event.target.checked ? [...current, comment.response_id] : current.filter((id) => id !== comment.response_id),
                      )
                    }
                  />
                  <span>Pick comment {comment.response_ref}</span>
                </label>
                <CommentText comment={comment} />
                <FlagTools comment={comment} onChange={(flags) => onFlag(comment, flags)} />
              </li>
            ))}
          </ul>
          <div className="feedback-theme-tools">
            <label htmlFor={splitId}>New theme name</label>
            <input id={splitId} value={splitName} maxLength={80} onChange={(event) => setSplitName(event.target.value)} />
            <button
              type="button"
              className="secondary-button small"
              disabled={!splitPick.length || !splitName.trim()}
              onClick={() =>
                void act(
                  () => api.post(`/admin/feedback/themes/${theme.id}/split`, { label: splitName.trim(), response_ids: splitPick }),
                  "Moved to a new theme.",
                )
              }
            >
              Move to new theme
            </button>
          </div>
          <div className="feedback-theme-tools">
            <label htmlFor={nameId}>Theme name</label>
            <input id={nameId} value={name} maxLength={80} onChange={(event) => setName(event.target.value)} />
            <button
              type="button"
              className="secondary-button small"
              disabled={!name.trim() || name.trim() === theme.label}
              onClick={() => void act(() => api.patch(`/admin/feedback/themes/${theme.id}`, { label: name.trim() }), "Theme renamed.")}
            >
              Rename
            </button>
            <button
              type="button"
              className="ghost-button small"
              onClick={() => void act(() => api.delete(`/admin/feedback/themes/${theme.id}`), "Theme removed. Its comments are in Other comments.")}
            >
              Remove theme
            </button>
          </div>
        </div>
      </details>
    </li>
  )
}

// ------------------------------------------------------------------- update for students

function UpdateRow({ update, onSaved }: { update: AdminUpdate; onSaved: (text: Notice) => void }) {
  const [title, setTitle] = useState(update.title)
  const [status, setStatus] = useState<UpdateStatus>(update.status)
  const [note, setNote] = useState(update.note ?? "")
  const [published, setPublished] = useState(update.published)
  const base = useId()

  const save = async () => {
    try {
      await api.patch(`/admin/feedback/updates/${update.id}`, { title, status, note: note.trim() || null, published })
      onSaved({ type: "success", text: "Update saved." })
    } catch (error: unknown) {
      onSaved({ type: "error", text: getErrorMessage(error, "We couldn't save that update.") })
    }
  }
  const remove = async () => {
    try {
      await api.delete(`/admin/feedback/updates/${update.id}`)
      onSaved({ type: "success", text: "Update removed." })
    } catch (error: unknown) {
      onSaved({ type: "error", text: getErrorMessage(error, "We couldn't remove that update.") })
    }
  }

  return (
    <li className="feedback-update-row">
      <UpdateFields
        base={base}
        title={title}
        setTitle={setTitle}
        status={status}
        setStatus={setStatus}
        note={note}
        setNote={setNote}
        published={published}
        setPublished={setPublished}
      />
      <div className="button-row">
        <button type="button" className="secondary-button small" onClick={() => void save()}>
          Save<span className="sr-only"> {update.title}</span>
        </button>
        <button type="button" className="ghost-button small" onClick={() => void remove()}>
          Remove<span className="sr-only"> {update.title}</span>
        </button>
      </div>
    </li>
  )
}

function UpdateFields(props: {
  base: string
  title: string
  setTitle: (value: string) => void
  status: UpdateStatus
  setStatus: (value: UpdateStatus) => void
  note: string
  setNote: (value: string) => void
  published: boolean
  setPublished: (value: boolean) => void
}) {
  return (
    <div className="feedback-update-fields">
      <label htmlFor={`${props.base}-title`}>What change</label>
      <input id={`${props.base}-title`} value={props.title} maxLength={160} onChange={(event) => props.setTitle(event.target.value)} />
      <label htmlFor={`${props.base}-status`}>Status</label>
      <select id={`${props.base}-status`} value={props.status} onChange={(event) => props.setStatus(event.target.value as UpdateStatus)}>
        {UPDATE_STATUSES.map((status) => (
          <option key={status} value={status}>
            {updateStatusLabel(status)}
          </option>
        ))}
      </select>
      <label htmlFor={`${props.base}-note`}>Note for students (optional)</label>
      <textarea id={`${props.base}-note`} value={props.note} maxLength={600} rows={2} onChange={(event) => props.setNote(event.target.value)} />
      <label className="check-row">
        <input type="checkbox" checked={props.published} onChange={(event) => props.setPublished(event.target.checked)} />
        Show to students
      </label>
    </div>
  )
}

function UpdatesSection({ pollId }: { pollId: string }) {
  const [items, setItems] = useState<AdminUpdate[] | null>(null)
  const [notice, setNotice] = useState<Notice | null>(null)
  const [reloadKey, setReloadKey] = useState(0)
  const [title, setTitle] = useState("")
  const [status, setStatus] = useState<UpdateStatus>("reviewing")
  const [note, setNote] = useState("")
  const [published, setPublished] = useState(false)
  const base = useId()

  useEffect(() => {
    let active = true
    api
      .get<AdminUpdate[]>(`/admin/feedback/polls/${pollId}/updates`)
      .then((response) => {
        if (active) setItems(response.data)
      })
      .catch((error: unknown) => {
        if (active) setNotice({ type: "error", text: getErrorMessage(error, "We couldn't load the updates.") })
      })
    return () => {
      active = false
    }
  }, [pollId, reloadKey])

  const add = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!title.trim()) {
      setNotice({ type: "error", text: "Write what change this is about." })
      return
    }
    try {
      await api.post(`/admin/feedback/polls/${pollId}/updates`, { title: title.trim(), status, note: note.trim() || null, published })
      setTitle("")
      setNote("")
      setStatus("reviewing")
      setPublished(false)
      setNotice({ type: "success", text: "Update added." })
      setReloadKey((key) => key + 1)
    } catch (error: unknown) {
      setNotice({ type: "error", text: getErrorMessage(error, "We couldn't add that update.") })
    }
  }

  return (
    <section className="feedback-admin-section" aria-labelledby="updates">
      <h2 id="updates">Update for students</h2>
      <p className="muted small-text">
        Students see the items you show them after the poll closes. With none, they see "We're reviewing your feedback." Nothing changes on
        the site by itself.
      </p>
      <NoticeBanner notice={notice} />
      {items?.length ? (
        <ul className="feedback-update-list">
          {items.map((item) => (
            <UpdateRow
              key={`${item.id}-${reloadKey}`}
              update={item}
              onSaved={(next) => {
                setNotice(next)
                setReloadKey((key) => key + 1)
              }}
            />
          ))}
        </ul>
      ) : null}
      <form className="feedback-update-add" onSubmit={add} aria-label="Add an update">
        <h3>Add an update</h3>
        <UpdateFields
          base={base}
          title={title}
          setTitle={setTitle}
          status={status}
          setStatus={setStatus}
          note={note}
          setNote={setNote}
          published={published}
          setPublished={setPublished}
        />
        <div className="button-row">
          <button type="submit" className="secondary-button">
            Add update
          </button>
        </div>
      </form>
    </section>
  )
}
