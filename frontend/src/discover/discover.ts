// Discover: where the shared-notes page lives, and small helpers for it.
// No window or React here, so `node --test` can run it.
//
// Privacy rules (owner decisions): a shared item shows the owner's @username and
// nothing else about them. No names, no photos, no counts, no popularity order.

/** Same as StudyType in ui/common.tsx (kept here so `node --test` needs no JSX). */
export type StudyType = "note" | "flashcards" | "summary"

export const DISCOVER = "/discover"

/** Where a brand-new student lands after typing their email code. Ordinary logins go Home. */
export const FIRST_TIME_LANDING = DISCOVER

/** Old addresses that now open Discover (the query string is kept). */
export const DISCOVER_REDIRECTS: ReadonlyArray<readonly [from: string, to: string]> = [["/search", DISCOVER]]

/** People search needs this many letters (the server says the same). */
export const MIN_PEOPLE_QUERY = 3

// Shaped like backend/app/public_search.py.
export type SharedItem = {
  id: string
  study_type: StudyType
  title: string
  preview: string
  tags: string[]
  username: string
  published_at?: string | null
  created_at: string
}

export type SharedPerson = {
  username: string
  items: SharedItem[]
}

/** "Note", "Deck" or "Summary": the small label above a shared item's title. */
export function kindLabel(studyType: StudyType): string {
  if (studyType === "flashcards") return "Deck"
  if (studyType === "summary") return "Summary"
  return "Note"
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

export type DiscoverTab = "topics" | "people"

/** A panel's request: none, waiting, or waiting long enough to say Luma is waking up. */
export type Busy = "idle" | "loading" | "slow"

export type DiscoverState = {
  tab: DiscoverTab
  busy: Busy
  /** The topic that was searched; "" means the newest shared items. */
  topic: string
  /** How many shared items the topics panel shows, or null before the first answer. */
  itemCount: number | null
  /** The last people search that was sent, or null before one. */
  personAsked: string | null
  peopleCount: number
}

/**
 * The one line a screen reader hears about the open panel: loading, how many were found,
 * or that nothing was found. "" when there is nothing new to say.
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
  const about = state.topic ? ` about “${state.topic}”` : ""
  if (state.itemCount === 0) {
    return state.topic ? `Nothing found for “${state.topic}”.` : "Nothing here yet. No one has shared notes or flashcards yet."
  }
  return state.itemCount === 1 ? `1 shared item${about}.` : `${state.itemCount} shared items${about}.`
}

/** True when a shared item is the signed-in student's own (usernames ignore case). */
export function isOwnItem(itemUsername: string, myUsername: string | null | undefined): boolean {
  return Boolean(myUsername) && itemUsername.toLowerCase() === (myUsername ?? "").toLowerCase()
}
