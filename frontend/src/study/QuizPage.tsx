import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import type { CSSProperties, FormEvent, KeyboardEvent as ReactKeyboardEvent } from "react"
import { Link, useSearchParams } from "react-router-dom"
import { AnimatePresence, motion } from "motion/react"
import { ArrowLeft, ArrowsClockwise, Cards, Check, Lightning, Play, Target, X } from "@phosphor-icons/react"

import { NoticeBanner } from "../ui/common"
import { Scribble } from "../ui/Scribble"
import { shuffle } from "./deck"
import type { Deck, DeckCard } from "./deck"
import { celebrate, recordStudy } from "./celebrate"
import { useDecks } from "./useDecks"
import { STUDY_HUB, parseDeckParam, pickDecks } from "./hub"
import { getTabAccountId } from "../api"

type QuestionKind = "choice" | "truefalse" | "type"

type Question = {
  id: string
  kind: QuestionKind
  prompt: string
  answer: string
  /** For multiple choice. */
  options?: string[]
  /** For true/false: the answer shown to the student. */
  shown?: string
  deckTitle: string
}

type Answer = { question: Question; given: string; correct: boolean }

const shapes = ["circle", "triangle", "square", "diamond"] as const

function normalize(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
}

/** Small typos are OK: allows about 1 mistake per 6 letters. */
function closeEnough(given: string, expected: string): boolean {
  const a = normalize(given)
  const b = normalize(expected)
  if (!a) return false
  if (a === b) return true
  const allowed = Math.floor(b.length / 6)
  if (allowed === 0) return false
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)] as number[])
  for (let j = 1; j <= b.length; j += 1) dp[0][j] = j
  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
    }
  }
  return dp[a.length][b.length] <= allowed
}

function buildQuiz(decks: Deck[], length: number, kinds: QuestionKind[]): Question[] {
  const pool: (DeckCard & { deckTitle: string })[] = decks.flatMap((deck) =>
    deck.cards.map((card) => ({ ...card, deckTitle: deck.title })),
  )
  const answers = Array.from(new Set(pool.map((card) => card.back)))
  const picked = shuffle(pool).slice(0, length)

  return picked.map((card, index) => {
    const others = shuffle(answers.filter((answer) => answer !== card.back))
    let kind = kinds[index % kinds.length]
    if (kind === "choice" && others.length < 1) kind = kinds.includes("type") ? "type" : "truefalse"
    if (kind === "truefalse" && others.length < 1) kind = "type"

    const base = { id: `${card.id}-${index}`, prompt: card.front, answer: card.back, deckTitle: card.deckTitle }
    if (kind === "choice") {
      return { ...base, kind, options: shuffle([card.back, ...others.slice(0, 3)]) }
    }
    if (kind === "truefalse") {
      const honest = Math.random() < 0.5
      return { ...base, kind, shown: honest ? card.back : others[0] }
    }
    return { ...base, kind: "type" as const }
  })
}

export function QuizPage() {
  const { decks, loading, error } = useDecks()
  const [params] = useSearchParams()
  // One deck (?deck=a) or several (?deck=a,b).
  const requested = parseDeckParam(params.get("deck"))
  const usable = useMemo(() => decks.filter((deck) => deck.cards.length > 0), [decks])

  const [picked, setSelected] = useState<string[] | null>(null)
  const [length, setLength] = useState(10)
  const [kinds, setKinds] = useState<QuestionKind[]>(["choice", "truefalse", "type"])
  const [questions, setQuestions] = useState<Question[] | null>(null)

  const selected = picked ?? pickDecks(requested, usable.map((deck) => deck.id))

  const chosenDecks = usable.filter((deck) => selected.includes(deck.id))
  const cardCount = chosenDecks.reduce((sum, deck) => sum + deck.cards.length, 0)

  const begin = () => {
    if (chosenDecks.length === 0 || kinds.length === 0) return
    setQuestions(buildQuiz(chosenDecks, Math.min(length, cardCount), shuffle(kinds)))
  }

  if (questions) {
    return (
      <QuizRun
        key={questions.map((question) => question.id).join("|")}
        questions={questions}
        onExit={() => setQuestions(null)}
        onRetry={(missed) => setQuestions(shuffle(missed.map((question, index) => ({ ...question, id: `${question.id}-r${index}` }))))}
        onNew={begin}
      />
    )
  }

  const toggleKind = (kind: QuestionKind) =>
    setKinds((current) => (current.includes(kind) ? current.filter((k) => k !== kind) : [...current, kind]))

  return (
    <>
      <header className="page-head">
        <div>
          <h1>
            Quiz <Scribble type="underline">yourself</Scribble>
          </h1>
          <p className="lede">Answer questions made from your flashcards.</p>
        </div>
        <div className="page-head-actions">
          <Link className="ghost-button" to={STUDY_HUB}>
            <ArrowLeft weight="bold" aria-hidden="true" /> Back to Study
          </Link>
        </div>
      </header>
      <NoticeBanner notice={error ? { type: "error", text: error } : null} />
      {loading ? (
        <div className="loading-card" role="status">
          <span className="spinner" />
          <p>Getting your decks...</p>
        </div>
      ) : null}

      {!loading && usable.length === 0 ? (
        <section className="empty-state">
          <Target size={56} weight="duotone" aria-hidden="true" />
          <h2>Make a deck first</h2>
          <p>Your quizzes use your cards. Make a deck and come back.</p>
          <Link className="primary-button" to="/flashcards/new">
            <Cards weight="bold" aria-hidden="true" /> Make a deck
          </Link>
        </section>
      ) : null}

      {!loading && usable.length > 0 ? (
        <div className="quiz-setup">
          <section className="quiz-step" aria-labelledby="quiz-step-decks">
            <div className="section-head">
              <h2 id="quiz-step-decks">1. Pick your decks</h2>
            </div>
            <div className="choice-chips">
              {usable.map((deck) => {
                const on = selected.includes(deck.id)
                return (
                  <button
                    key={deck.id}
                    type="button"
                    className={on ? "chip on" : "chip"}
                    aria-pressed={on}
                    onClick={() =>
                      setSelected(on ? selected.filter((id) => id !== deck.id) : [...selected, deck.id])
                    }
                  >
                    {on ? <Check weight="bold" aria-hidden="true" /> : null}
                    {deck.title}
                    <small>{deck.cards.length}</small>
                  </button>
                )
              })}
            </div>
          </section>

          <section className="quiz-step" aria-labelledby="quiz-step-kinds">
            <div className="section-head">
              <h2 id="quiz-step-kinds">2. Pick question types</h2>
            </div>
            <div className="choice-chips">
              {(
                [
                  ["choice", "Pick the answer"],
                  ["truefalse", "True or false"],
                  ["type", "Type the answer"],
                ] as [QuestionKind, string][]
              ).map(([kind, label]) => {
                const on = kinds.includes(kind)
                return (
                  <button key={kind} type="button" className={on ? "chip on" : "chip"} aria-pressed={on} onClick={() => toggleKind(kind)}>
                    {on ? <Check weight="bold" aria-hidden="true" /> : null}
                    {label}
                  </button>
                )
              })}
            </div>
          </section>

          <section className="quiz-step" aria-labelledby="quiz-step-count">
            <div className="section-head">
              <h2 id="quiz-step-count">3. How many questions?</h2>
            </div>
            <div className="choice-chips">
              {[5, 10, 20].map((count) => (
                <button
                  key={count}
                  type="button"
                  className={length === count ? "chip on" : "chip"}
                  aria-pressed={length === count}
                  onClick={() => setLength(count)}
                >
                  {count}
                </button>
              ))}
            </div>
            <p className="muted small-text" aria-live="polite">
              {cardCount} card{cardCount === 1 ? "" : "s"} picked
              {cardCount < length ? ` — the quiz will have ${cardCount} question${cardCount === 1 ? "" : "s"}.` : "."}
            </p>
          </section>

          <div className="sticky-save">
            <span aria-live="polite">
              {chosenDecks.length === 0
                ? "Pick at least one deck."
                : kinds.length === 0
                  ? "Pick at least one question type"
                  : "Ready when you are"}
            </span>
            <button type="button" className="primary-button" onClick={begin} disabled={chosenDecks.length === 0 || kinds.length === 0}>
              <Play weight="fill" aria-hidden="true" /> Start quiz
            </button>
          </div>
        </div>
      ) : null}
    </>
  )
}

function QuizRun({
  questions,
  onExit,
  onRetry,
  onNew,
}: {
  questions: Question[]
  onExit: () => void
  onRetry: (missed: Question[]) => void
  onNew: () => void
}) {
  const [index, setIndex] = useState(0)
  const [answers, setAnswers] = useState<Answer[]>([])
  const [typed, setTyped] = useState("")
  const [streak, setStreak] = useState(0)
  const stageRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  // Each typed question gets a new answer box once the old question has animated out
  // (AnimatePresence mode="wait"), so focus it when it appears, not when the index changes.
  const answerBoxRef = useCallback((node: HTMLInputElement | null) => {
    inputRef.current = node
    if (node && !node.disabled) node.focus()
  }, [])

  const question = questions[index]
  const answered = answers.length > index ? answers[index] : null
  const finished = index >= questions.length

  useEffect(() => {
    if (finished) {
      const score = answers.filter((answer) => answer.correct).length
      recordStudy(getTabAccountId(), answers.length)
      if (score / Math.max(1, answers.length) >= 0.7) {
        const accent = getComputedStyle(document.documentElement).getPropertyValue("--accent").trim()
        celebrate(accent || undefined)
      }
      return
    }
    if (question?.kind === "type") inputRef.current?.focus()
    else stageRef.current?.focus()
    // Only run when the question changes or the quiz ends.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [index, finished])

  const submit = useCallback(
    (given: string) => {
      if (!question || answered) return
      const correct =
        question.kind === "truefalse"
          ? (given === "true") === (question.shown === question.answer)
          : question.kind === "type"
            ? closeEnough(given, question.answer)
            : given === question.answer
      setAnswers((current) => [...current, { question, given, correct }])
      setStreak((value) => (correct ? value + 1 : 0))
    },
    [answered, question],
  )

  const next = () => {
    setTyped("")
    setIndex((value) => value + 1)
  }

  const onKey = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (!question) return
    if (answered && (event.key === "Enter" || event.key === " ")) {
      event.preventDefault()
      next()
      return
    }
    if (answered) return
    if (question.kind === "choice" && question.options) {
      const pick = Number(event.key) - 1
      if (pick >= 0 && pick < question.options.length) submit(question.options[pick])
    }
    if (question.kind === "truefalse") {
      if (event.key.toLowerCase() === "t" || event.key === "1") submit("true")
      if (event.key.toLowerCase() === "f" || event.key === "2") submit("false")
    }
  }

  if (finished) {
    const score = answers.filter((answer) => answer.correct).length
    const percent = Math.round((score / Math.max(1, answers.length)) * 100)
    const missed = answers.filter((answer) => !answer.correct)
    const message = percent >= 90 ? "Superstar!" : percent >= 70 ? "Great job!" : percent >= 40 ? "Nice try!" : "Keep going!"

    return (
      <section className="session-recap">
        <p className="eyebrow">Quiz done</p>
        <div className="score-ring" style={{ "--score": percent } as CSSProperties}>
          <strong>{percent}%</strong>
          <small>
            {score} of {answers.length}
          </small>
        </div>
        <h1>
          <Scribble type="highlight">{message}</Scribble>
        </h1>
        {missed.length > 0 ? (
          <section className="recap-list" aria-labelledby="quiz-missed-title">
            <div className="section-head">
              <h2 id="quiz-missed-title">Study these again</h2>
            </div>
            <ul className="card-list compact">
              {missed.map((answer) => (
                <li key={answer.question.id}>
                  <div>
                    <p className="card-q">{answer.question.prompt}</p>
                    <p className="card-a">
                      <Check weight="bold" aria-hidden="true" /> {answer.question.answer}
                    </p>
                    {answer.question.kind !== "truefalse" && answer.given ? (
                      <p className="card-wrong">
                        <X weight="bold" aria-hidden="true" /> You said: {answer.given}
                      </p>
                    ) : null}
                  </div>
                  <span className="deck-tag">{answer.question.deckTitle}</span>
                </li>
              ))}
            </ul>
          </section>
        ) : (
          <p className="hand-note">You got every one right!</p>
        )}
        <div className="button-row center">
          {missed.length > 0 ? (
            <button type="button" className="primary-button" onClick={() => onRetry(missed.map((answer) => answer.question))}>
              <ArrowsClockwise weight="bold" aria-hidden="true" /> Retry missed
            </button>
          ) : null}
          <button type="button" className="secondary-button" onClick={onNew}>
            <Lightning weight="bold" aria-hidden="true" /> New quiz
          </button>
          <button type="button" className="ghost-button" onClick={onExit}>
            Change settings
          </button>
        </div>
      </section>
    )
  }

  const typedSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (answered) next()
    else if (typed.trim()) submit(typed)
  }

  return (
    <section className="study-room quiz-room">
      <header className="study-top">
        <button type="button" className="icon-button" onClick={onExit} aria-label="Stop quiz">
          <ArrowLeft weight="bold" aria-hidden="true" />
        </button>
        <div
          className="progress-track"
          role="progressbar"
          aria-label="Questions done"
          aria-valuenow={index}
          aria-valuemin={0}
          aria-valuemax={questions.length}
        >
          <span style={{ width: `${(index / questions.length) * 100}%` }} />
        </div>
        <span className="study-count">
          {index + 1}/{questions.length}
        </span>
      </header>

      <div className="quiz-stage" ref={stageRef} tabIndex={-1} onKeyDown={onKey}>
        <AnimatePresence mode="wait" initial={false}>
          <motion.div
            key={question.id}
            className="quiz-question"
            initial={{ opacity: 0, y: 24 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -16 }}
            transition={{ duration: 0.22 }}
          >
            <p className="quiz-kind">
              {question.kind === "choice" ? "Pick the answer" : question.kind === "truefalse" ? "True or false?" : "Type the answer"}
              {streak >= 3 ? <span className="streak-pill">{streak} in a row!</span> : null}
            </p>
            <h2 className="quiz-prompt">{question.prompt}</h2>

            {question.kind === "truefalse" ? (
              <p className="tf-claim">
                Answer: <strong>{question.shown}</strong>
              </p>
            ) : null}

            {question.kind === "choice" && question.options ? (
              <div className="answer-grid">
                {question.options.map((option, optionIndex) => {
                  const state = !answered
                    ? ""
                    : option === question.answer
                      ? "right"
                      : option === answered.given
                        ? "wrong"
                        : "dim"
                  return (
                    <button
                      key={option}
                      type="button"
                      className={`answer-button shape-${shapes[optionIndex]} ${state}`}
                      onClick={() => submit(option)}
                      disabled={Boolean(answered)}
                    >
                      <span className="answer-shape" aria-hidden="true" />
                      <span>{option}</span>
                      <kbd aria-hidden="true">{optionIndex + 1}</kbd>
                    </button>
                  )
                })}
              </div>
            ) : null}

            {question.kind === "truefalse" ? (
              <div className="answer-grid two">
                {(["true", "false"] as const).map((value, valueIndex) => {
                  const isRight = (value === "true") === (question.shown === question.answer)
                  const state = !answered ? "" : isRight ? "right" : answered.given === value ? "wrong" : "dim"
                  return (
                    <button
                      key={value}
                      type="button"
                      className={`answer-button shape-${shapes[valueIndex]} ${state}`}
                      onClick={() => submit(value)}
                      disabled={Boolean(answered)}
                    >
                      <span className="answer-shape" aria-hidden="true" />
                      <span>{value === "true" ? "True" : "False"}</span>
                      <kbd aria-hidden="true">{value === "true" ? "T" : "F"}</kbd>
                    </button>
                  )
                })}
              </div>
            ) : null}

            {question.kind === "type" ? (
              <form className="type-answer" onSubmit={typedSubmit}>
                <input
                  ref={answerBoxRef}
                  value={typed}
                  onChange={(event) => setTyped(event.target.value)}
                  placeholder="Type your answer"
                  disabled={Boolean(answered)}
                  autoComplete="off"
                  aria-label="Your answer"
                />
                <button type="submit" className="primary-button" disabled={!answered && !typed.trim()}>
                  {answered ? "Next" : "Check"}
                </button>
              </form>
            ) : null}
          </motion.div>
        </AnimatePresence>
      </div>

      <AnimatePresence>
        {answered ? (
          <motion.div
            className={answered.correct ? "feedback-bar right" : "feedback-bar wrong"}
            initial={{ y: 80, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            exit={{ y: 80, opacity: 0 }}
            transition={{ type: "spring", stiffness: 380, damping: 30 }}
            role="status"
          >
            <div>
              <strong>
                {answered.correct ? (
                  <>
                    <Check weight="bold" aria-hidden="true" /> {["Yes!", "Nailed it!", "Correct!", "You got it!"][index % 4]}
                  </>
                ) : (
                  <>
                    <X weight="bold" aria-hidden="true" /> Not quite
                  </>
                )}
              </strong>
              {!answered.correct || question.kind === "type" ? <p>Answer: {question.answer}</p> : null}
            </div>
            <button type="button" className="primary-button" onClick={next} autoFocus={question.kind !== "type"}>
              {index + 1 === questions.length ? "See results" : "Next"}
            </button>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </section>
  )
}
