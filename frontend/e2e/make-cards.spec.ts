// "Make cards from my notes" in the deck editor: paste notes or pick a note, then the fake AI
// (1 free AI turn) or the free list finder suggests cards; the student keeps, changes or tosses
// them before they go in the deck. FAKE API only; brand-new made-up accounts.
import { expect, test } from "@playwright/test"
import type { Page } from "@playwright/test"

import { loginAndWait, makeAccount } from "./helpers"
import { apiCreate, apiGet, countRequests, failNext, saveLine } from "./work-helpers"

const field = (page: Page, name: string) => page.getByRole("textbox", { name, exact: true })
const panel = (page: Page) => page.getByRole("region", { name: "Make cards from my notes" })
const card = (page: Page, text: string) => page.locator(".make-cards .mini-card", { hasText: text })

const NOTES =
  "Plants make their own food with sunlight. This is called photosynthesis. They need water and carbon dioxide, and they give off oxygen."

async function openPanel(page: Page) {
  const open = page.getByRole("button", { name: "Make cards from my notes", exact: true })
  await open.click()
  await expect(open).toHaveAttribute("aria-expanded", "true")
  await expect(panel(page).getByRole("heading", { name: "Make cards from my notes" })).toBeVisible()
}

test("paste notes, Make cards with AI, fix one, toss one, add them; the saved deck saves them", async ({ page }, info) => {
  const { email } = await makeAccount(page, info, "makeai")
  await loginAndWait(page, email)
  // The deck already has the AI's first card: it is not suggested again.
  const deck = await apiCreate(page, email, "flashcards", {
    title: "Plants deck",
    cards: [{ id: "c1", front: "What is photosynthesis?", back: "How plants make food from sunlight" }],
  })
  await page.goto(`/flashcards/${deck.id}/edit`)
  await expect(field(page, "Answer 1")).toHaveValue("How plants make food from sunlight")
  await openPanel(page)
  await expect(panel(page).getByText("Uses 1 of your free AI turns today.")).toHaveCount(0)

  await panel(page).getByRole("textbox", { name: "Your notes" }).fill(NOTES)
  await expect(panel(page).getByText("Uses 1 of your free AI turns today.")).toBeVisible()
  const ai = countRequests(page, (r) => r.method() === "POST" && r.url().endsWith("/api/notes-from-text"))
  const make = panel(page).getByRole("button", { name: "Make cards with AI" })
  await make.click()
  await expect(panel(page).getByRole("button", { name: "Making cards..." })).toBeDisabled()
  await expect(panel(page).getByText("Keeping 4 of 4")).toBeVisible({ timeout: 15_000 })
  expect(ai.count).toBe(1)
  expect(ai.requests[0].postDataJSON()).toMatchObject({ source_kind: "paste", source_label: "Pasted notes" })
  await expect(card(page, "What is photosynthesis?")).toHaveCount(0)

  // An emptied answer stops "Add 4 cards" and is marked.
  await card(page, "What gas do plants give off?").locator(".mini-card-face").click()
  const answer = panel(page).getByRole("textbox", { name: "Answer", exact: true })
  await answer.fill("")
  await panel(page).getByRole("button", { name: "Done", exact: true }).click()
  await panel(page).getByRole("button", { name: "Add 4 cards" }).click()
  await expect(panel(page).locator(".card-problems")).toContainText("1 card isn't filled in.")
  await expect(answer).toBeFocused()
  await expect(answer).toHaveAccessibleDescription("Not filled in")
  await answer.fill("Oxygen gas")
  await expect(panel(page).locator(".card-problems")).toHaveCount(0)
  await panel(page).getByRole("button", { name: "Done", exact: true }).click()

  await card(page, "What makes leaves green?").getByRole("button", { name: "Toss" }).click()
  await expect(panel(page).getByText("Keeping 3 of 4")).toBeVisible()
  await panel(page).getByRole("button", { name: "Add 3 cards" }).click()

  await expect(page.getByText("Added 3 cards.")).toBeVisible()
  await expect(panel(page)).toHaveCount(0)
  await expect(field(page, "Question 2")).toBeFocused()
  await expect(page.locator(".card-editor-row")).toHaveCount(4)
  await expect(field(page, "Answer 3")).toHaveValue("Oxygen gas")
  await expect(saveLine(page)).toHaveText(/^Saved at/, { timeout: 10_000 })
  const { body } = await apiGet(page, email, `/flashcards/${deck.id}`)
  expect(body.title).toBe("Plants deck")
  expect(body.cards.map((c: { back: string }) => c.back)).toEqual([
    "How plants make food from sunlight",
    "Sunlight, water, and carbon dioxide",
    "Oxygen gas",
    "In the chloroplasts",
  ])
})

test("pick a note that is a list: find cards for free, with no AI request", async ({ page }, info) => {
  const { email } = await makeAccount(page, info, "makefree")
  await loginAndWait(page, email)
  await apiCreate(page, email, "notes", { title: "Spanish words", content: "perro - dog\ngato - cat\ncasa - house\nlibro - book", tags: [] })
  const ai = countRequests(page, (r) => r.url().includes("/api/"))

  await page.goto("/flashcards/new")
  await openPanel(page)
  await panel(page).getByRole("button", { name: "Pick a note" }).click()
  await expect(panel(page).getByRole("button", { name: "Pick a note" })).toHaveAttribute("aria-pressed", "true")
  await panel(page).getByRole("searchbox", { name: "Find a note" }).fill("span")
  await panel(page).getByRole("button", { name: /Spanish words/ }).click()
  await expect(panel(page).getByText("From your note:")).toContainText("Spanish words")
  await expect(panel(page).getByText("This looks like a list of cards. You can add them for free.")).toBeVisible()
  // A list: the free button comes first.
  await expect(panel(page).locator(".make-cards-actions button").first()).toHaveText("Find cards for free")

  await panel(page).getByRole("button", { name: "Find cards for free" }).click()
  await expect(panel(page).getByText("Keeping 4 of 4")).toBeVisible()

  // Cards waiting in the panel count as unsaved work.
  await page.getByRole("link", { name: "Back", exact: true }).click()
  const ask = page.getByRole("alertdialog", { name: "Your work isn't saved." })
  await ask.getByRole("button", { name: "Stay here" }).click()
  await expect(page).toHaveURL(/\/flashcards\/new$/)

  await panel(page).getByRole("button", { name: "Add 4 cards" }).click()
  await expect(page.getByText("Added 4 cards.")).toBeVisible()
  // The two empty starting rows were replaced by the new cards.
  await expect(page.locator(".card-editor-row")).toHaveCount(4)
  await expect(field(page, "Question 1")).toHaveValue("perro")
  await expect(field(page, "Answer 4")).toHaveValue("book")
  await expect(field(page, "Question 5")).toHaveCount(0)
  expect(ai.count).toBe(0)

  await field(page, "Title").fill("Spanish")
  await page.getByRole("button", { name: "Save deck" }).click()
  await expect(page).toHaveURL(/\/flashcards\/[^/]+\/edit$/)
})

test("AI limits and errors show in the panel, and the free finder still works", async ({ page }, info) => {
  const { email } = await makeAccount(page, info, "makelim")
  await loginAndWait(page, email)
  await page.goto("/flashcards/new")
  await openPanel(page)
  const box = panel(page).getByRole("textbox", { name: "Your notes" })
  const make = panel(page).getByRole("button", { name: "Make cards with AI" })
  const ai = countRequests(page, (r) => r.method() === "POST" && r.url().endsWith("/api/notes-from-text"))

  await box.fill("Too short")
  await make.click()
  await expect(panel(page).getByText("Add a few more sentences first.")).toBeVisible()
  expect(ai.count).toBe(0)

  await box.fill(NOTES)
  await failNext(page, "/api/notes-from-text", "limit")
  await make.click()
  await expect(panel(page).getByText("You used today's free AI turns. You can still find cards for free or add them yourself.")).toBeVisible()

  await failNext(page, "/api/notes-from-text", "busy")
  await make.click()
  await expect(panel(page).getByText("Luma is still working on your last request. Try again in a moment.")).toBeVisible()

  await failNext(page, "/api/notes-from-text", "500")
  await make.click()
  await expect(panel(page).getByText("We couldn't make cards right now. Try again.")).toBeVisible()
  expect(ai.count).toBe(3)

  await panel(page).getByRole("button", { name: "Find cards for free" }).click()
  await expect(panel(page).getByText("We couldn't find cards in that. Try Make cards with AI.")).toBeVisible()

  await box.fill("Sun - a star\nMoon - goes around Earth")
  await panel(page).getByRole("button", { name: "Find cards for free" }).click()
  await expect(panel(page).getByText("Keeping 2 of 2")).toBeVisible()
  await panel(page).getByRole("button", { name: "Add 2 cards" }).click()
  await expect(page.locator(".card-editor-row")).toHaveCount(2)
  await expect(field(page, "Question 2")).toHaveValue("Moon")
  expect(ai.count).toBe(3)
})

test("an empty deck shows Make cards from my notes at the top; new suggestions come into view; Save deck points at them", async ({ page }, info) => {
  const { email } = await makeAccount(page, info, "maketop")
  await loginAndWait(page, email)
  await page.goto("/flashcards/new")
  // The big button sits above the empty cards, with one line of help; no second link below.
  const open = page.getByRole("button", { name: "Make cards from my notes", exact: true })
  await expect(open).toHaveCount(1)
  await expect(page.getByText("Paste notes and Luma suggests cards. Or type your own cards below.")).toBeVisible()
  const openBox = await open.boundingBox()
  const firstCard = await field(page, "Question 1").boundingBox()
  expect(openBox!.y).toBeLessThan(firstCard!.y)

  await openPanel(page)
  await panel(page).getByRole("textbox", { name: "Your notes" }).fill(NOTES)
  await panel(page).getByRole("button", { name: "Make cards with AI" }).click()
  await expect(panel(page).getByText("Keeping 5 of 5")).toBeVisible({ timeout: 15_000 })
  // The suggestions come into view with focus on their heading (never hidden under the bars).
  const heading = panel(page).getByRole("heading", { name: "Cards Luma suggests" })
  await expect(heading).toBeFocused()
  await expect(heading).toBeInViewport()
  // Now "Add 5 cards" is the main button; another AI turn is a plain choice.
  await expect(panel(page).getByRole("button", { name: "Add 5 cards" })).toHaveClass(/primary-button/)
  await expect(panel(page).getByRole("button", { name: "Make more with AI" })).toHaveClass(/secondary-button/)

  const narrow = (page.viewportSize()?.width ?? 1280) < 720
  if (narrow) {
    // On a phone the save bar steps aside while the panel is open (it has its own Add button).
    await expect(page.locator(".sticky-save")).toBeHidden()
  } else {
    await expect(page.locator(".sticky-save")).toContainText("5 suggested cards not added yet")
    await field(page, "Title").fill("Plants")
    await page.getByRole("button", { name: "Save deck" }).click()
    await expect(page.getByText("You have 5 suggested cards. Tap Add 5 cards first.")).toBeVisible()
    await expect(panel(page).getByRole("button", { name: "Add 5 cards" })).toBeFocused()
    await expect(page).toHaveURL(/\/flashcards\/new$/)
  }
  await panel(page).getByRole("button", { name: "Add 5 cards" }).click()
  await expect(page.getByText("Added 5 cards.")).toBeVisible()
  await expect(page.getByText(/You have \d+ suggested card/)).toHaveCount(0)
  await expect(page.locator(".sticky-save")).toBeVisible()
  await expect(page.locator(".sticky-save")).toContainText("5 cards ready")
})
