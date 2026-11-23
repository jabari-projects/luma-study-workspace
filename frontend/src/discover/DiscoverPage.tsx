import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import type { FormEvent } from "react"
import { Link, useSearchParams } from "react-router-dom"
import { MagnifyingGlass } from "@phosphor-icons/react"

import { api, getErrorCode, getErrorMessage } from "../api"
import { useAuth } from "../auth"
import { ReportButton } from "../account/Reporting"
import { NoticeBanner } from "../ui/common"
import { Scribble } from "../ui/Scribble"
import type { Notice } from "../ui/common"
import { NOTES_HUB } from "../notes/paths"
import { findSubject, findSubtopic, subjectLabel } from "../subjects/subjects"
import type { SubjectList } from "../subjects/subjects"
import { useSubjects } from "../subjects/useSubjects"
import {
  MAX_QUERY,
  NO_FILTERS,
  discoverStatus,
  filtersFromParams,
  hasFilters,
  isOwnItem,
  kindLabel,
  paramsFromFilters,
  peopleQuery,
  sharedDate,
  subjectChips,
  typeChipLabel,
  typeChips,
} from "./discover"
import type { Busy, DiscoverFilters, DiscoverTab, SearchAnswer, SharedItem, SharedPerson } from "./discover"

type Tab = DiscoverTab

/** After this long, a load says Luma is waking up (the free server sleeps when nobody uses it). */
const SLOW_AFTER_MS = 3000

/** A subject's name, or its slug in plain words while the list is loading (or if it isn't on it). */
function subjectName(list: SubjectList | null, slug: string): string {
  return findSubject(list, slug)?.name ?? slug.replace(/-/g, " ")
}

function subtopicName(list: SubjectList | null, subject: string, slug: string): string {
  return findSubtopic(findSubject(list, subject), slug)?.name ?? slug.replace(/-/g, " ")
}

/**
 * Discover: notes, decks and summaries other students shared. It opens on the newest ones.
 * Search anything, then narrow with chips: subject, then subtopic, then type (each with how many
 * items it holds). The filters live in the address, so Back undoes a tap and a reload keeps them.
 * Or look up a student by username. Each item shows its @username and nothing else about the
 * person: no name, no photo, no popularity order.
 */
export function DiscoverPage() {
  const { user } = useAuth()
  const myUsername = user?.username ?? null
  const { list } = useSubjects()
  const [params, setParams] = useSearchParams()
  const paramsKey = paramsFromFilters(filtersFromParams(params)).toString()
  const filters = useMemo(() => filtersFromParams(new URLSearchParams(paramsKey)), [paramsKey])
  const [tab, setTab] = useState<Tab>("topics")
  const [query, setQuery] = useState(filters.q)
  // Back and Forward change the address: the search box follows it.
  const [shownQ, setShownQ] = useState(filters.q)
  if (shownQ !== filters.q) {
    setShownQ(filters.q)
    setQuery(filters.q)
  }
  const [answer, setAnswer] = useState<{ key: string; data: SearchAnswer } | null>(null)
  const [showAllSubjects, setShowAllSubjects] = useState(false)
  const [moreBusy, setMoreBusy] = useState(false)
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

  /** Changes the filters in the address. Each tap is one step back in history. */
  const go = useCallback(
    (next: DiscoverFilters, replace = false) => {
      setParams(paramsFromFilters(next), { replace })
    },
    [setParams],
  )

  const findTopics = useCallback(
    async (wanted: DiscoverFilters) => {
      const key = paramsFromFilters(wanted).toString()
      const ticket = ++latest.current.topics
      const current = () => ticket === latest.current.topics
      setBusyFor("topics", "loading")
      setNoticeFor("topics", null)
      const timer = window.setTimeout(() => {
        if (current()) setBusyFor("topics", "slow")
      }, SLOW_AFTER_MS)
      try {
        const response = await api.get<SearchAnswer>("/public/search", {
          params: { q: wanted.q || undefined, subject: wanted.subject ?? undefined, subtopic: wanted.subtopic ?? undefined, type: wanted.type ?? undefined },
        })
        if (current()) setAnswer({ key, data: response.data })
      } catch (error: unknown) {
        if (!current()) return
        if (getErrorCode(error) === "unknown_subject") {
          // A subject that isn't on the list (an old or typed address): drop it quietly.
          go({ ...wanted, subject: null, subtopic: null }, true)
          return
        }
        setNoticeFor("topics", { type: "error", text: getErrorMessage(error, "We couldn't load shared notes. Try again.") })
      } finally {
        window.clearTimeout(timer)
        if (current()) setBusyFor("topics", "idle")
      }
    },
    [go, setBusyFor, setNoticeFor],
  )

  const showMore = async () => {
    const shown = answer
    if (!shown || shown.data.next_offset === null || moreBusy) return
    const ticket = latest.current.topics
    setMoreBusy(true)
    try {
      const response = await api.get<SearchAnswer>("/public/search", {
        params: {
          q: filters.q || undefined,
          subject: filters.subject ?? undefined,
          subtopic: filters.subtopic ?? undefined,
          type: filters.type ?? undefined,
          offset: shown.data.next_offset,
        },
      })
      // Another search started meanwhile: this page belongs to the old one.
      if (ticket !== latest.current.topics) return
      setAnswer((now) =>
        now && now.key === shown.key
          ? { key: now.key, data: { ...response.data, items: [...now.data.items, ...response.data.items] } }
          : now,
      )
    } catch (error: unknown) {
      if (ticket === latest.current.topics) {
        setNoticeFor("topics", { type: "error", text: getErrorMessage(error, "We couldn't load more. Try again.") })
      }
    } finally {
      setMoreBusy(false)
    }
  }

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
    const ticket = ++latest.current.people
    const current = () => ticket === latest.current.people
    setBusyFor("people", "loading")
    const timer = window.setTimeout(() => {
      if (current()) setBusyFor("people", "slow")
    }, SLOW_AFTER_MS)
    try {
      const response = await api.get<SharedPerson[]>("/public/users", { params: { query: wanted } })
      if (current()) {
        setPersonAsked(wanted)
        setPeople(response.data)
      }
    } catch (error: unknown) {
      if (current()) setNoticeFor("people", { type: "error", text: getErrorMessage(error, "We couldn't search for people. Try again.") })
    } finally {
      window.clearTimeout(timer)
      if (current()) setBusyFor("people", "idle")
    }
  }

  // Each new set of filters in the address (a search, a tap, Back) loads once. No polling.
  useEffect(() => {
    if (tab === "topics") void findTopics(filters)
  }, [filters, findTopics, tab])

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (tab === "people") {
      await findPeople(query)
      return
    }
    const next = { ...filters, q: query.trim() }
    // The same search again still asks again (the address doesn't change, so nothing else would).
    if (paramsFromFilters(next).toString() === paramsKey) void findTopics(next)
    else go(next)
  }

  const showNewest = () => {
    setQuery("")
    // The button goes away once the newest items load, so keyboard focus moves to the search box first.
    searchInput.current?.focus()
    go(NO_FILTERS)
  }

  const chooseTab = (next: Tab) => {
    if (next === tab) return
    setTab(next)
  }

  const shown = answer && answer.key === paramsKey ? answer.data : null
  const items = shown?.items ?? null
  const filtered = hasFilters(filters)
  const place = filters.subject ? subjectLabel(list, filters.subject, filters.subtopic) || subjectName(list, filters.subject) : ""
  const status = discoverStatus({
    tab,
    busy: busy[tab],
    topic: filters.q,
    itemCount: shown ? shown.total : null,
    place,
    type: filters.type,
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
            maxLength={MAX_QUERY}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={tab === "topics" ? "Search anything, like photosynthesis or 1+1" : "Find a username"}
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
            <h2 id="discover-list-title">{filters.q ? `Shared notes about “${filters.q}”` : "Newest shared"}</h2>
            {filters.q || filtered ? (
              <button type="button" className="text-button" onClick={showNewest}>
                Show newest
              </button>
            ) : null}
          </div>

          {shown && (shown.total > 0 || filtered) ? (
            <Filters
              list={list}
              filters={filters}
              answer={shown}
              showAllSubjects={showAllSubjects}
              onShowAllSubjects={setShowAllSubjects}
              onChange={(next) => go(next)}
            />
          ) : null}

          {shown && !topicsBusy && shown.total > 0 ? (
            <p className="result-line" aria-hidden="true">
              {status}
            </p>
          ) : null}

          {topicsBusy ? (
            <Loading slow={busy.topics === "slow"} text="Loading shared notes…" />
          ) : items && items.length === 0 ? (
            filtered ? (
              <div className="discover-empty">
                <h3>Nothing here with these filters.</h3>
                <button type="button" className="secondary-button" onClick={() => go({ ...filters, subject: null, subtopic: null, type: null })}>
                  Clear filters
                </button>
              </div>
            ) : filters.q ? (
              <div className="discover-empty">
                <h3>Nothing found for “{filters.q}”.</h3>
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
            <>
              <ul className="result-list">
                {items.map((item) => (
                  <li key={`${item.study_type}-${item.id}`}>
                    <SharedRow item={item} mine={isOwnItem(item.username, myUsername)} subject={subjectLabel(list, item.subject_slug, item.subtopic_slug)} />
                  </li>
                ))}
              </ul>
              {shown?.next_offset !== null && shown?.next_offset !== undefined ? (
                <button type="button" className="secondary-button show-more" onClick={() => void showMore()} disabled={moreBusy}>
                  {moreBusy ? "Loading..." : "Show more"}
                </button>
              ) : null}
            </>
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
                        <SharedRow item={item} mine={isOwnItem(item.username, myUsername)} subject={subjectLabel(list, item.subject_slug, item.subtopic_slug)} />
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
 * Where the filters stand ("All › Math › Algebra 1 › Flashcards"), then chips with counts:
 * subject, its subtopics (once a subject is chosen) and type. Each tap is one request.
 * The chips wrap onto new lines; nothing scrolls sideways.
 */
function Filters({
  list,
  filters,
  answer,
  showAllSubjects,
  onShowAllSubjects,
  onChange,
}: {
  list: SubjectList | null
  filters: DiscoverFilters
  answer: SearchAnswer
  showAllSubjects: boolean
  onShowAllSubjects: (value: boolean) => void
  onChange: (next: DiscoverFilters) => void
}) {
  const { chips: subjects, more } = subjectChips(answer.facets.subjects, filters.subject, showAllSubjects)
  const subtopics = answer.facets.subtopics.filter((entry): entry is { slug: string; count: number } => entry.slug !== null)
  const types = typeChips(answer.facets.types)
  const chosenName = filters.subject ? subjectName(list, filters.subject) : ""
  const typeChosen = filters.type
  const nothingToPick = subjects.length === 0 && types.length === 0 && !hasFilters(filters)

  if (nothingToPick) return null

  return (
    <div className="discover-filters">
      {hasFilters(filters) ? (
        <nav aria-label="Filters">
          <ol className="filter-trail">
            <li>
              <button type="button" className="text-button" onClick={() => onChange({ ...filters, subject: null, subtopic: null, type: null })}>
                All
              </button>
            </li>
            {filters.subject ? (
              <li>
                <button
                  type="button"
                  className="text-button"
                  aria-current={!filters.subtopic && !typeChosen ? "true" : undefined}
                  onClick={() => onChange({ ...filters, subtopic: null, type: null })}
                >
                  {chosenName}
                </button>
              </li>
            ) : null}
            {filters.subject && filters.subtopic ? (
              <li>
                <button
                  type="button"
                  className="text-button"
                  aria-current={!typeChosen ? "true" : undefined}
                  onClick={() => onChange({ ...filters, type: null })}
                >
                  {subtopicName(list, filters.subject, filters.subtopic)}
                </button>
              </li>
            ) : null}
            {typeChosen ? (
              <li>
                <span aria-current="true">{typeChipLabel(typeChosen)}</span>
              </li>
            ) : null}
            <li className="clear">
              <button type="button" className="text-button clear-all" onClick={() => onChange({ ...filters, subject: null, subtopic: null, type: null })}>
                Clear all
              </button>
            </li>
          </ol>
        </nav>
      ) : null}

      {subjects.length > 0 ? (
        <fieldset className="filter-row">
          <legend>Subject</legend>
          <ul className="chip-list">
            {subjects.map((entry) => {
              const pressed = filters.subject === entry.slug
              return (
                <li key={entry.slug}>
                  <button
                    type="button"
                    className="filter-chip"
                    aria-pressed={pressed}
                    onClick={() => onChange({ ...filters, subject: pressed ? null : entry.slug, subtopic: null })}
                  >
                    <span>{subjectName(list, entry.slug)}</span> <span className="chip-count">{entry.count}</span>
                  </button>
                </li>
              )
            })}
            {more > 0 || showAllSubjects ? (
              <li>
                <button type="button" className="filter-chip more" aria-expanded={showAllSubjects} onClick={() => onShowAllSubjects(!showAllSubjects)}>
                  {showAllSubjects ? "Fewer subjects" : `More subjects (${more})`}
                </button>
              </li>
            ) : null}
          </ul>
        </fieldset>
      ) : null}

      {filters.subject && subtopics.length > 0 ? (
        <fieldset className="filter-row">
          <legend>Topics in {chosenName}</legend>
          <ul className="chip-list">
            {subtopics.map((entry) => {
              const pressed = filters.subtopic === entry.slug
              return (
                <li key={entry.slug}>
                  <button
                    type="button"
                    className="filter-chip"
                    aria-pressed={pressed}
                    onClick={() => onChange({ ...filters, subtopic: pressed ? null : entry.slug })}
                  >
                    <span>{subtopicName(list, filters.subject as string, entry.slug)}</span> <span className="chip-count">{entry.count}</span>
                  </button>
                </li>
              )
            })}
          </ul>
        </fieldset>
      ) : null}

      {types.length > 0 ? (
        <fieldset className="filter-row">
          <legend>Type</legend>
          <ul className="chip-list">
            {types.map((entry) => {
              const pressed = filters.type === entry.type
              return (
                <li key={entry.type}>
                  <button
                    type="button"
                    className="filter-chip"
                    aria-pressed={pressed}
                    onClick={() => onChange({ ...filters, type: pressed ? null : entry.type })}
                  >
                    <span>{typeChipLabel(entry.type)}</span> <span className="chip-count">{entry.count}</span>
                  </button>
                </li>
              )
            })}
          </ul>
          <p className="filter-note">Every deck can be a quiz.</p>
        </fieldset>
      ) : null}
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

function SharedRow({ item, mine, subject }: { item: SharedItem; mine: boolean; subject: string }) {
  const titleId = `result-${item.study_type}-${item.id}`
  const date = sharedDate(item.published_at || item.created_at)
  return (
    <article className="result" aria-labelledby={titleId}>
      <p className="result-kind">{kindLabel(item.study_type)}</p>
      <h3 id={titleId}>{item.title}</h3>
      {subject ? (
        <p className="result-subject">
          <span className="sr-only">Subject: </span>
          {subject}
        </p>
      ) : null}
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
