// The subject list (subjects -> subtopics) and small helpers for it.
// No window or React here, so `node --test` can run it. The list itself comes from the API
// (GET /subjects, the backend's app/data/subjects.json); see useSubjects.ts.

export type Subtopic = { slug: string; name: string; aliases?: string[]; retired?: boolean }
export type Subject = {
  slug: string
  name: string
  group: string
  aliases?: string[]
  retired?: boolean
  subtopics: Subtopic[]
}
export type SubjectGroup = { slug: string; name: string }
export type SubjectList = { version: number; groups: SubjectGroup[]; subjects: Subject[] }

/** What a note, deck or summary stores. `subtopic` is null when only a subject is picked. */
export type SubjectChoice = { subject: string | null; subtopic: string | null }
export const NO_SUBJECT: SubjectChoice = { subject: null, subtopic: null }

const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/

/** True for a value shaped like a slug (the server checks the real list). */
export function isSlug(value: unknown): value is string {
  return typeof value === "string" && value.length <= 40 && SLUG.test(value)
}

/** A choice from anything (a saved row, an old tab draft, the address bar): bad values become none. */
export function choiceFrom(subject: unknown, subtopic: unknown): SubjectChoice {
  if (!isSlug(subject)) return NO_SUBJECT
  return { subject, subtopic: isSlug(subtopic) ? subtopic : null }
}

/** What the API takes: both fields, always (null clears). */
export function subjectBody(choice: SubjectChoice): { subject_slug: string | null; subtopic_slug: string | null } {
  return { subject_slug: choice.subject, subtopic_slug: choice.subject ? choice.subtopic : null }
}

export function findSubject(list: SubjectList | null, slug: string | null | undefined): Subject | null {
  if (!list || !slug) return null
  return list.subjects.find((subject) => subject.slug === slug) ?? null
}

export function findSubtopic(subject: Subject | null, slug: string | null | undefined): Subtopic | null {
  if (!subject || !slug) return null
  return subject.subtopics.find((subtopic) => subtopic.slug === slug) ?? null
}

/** "Math › Algebra 1", "Math", or "" when there is no subject or it isn't on the list. */
export function subjectLabel(list: SubjectList | null, subject: string | null | undefined, subtopic?: string | null): string {
  const found = findSubject(list, subject)
  if (!found) return ""
  const sub = findSubtopic(found, subtopic)
  return sub ? `${found.name} › ${sub.name}` : found.name
}

/** Subjects the picker lists, under their group headings, in the file's order. Retired ones are hidden. */
export function groupedSubjects(list: SubjectList): { group: SubjectGroup; subjects: Subject[] }[] {
  return list.groups
    .map((group) => ({ group, subjects: list.subjects.filter((subject) => subject.group === group.slug && !subject.retired) }))
    .filter((entry) => entry.subjects.length > 0)
}

export type SubjectMatch =
  | { kind: "subject"; subject: Subject }
  | { kind: "subtopic"; subject: Subject; subtopic: Subtopic }

/** Like the backend's subjects.fold: lower case, "." and "'" dropped ("U.S." is "us"), any other mark a space. */
export function fold(text: string): string {
  return text.toLowerCase().replace(/[.'’]/g, "").replace(/[^\p{L}\p{N}]+/gu, " ").trim()
}

// Words that only say a level or a class type ("spanish 2", "chem honors"): nice to match, never needed.
const LEVEL_WORDS = new Set(["honors", "honor", "hon", "h", "regular", "level", "cp", "i", "ii", "iii", "iv"])
// Small words that never decide a match on their own.
const SMALL_WORDS = new Set(["a", "an", "and", "at", "by", "for", "in", "is", "of", "on", "or", "the", "to", "with"])
const isLevel = (word: string) => /^\d+$/.test(word) || LEVEL_WORDS.has(word)

/** True when every word starts a word somewhere in `texts` (all folded). */
const allStart = (texts: string[], words: string[]) => words.every((word) => texts.some((text) => ` ${text}`.includes(` ${word}`)))

type Query = { whole: string; needed: string[]; extra: string[] }

function readQuery(text: string): Query | null {
  const whole = fold(text)
  if (!whole) return null
  const words = whole.split(" ")
  const needed = words.filter((word) => !isLevel(word) && !SMALL_WORDS.has(word))
  const kept = needed.length ? needed : words
  return { whole, needed: kept, extra: words.filter((word) => !kept.includes(word)) }
}

/**
 * How well one entry fits, best 0, or null. `own` is the entry's name and aliases, `wider` the
 * names it sits under (a subtopic's subject, a subject's group). All folded.
 */
function fit(query: Query, own: string[], wider: string[]): number | null {
  let tier: number | null = null
  if (own.includes(query.whole)) tier = 0
  else if (own.some((text) => text.startsWith(query.whole))) tier = 1
  else if (allStart(own, query.needed)) tier = 2
  else if (wider.length > 0 && allStart([...own, ...wider], query.needed)) tier = 3
  else if (query.whole.length >= 3 && own.some((text) => text.includes(query.whole))) tier = 4
  if (tier === null) return null
  // "spanish 2": Spanish fits, but an entry that also has the "2" fits better.
  const missedExtra = query.extra.length > 0 && !allStart([...own, ...wider], query.extra)
  return tier * 2 + (missedExtra ? 1 : 0)
}

const ownWords = (entry: { name: string; aliases?: string[] }) => [fold(entry.name), ...(entry.aliases ?? []).map(fold)]

/** Picker search inside one subject: its subtopics whose name or alias fits the words, best first. */
export function searchSubtopics(subject: Subject, text: string): Subtopic[] {
  const query = readQuery(text)
  const open = subject.subtopics.filter((subtopic) => !subtopic.retired)
  if (!query) return open
  return open
    .map((subtopic, order) => ({ subtopic, order, score: fit(query, ownWords(subtopic), []) }))
    .filter((entry): entry is { subtopic: Subtopic; order: number; score: number } => entry.score !== null)
    .sort((a, b) => a.score - b.score || a.order - b.order)
    .map((entry) => entry.subtopic)
}

/**
 * Picker search, word by word in any order: subject names and aliases, subtopic names and
 * aliases ("ap calc", "trig", "texas history"), and group names ("science" lists every subject
 * in Science). Level words like "2" or "honors" help but are never needed ("spanish 2" finds
 * Spanish). Best first: a whole name, then a name that starts with the words, then every word
 * starting a word, and a subject before a subtopic. Retired entries are hidden.
 */
export function searchSubjects(list: SubjectList, text: string, limit = 40): SubjectMatch[] {
  const query = readQuery(text)
  if (!query) return []
  const scored: { score: number; order: number; match: SubjectMatch }[] = []
  const groupNames = new Map(list.groups.map((group) => [group.slug, fold(group.name)]))
  let order = 0
  for (const subject of list.subjects) {
    if (subject.retired) continue
    const subjectWords = ownWords(subject)
    const best = fit(query, subjectWords, [groupNames.get(subject.group) ?? ""])
    if (best !== null) scored.push({ score: best * 2, order: order++, match: { kind: "subject", subject } })
    for (const subtopic of subject.subtopics) {
      if (subtopic.retired) continue
      const score = fit(query, ownWords(subtopic), subjectWords)
      if (score !== null) scored.push({ score: score * 2 + 1, order: order++, match: { kind: "subtopic", subject, subtopic } })
    }
  }
  return scored
    .sort((a, b) => a.score - b.score || a.order - b.order)
    .slice(0, limit)
    .map((entry) => entry.match)
}

/** The words a search result shows: "Algebra 1 · Math" for a subtopic, the name for a subject. */
export function matchLabel(match: SubjectMatch): string {
  return match.kind === "subject" ? match.subject.name : `${match.subtopic.name} · ${match.subject.name}`
}
