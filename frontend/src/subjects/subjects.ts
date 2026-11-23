// The subject list (subjects -> subtopics) and small helpers for it.
// No window or React here, so `node --test` can run it. The list itself comes from the API
// (GET /subjects, the backend's app/data/subjects.json); see useSubjects.ts.

export type Subtopic = { slug: string; name: string; retired?: boolean }
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

const squeeze = (text: string) => text.toLowerCase().split(/\s+/).filter(Boolean).join(" ")

/**
 * Picker search: subject names, aliases, group names and subtopic names that hold the words.
 * Best first: starts-with before contains, and a subject before a subtopic. A group name
 * ("science") lists every subject in that group. Retired entries are hidden.
 */
export function searchSubjects(list: SubjectList, text: string, limit = 40): SubjectMatch[] {
  const wanted = squeeze(text)
  if (!wanted) return []
  const scored: { score: number; order: number; match: SubjectMatch }[] = []
  const groupNames = new Map(list.groups.map((group) => [group.slug, group.name.toLowerCase()]))
  let order = 0
  const scoreOf = (words: string[]) => {
    if (words.some((word) => word === wanted)) return 0
    if (words.some((word) => word.startsWith(wanted))) return 1
    if (words.some((word) => word.split(/[\s(,-]+/).some((part) => part.startsWith(wanted)))) return 2
    if (words.some((word) => word.includes(wanted))) return 3
    return null
  }
  for (const subject of list.subjects) {
    if (subject.retired) continue
    const own = scoreOf([subject.name.toLowerCase(), ...(subject.aliases ?? [])])
    const viaGroup = scoreOf([groupNames.get(subject.group) ?? ""])
    const best = own ?? (viaGroup === null ? null : viaGroup + 1)
    if (best !== null) scored.push({ score: best * 2, order: order++, match: { kind: "subject", subject } })
    for (const subtopic of subject.subtopics) {
      if (subtopic.retired) continue
      const score = scoreOf([subtopic.name.toLowerCase()])
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
