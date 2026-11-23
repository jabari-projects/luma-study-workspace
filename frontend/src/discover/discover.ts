// Discover: where the shared-notes page lives, and small helpers for it.
// No window or React here, so `node --test` can run it.
//
// Privacy rules (owner decisions): a shared item shows the owner's @username and
// nothing else about them. No names, no photos, no popularity order. The filter counts
// say how many shared items are in a subject or type, never anything per person.

/** Same as StudyType in ui/common.tsx (kept here so `node --test` needs no JSX). */
export type StudyType = "note" | "flashcards" | "summary"

export const DISCOVER = "/discover"

/** Where a brand-new student lands after typing their email code. Ordinary logins go Home. */
export const FIRST_TIME_LANDING = DISCOVER

/** Old addresses that now open Discover (the query string is kept). */
export const DISCOVER_REDIRECTS: ReadonlyArray<readonly [from: string, to: string]> = [["/search", DISCOVER]]

/** People search needs this many letters (the server says the same). */
export const MIN_PEOPLE_QUERY = 3

/** The longest search the server takes. */
export const MAX_QUERY = 80

// Shaped like backend/app/public_search.py.
export type SharedItem = {
  id: string
  study_type: StudyType
  title: string
  preview: string
  tags: string[]
  subject_slug?: string | null
  subtopic_slug?: string | null
  username: string
  published_at?: string | null
  created_at: string
}

export type SharedPerson = {
  username: string
  items: SharedItem[]
}

export type SlugCount = { slug: string | null; count: number }
export type TypeCount = { type: StudyType; count: number }
export type SearchFacets = { subjects: SlugCount[]; subtopics: SlugCount[]; types: TypeCount[] }
/** GET /public/search */
export type SearchAnswer = { items: SharedItem[]; total: number; next_offset: number | null; facets: SearchFacets }

/** "Note", "Deck" or "Summary": the small label above a shared item's title. */
export function kindLabel(studyType: StudyType): string {
  if (studyType === "flashcards") return "Deck"
  if (studyType === "summary") return "Summary"
  return "Note"
}

/** The type filter's words. Every deck can be a quiz, so there is no separate Quizzes filter. */
export const TYPE_ORDER: StudyType[] = ["flashcards", "note", "summary"]
export function typeChipLabel(studyType: StudyType): string {
  if (studyType === "flashcards") return "Flashcards"
  if (studyType === "summary") return "Summaries"
  return "Notes"
}

/** "deck" / "decks", "note" / "notes", "summary" / "summaries". */
function typeNoun(studyType: StudyType | null, count: number): string {
  const one = count === 1
  if (studyType === "flashcards") return one ? "deck" : "decks"
  if (studyType === "note") return one ? "note" : "notes"
  if (studyType === "summary") return one ? "summary" : "summaries"
  return one ? "item" : "items"
}

/**
 * What a people search sends, or null when it should not be sent:
 * fewer than 3 letters, or characters a username can't have.
 */
export function peopleQuery(raw: string): string | null {
  const wanted = raw.trim().replace(/^@/, "")
  if (wanted.length < MIN_PEOPLE_QUERY || !/^[A-Za-z0-9_]+$/.test(wanted)) return null
  return wanted
}

/** "Nov 14" for this year, "Nov 14, 2025" for older ones, or "" when there is no good date. */
export function sharedDate(value: string | null | undefined, today = new Date()): string {
  if (!value) return ""
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ""
  const options: Intl.DateTimeFormatOptions =
    date.getFullYear() === today.getFullYear()
      ? { month: "short", day: "numeric" }
      : { month: "short", day: "numeric", year: "numeric" }
  return date.toLocaleDateString("en-US", options)
}

/* ------------------------------------------------------------------ */
/* Filters (kept in the address, so Back undoes a tap)                */
/* ------------------------------------------------------------------ */

export type DiscoverFilters = { q: string; subject: string | null; subtopic: string | null; type: StudyType | null }
export const NO_FILTERS: DiscoverFilters = { q: "", subject: null, subtopic: null, type: null }

const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/
const slugOrNull = (value: string | null) => (value && value.length <= 40 && SLUG.test(value) ? value : null)

/** Filters from the address. Anything that can't be right is dropped quietly. */
export function filtersFromParams(params: URLSearchParams): DiscoverFilters {
  const q = (params.get("q") ?? "").trim().slice(0, MAX_QUERY)
  const subject = slugOrNull(params.get("subject"))
  const subtopic = subject ? slugOrNull(params.get("subtopic")) : null
  const rawType = params.get("type")
  const type = TYPE_ORDER.includes(rawType as StudyType) ? (rawType as StudyType) : null
  return { q, subject, subtopic, type }
}

/** The address for these filters (only the ones that are set, in a fixed order). */
export function paramsFromFilters(filters: DiscoverFilters): URLSearchParams {
  const params = new URLSearchParams()
  const q = filters.q.trim()
  if (q) params.set("q", q)
  if (filters.subject) {
    params.set("subject", filters.subject)
    if (filters.subtopic) params.set("subtopic", filters.subtopic)
  }
  if (filters.type) params.set("type", filters.type)
  return params
}

export function hasFilters(filters: DiscoverFilters): boolean {
  return Boolean(filters.subject || filters.type)
}

/** How many subject chips show before "More subjects". */
export const TOP_SUBJECTS = 8

/**
 * The subject chips: the most-shared subjects first (the server's order), at most 8 unless
 * `showAll`. The chosen subject always shows. "No subject" is not a chip: it can't be chosen.
 */
export function subjectChips(counts: SlugCount[], chosen: string | null, showAll: boolean): { chips: { slug: string; count: number }[]; more: number } {
  const named = counts.filter((entry): entry is { slug: string; count: number } => entry.slug !== null && entry.count > 0)
  if (showAll || named.length <= TOP_SUBJECTS) return { chips: named, more: 0 }
  const top = named.slice(0, TOP_SUBJECTS)
  const picked = chosen && !top.some((entry) => entry.slug === chosen) ? named.find((entry) => entry.slug === chosen) : undefined
  const chips = picked ? [...top, picked] : top
  return { chips, more: named.length - chips.length }
}

/** The type chips in a fixed order, zero counts left out. */
export function typeChips(counts: TypeCount[]): TypeCount[] {
  return TYPE_ORDER.map((type) => ({ type, count: counts.find((entry) => entry.type === type)?.count ?? 0 })).filter((entry) => entry.count > 0)
}

export type DiscoverTab = "topics" | "people"

/** A panel's request: none, waiting, or waiting long enough to say Luma is waking up. */
export type Busy = "idle" | "loading" | "slow"

export type DiscoverState = {
  tab: DiscoverTab
  busy: Busy
  /** The words that were searched; "" means everything. */
  topic: string
  /** How many shared items match, or null before the first answer. */
  itemCount: number | null
  /** The chosen subject in words ("Math › Algebra 1"), or "". */
  place?: string
  /** The chosen type, or null. */
  type?: StudyType | null
  /** The last people search that was sent, or null before one. */
  personAsked: string | null
  peopleCount: number
}

/**
 * The one line about the open panel: loading, how many were found, or that nothing was found.
 * "312 shared items for “1+1”." -> "10 shared items for “1+1” in Math." -> "2 shared decks for
 * “1+1” in Math › Algebra 1." Screen readers hear it too. "" when there is nothing new to say.
 */
export function discoverStatus(state: DiscoverState): string {
  if (state.busy === "slow") return "Waking up Luma… This can take a minute."
  if (state.busy === "loading") return state.tab === "topics" ? "Loading shared notes…" : "Looking for people…"
  if (state.tab === "people") {
    if (state.personAsked === null) return ""
    if (state.peopleCount === 0) return "No one with that username has shared anything yet."
    return state.peopleCount === 1 ? "Found 1 person." : `Found ${state.peopleCount} people.`
  }
  if (state.itemCount === null) return ""
  const type = state.type ?? null
  const filtered = Boolean(state.place || type)
  if (state.itemCount === 0) {
    if (filtered) return "Nothing here with these filters."
    return state.topic ? `Nothing found for “${state.topic}”.` : "Nothing here yet. No one has shared notes or flashcards yet."
  }
  const words = state.topic ? ` for “${state.topic}”` : ""
  const place = state.place ? ` in ${state.place}` : ""
  return `${state.itemCount} shared ${typeNoun(type, state.itemCount)}${words}${place}.`
}

/** True when a shared item is the signed-in student's own (usernames ignore case). */
export function isOwnItem(itemUsername: string, myUsername: string | null | undefined): boolean {
  return Boolean(myUsername) && itemUsername.toLowerCase() === (myUsername ?? "").toLowerCase()
}
