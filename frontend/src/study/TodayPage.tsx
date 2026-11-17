import { useEffect, useState } from "react"
import { Link } from "react-router-dom"
import {
  Cards,
  DownloadSimple,
  Image,
  ListChecks,
  Microphone,
  Notebook,
  PencilSimpleLine,
  Play,
  Plus,
  Sparkle,
} from "@phosphor-icons/react"

import { api } from "../api"
import { useAuth, useProfile } from "../auth"
import { Scribble } from "../ui/Scribble"
import { IMAGE_NOTES, IMPORT_NOTES, NEW_NOTE, VOICE_NOTES } from "../notes/paths"
import { deckStats } from "./deck"
import { weekActivity } from "./celebrate"
import { useDecks } from "./useDecks"

const WEEK_GOAL = 4
/** How many items the Recent list shows. Home stays short; the hubs show the rest. */
const RECENT_LIMIT = 4

/** Small links to start something. Shown from 720px; on phones the + button does this. */
const quickStart = [
  { to: NEW_NOTE, label: "Write a note", icon: PencilSimpleLine },
  { to: IMPORT_NOTES, label: "Import a file", icon: DownloadSimple },
  { to: VOICE_NOTES, label: "Voice to notes", icon: Microphone },
  { to: IMAGE_NOTES, label: "Image to notes", icon: Image },
  { to: "/flashcards", label: "Review cards", icon: Cards },
]

type NoteSummary = { id: string; title?: string | null; created_at?: string | null; updated_at?: string | null }
type RecentItem = { key: string; to: string; kind: "Note" | "Deck"; title: string; detail: string | null; when: string | null }

function greeting(): string {
  const hour = new Date().getHours()
  if (hour < 12) return "Good morning"
  if (hour < 18) return "Good afternoon"
  return "Good evening"
}

/** About 12 seconds a card, rounded up to whole minutes. */
function minutesFor(cards: number): number {
  return Math.max(1, Math.ceil((cards * 12) / 60))
}

/**
 * "8 cards are ready across your decks. About 2 minutes." The time is for the same count
 * as the sentence. A no-break space keeps "2 minutes" together on one line.
 */
function readyLine(total: number, manyDecks: boolean): string {
  const minutes = minutesFor(total)
  const cards = `${total}\u00a0card${total === 1 ? " is" : "s are"} ready${manyDecks ? " across your decks" : ""}.`
  return `${cards} About ${minutes}\u00a0minute${minutes === 1 ? "" : "s"}.`
}

function shortDate(value: string | null): string | null {
  if (!value) return null
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? null : date.toLocaleDateString(undefined, { month: "short", day: "numeric" })
}

export function TodayPage() {
  const profile = useProfile()
  const { activeAccountId } = useAuth()
  const { decks, loading } = useDecks()
  const [notes, setNotes] = useState<NoteSummary[]>([])
  const week = weekActivity(activeAccountId)
  const daysStudied = week.filter((day) => day.count > 0).length

  useEffect(() => {
    let active = true
    api
      .get<NoteSummary[]>("/notes")
      .then((response) => {
        if (active && Array.isArray(response.data)) setNotes(response.data)
      })
      .catch(() => {
        // Recent just shows decks if notes can't load.
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

  const recent: RecentItem[] = [
    ...decks.map((deck) => ({
      key: `deck-${deck.id}`,
      to: `/flashcards/${deck.id}`,
      kind: "Deck" as const,
      title: deck.title || "Untitled deck",
      detail: `${deck.cards.length} card${deck.cards.length === 1 ? "" : "s"}`,
      when: deck.updated_at ?? deck.created_at ?? null,
    })),
    ...notes.map((note) => ({
      key: `note-${note.id}`,
      to: `/notes/${note.id}`,
      kind: "Note" as const,
      title: note.title?.trim() || "Untitled note",
      detail: null,
      when: note.updated_at ?? note.created_at ?? null,
    })),
  ]
    .sort((a, b) => (b.when ?? "").localeCompare(a.when ?? ""))
    .slice(0, RECENT_LIMIT)

  const goalMet = daysStudied >= WEEK_GOAL

  return (
    <div className="home">
      <header className="page-head">
        <div>
          <p className="kicker">{new Date().toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" })}</p>
          <h1>
            {greeting()}
            {profile?.username ? (
              <>
                , <Scribble type="underline">{profile.username}</Scribble>
              </>
            ) : null}
          </h1>
          <p className="lede">Here's what to do next.</p>
        </div>
      </header>

      <div className="with-margin">
        <div className="home-main">
          <section className="next-step" aria-live="polite" aria-labelledby="next-step-title">
            <div className="next-copy">
              <p className="next-label">
                <Sparkle weight="fill" aria-hidden="true" /> Up next
              </p>
              {loading ? (
                <h2 id="next-step-title">Looking at your cards...</h2>
              ) : best && best.stats.due > 0 ? (
                <>
                  <h2 id="next-step-title">
                    Review {best.stats.due} card{best.stats.due === 1 ? "" : "s"} in “{best.deck.title}”
                  </h2>
                  <p>{readyLine(totalDue, totalDue > best.stats.due)}</p>
                  <Link className="primary-button" to={`/flashcards/${best.deck.id}/study`}>
                    <Play weight="fill" aria-hidden="true" /> Start now
                  </Link>
                </>
              ) : best ? (
                <>
                  <h2 id="next-step-title">You're all caught up!</h2>
                  <p>Want a challenge? Take a quick quiz on “{best.deck.title}”.</p>
                  <Link className="primary-button" to={`/quizzes?deck=${best.deck.id}`}>
                    <ListChecks weight="bold" aria-hidden="true" /> Quiz me
                  </Link>
                </>
              ) : (
                <>
                  <h2 id="next-step-title">Make your first flashcard deck</h2>
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

          <section className="week-strip" aria-labelledby="week-title">
            <h2 id="week-title" className="sr-only">
              This week
            </h2>
            <ol className="week-dots">
              {week.map((day) => (
                <li key={day.key} className={[day.count > 0 ? "lit" : "", day.isToday ? "today" : "", day.isFuture ? "future" : ""].join(" ").trim() || undefined}>
                  <span className="week-star" aria-hidden="true" />
                  <small>{day.label}</small>
                  <span className="sr-only">{day.count > 0 ? `studied ${day.count} cards` : "no study yet"}</span>
                </li>
              ))}
            </ol>
            <p className="week-text">
              <strong>
                {Math.min(daysStudied, WEEK_GOAL)} of {WEEK_GOAL} days
              </strong>{" "}
              this week{goalMet ? ". Goal reached!" : ""}
            </p>
          </section>

          {recent.length ? (
            <section className="home-recent" aria-labelledby="recent-title">
              <div className="section-head">
                <h2 id="recent-title">Recent</h2>
              </div>
              <ul className="row-list">
                {recent.map((item) => (
                  <li key={item.key} className="row">
                    <span className="row-icon" aria-hidden="true">
                      {item.kind === "Deck" ? <Cards weight="duotone" /> : <Notebook weight="duotone" />}
                    </span>
                    <span className="row-main">
                      <Link className="row-link" to={item.to}>
                        {item.title}
                      </Link>
                      <small>{item.detail ? `${item.kind} · ${item.detail}` : item.kind}</small>
                    </span>
                    {shortDate(item.when) ? <small className="row-meta">Changed {shortDate(item.when)}</small> : null}
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
        </div>

        <nav className="margin quick-start" aria-label="Quick start">
          <h2 className="margin-title">Quick start</h2>
          <ul>
            {quickStart.map((item) => (
              <li key={item.to}>
                <Link to={item.to}>
                  <item.icon weight="duotone" aria-hidden="true" />
                  <span>{item.label}</span>
                </Link>
              </li>
            ))}
          </ul>
        </nav>
      </div>
    </div>
  )
}
