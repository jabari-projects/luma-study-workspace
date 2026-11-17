import { useCallback, useEffect, useState } from "react"
import type { FormEvent } from "react"
import { MagnifyingGlass } from "@phosphor-icons/react"

import { api, getErrorMessage } from "../api"
import { ReportButton } from "../account/Reporting"
import { NoticeBanner } from "../ui/common"
import { Scribble } from "../ui/Scribble"
import type { Notice, StudyType } from "../ui/common"

// Shaped like backend/app/public_search.py. A shared item carries the username only:
// no user id, no name, no photo and no counts (owner decision).
type PublicStudyItem = {
  id: string
  study_type: StudyType
  title: string
  preview: string
  tags: string[]
  username: string
  published_at?: string | null
  created_at: string
}

type PublicUser = {
  username: string
  items: PublicStudyItem[]
}

/** People search needs this many letters (the server says the same). */
const MIN_PEOPLE_QUERY = 3

const STUDY_GROUPS: Array<{ type: StudyType; title: string }> = [
  { type: "note", title: "Notes" },
  { type: "flashcards", title: "Flashcards" },
  { type: "summary", title: "Summaries" },
]

function labelForStudyType(studyType: StudyType): string {
  if (studyType === "note") return "Note"
  if (studyType === "flashcards") return "Flashcards"
  return "Summary"
}

function formatPublishedDate(value?: string | null): string {
  if (!value) return ""
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ""
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })
}

function groupPublicItems(items: PublicStudyItem[]): Record<StudyType, PublicStudyItem[]> {
  return items.reduce<Record<StudyType, PublicStudyItem[]>>(
    (groups, item) => {
      groups[item.study_type].push(item)
      return groups
    },
    { note: [], flashcards: [], summary: [] },
  )
}

/**
 * Search shared notes and flashcards, or look up a student by username.
 * Laid out the way Discover will be: a search line, two plain tabs, then ruled lists (no card grid).
 */
export function SearchPage() {
  const [activeTab, setActiveTab] = useState<"topics" | "users">("topics")
  const [query, setQuery] = useState("")
  const [topics, setTopics] = useState<PublicStudyItem[]>([])
  const [users, setUsers] = useState<PublicUser[]>([])
  const [notice, setNotice] = useState<Notice | null>(null)
  const [loading, setLoading] = useState(false)
  // The last people search that was sent, or null before the first one.
  const [peopleQuery, setPeopleQuery] = useState<string | null>(null)
  const groupedTopics = groupPublicItems(topics)

  const searchPublicTopics = useCallback(async (searchQuery: string) => {
    setLoading(true)
    setNotice(null)

    try {
      const response = await api.get<PublicStudyItem[]>("/public/topics", {
        params: { query: searchQuery },
      })
      setTopics(response.data)
    } catch (error: unknown) {
      setNotice({ type: "error", text: getErrorMessage(error, "We couldn't search shared notes. Try again.") })
    } finally {
      setLoading(false)
    }
  }, [])

  const searchPublicUsers = useCallback(async (searchQuery: string) => {
    const wanted = searchQuery.trim().replace(/^@/, "")
    setNotice(null)
    setPeopleQuery(wanted)
    if (wanted.length < MIN_PEOPLE_QUERY) {
      setUsers([])
      return
    }
    setLoading(true)

    try {
      const response = await api.get<PublicUser[]>("/public/users", {
        params: { query: wanted },
      })
      setUsers(response.data)
    } catch (error: unknown) {
      setNotice({ type: "error", text: getErrorMessage(error, "We couldn't search for people. Try again.") })
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void searchPublicTopics("")
  }, [searchPublicTopics])

  const submitSearch = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()

    if (activeTab === "topics") {
      await searchPublicTopics(query)
      return
    }

    await searchPublicUsers(query)
  }

  const browseTopics = async () => {
    setActiveTab("topics")
    setQuery("")
    await searchPublicTopics("")
  }

  return (
    <div className="search-page">
      <header className="page-head">
        <div>
          <h1>
            <Scribble type="underline">Search</Scribble>
          </h1>
          <p className="lede">Find notes and flashcards other students shared.</p>
        </div>
      </header>

      <form className="search-bar" role="search" onSubmit={submitSearch}>
        <label htmlFor="search-box" className="sr-only">
          Search
        </label>
        <span className="search-field">
          <MagnifyingGlass weight="bold" aria-hidden="true" />
          <input
            id="search-box"
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={activeTab === "topics" ? "Try math, history or science" : "Find a username"}
          />
        </span>
        <button className="primary-button" type="submit">
          Search
        </button>
        <button className="ghost-button" type="button" onClick={() => void browseTopics()}>
          Browse all
        </button>
      </form>

      {/* A simple switch of what to search, so plain toggle buttons (aria-pressed), not tabs. */}
      <div className="tabs" role="group" aria-label="Search choices">
        <button
          type="button"
          className="tab"
          aria-pressed={activeTab === "topics"}
          onClick={() => setActiveTab("topics")}
        >
          Notes and cards
        </button>
        <button type="button" className="tab" aria-pressed={activeTab === "users"} onClick={() => setActiveTab("users")}>
          People
        </button>
      </div>

      <NoticeBanner notice={notice} />

      {activeTab === "topics" ? (
        <div className="search-results" aria-live="polite">
          {loading ? <p className="muted">Loading...</p> : null}
          {!loading && topics.length === 0 ? <p className="muted">No shared notes or cards found.</p> : null}
          {STUDY_GROUPS.map((group) =>
            groupedTopics[group.type].length ? (
              <section className="result-group" key={group.type} aria-labelledby={`results-${group.type}`}>
                <div className="section-head">
                  <h2 id={`results-${group.type}`}>{group.title}</h2>
                </div>
                <ul className="result-list">
                  {groupedTopics[group.type].map((item) => (
                    <li key={`${item.study_type}-${item.id}`}>
                      <PublicStudyCard item={item} />
                    </li>
                  ))}
                </ul>
              </section>
            ) : null,
          )}
        </div>
      ) : (
        <div className="search-results" aria-live="polite">
          {loading ? <p className="muted">Loading...</p> : null}
          {!loading && users.length === 0 ? (
            <p className="muted">
              {peopleQuery === null || peopleQuery.length < MIN_PEOPLE_QUERY
                ? "Type at least 3 letters of a username."
                : "No one with that username has shared anything yet."}
            </p>
          ) : null}
          {users.map((user) => (
            <section className="person" key={user.username} aria-labelledby={`person-${user.username}`}>
              {/* Username only: no name, no photo, no counts. */}
              <div className="person-head">
                <h2 id={`person-${user.username}`}>@{user.username}</h2>
              </div>
              <ul className="result-list">
                {user.items.map((item) => (
                  <li key={`${item.study_type}-${item.id}`}>
                    <PublicStudyCard item={item} />
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

function PublicStudyCard({ item }: { item: PublicStudyItem }) {
  const titleId = `result-${item.study_type}-${item.id}`
  const date = formatPublishedDate(item.published_at)
  return (
    <article className="result" aria-labelledby={titleId}>
      <p className="result-kind">{labelForStudyType(item.study_type)}</p>
      <h3 id={titleId}>{item.title}</h3>
      <p className="result-preview">{item.preview || "No text yet."}</p>
      <p className="result-meta">
        <span>Shared by @{item.username}</span>
        {date ? <span>{date}</span> : null}
      </p>
      {item.tags.length ? (
        <p className="tag-row">
          {item.tags.map((tag) => (
            <span key={tag}>#{tag}</span>
          ))}
        </p>
      ) : null}
      <ReportButton itemType={item.study_type} itemId={item.id} title={item.title} />
    </article>
  )
}
