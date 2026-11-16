import { useEffect, useState } from "react"
import { Link } from "react-router-dom"
import {
  Article,
  CalendarCheck,
  DownloadSimple,
  Cards,
  ListChecks,
  Microphone,
  Notebook,
  Play,
  Plus,
  Robot,
  Sparkle,
} from "@phosphor-icons/react"

import { api } from "../api"
import { useProfile } from "../auth"
import { Scribble } from "../ui/Scribble"
import { deckStats } from "./deck"
import { weekActivity } from "./celebrate"
import { useDecks } from "./useDecks"

const WEEK_GOAL = 4

const tools = [
  { to: "/notes", title: "Notes", text: "Write down what you're learning so you don't forget.", icon: Notebook, endpoint: "/notes", tone: "sun" },
  { to: "/flashcards", title: "Flashcards", text: "Practice remembering things you learned.", icon: Cards, endpoint: null, tone: "sky" },
  { to: "/quizzes", title: "Quizzes", text: "Test yourself and find out what you know.", icon: ListChecks, endpoint: null, tone: "rose" },
  { to: "/study-sessions", title: "Study Sessions", text: "Plan your study time.", icon: CalendarCheck, endpoint: "/study-sessions", tone: "mint" },
  { to: "/summaries", title: "Summaries", text: "Save short versions of your lessons.", icon: Article, endpoint: "/summaries", tone: "sand" },
  { to: "/voice-input", title: "Voice to Notes", text: "Upload audio and turn it into text.", icon: Microphone, endpoint: null, tone: "lilac" },
  { to: "/import", title: "Import to Notes", text: "Turn a file, link, or video into notes.", icon: DownloadSimple, endpoint: null, tone: "sky" },
  { to: "/ai-tutor", title: "AI Tutor", text: "Get help studying from your AI tutor.", icon: Robot, endpoint: null, tone: "ink" },
]

function greeting(): string {
  const hour = new Date().getHours()
  if (hour < 12) return "Good morning"
  if (hour < 18) return "Good afternoon"
  return "Good evening"
}

export function TodayPage() {
  const profile = useProfile()
  const { decks, loading } = useDecks()
  const [counts, setCounts] = useState<Record<string, number>>({})
  const week = weekActivity()
  const daysStudied = week.filter((day) => day.count > 0).length

  useEffect(() => {
    let active = true
    Promise.allSettled(
      tools
        .filter((tool) => tool.endpoint)
        .map(async (tool) => [tool.to, (await api.get<unknown[]>(tool.endpoint!)).data.length] as const),
    ).then((results) => {
      if (!active) return
      const entries = results.flatMap((result) => (result.status === "fulfilled" ? [result.value] : []))
      setCounts(Object.fromEntries(entries))
    })
    return () => {
      active = false
    }
  }, [])

  const ranked = decks
    .map((deck) => ({ deck, stats: deckStats(deck) }))
    .sort((a, b) => b.stats.due - a.stats.due)
  const best = ranked[0]
  const totalDue = ranked.reduce((sum, entry) => sum + entry.stats.due, 0)
  const cardTotal = ranked.reduce((sum, entry) => sum + entry.stats.total, 0)

  return (
    <div className="today">
      <header className="today-head">
        <p className="eyebrow">{new Date().toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" })}</p>
        <h1>
          {greeting()}
          {profile?.username ? (
            <>
              , <Scribble type="underline">{profile.username}</Scribble>
            </>
          ) : null}
        </h1>
        <p>Pick what you want to work on today.</p>
      </header>

      <section className="next-step" aria-live="polite">
        <div className="next-copy">
          <p className="eyebrow">
            <Sparkle weight="fill" aria-hidden="true" /> Your next step
          </p>
          {loading ? (
            <h2>Looking at your cards...</h2>
          ) : best && best.stats.due > 0 ? (
            <>
              <h2>
                Review {best.stats.due} card{best.stats.due === 1 ? "" : "s"} in “{best.deck.title}”
              </h2>
              <p>
                {totalDue} card{totalDue === 1 ? " is" : "s are"} ready across your decks. A few minutes keeps them glowing.
              </p>
              <Link className="primary-button" to={`/flashcards/${best.deck.id}/study`}>
                <Play weight="fill" aria-hidden="true" /> Start now
              </Link>
            </>
          ) : best ? (
            <>
              <h2>You're all caught up!</h2>
              <p>Want a challenge? Take a quick quiz on “{best.deck.title}”.</p>
              <Link className="primary-button" to={`/quizzes?deck=${best.deck.id}`}>
                <ListChecks weight="bold" aria-hidden="true" /> Quiz me
              </Link>
            </>
          ) : (
            <>
              <h2>Make your first flashcard deck</h2>
              <p>Add a few questions and answers. Luma will tell you when to review each one.</p>
              <Link className="primary-button" to="/flashcards/new">
                <Plus weight="bold" aria-hidden="true" /> Make a deck
              </Link>
            </>
          )}
        </div>
        <div className="next-art" aria-hidden="true">
          <span className="paper-card one" />
          <span className="paper-card two" />
          <span className="paper-card three">
            <img src="/luma-star.png" alt="" />
          </span>
        </div>
      </section>

      <section className="glow-week paper-panel">
        <div>
          <h2>Weekly glow goal</h2>
          <p>
            Study {WEEK_GOAL} days this week. <strong>{Math.min(daysStudied, WEEK_GOAL)}/{WEEK_GOAL}</strong> done
            {daysStudied >= WEEK_GOAL ? " — goal reached!" : "."}
          </p>
        </div>
        <ol className="week-dots">
          {week.map((day) => (
            <li key={day.key} className={[day.count > 0 ? "lit" : "", day.isToday ? "today" : "", day.isFuture ? "future" : ""].join(" ")}>
              <span className="week-star" aria-hidden="true" />
              <small>{day.label}</small>
              <span className="sr-only">{day.count > 0 ? `studied ${day.count} cards` : "no study yet"}</span>
            </li>
          ))}
        </ol>
        <p className="muted small-text">{cardTotal} flashcard{cardTotal === 1 ? "" : "s"} in {decks.length} deck{decks.length === 1 ? "" : "s"}</p>
      </section>

      <section className="tool-grid" aria-label="Study tools">
        {tools.map((tool, index) => (
          <Link key={tool.to} to={tool.to} className={`tool-tile tone-${tool.tone}`} style={{ animationDelay: `${index * 40}ms` }}>
            <tool.icon weight="duotone" aria-hidden="true" />
            <strong>{tool.title}</strong>
            <p>{tool.text}</p>
            {counts[tool.to] !== undefined ? <span className="tile-count">{counts[tool.to]}</span> : null}
          </Link>
        ))}
      </section>
    </div>
  )
}
