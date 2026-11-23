// Where the Notes pages live, and small helpers for the Notes hub.
// No window or React here, so `node --test` can run it.

export const NOTES_HUB = "/notes"
export const NEW_NOTE = "/notes/new"
export const IMPORT_NOTES = "/notes/import"
export const VOICE_NOTES = "/notes/voice"
export const IMAGE_NOTES = "/notes/image"
export const SUMMARIES_TAB = "/notes?show=summaries"

/** Old addresses that still work: each one sends you to its new place. */
export const NOTE_REDIRECTS: ReadonlyArray<readonly [from: string, to: string]> = [
  ["/import", IMPORT_NOTES],
  ["/voice-input", VOICE_NOTES],
  ["/audio-to-notes", VOICE_NOTES],
  ["/image-to-notes", IMAGE_NOTES],
  ["/notes/picture", IMAGE_NOTES],
  ["/summaries", SUMMARIES_TAB],
]

/**
 * The new address for an old link, keeping its query (like ?from=link) and #hash.
 * The new address's own query wins when both name the same thing.
 */
export function redirectTarget(to: string, search: string, hash = ""): string {
  const [path, query = ""] = to.split("?")
  const params = new URLSearchParams(query)
  new URLSearchParams(search).forEach((value, key) => {
    if (!params.has(key)) params.append(key, value)
  })
  const qs = params.toString()
  return `${path}${qs ? `?${qs}` : ""}${hash}`
}

export type HubTab = "all" | "notes" | "summaries"

/** The tab named by ?show=, or All. */
export function tabFromQuery(show: string | null): HubTab {
  return show === "notes" || show === "summaries" ? show : "all"
}

export type HubItem = {
  id: string
  kind: "note" | "summary"
  title?: string | null
  content?: string | null
  subject_slug?: string | null
  subtopic_slug?: string | null
  is_public?: boolean | null
  created_at?: string | null
  updated_at?: string | null
}

/** When it last changed: updated_at, or created_at for items never edited. */
export function changedAt(item: Pick<HubItem, "created_at" | "updated_at">): string {
  return item.updated_at || item.created_at || ""
}

/** Notes and summaries in one list, the most recently changed first. */
export function mergeByChanged(notes: HubItem[], summaries: HubItem[]): HubItem[] {
  return [...notes, ...summaries].sort((a, b) => {
    const diff = (Date.parse(changedAt(b)) || 0) - (Date.parse(changedAt(a)) || 0)
    return diff || a.id.localeCompare(b.id)
  })
}

/** One short line of plain text from a note, without Markdown marks or card arrows. */
export function previewLine(content: string | null | undefined, max = 140): string {
  const text = (content ?? "")
    .split(/\r?\n/)
    .filter((line) => !/^\s*(Source|Key words):/i.test(line))
    .map((line) =>
      line
        .replace(/^\s*(?:[-+*]|\d+\.)\s+/, "")
        .replace(/\s*::\s*/g, " → ")
        .replace(/[#*_>`[\]]/g, "")
        .replace(/\s+/g, " ")
        .trim(),
    )
    .filter(Boolean)
    // Lines become one sentence each: "Apple → Manzana. Bread → Pan."
    .reduce((joined, line) => (joined ? `${joined}${/[.!?:;,]$/.test(joined) ? "" : "."} ${line}` : line), "")
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text
}

/** Keeps items whose title or text has every word typed in "Find in my notes". */
export function matchesFind(item: HubItem, find: string): boolean {
  const words = find.toLowerCase().split(/\s+/).filter(Boolean)
  if (!words.length) return true
  const haystack = `${item.title ?? ""} ${item.content ?? ""}`.toLowerCase()
  return words.every((word) => haystack.includes(word))
}

/** "Notes for Nov 16": the starting title of a new note (the server needs a title). */
export function defaultNoteTitle(date = new Date()): string {
  return `Notes for ${date.toLocaleDateString("en-US", { month: "short", day: "numeric" })}`
}

/** "Nov 14", or "" when there is no good date. */
export function shortChangedDate(value: string): string {
  const date = new Date(value)
  return value && !Number.isNaN(date.getTime()) ? date.toLocaleDateString(undefined, { month: "short", day: "numeric" }) : ""
}

/** Tags typed as "biology, cells" become ["biology", "cells"]. */
export function parseTags(value: string): string[] {
  return value
    .split(",")
    .map((tag) => tag.trim().replace(/^#/, ""))
    .filter(Boolean)
}
