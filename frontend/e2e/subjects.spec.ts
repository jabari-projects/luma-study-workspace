// The subject picker (owner item 4): pick a subject and subtopic for notes, decks and summaries,
// by search, by browsing or with the keyboard only. It saves with the rest of the item.
// FAKE API only (dev/mock-api.mjs); brand-new made-up accounts, nothing shared.
import { expect, test } from "@playwright/test"
import type { Page } from "@playwright/test"

import { answerSharePrompt, expectNoSeriousA11yIssues, loginAndWait, makeAccount } from "./helpers"
import { apiCreate, apiGet, saveLine } from "./work-helpers"

const pickerButton = (page: Page) => page.getByRole("button", { name: /^Subject \(optional\)/ })
const panel = (page: Page) => page.locator(".subject-panel")
const search = (page: Page) => page.getByRole("combobox", { name: /^Search (subjects|topics in .+)$/ })
const option = (page: Page, name: string) => page.getByRole("option", { name, exact: true })

test("pick by search, clear, pick by browsing; each choice saves by itself and shows on the note", async ({ page }, info) => {
  const { email } = await makeAccount(page, info, "subj")
  await loginAndWait(page, email)
  const note = await apiCreate(page, email, "notes", { title: "Equations", content: "x + 2 = 5, so x = 3.", tags: [] })
  await page.goto(`/notes/${note.id}/edit`)

  await expect(pickerButton(page)).toHaveAccessibleName("Subject (optional) Pick a subject")
  await expect(page.getByText("A subject helps people find it if you share it.")).toBeVisible()
  await pickerButton(page).click()
  await expect(page.getByRole("dialog", { name: "Pick a subject" })).toBeVisible()
  await expect(search(page)).toBeFocused()
  await expect(search(page)).toHaveAttribute("placeholder", "Search, like algebra or Spanish")
  // Before typing: subjects under their group headings.
  await expect(panel(page).getByText("Math and data", { exact: true })).toBeVisible()
  await expect(option(page, "Biology")).toBeVisible()
  await expectNoSeriousA11yIssues(page, "subject-picker-open", info)

  await search(page).fill("algebra")
  await expect(page.getByRole("option").first()).toHaveAccessibleName("Algebra 1 · Math")
  await option(page, "Algebra 1 · Math").click()
  await expect(panel(page)).toHaveCount(0)
  await expect(pickerButton(page)).toBeFocused()
  await expect(pickerButton(page)).toHaveAccessibleName("Subject (optional) Math › Algebra 1")
  await expect(saveLine(page)).toHaveText(/^Saved at /, { timeout: 10_000 })
  expect((await apiGet(page, email, `/notes/${note.id}`)).body).toMatchObject({ subject_slug: "math", subtopic_slug: "algebra", version: 2 })

  // Remove subject clears both.
  await page.getByRole("button", { name: "Remove subject" }).click()
  await expect(pickerButton(page)).toHaveAccessibleName("Subject (optional) Pick a subject")
  await expect.poll(async () => (await apiGet(page, email, `/notes/${note.id}`)).body.subject_slug, { timeout: 10_000 }).toBeNull()

  // Browse: a subject, then "Just Biology" (no subtopic).
  await pickerButton(page).click()
  await option(page, "Biology").click()
  await expect(page.getByRole("dialog", { name: "Pick a topic in Biology" })).toBeVisible()
  await expect(page.getByRole("option").first()).toHaveAccessibleName(/^Just Biology/)
  await option(page, "Genetics and DNA").scrollIntoViewIfNeeded()
  await page.getByRole("button", { name: "All subjects" }).click()
  await expect(page.getByRole("dialog", { name: "Pick a subject" })).toBeVisible()
  await option(page, "Biology").click()
  await page.getByRole("option", { name: /^Just Biology/ }).click()
  await expect(pickerButton(page)).toHaveAccessibleName("Subject (optional) Biology")
  await expect.poll(async () => (await apiGet(page, email, `/notes/${note.id}`)).body.subject_slug, { timeout: 10_000 }).toBe("biology")

  // The note page shows it under the title.
  await page.getByRole("button", { name: "Save changes" }).click()
  await expect(page).toHaveURL(new RegExp(`/notes/${note.id}$`))
  await expect(page.locator(".subject-line")).toHaveText("Subject: Biology")
})

test("keyboard only: type, Up and Down, Enter picks, Escape goes back a step, then closes", async ({ page }, info) => {
  const { email } = await makeAccount(page, info, "subjkb")
  await loginAndWait(page, email)
  const note = await apiCreate(page, email, "notes", { title: "Verbos", content: "Hablar means to talk.", tags: [] })
  await page.goto(`/notes/${note.id}/edit`)

  await pickerButton(page).focus()
  await page.keyboard.press("Enter")
  await expect(search(page)).toBeFocused()
  await page.keyboard.type("spanish")
  await expect(search(page)).toHaveAttribute("aria-activedescendant", /option-0$/)
  await expect(page.getByRole("option", { selected: true })).toHaveAccessibleName("Spanish")
  await page.keyboard.press("Enter")
  // Step 2: Spanish's topics, with "Just Spanish" first.
  await expect(page.getByRole("dialog", { name: "Pick a topic in Spanish" })).toBeVisible()
  await expect(search(page)).toBeFocused()
  await expect(page.getByRole("option", { selected: true })).toHaveAccessibleName(/^Just Spanish/)
  await page.keyboard.press("ArrowDown")
  await page.keyboard.press("ArrowDown")
  await expect(page.getByRole("option", { selected: true })).toHaveAccessibleName("Grammar")
  await page.keyboard.press("ArrowUp")
  await expect(page.getByRole("option", { selected: true })).toHaveAccessibleName("Vocabulary")
  await page.keyboard.press("Enter")
  await expect(panel(page)).toHaveCount(0)
  await expect(pickerButton(page)).toBeFocused()
  await expect(pickerButton(page)).toHaveAccessibleName("Subject (optional) Spanish › Vocabulary")
  // Enter in the picker never submitted the form.
  await expect(page).toHaveURL(/\/edit$/)

  // Opening again starts on Spanish's topics. Escape goes back, then closes.
  await page.keyboard.press("Enter")
  await expect(page.getByRole("dialog", { name: "Pick a topic in Spanish" })).toBeVisible()
  await page.keyboard.press("Escape")
  await expect(page.getByRole("dialog", { name: "Pick a subject" })).toBeVisible()
  await page.keyboard.press("Escape")
  await expect(panel(page)).toHaveCount(0)
  await expect(pickerButton(page)).toBeFocused()
  await expect(saveLine(page)).toHaveText(/^Saved at /, { timeout: 10_000 })
  expect((await apiGet(page, email, `/notes/${note.id}`)).body).toMatchObject({ subject_slug: "spanish", subtopic_slug: "vocabulary" })
})

test("a new deck saves its subject; the deck page and the shelf show it", async ({ page }, info) => {
  const { email } = await makeAccount(page, info, "subjdk")
  await loginAndWait(page, email)
  await page.goto("/flashcards/new")
  await page.getByRole("textbox", { name: "Title", exact: true }).fill("Shapes")
  await page.getByRole("textbox", { name: "Question 1", exact: true }).fill("Sides on a hexagon?")
  await page.getByRole("textbox", { name: "Answer 1", exact: true }).fill("6")
  await page.getByRole("button", { name: "Remove card 2" }).click()
  await pickerButton(page).click()
  await search(page).fill("geometry")
  await option(page, "Geometry · Math").click()
  await expect(pickerButton(page)).toHaveAccessibleName("Subject (optional) Math › Geometry")

  const created = page.waitForRequest((r) => r.method() === "POST" && r.url().endsWith("/flashcards"))
  await page.getByRole("button", { name: "Save deck" }).click()
  expect((await created).postDataJSON()).toMatchObject({ subject_slug: "math", subtopic_slug: "geometry" })
  await expect(page).toHaveURL(/\/flashcards\/[^/]+\/edit$/)
  await answerSharePrompt(page)
  await expect(pickerButton(page)).toHaveAccessibleName("Subject (optional) Math › Geometry")
  await page.getByRole("button", { name: "Save deck" }).click()
  await expect(page).toHaveURL(/\/flashcards\/[^/]+$/)
  await expect(page.locator("header.page-head .lede")).toHaveText("Math › Geometry · Your deck")
  await page.goto("/flashcards")
  await expect(page.locator("li.deck-tile").filter({ hasText: "Shapes" }).locator(".subject-line")).toHaveText("Subject: Math › Geometry")
})

test("phones get a sheet from the bottom with a Close button; wide screens a pop-up under the button", async ({ page }, info) => {
  const { email } = await makeAccount(page, info, "subjph")
  await loginAndWait(page, email)
  await page.goto("/notes/new")
  await pickerButton(page).click()
  const box = await panel(page).boundingBox()
  const viewport = page.viewportSize()!
  expect(box).toBeTruthy()
  if (viewport.width < 600) {
    await expect(panel(page)).toHaveCSS("position", "fixed")
    expect(Math.abs(box!.y + box!.height - viewport.height)).toBeLessThan(2)
    expect(box!.height).toBeLessThanOrEqual(viewport.height * 0.85 + 1)
    // The sheet shows its title, stays at least 60% tall, and closes with Close.
    await expect(panel(page).getByText("Pick a subject", { exact: true })).toBeVisible()
    expect(box!.height).toBeGreaterThanOrEqual(viewport.height * 0.6 - 1)
    await panel(page).getByRole("button", { name: "Close", exact: true }).click()
    await expect(panel(page)).toHaveCount(0)
  } else {
    await expect(panel(page)).toHaveCSS("position", "absolute")
    await expect(panel(page).getByRole("button", { name: "Close", exact: true })).toBeHidden()
    // A tap outside closes it.
    await page.locator("h1").click()
    await expect(panel(page)).toHaveCount(0)
  }
  const sideways = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
  expect(sideways).toBeLessThanOrEqual(0)
})
