// Two tabs or devices: a newer save is never overwritten quietly. The conflict panel offers
// "See the newer one", "Keep mine" and "Save mine as a new note"; a deleted note offers a copy
// or throwing it away. Studying in one tab and editing the deck in another keeps both.
// FAKE API only (dev/mock-api.mjs); made-up titles on the seeded demo account.
import { expect, test } from "@playwright/test"
import type { Page } from "@playwright/test"

import { SEEDED, loginAndWait } from "./helpers"
import { apiCreate, apiDelete, apiGet, editElsewhere, saveLine, uniqueTitle } from "./work-helpers"

const notesBox = (page: Page) => page.getByRole("textbox", { name: "Your notes" })
const panel = (page: Page) => page.getByRole("group", { name: "This note was changed in another tab or on another device." })

test.beforeEach(async ({ page }) => {
  await loginAndWait(page, SEEDED.demo.email)
})

async function conflictOn(page: Page, title: string) {
  const note = await apiCreate(page, SEEDED.demo.email, "notes", { title, content: "SYNTH first words.", tags: [] })
  await page.goto(`/notes/${note.id}/edit`)
  await expect(notesBox(page)).toHaveValue("SYNTH first words.")
  // Another tab saves first.
  await editElsewhere(page, "notes", note.id, { content: "SYNTH from the other tab." })
  await notesBox(page).fill("SYNTH mine from this tab.")
  await expect(panel(page)).toBeVisible({ timeout: 10_000 })
  // Nothing was saved over the newer words.
  const { body } = await apiGet(page, SEEDED.demo.email, `/notes/${note.id}`)
  expect(body).toMatchObject({ content: "SYNTH from the other tab.", version: 2 })
  await expect(page.getByRole("heading", { name: "This note was changed in another tab or on another device." })).toBeFocused()
  return note.id
}

test("See the newer one loads it and keeps mine in a box to copy from", async ({ page }, info) => {
  const id = await conflictOn(page, uniqueTitle("See newer", info))
  await panel(page).getByRole("button", { name: "See the newer one" }).click()
  await expect(panel(page)).toBeHidden()
  await expect(notesBox(page)).toHaveValue("SYNTH from the other tab.")
  await expect(page.getByRole("textbox", { name: "Your version" })).toHaveValue(/SYNTH mine from this tab\./)
  // Editing again saves on top of the newer version.
  await notesBox(page).fill("SYNTH from the other tab. And one more line.")
  await expect(saveLine(page)).toHaveText(/^Saved at/)
  const { body } = await apiGet(page, SEEDED.demo.email, `/notes/${id}`)
  expect(body).toMatchObject({ content: "SYNTH from the other tab. And one more line.", version: 3 })
})

test("Keep mine saves my words only because I pressed it", async ({ page }, info) => {
  const id = await conflictOn(page, uniqueTitle("Keep mine", info))
  const sent = page.waitForRequest((r) => r.method() === "PUT" && r.url().endsWith(`/notes/${id}`))
  await panel(page).getByRole("button", { name: "Keep mine" }).click()
  expect((await sent).postDataJSON()).toMatchObject({ content: "SYNTH mine from this tab.", expected_version: 2 })
  await expect(saveLine(page)).toHaveText(/^Saved at/)
  const { body } = await apiGet(page, SEEDED.demo.email, `/notes/${id}`)
  expect(body).toMatchObject({ content: "SYNTH mine from this tab.", version: 3 })
})

test("Save mine as a new note keeps both", async ({ page }, info) => {
  const title = uniqueTitle("Save as new", info)
  const id = await conflictOn(page, title)
  await panel(page).getByRole("button", { name: "Save mine as a new note" }).click()
  await expect(page).not.toHaveURL(new RegExp(id))
  await expect(page).toHaveURL(/\/notes\/[0-9a-f-]{36}\/edit$/)
  await expect(notesBox(page)).toHaveValue("SYNTH mine from this tab.")
  const { body: original } = await apiGet(page, SEEDED.demo.email, `/notes/${id}`)
  expect(original.content).toBe("SYNTH from the other tab.")
  const { body: all } = await apiGet(page, SEEDED.demo.email, "/notes")
  expect((all as Array<{ title: string }>).filter((note) => note.title === title)).toHaveLength(2)
})

test("a note deleted somewhere else: save mine as a new note, or throw mine away", async ({ page }, info) => {
  const title = uniqueTitle("Deleted elsewhere", info)
  const note = await apiCreate(page, SEEDED.demo.email, "notes", { title, content: "SYNTH soon gone.", tags: [] })
  await page.goto(`/notes/${note.id}/edit`)
  await expect(notesBox(page)).toHaveValue("SYNTH soon gone.")
  await apiDelete(page, SEEDED.demo.email, `/notes/${note.id}`)
  await notesBox(page).fill("SYNTH typed after it was deleted.")
  const gone = page.getByRole("group", { name: "This note was deleted somewhere else." })
  await expect(gone).toBeVisible({ timeout: 10_000 })
  await expect(gone.getByRole("button", { name: "Keep mine" })).toHaveCount(0)
  await gone.getByRole("button", { name: "Save mine as a new note" }).click()
  await expect(page).toHaveURL(/\/notes\/[0-9a-f-]{36}\/edit$/)
  await expect(notesBox(page)).toHaveValue("SYNTH typed after it was deleted.")

  // Throw mine away goes back to the notes.
  const other = await apiCreate(page, SEEDED.demo.email, "notes", { title: uniqueTitle("Gone too", info), content: "SYNTH x.", tags: [] })
  await page.goto(`/notes/${other.id}/edit`)
  await expect(notesBox(page)).toHaveValue("SYNTH x.")
  await apiDelete(page, SEEDED.demo.email, `/notes/${other.id}`)
  await notesBox(page).fill("SYNTH not wanted.")
  await page.getByRole("group", { name: "This note was deleted somewhere else." }).getByRole("button", { name: "Throw mine away" }).click()
  await expect(page).toHaveURL(/\/notes$/)
})

test("studying in one tab and editing the deck in another keeps the progress and the new words", async ({ context }, info) => {
  // The demo account is already signed in on this device (beforeEach); new tabs use it.
  const study = await context.newPage()
  await study.goto("/dashboard")
  const title = uniqueTitle("Study vs edit", info)
  const deck = await apiCreate(study, SEEDED.demo.email, "flashcards", {
    title,
    cards: [
      { id: "s1", front: "SYNTH Q1", back: "SYNTH A1" },
      { id: "s2", front: "SYNTH Q2", back: "SYNTH A2" },
    ],
  })
  const editor = await context.newPage()
  await editor.goto(`/flashcards/${deck.id}/edit`)
  await expect(editor.getByRole("textbox", { name: "Question 1" })).toHaveValue("SYNTH Q1")

  // Tab 1 studies: each grade is saved as progress only.
  await study.goto(`/flashcards/${deck.id}/study`)
  await expect(study.getByRole("heading", { level: 1, name: /^Ready to (review|practice)$/ })).toBeVisible()
  await study.getByRole("button", { name: "Start", exact: true }).click()
  const progress = study.waitForResponse((r) => r.url().endsWith(`/flashcards/${deck.id}/progress`) && r.request().method() === "PATCH")
  await study.getByRole("button", { name: "Show answer" }).click()
  await study.getByRole("button", { name: /^Got it/ }).click()
  expect((await progress).status()).toBe(200)

  // Tab 2 edits a card after that: no conflict, and the progress stays.
  await editor.getByRole("textbox", { name: "Answer 2" }).fill("SYNTH A2, fixed")
  await expect(saveLine(editor)).toHaveText(/^Saved at/, { timeout: 10_000 })
  await expect(editor.getByRole("group", { name: /was changed in another tab/ })).toHaveCount(0)
  const { body } = await apiGet(study, SEEDED.demo.email, `/flashcards/${deck.id}`)
  const cards = body.cards as Array<{ id: string; back: string; review: unknown }>
  expect(cards.find((card) => card.id === "s2")?.back).toBe("SYNTH A2, fixed")
  expect(cards.filter((card) => card.review !== null)).toHaveLength(1)
  expect(body.version).toBe(2)
  // The seeded demo account's deck list is counted by other tests: remove this made-up deck.
  await apiDelete(study, SEEDED.demo.email, `/flashcards/${deck.id}`)
})

test("the share button with an older version shows the conflict panel instead of overwriting", async ({ page }, info) => {
  const title = uniqueTitle("Share conflict", info)
  const note = await apiCreate(page, SEEDED.demo.email, "notes", { title, content: "SYNTH share me.", tags: [] })
  await page.goto(`/notes/${note.id}`)
  await expect(page.getByRole("heading", { level: 1, name: title })).toBeVisible()
  await editElsewhere(page, "notes", note.id, { title: `${title} renamed` })
  await page.locator("header.page-head").getByRole("button", { name: "Share", exact: true }).click()
  await page.getByRole("dialog", { name: "Share this note?" }).getByRole("button", { name: "Share", exact: true }).click()
  await expect(panel(page)).toBeVisible()
  const { body } = await apiGet(page, SEEDED.demo.email, `/notes/${note.id}`)
  expect(body.is_public).toBe(false)
  await panel(page).getByRole("button", { name: "See the newer one" }).click()
  await expect(page.getByRole("heading", { level: 1, name: `${title} renamed` })).toBeVisible()
})
