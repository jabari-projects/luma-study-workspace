// Saving student work as you type: "Saving...", "Saved" only after the server confirmed it,
// slow and failed saves, and leaving a page with work that isn't saved yet.
// FAKE API only (dev/mock-api.mjs); made-up titles on the seeded demo account.
import { expect, test } from "@playwright/test"
import type { Page } from "@playwright/test"

import { SEEDED, loginAndWait } from "./helpers"
import { apiCreate, apiDelete, apiGet, countRequests, failNext, saveLine, slowNext, uniqueTitle, warnsBeforeLeaving } from "./work-helpers"

const notesBox = (page: Page) => page.getByRole("textbox", { name: "Your notes" })

test.beforeEach(async ({ page }) => {
  await loginAndWait(page, SEEDED.demo.email)
})

async function openEditor(page: Page, title: string, content = "SYNTH start.") {
  const note = await apiCreate(page, SEEDED.demo.email, "notes", { title, content, tags: [] })
  await page.goto(`/notes/${note.id}/edit`)
  await expect(notesBox(page)).toHaveValue(content)
  return note.id
}

test("a saved note saves by itself a moment after typing; Saved shows only after the server answered", async ({ page }, info) => {
  const id = await openEditor(page, uniqueTitle("Autosave", info))
  const puts = countRequests(page, (r) => r.method() === "PUT" && r.url().endsWith(`/notes/${id}`))
  await expect(saveLine(page)).toHaveText("")
  expect(await warnsBeforeLeaving(page)).toBe(false)

  await notesBox(page).fill("SYNTH start. More words.")
  await expect(saveLine(page)).toHaveText("Not saved yet")
  expect(await warnsBeforeLeaving(page)).toBe(true)
  await expect(saveLine(page)).toHaveText(/^Saved at \d{1,2}:\d{2}/)
  expect(puts.count).toBe(1)
  expect(puts.requests[0].postDataJSON()).toMatchObject({ content: "SYNTH start. More words.", expected_version: 1 })
  expect(await warnsBeforeLeaving(page)).toBe(false)

  const { body } = await apiGet(page, SEEDED.demo.email, `/notes/${id}`)
  expect(body).toMatchObject({ content: "SYNTH start. More words.", version: 2 })

  // The next change carries the new version.
  await notesBox(page).fill("SYNTH start. More words. Even more.")
  await expect(saveLine(page)).toHaveText(/^Saved at/)
  await expect.poll(() => puts.count).toBe(2)
  expect(puts.requests[1].postDataJSON()).toMatchObject({ expected_version: 2 })
})

test("a slow save says Still saving... and is never sent twice", async ({ page }, info) => {
  const id = await openEditor(page, uniqueTitle("Slow save", info))
  await slowNext(page, `/notes/${id}`, 7000)
  const puts = countRequests(page, (r) => r.method() === "PUT" && r.url().endsWith(`/notes/${id}`))
  await notesBox(page).fill("SYNTH slow words")
  await expect(saveLine(page)).toHaveText("Saving...")
  await expect(saveLine(page)).toHaveText("Still saving...", { timeout: 8000 })
  // Typing while it saves waits for that save, then only the newest words go.
  await notesBox(page).fill("SYNTH slow words, newer")
  await expect(saveLine(page)).toHaveText(/^Saved at/, { timeout: 15_000 })
  await expect.poll(() => puts.count).toBe(2)
  expect(puts.requests[1].postDataJSON()).toMatchObject({ content: "SYNTH slow words, newer", expected_version: 2 })
  await expect(notesBox(page)).toHaveValue("SYNTH slow words, newer")
})

test("a failed save says Couldn't save, keeps the words, and Try again saves them", async ({ page }, info) => {
  const id = await openEditor(page, uniqueTitle("Failed save", info))
  await failNext(page, `/notes/${id}`, "500")
  const puts = countRequests(page, (r) => r.method() === "PUT" && r.url().endsWith(`/notes/${id}`))
  await notesBox(page).fill("SYNTH words that must not be lost")
  await expect(saveLine(page)).toHaveText("Couldn't save. Your words are still here.")
  await expect(notesBox(page)).toHaveValue("SYNTH words that must not be lost")
  // A server error is not retried by itself, and no technical text is shown.
  await page.waitForTimeout(2500)
  expect(puts.count).toBe(1)
  await expect(page.locator(".save-status")).not.toContainText(/500|Internal|Error/)
  expect(await warnsBeforeLeaving(page)).toBe(true)

  await page.getByRole("button", { name: "Try again" }).click()
  await expect(saveLine(page)).toHaveText(/^Saved at/)
  const { body } = await apiGet(page, SEEDED.demo.email, `/notes/${id}`)
  expect(body.content).toBe("SYNTH words that must not be lost")
})

test("leaving by an in-app link first saves, shows Saving your work..., then goes on by itself", async ({ page }, info) => {
  const id = await openEditor(page, uniqueTitle("Leave saves", info))
  await slowNext(page, `/notes/${id}`, 1500)
  await notesBox(page).fill("SYNTH saved on the way out")
  await page.getByRole("link", { name: "Back to the note" }).click()
  await expect(page.getByRole("alertdialog", { name: "Saving your work" })).toBeVisible()
  await expect(page).toHaveURL(new RegExp(`/notes/${id}$`))
  await expect(page.getByRole("article")).toContainText("SYNTH saved on the way out")
})

test("if saving on the way out fails, it asks: Stay here keeps the words, Leave anyway goes", async ({ page }, info) => {
  const id = await openEditor(page, uniqueTitle("Leave fails", info))
  await failNext(page, `/notes/${id}`, "500", 2)
  await notesBox(page).fill("SYNTH not saved yet")
  await page.getByRole("link", { name: "Back to the note" }).click()
  const ask = page.getByRole("alertdialog", { name: "Your work isn't saved." })
  await expect(ask).toBeVisible()
  await ask.getByRole("button", { name: "Stay here" }).click()
  await expect(page).toHaveURL(new RegExp(`/notes/${id}/edit$`))
  await expect(notesBox(page)).toHaveValue("SYNTH not saved yet")

  await page.getByRole("link", { name: "Back to the note" }).click()
  await page.getByRole("alertdialog", { name: "Your work isn't saved." }).getByRole("button", { name: "Leave anyway" }).click()
  await expect(page).toHaveURL(new RegExp(`/notes/${id}$`))
})

test("a new note never saves by itself; leaving asks first and nothing half-done is saved", async ({ page }, info) => {
  await page.goto("/notes/new")
  const posts = countRequests(page, (r) => r.method() === "POST" && /\/notes$/.test(r.url()))
  await page.getByRole("textbox", { name: "Title" }).fill(uniqueTitle("Not yet", info))
  await notesBox(page).fill("SYNTH half a note")
  await expect(saveLine(page)).toHaveText("Not saved yet")
  await page.waitForTimeout(3000)
  expect(posts.count).toBe(0)
  expect(await warnsBeforeLeaving(page)).toBe(true)

  await page.getByRole("link", { name: "Cancel" }).click()
  const ask = page.getByRole("alertdialog", { name: "Your work isn't saved." })
  await ask.getByRole("button", { name: "Stay here" }).click()
  await expect(page).toHaveURL(/\/notes\/new$/)
  expect(posts.count).toBe(0)
})

test("the deck editor saves by itself and waits (without failing) while a card has only one side", async ({ page }, info) => {
  const title = uniqueTitle("Autosave deck", info)
  const deck = await apiCreate(page, SEEDED.demo.email, "flashcards", { title, cards: [{ id: "a1", front: "Q one", back: "A one" }] })
  await page.goto(`/flashcards/${deck.id}/edit`)
  await expect(page.getByRole("textbox", { name: "Answer 1" })).toHaveValue("A one")
  await page.getByRole("textbox", { name: "Answer 1" }).fill("A one, fixed")
  await expect(saveLine(page)).toHaveText(/^Saved at/, { timeout: 10_000 })
  const { body } = await apiGet(page, SEEDED.demo.email, `/flashcards/${deck.id}`)
  expect(body.cards[0]).toMatchObject({ id: "a1", back: "A one, fixed" })
  expect(body.version).toBe(2)

  // A card with only a question can't be saved yet: autosave waits, says which card, and sends nothing.
  const puts = countRequests(page, (r) => r.method() === "PUT" && r.url().endsWith(`/flashcards/${deck.id}`))
  await page.getByRole("button", { name: "Add card" }).click()
  await page.getByRole("textbox", { name: "Question 2" }).fill("Only a question")
  await expect(saveLine(page)).toHaveText("Not saved yet. Finish card 2.", { timeout: 10_000 })
  await page.waitForTimeout(2500)
  expect(puts.count).toBe(0)
  await expect(page.locator(".save-status")).toHaveAttribute("data-state", "dirty")
  // No red marks until the student presses Save.
  await expect(page.getByText("Not filled in")).toHaveCount(0)
  expect(await warnsBeforeLeaving(page)).toBe(true)
  await page.getByRole("textbox", { name: "Answer 2" }).fill("Now an answer")
  await expect(saveLine(page)).toHaveText(/^Saved at/, { timeout: 10_000 })
  expect(puts.count).toBe(1)
  // The seeded demo account's deck list is counted by other tests: remove this made-up deck.
  await page.goto("/flashcards")
  await apiDelete(page, SEEDED.demo.email, `/flashcards/${deck.id}`)
})
