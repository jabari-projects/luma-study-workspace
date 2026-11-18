// Retries never make copies: a lost answer, a double tap, or a reload and retry each make ONE
// note, deck or plan (the same Idempotency-Key is sent every time for one new item).
// FAKE API only (dev/mock-api.mjs); made-up titles on the seeded demo account.
import { expect, test } from "@playwright/test"
import type { Page } from "@playwright/test"

import { SEEDED, loginAndWait } from "./helpers"
import { apiDelete, apiGet, countRequests, failNext, saveLine, uniqueTitle } from "./work-helpers"

const notesBox = (page: Page) => page.getByRole("textbox", { name: "Your notes" })

async function countByTitle(page: Page, path: string, title: string, field = "title") {
  const { body } = await apiGet(page, SEEDED.demo.email, path)
  return (body as Array<Record<string, unknown>>).filter((row) => row[field] === title).length
}

test.beforeEach(async ({ page }) => {
  await loginAndWait(page, SEEDED.demo.email)
})

test("a new note whose answer is lost: the automatic retry makes one note", async ({ page }, info) => {
  const title = uniqueTitle("Lost answer", info)
  await page.goto("/notes/new")
  await page.getByRole("textbox", { name: "Title" }).fill(title)
  await notesBox(page).fill("SYNTH saved once")
  await failNext(page, "/notes", "drop-after-commit")
  const posts = countRequests(page, (r) => r.method() === "POST" && /\/notes$/.test(r.url()))
  await page.getByRole("button", { name: "Save note" }).click()
  await expect(page).toHaveURL(/\/notes\/[0-9a-f-]{36}\/edit$/, { timeout: 15_000 })
  expect(posts.count).toBe(2)
  const keys = posts.requests.map((r) => r.headers()["idempotency-key"])
  expect(keys[0]).toMatch(/^[0-9a-f-]{36}$/)
  expect(keys[1]).toBe(keys[0])
  expect(await countByTitle(page, "/notes", title)).toBe(1)
})

test("tapping Save note twice makes one note", async ({ page }, info) => {
  const title = uniqueTitle("Double tap", info)
  await page.goto("/notes/new")
  await page.getByRole("textbox", { name: "Title" }).fill(title)
  await notesBox(page).fill("SYNTH tapped twice")
  const save = page.getByRole("button", { name: "Save note" })
  await save.dblclick()
  await expect(page).toHaveURL(/\/notes\/[0-9a-f-]{36}\/edit$/)
  await expect(saveLine(page)).toHaveText(/^Saved at/)
  expect(await countByTitle(page, "/notes", title)).toBe(1)
})

test("a lost answer, then a reload and Save again, still makes one note", async ({ page }, info) => {
  const title = uniqueTitle("Reload retry", info)
  await page.goto("/notes/new")
  await page.getByRole("textbox", { name: "Title" }).fill(title)
  await notesBox(page).fill("SYNTH reload and retry")
  // The copy in this tab (with the note's Idempotency-Key) is written a moment after typing.
  await expect
    .poll(() => page.evaluate(() => Object.keys(window.sessionStorage).filter((key) => key.startsWith("luma.draft:v1:u1:note:new"))))
    .toHaveLength(1)
  await failNext(page, "/notes", "drop-after-commit")
  const lost = page.waitForEvent("requestfailed", (r) => r.method() === "POST" && /\/notes$/.test(r.url()))
  await page.getByRole("button", { name: "Save note" }).click()
  const firstKey = (await lost).headers()["idempotency-key"]
  // The student reloads before the automatic retry.
  page.once("dialog", (dialog) => void dialog.accept())
  await page.reload()
  await page.getByRole("button", { name: "Use them" }).click()
  await expect(notesBox(page)).toHaveValue("SYNTH reload and retry")
  const again = page.waitForRequest((r) => r.method() === "POST" && /\/notes$/.test(r.url()))
  await page.getByRole("button", { name: "Save note" }).click()
  expect((await again).headers()["idempotency-key"]).toBe(firstKey)
  await expect(page).toHaveURL(/\/notes\/[0-9a-f-]{36}\/edit$/)
  expect(await countByTitle(page, "/notes", title)).toBe(1)
})

test("a new deck whose answer is lost makes one deck", async ({ page }, info) => {
  const title = uniqueTitle("Deck once", info)
  await page.goto("/flashcards/new")
  await page.getByRole("textbox", { name: "Title" }).fill(title)
  await page.getByRole("textbox", { name: "Question 1" }).fill("SYNTH Q")
  await page.getByRole("textbox", { name: "Answer 1" }).fill("SYNTH A")
  await failNext(page, "/flashcards", "drop-after-commit")
  await page.getByRole("button", { name: "Save deck" }).click()
  await expect(page).toHaveURL(/\/flashcards\/[0-9a-f-]{36}\/edit$/, { timeout: 15_000 })
  expect(await countByTitle(page, "/flashcards", title)).toBe(1)
  // The seeded demo account's deck list is counted by other tests: remove this made-up deck.
  const deckId = page.url().split("/").slice(-2)[0]
  await page.goto("/flashcards")
  await apiDelete(page, SEEDED.demo.email, `/flashcards/${deckId}`)
})

test("a study plan whose answer is lost: tapping Save plan again makes one plan", async ({ page }, info) => {
  const name = uniqueTitle("Plan once", info)
  await page.goto("/study-sessions")
  await page.getByRole("textbox", { name: "Name" }).fill(name)
  await failNext(page, "/study-sessions", "drop-after-commit")
  await page.getByRole("button", { name: "Save plan" }).click()
  await expect(page.getByText("We can't reach Luma right now. Try again in a minute.")).toBeVisible()
  await expect(page.getByRole("textbox", { name: "Name" })).toHaveValue(name)
  await page.getByRole("button", { name: "Save plan" }).click()
  await expect(page.locator(".plan-name", { hasText: name })).toHaveCount(1)
  expect(await countByTitle(page, "/study-sessions", name, "name")).toBe(1)
})
