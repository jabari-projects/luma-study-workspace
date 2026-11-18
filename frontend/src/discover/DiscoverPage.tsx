import { useCallback, useEffect, useRef, useState } from "react"
import type { FormEvent } from "react"
import { Link } from "react-router-dom"
import { MagnifyingGlass } from "@phosphor-icons/react"

import { api, getErrorMessage } from "../api"
import { useAuth } from "../auth"
import { ReportButton } from "../account/Reporting"
import { NoticeBanner } from "../ui/common"
import { Scribble } from "../ui/Scribble"
import type { Notice } from "../ui/common"
import { NOTES_HUB } from "../notes/paths"
import { discoverStatus, isOwnItem, kindLabel, peopleQuery, sharedDate } from "./discover"
import type { Busy, DiscoverTab, SharedItem, SharedPerson } from "./discover"

type Tab = DiscoverTab

/** After this long, a load says Luma is waking up (the free server sleeps when nobody uses it). */
const SLOW_AFTER_MS = 3000

/**
 * Discover: notes and flashcards other students shared. It opens on the newest ones.
 * Search a topic, or look up a student by username. Each item shows its @username and
 * nothing else about the person: no name, no photo, no counts, no popularity order.
 */
export function DiscoverPage() {
  const { user } = useAuth()
  const myUsername = user?.username ?? null
  const [tab, setTab] = useState<Tab>("topics")
  const [query, setQuery] = useState("")
  // The topic that was searched; "" means the newest shared items.
  const [topic, setTopic] = useState("")
  const [items, setItems] = useState<SharedItem[] | null>(null)
  const [people, setPeople] = useState<SharedPerson[]>([])
  // The last people search that was sent, or null before the first one (or after one that was too short).
  const [personAsked, setPersonAsked] = useState<string | null>(null)
  // Each panel keeps its own request, loading state and error, so one never shows the other's.
  const [notices, setNotices] = useState<Record<Tab, Notice | null>>({ topics: null, people: null })
  const [busy, setBusy] = useState<Record<Tab, Busy>>({ topics: "idle", people: "idle" })
  // Each request gets a number per panel, so an older answer that arrives late is ignored.
  const latest = useRef<Record<Tab, number>>({ topics: 0, people: 0 })
  const searchInput = useRef<HTMLInputElement>(null)

  const setBusyFor = useCallback((which: Tab, value: Busy) => {
    setBusy((previous) => (previous[which] === value ? previous : { ...previous, [which]: value }))
  }, [])
  const setNoticeFor = useCallback((which: Tab, value: Notice | null) => {
    setNotices((previous) => (previous[which] === value ? previous : { ...previous, [which]: value }))
  }, [])

  const load = useCallback(
    async <T,>(which: Tab, path: string, wanted: string, onDone: (data: T) => void, failText: string) => {
      const ticket = ++latest.current[which]
      const current = () => ticket === latest.current[which]
      setBusyFor(which, "loading")
      setNoticeFor(which, null)
      const timer = window.setTimeout(() => {
        if (current()) setBusyFor(which, "slow")
      }, SLOW_AFTER_MS)
      try {
        const response = await api.get<T>(path, { params: { query: wanted } })
        if (current()) onDone(response.data)
      } catch (error: unknown) {
        if (current()) setNoticeFor(which, { type: "error", text: getErrorMessage(error, failText) })
      } finally {
        window.clearTimeout(timer)
        if (current()) setBusyFor(which, "idle")
      }
    },
    [setBusyFor, setNoticeFor],
  )

  const findTopics = useCallback(
    async (wanted: string) => {
      const cleaned = wanted.trim()
      await load<SharedItem[]>(
        "topics",
        "/public/topics",
        cleaned,
        (data) => {
          setTopic(cleaned)
          setItems(data)
        },
        "We couldn't load shared notes. Try again.",
      )
    },
    [load],
  )

  const findPeople = async (raw: string) => {
    const wanted = peopleQuery(raw)
    setNoticeFor("people", null)
    if (!wanted) {
      // Too short (or not a username): nothing is sent, and the hint stays.
      latest.current.people += 1
      setBusyFor("people", "idle")
      setPersonAsked(null)
      setPeople([])
      return
    }
    await load<SharedPerson[]>(
      "people",
      "/public/users",
      wanted,
      (data) => {
        setPersonAsked(wanted)
        setPeople(data)
      },
      "We couldn't search for people. Try again.",
    )
  }

  // Browse first: open on the newest shared notes and cards.
  useEffect(() => {
    void findTopics("")
  }, [findTopics])

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (tab === "topics") await findTopics(query)
    else await findPeople(query)
  }

  const showNewest = async () => {
    setQuery("")
    // The button goes away once the newest items load, so keyboard focus moves to the search box first.
    searchInput.current?.focus()
    await findTopics("")
  }

  const chooseTab = (next: Tab) => {
    if (next === tab) return
    setTab(next)
    if (next === "topics" && items === null && busy.topics === "idle") void findTopics("")
  }

  const status = discoverStatus({
    tab,
    busy: busy[tab],
    topic,
    itemCount: items ? items.length : null,
    personAsked,
    peopleCount: people.length,
  })
  const topicsBusy = busy.topics !== "idle"
  const peopleBusy = busy.people !== "idle"

  return (
    <div className="search-page discover-page">
      <header className="page-head">
        <div>
          <h1>
            Discover <Scribble type="underline">notes</Scribble>
          </h1>
          <p className="lede">Notes and flashcards other students shared. Only people signed in to Luma can see them.</p>
        </div>
      </header>

      <form className="search-bar" role="search" onSubmit={submit}>
        <label htmlFor="search-box" className="sr-only">
          Search
        </label>
        <span className="search-field">
          <MagnifyingGlass weight="bold" aria-hidden="true" />
          <input
            ref={searchInput}
            id="search-box"
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={tab === "topics" ? "Try photosynthesis" : "Find a username"}
            autoComplete="off"
          />
        </span>
        <button className="primary-button" type="submit">
          Search
        </button>
      </form>

      {/* A simple switch of what to search, so plain toggle buttons (aria-pressed), not tabs. */}
      <div className="tabs" role="group" aria-label="What to find">
        <button type="button" className="tab" aria-pressed={tab === "topics"} onClick={() => chooseTab("topics")}>
          Notes and cards
        </button>
        <button type="button" className="tab" aria-pressed={tab === "people"} onClick={() => chooseTab("people")}>
          People
        </button>
      </div>

      {/* Always on the page, so screen readers hear loading, what was found, and "nothing found". */}
      <p className="sr-only" role="status" data-testid="discover-status">
        {status}
      </p>

      <NoticeBanner notice={notices[tab]} />

      {tab === "topics" ? (
        <section className="search-results" aria-labelledby="discover-list-title" aria-busy={topicsBusy}>
          <div className="section-head">
            <h2 id="discover-list-title">{topic ? `Shared notes about “${topic}”` : "Newest shared"}</h2>
            {topic ? (
              <button type="button" className="text-button" onClick={() => void showNewest()}>
                Show newest
              </button>
            ) : null}
          </div>
          {topicsBusy ? (
            <Loading slow={busy.topics === "slow"} text="Loading shared notes…" />
          ) : items && items.length === 0 ? (
            topic ? (
              <div className="discover-empty">
                <h3>Nothing found for “{topic}”.</h3>
                <p className="muted">Try another topic, or check the spelling.</p>
              </div>
            ) : (
              <div className="discover-empty">
                <h3>Nothing here yet.</h3>
                <p className="muted">No one has shared notes or flashcards yet.</p>
                <p className="hand-note">Share your own notes so others can learn too.</p>
                <Link to={NOTES_HUB}>Go to my notes</Link>
              </div>
            )
          ) : items ? (
            <ul className="result-list">
              {items.map((item) => (
                <li key={`${item.study_type}-${item.id}`}>
                  <SharedRow item={item} mine={isOwnItem(item.username, myUsername)} />
                </li>
              ))}
            </ul>
          ) : null}
        </section>
      ) : (
        <div className="search-results" aria-busy={peopleBusy}>
          {peopleBusy ? <Loading slow={busy.people === "slow"} text="Looking for people…" /> : null}
          {!peopleBusy && people.length === 0 ? (
            <p className="muted">
              {personAsked === null
                ? "Type at least 3 letters of a username."
                : "No one with that username has shared anything yet."}
            </p>
          ) : null}
          {peopleBusy
            ? null
            : people.map((person) => (
                <section className="person" key={person.username} aria-labelledby={`person-${person.username}`}>
                  {/* Username only: no name, no photo, no counts. */}
                  <div className="person-head">
                    <h2 id={`person-${person.username}`}>@{person.username}</h2>
                  </div>
                  <ul className="result-list">
                    {person.items.map((item) => (
                      <li key={`${item.study_type}-${item.id}`}>
                        <SharedRow item={item} mine={isOwnItem(item.username, myUsername)} />
                      </li>
                    ))}
                  </ul>
                </section>
              ))}
        </div>
      )}
    </div>
  )
}

/**
 * Grey placeholder rows while a panel loads. After a few seconds, it says Luma is waking up.
 * The words are for sighted students; screen readers hear the page's status line instead.
 */
function Loading({ slow, text }: { slow: boolean; text: string }) {
  return (
    <div className="discover-loading">
      <p className="muted" aria-hidden="true">
        {slow ? "Waking up Luma… This can take a minute." : text}
      </p>
      <ul className="result-list skeleton-list" aria-hidden="true">
        {[0, 1, 2, 3].map((index) => (
          <li key={index}>
            <span className="skeleton-line short" />
            <span className="skeleton-line" />
            <span className="skeleton-line" />
          </li>
        ))}
      </ul>
    </div>
  )
}

function SharedRow({ item, mine }: { item: SharedItem; mine: boolean }) {
  const titleId = `result-${item.study_type}-${item.id}`
  const date = sharedDate(item.published_at || item.created_at)
  return (
    <article className="result" aria-labelledby={titleId}>
      <p className="result-kind">{kindLabel(item.study_type)}</p>
      <h3 id={titleId}>{item.title}</h3>
      <p className="result-preview">{item.preview || "No text yet."}</p>
      <p className="result-meta">
        <span>Shared by @{item.username}</span>
        {date ? <span>{date}</span> : null}
        {/* No Report button on your own shared items. */}
        {mine ? <span>You shared this</span> : null}
      </p>
      {mine ? null : <ReportButton itemType={item.study_type} itemId={item.id} title={item.title} />}
    </article>
  )
}
