// The subject list helpers, run on the backend's own file (the one GET /subjects sends).
import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"

import {
  NO_SUBJECT,
  choiceFrom,
  fold,
  groupedSubjects,
  isSlug,
  matchLabel,
  searchSubjects,
  searchSubtopics,
  subjectBody,
  subjectLabel,
} from "./subjects.ts"
import type { SubjectList } from "./subjects.ts"

const list = JSON.parse(readFileSync(new URL("../../../backend/app/data/subjects.json", import.meta.url), "utf8")) as SubjectList

describe("the subject list", () => {
  it("has every subject under a group heading, in the file's order", () => {
    const groups = groupedSubjects(list)
    assert.equal(groups.length, list.groups.length)
    assert.equal(groups.reduce((n, g) => n + g.subjects.length, 0), 67)
    assert.equal(groups[0].group.name, "Math and data")
    assert.equal(groups[0].subjects[0].name, "Math")
  })

  it("hides retired subjects from the picker", () => {
    const copy: SubjectList = { ...list, subjects: list.subjects.map((s) => (s.slug === "math" ? { ...s, retired: true } : s)) }
    assert.ok(!groupedSubjects(copy).some((g) => g.subjects.some((s) => s.slug === "math")))
    assert.ok(!searchSubjects(copy, "math").some((m) => m.kind === "subject" && m.subject.slug === "math"))
    // A stored row that uses it still shows its name.
    assert.equal(subjectLabel(copy, "math", "algebra"), "Math › Algebra 1")
  })
})

describe("picker search", () => {
  it('"alg" puts Algebra 1 first', () => {
    const results = searchSubjects(list, "alg")
    assert.equal(matchLabel(results[0]), "Algebra 1 · Math")
    assert.ok(results.some((m) => matchLabel(m) === "Abstract algebra · College math"))
  })

  it("finds a subject by its alias", () => {
    const first = searchSubjects(list, "apush")[0]
    assert.equal(first.kind, "subject")
    assert.equal(first.subject.slug, "us-history")
  })

  it('"science" shows the whole Science group', () => {
    const subjects = new Set(searchSubjects(list, "science").filter((m) => m.kind === "subject").map((m) => m.subject.slug))
    for (const slug of ["general-science", "biology", "chemistry", "physics", "earth-space", "environmental-science", "nanotech"]) {
      assert.ok(subjects.has(slug), slug)
    }
  })

  it("a subject comes before a subtopic with the same start", () => {
    const results = searchSubjects(list, "spanish")
    assert.equal(results[0].kind, "subject")
    assert.equal(results[0].subject.slug, "spanish")
  })

  it("finds what teens type: word by word, short course names, level numbers", () => {
    const first = (text: string) => matchLabel(searchSubjects(list, text)[0])
    assert.equal(first("us history"), "U.S. history")
    assert.equal(first("u.s. history"), "U.S. history")
    assert.equal(first("history us"), "U.S. history")
    assert.equal(first("ap calc"), "Calculus · Math")
    assert.equal(first("calc bc"), "Calculus · Math")
    assert.equal(first("ap stats"), "Statistics and data science")
    assert.equal(first("ap lang"), "English language arts")
    assert.equal(first("ap art history"), "Art history · Art and design")
    assert.equal(first("spanish 2"), "Spanish")
    assert.equal(first("chem honors"), "Chemistry")
    assert.equal(first("integrated math"), "Integrated math I, II and III · Math")
    assert.equal(first("ap seminar"), "AP Seminar and AP Research · English language arts")
    assert.equal(first("holocaust"), "The Holocaust and genocide · World history")
    assert.equal(first("texas history"), "State history (Texas, California and more) · U.S. history")
    assert.equal(first("trig"), "Trigonometry · Math")
    assert.equal(first("geo"), "Geometry · Math")
    assert.equal(first("italian"), "Italian")
  })

  it("hides retired subtopics (Italian moved to its own subject)", () => {
    assert.ok(!searchSubjects(list, "italian").some((m) => m.kind === "subtopic" && m.subject.slug === "more-languages"))
    const more = list.subjects.find((s) => s.slug === "more-languages")!
    assert.ok(!searchSubtopics(more, "").some((t) => t.slug === "italian"))
    assert.deepEqual(searchSubtopics(more, "navajo").map((t) => t.slug), ["navajo"])
  })

  it("folds marks the way the server does", () => {
    assert.equal(fold("U.S. History"), "us history")
    assert.equal(fold("Newton's  laws"), "newtons laws")
    assert.equal(fold("pre-algebra/ratios"), "pre algebra ratios")
  })

  it("finds nothing for words on no list, and nothing for an empty box", () => {
    assert.deepEqual(searchSubjects(list, "zzzz"), [])
    assert.deepEqual(searchSubjects(list, "   "), [])
  })
})

describe("labels and stored values", () => {
  it('reads "Subject › Subtopic", or just the subject', () => {
    assert.equal(subjectLabel(list, "math", "algebra"), "Math › Algebra 1")
    assert.equal(subjectLabel(list, "biology", null), "Biology")
    assert.equal(subjectLabel(list, "computer-science", "math-for-cs"), "Computer science › Math for computer science")
  })

  it("shows nothing (instead of crashing) for unknown slugs or no list", () => {
    assert.equal(subjectLabel(list, "astrology", null), "")
    assert.equal(subjectLabel(list, null, "algebra"), "")
    assert.equal(subjectLabel(null, "math", "algebra"), "")
    assert.equal(subjectLabel(list, "math", "nope"), "Math")
  })

  it("old drafts and rows with no subject read as none; bad values are dropped", () => {
    assert.deepEqual(choiceFrom(undefined, undefined), NO_SUBJECT)
    assert.deepEqual(choiceFrom(null, "algebra"), NO_SUBJECT)
    assert.deepEqual(choiceFrom("Math!", null), NO_SUBJECT)
    assert.deepEqual(choiceFrom("math", "Bad One"), { subject: "math", subtopic: null })
    assert.deepEqual(choiceFrom("math", "algebra"), { subject: "math", subtopic: "algebra" })
    assert.equal(isSlug("a".repeat(41)), false)
  })

  it("always sends both fields, and never a subtopic without a subject", () => {
    assert.deepEqual(subjectBody(NO_SUBJECT), { subject_slug: null, subtopic_slug: null })
    assert.deepEqual(subjectBody({ subject: "math", subtopic: "algebra" }), { subject_slug: "math", subtopic_slug: "algebra" })
    assert.deepEqual(subjectBody({ subject: null, subtopic: "algebra" }), { subject_slug: null, subtopic_slug: null })
  })
})

describe("where the picker is", () => {
  const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8")
  it("is on the note and summary editor, the deck editor and the notes workbench", () => {
    assert.match(read("../notes/NoteEditorPage.tsx"), /<SubjectPicker value=\{subject\}/)
    assert.match(read("../study/FlashcardPages.tsx"), /<SubjectPicker value=\{subject\}/)
    assert.match(read("../capture/Workbench.tsx"), /<SubjectPicker value=\{subject\}/)
  })

  it("loads the list once per page load, with no polling", () => {
    const hook = read("./useSubjects.ts")
    assert.match(hook, /let pending: Promise<SubjectList> \| null = null/)
    assert.doesNotMatch(hook, /setInterval|setTimeout/)
  })
})
