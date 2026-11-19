import { useCallback, useEffect, useId, useRef, useState } from "react"
import type { FormEvent, ReactNode } from "react"
import { Link } from "react-router-dom"

import { api, getErrorCode, getErrorMessage } from "../api"
import { useAuth } from "../auth"
import { NoticeBanner, PageHeader } from "../ui/common"
import type { Notice } from "../ui/common"
import { Scribble } from "../ui/Scribble"
import {
  COMMENT_HINT,
  COMMENT_LABEL,
  COMMENT_MAX,
  NO_LABEL,
  ONE_VOTE_LINE,
  POLL_INTRO,
  PRIVACY_LINE,
  YES_LABEL,
  answerList,
  charactersLeftLine,
  codePointLength,
  draftKey,
  formatCentral,
  hasAnswered,
  hasSomething,
  msUntil,
  parseDraft,
  reviewSummary,
} from "./feedback"
import type { Choice, CurrentFeedback, OpenPoll } from "./feedback"

type Step = "form" | "review" | "sent" | "closed" | "skipped"

/** Title that keeps the hand-drawn yellow underline on one word. */
export function PollTitle() {
  return (
    <>
      If it ain't broke why <Scribble type="underline">fix it?!</Scribble>
    </>
  )
}

function readDraft(key: string | null, poll: OpenPoll) {
  if (!key) return null
  try {
    return parseDraft(window.sessionStorage.getItem(key), poll.questions)
  } catch {
    return null
  }
}

function writeDraft(key: string | null, value: { answers: Record<string, Choice>; comment: string } | null) {
  if (!key) return
  try {
    if (value) window.sessionStorage.setItem(key, JSON.stringify(value))
    else window.sessionStorage.removeItem(key)
  } catch {
    // The draft just isn't kept on this device.
  }
}

/** The monthly poll page: answer, check, send. Or skip the whole thing in one tap. */
export function FeedbackPage() {
  const { activeAccountId, user } = useAuth()
  const [data, setData] = useState<CurrentFeedback | null>(null)
  const [loadError, setLoadError] = useState(false)
  const [reloadKey, setReloadKey] = useState(0)
  // The poll this page showed last, so a poll that closes while the page is open says so.
  const [shownPoll, setShownPoll] = useState<OpenPoll | null>(null)

  useEffect(() => {
    let active = true
    api
      .get<CurrentFeedback>("/feedback/current")
      .then((response) => {
        if (active) {
          setData(response.data)
          if (response.data.poll) setShownPoll(response.data.poll)
          setLoadError(false)
        }
      })
      .catch(() => {
        if (active) setLoadError(true)
      })
    return () => {
      active = false
    }
  }, [reloadKey])

  // When the poll closes, ask the server again so the page changes without a reload.
  // The page never decides by itself that the poll is closed.
  // The wait is measured on the server's clock, not this device's, so a wrong device clock can't loop.
  const closesAt = data?.poll?.closes_at
  const serverNow = data?.server_now
  useEffect(() => {
    if (!closesAt || !serverNow) return
    const wait = msUntil(closesAt, new Date(serverNow).getTime())
    if (wait <= 0) return
    const timer = window.setTimeout(() => setReloadKey((key) => key + 1), Math.min(wait + 500, 2 ** 31 - 1))
    return () => window.clearTimeout(timer)
  }, [closesAt, serverNow])

  const header = (description?: string) => (
    <PageHeader
      eyebrow={data?.poll ? `Monthly poll · Open until ${formatCentral(data.poll.closes_at)} Central time` : "Monthly poll"}
      title={<PollTitle />}
      description={description}
    />
  )

  if (loadError) {
    return (
      <div className="feedback-page">
        {header()}
        <div className="notice error" role="alert">
          We couldn't load the poll. Check your connection and try again.
        </div>
        <button type="button" className="secondary-button" onClick={() => setReloadKey((key) => key + 1)}>
          Try again
        </button>
      </div>
    )
  }

  if (!data) {
    return (
      <div className="feedback-page">
        {header()}
        <p className="muted" aria-busy="true">
          Loading the poll...
        </p>
      </div>
    )
  }

  if (!data.poll && shownPoll && new Date(data.server_now).getTime() >= new Date(shownPoll.closes_at).getTime()) {
    return (
      <div className="feedback-page">
        {header()}
        <section className="feedback-done" aria-labelledby="closed-now-title">
          <h2 id="closed-now-title">This poll closed.</h2>
          <p>It closed {formatCentral(shownPoll.closes_at)} Central time. Thanks for taking a look!</p>
          <div className="button-row">
            <Link className="secondary-button" to="/feedback/results">
              See the results
            </Link>
          </div>
        </section>
      </div>
    )
  }

  if (!data.poll) {
    return (
      <div className="feedback-page">
        {header()}
        <section className="feedback-empty" aria-labelledby="no-poll-title">
          <h2 id="no-poll-title">There's no poll open right now.</h2>
          <p>
            {data.next_opens_at
              ? `The next one opens ${formatCentral(data.next_opens_at)} Central time.`
              : "A new poll opens on the last Sunday of each month at noon Central time."}
          </p>
          <div className="button-row">
            <Link className="secondary-button" to="/feedback/results">
              Past results
            </Link>
          </div>
        </section>
      </div>
    )
  }

  return (
    <OpenPollView
      key={data.poll.id}
      data={data}
      poll={data.poll}
      accountId={activeAccountId}
      email={user?.email ?? null}
      header={header}
      onReload={() => setReloadKey((key) => key + 1)}
    />
  )
}

function OpenPollView({
  data,
  poll,
  accountId,
  email,
  header,
  onReload,
}: {
  email: string | null
  data: CurrentFeedback
  poll: OpenPoll
  accountId: string | null
  header: (description?: string) => ReactNode
  onReload: () => void
}) {
  const key = accountId ? draftKey(accountId, poll.id) : null
  const max = poll.comment_max || COMMENT_MAX
  const [answers, setAnswers] = useState<Record<string, Choice>>(() => readDraft(key, poll)?.answers ?? {})
  const [comment, setComment] = useState(() => readDraft(key, poll)?.comment ?? "")
  const [step, setStep] = useState<Step>(data.skipped ? "skipped" : "form")
  const [notice, setNotice] = useState<Notice | null>(null)
  const [sending, setSending] = useState(false)
  const [skipping, setSkipping] = useState(false)
  const [skipFailed, setSkipFailed] = useState(false)
  const sendingRef = useRef(false)
  const stepHeadingRef = useRef<HTMLHeadingElement>(null)
  const firstStep = useRef(true)
  const commentHintId = useId()
  const commentCountId = useId()
  const commentRef = useRef<HTMLTextAreaElement>(null)

  const tooLong = codePointLength(comment) > max

  useEffect(() => {
    if (step === "form" || step === "skipped") writeDraft(key, { answers, comment })
  }, [key, answers, comment, step])

  // Move focus to the new step's heading, so keyboard and screen-reader users land on it.
  useEffect(() => {
    if (firstStep.current) {
      firstStep.current = false
      return
    }
    stepHeadingRef.current?.focus()
  }, [step])

  const choose = (questionId: string, choice: Choice | null) => {
    // An old "answer something" message goes away as soon as they answer.
    setNotice(null)
    setAnswers((current) => {
      const next = { ...current }
      if (choice) next[questionId] = choice
      else delete next[questionId]
      return next
    })
  }

  const review = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (tooLong) {
      // The counter under the box already says how much to cut; take them there.
      setNotice(null)
      commentRef.current?.focus()
      return
    }
    if (!hasSomething(poll.questions, answers, comment)) {
      setNotice({ type: "error", text: "Answer at least one question, or skip the poll." })
      return
    }
    setNotice(null)
    setStep("review")
  }

  const send = async () => {
    if (sendingRef.current) return
    sendingRef.current = true
    setSending(true)
    setNotice(null)
    try {
      await api.post(`/feedback/polls/${poll.id}/responses`, {
        answers: answerList(poll.questions, answers),
        comment: comment.trim() ? comment : null,
      })
      // 201 (received) and 200 (we already had them) both mean the answers are in.
      writeDraft(key, null)
      setStep("sent")
    } catch (error: unknown) {
      const code = getErrorCode(error)
      if (code === "poll_closed") {
        writeDraft(key, null)
        setStep("closed")
      } else if (code === "comment_too_long" || code === "empty_response" || code === "email_unverified") {
        setNotice({ type: "error", text: getErrorMessage(error) })
        setStep("form")
      } else {
        setNotice({ type: "error", text: "We couldn't send your answers. They're still here. Try again." })
      }
    } finally {
      sendingRef.current = false
      setSending(false)
    }
  }

  const skip = async () => {
    setSkipping(true)
    setSkipFailed(false)
    try {
      // Remembered by the server; skipping is never a vote.
      await api.post(`/feedback/polls/${poll.id}/skip`)
      setNotice(null)
      setStep("skipped")
    } catch {
      setSkipFailed(true)
    } finally {
      setSkipping(false)
    }
  }

  const verifyHref = email ? `/verify-email?email=${encodeURIComponent(email)}` : "/verify-email"
  const resultsLine = `Results come out ${formatCentral(poll.closes_at)} Central time.`

  const blocked = data.blocked_reason === "email_unverified"

  const skipBlock = (
    <div className="feedback-skip">
      <p>Not today?</p>
      <button type="button" className="secondary-button" disabled={skipping} onClick={() => void skip()}>
        Skip this poll
      </button>
      {skipFailed && (
        <p role="alert" className="feedback-skip-error">
          We couldn't skip the poll just now. Try again.
        </p>
      )}
    </div>
  )

  // ------------------------------------------------------------- blocked: email not verified
  if (blocked && step !== "skipped") {
    return (
      <div className="feedback-page">
        {header(POLL_INTRO)}
        <div className="verify-banner feedback-verify">
          <p>Verify your email to answer the poll.</p>
          <Link className="secondary-button" to={verifyHref}>
            Enter code
          </Link>
        </div>
        {skipBlock}
      </div>
    )
  }

  // ------------------------------------------------------------- already answered
  if (hasAnswered(data) && step !== "sent") {
    const mine = data.my_response
    const chosen: Record<string, Choice> = Object.fromEntries((mine?.answers ?? []).map((a) => [a.question_id, a.choice]))
    return (
      <div className="feedback-page">
        {header()}
        <section className="feedback-done" aria-labelledby="done-title">
          <h2 id="done-title">We already have your answers for this poll. Thanks!</h2>
          <p>{resultsLine}</p>
          {mine?.answers.length || mine?.comment ? (
            <>
              <h3 className="feedback-subhead">Your answers</h3>
              <ReviewList poll={poll} answers={chosen} comment={mine.comment ?? ""} />
            </>
          ) : null}
          <div className="button-row">
            <Link className="secondary-button" to="/dashboard">
              Back to Home
            </Link>
          </div>
        </section>
      </div>
    )
  }

  if (step === "sent") {
    return (
      <div className="feedback-page">
        {header()}
        <section className="feedback-done" role="status" aria-labelledby="sent-title">
          <h2 id="sent-title" ref={stepHeadingRef} tabIndex={-1}>
            Thanks! We got your answers.
          </h2>
          <p>{resultsLine}</p>
          <div className="button-row">
            <Link className="secondary-button" to="/dashboard">
              Back to Home
            </Link>
          </div>
        </section>
      </div>
    )
  }

  if (step === "closed") {
    return (
      <div className="feedback-page">
        {header()}
        <section className="feedback-done" aria-labelledby="closed-title">
          <h2 id="closed-title" ref={stepHeadingRef} tabIndex={-1}>
            This poll closed before your answers arrived.
          </h2>
          <p>It closed {formatCentral(poll.closes_at)} Central time. Thanks for trying!</p>
          <div className="button-row">
            <Link className="secondary-button" to="/feedback/results">
              See the results
            </Link>
          </div>
        </section>
      </div>
    )
  }

  if (step === "skipped") {
    return (
      <div className="feedback-page">
        {header()}
        <section className="feedback-done" aria-labelledby="skipped-title">
          <h2 id="skipped-title" ref={stepHeadingRef} tabIndex={-1}>
            You skipped this poll. That's okay!
          </h2>
          <p>
            {blocked
              ? "We won't ask you about it again."
              : `We won't ask you about it again. You can still answer it until ${formatCentral(poll.closes_at)} Central time.`}
          </p>
          <div className="button-row">
            <Link className="secondary-button" to="/dashboard">
              Back to Home
            </Link>
            {blocked ? null : (
              <button type="button" className="ghost-button" onClick={() => setStep("form")}>
                Answer it anyway
              </button>
            )}
          </div>
        </section>
      </div>
    )
  }

  if (step === "review") {
    return (
      <div className="feedback-page">
        {header()}
        <section className="feedback-review" aria-labelledby="review-title">
          <h2 id="review-title" ref={stepHeadingRef} tabIndex={-1}>
            Check your answers
          </h2>
          <ReviewList poll={poll} answers={answers} comment={comment} />
          <p className="feedback-final">You can't change your answers after you send them.</p>
          <NoticeBanner notice={notice} />
          <div className="button-row">
            <button type="button" className="primary-button" disabled={sending} onClick={() => void send()}>
              {sending ? "Sending..." : "Send my answers"}
            </button>
            <button type="button" className="secondary-button" disabled={sending} onClick={() => setStep("form")}>
              Change my answers
            </button>
          </div>
        </section>
      </div>
    )
  }

  const ordered = [...poll.questions].sort((a, b) => a.position - b.position)
  return (
    <div className="feedback-page">
      {header(POLL_INTRO)}
      <div className="feedback-privacy">
        <p>
          <strong>{PRIVACY_LINE}</strong> {ONE_VOTE_LINE}
        </p>
        <p className="muted small-text">Yes means "I want this change." No means "Keep it as it is." You can leave any question blank.</p>
      </div>

      {skipBlock}

      <form className="feedback-form" onSubmit={review} noValidate>
        <ol className="feedback-questions">
          {ordered.map((question, index) => (
            <li key={question.id}>
              <fieldset className="feedback-question">
                <legend>
                  <span className="feedback-number">{index + 1}.</span> {question.label}
                </legend>
                <div className="feedback-choices">
                  {(["yes", "no"] as const).map((choice) => (
                    <label key={choice} className={`feedback-choice${answers[question.id] === choice ? " active" : ""}`}>
                      <input
                        type="radio"
                        name={`q-${question.id}`}
                        value={choice}
                        checked={answers[question.id] === choice}
                        onChange={() => choose(question.id, choice)}
                      />
                      <span>{choice === "yes" ? YES_LABEL : NO_LABEL}</span>
                    </label>
                  ))}
                </div>
                {answers[question.id] ? (
                  <button type="button" className="ghost-button small feedback-clear" onClick={() => choose(question.id, null)}>
                    Clear answer<span className="sr-only"> for question {index + 1}</span>
                  </button>
                ) : null}
              </fieldset>
            </li>
          ))}
        </ol>

        <div className="feedback-comment">
          <label htmlFor="feedback-comment">{COMMENT_LABEL} (optional)</label>
          <p id={commentHintId} className="field-hint">
            {COMMENT_HINT}
          </p>
          <textarea
            id="feedback-comment"
            ref={commentRef}
            value={comment}
            rows={4}
            aria-describedby={`${commentHintId} ${commentCountId}`}
            aria-invalid={tooLong || undefined}
            onChange={(event) => {
              setNotice(null)
              setComment(event.target.value)
            }}
          />
          <p id={commentCountId} className={`feedback-count${tooLong ? " over" : ""}`}>
            {charactersLeftLine(comment, max)}
          </p>
          {/* Says it once when the comment goes over (or back under), not on every key. */}
          <p className="sr-only" aria-live="polite">
            {tooLong ? `Your comment is over ${max} characters.` : ""}
          </p>
        </div>

        <NoticeBanner notice={notice} />
        <div className="button-row">
          <button type="submit" className="primary-button">
            Review my answers
          </button>
        </div>
      </form>
      <ReloadOnFocus onReload={onReload} />
    </div>
  )
}

/** The answers as plain text, one row per question. */
function ReviewList({ poll, answers, comment }: { poll: OpenPoll; answers: Record<string, Choice>; comment: string }) {
  return (
    <>
      <ol className="feedback-summary">
        {reviewSummary(poll.questions, answers).map((row) => (
          <li key={row.id}>
            <span className="feedback-summary-q">
              {row.number}. {row.label}
            </span>
            <strong className="feedback-summary-a">{row.answer}</strong>
          </li>
        ))}
      </ol>
      <div className="feedback-summary-comment">
        <h3 className="feedback-subhead">Your comment</h3>
        {comment.trim() ? <p className="feedback-text">{comment}</p> : <p className="muted">No comment.</p>}
      </div>
    </>
  )
}

/** Checks again when the tab comes back, so a poll answered in another tab shows as answered. */
function ReloadOnFocus({ onReload }: { onReload: () => void }) {
  const reload = useCallback(() => {
    if (document.visibilityState === "visible") onReload()
  }, [onReload])
  useEffect(() => {
    document.addEventListener("visibilitychange", reload)
    return () => document.removeEventListener("visibilitychange", reload)
  }, [reload])
  return null
}
