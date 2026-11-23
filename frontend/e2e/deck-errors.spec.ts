// Cards that aren't filled in: "Save deck" (and the workbench's "Save + make deck") sends
// nothing, says how many cards and which ones, marks each empty box in red with
// "Not filled in", moves focus to the first one, and offers to remove fully empty cards.
// FAKE API only (dev/mock-api.mjs); brand-new made-up accounts.
import { expect, test } from "@playwright/test"
import type { Page } from "@playwright/test"

import { loginAndWait, makeAccount } from "./helpers"
import { countRequests } from "./work-helpers"

const field = (page: Page, name: string) => page.getByRole("textbox", { name, exact: true })
const problems = (page: Page) => page.locator(".card-problems")

test.beforeEach(async ({ page }, info) => {
  const { email } = await makeAccount(page, info, "deckerr")
  await loginAndWait(page, email)
})

test("a new deck with empty cards is not sent; the box points at each card and empty cards can go", async ({ page }) => {
  await page.goto("/flashcards/new")
  await expect(page.getByRole("heading", { level: 1, name: "Make a deck" })).toBeVisible()
  // No "Paste a list" any more: "Make cards from my notes" does that job.
  await expect(page.getByRole("button", { name: "Paste a list" })).toHaveCount(0)
  await field(page, "Title").fill("Errors test deck")
  // 4 rows: one good card, one with only a question, two empty.
  await page.getByRole("button", { name: "Add card" }).click()
  await page.getByRole("button", { name: "Add card" }).click()
  await field(page, "Question 1").fill("Capital of Peru")
  await field(page, "Answer 1").fill("Lima")
  await field(page, "Question 2").fill("Half a card")

  const posts = countRequests(page, (r) => r.method() === "POST" && /\/flashcards$/.test(r.url()))
  await page.getByRole("button", { name: "Save deck" }).click()

  await expect(problems(page)).toContainText("3 cards aren't filled in.")
  for (const name of ["Card 2: answer", "Card 3: question and answer", "Card 4: question and answer"]) {
    await expect(problems(page).getByRole("button", { name })).toBeVisible()
  }
  // Focus is on the first empty box, in view (not under the sticky save bar), marked and described.
  const answer2 = field(page, "Answer 2")
  await expect(answer2).toBeFocused()
  await expect(answer2).toBeInViewport()
  await expect(answer2).toHaveAttribute("aria-invalid", "true")
  await expect(answer2).toHaveAccessibleDescription("Not filled in")
  await expect(field(page, "Question 2")).not.toHaveAttribute("aria-invalid", "true")
  await expect(field(page, "Answer 1")).not.toHaveAttribute("aria-invalid", "true")
  await expect(page.locator(".card-editor-row.has-problem")).toHaveCount(3)
  await expect(page.getByText("Not filled in")).toHaveCount(5)
  await expect(page.locator(".sticky-save")).toContainText("3 cards need words")
  await page.waitForTimeout(500)
  expect(posts.count).toBe(0)
  await expect(page).toHaveURL(/\/flashcards\/new$/)

  // A link in the box goes to that card.
  await problems(page).getByRole("button", { name: "Card 3: question and answer" }).click()
  await expect(field(page, "Question 3")).toBeFocused()

  // "Remove 2 empty cards" removes only the empty ones; the half card keeps its words.
  await problems(page).getByRole("button", { name: "Remove 2 empty cards" }).click()
  await expect(page.getByText("Removed 2 empty cards.")).toBeVisible()
  await expect(field(page, "Question 3")).toHaveCount(0)
  await expect(field(page, "Question 2")).toHaveValue("Half a card")
  await expect(problems(page)).toContainText("1 card isn't filled in.")
  await expect(answer2).toBeFocused()

  // Typing the missing answer clears the marks and the box at once.
  await answer2.fill("A whole card now")
  await expect(problems(page)).toHaveCount(0)
  await expect(page.getByText("Not filled in")).toHaveCount(0)
  await expect(page.locator(".sticky-save")).toContainText("2 cards ready")

  await page.getByRole("button", { name: "Save deck" }).click()
  await expect(page).toHaveURL(/\/flashcards\/[^/]+\/edit$/)
  expect(posts.count).toBe(1)
  expect(posts.requests[0].postDataJSON().cards).toHaveLength(2)
})

test("a saved deck: Save deck with an empty answer stays put and says which card", async ({ page }) => {
  await page.goto("/flashcards/new")
  await field(page, "Title").fill("Saved errors deck")
  await field(page, "Question 1").fill("One")
  await field(page, "Answer 1").fill("Uno")
  await field(page, "Question 2").fill("Two")
  await field(page, "Answer 2").fill("Dos")
  await page.getByRole("button", { name: "Save deck" }).click()
  await expect(page).toHaveURL(/\/flashcards\/[^/]+\/edit$/)
  await expect(page.getByText(/^Saved at /)).toBeVisible()

  await field(page, "Answer 2").fill("")
  await expect(page.locator(".save-status-text")).toHaveText("Not saved yet. Finish card 2.", { timeout: 10_000 })
  await page.getByRole("button", { name: "Save deck" }).click()
  await expect(problems(page)).toContainText("1 card isn't filled in.")
  await expect(field(page, "Answer 2")).toBeFocused()
  await expect(page).toHaveURL(/\/edit$/)
  // No empty cards here, so there is nothing to remove.
  await expect(problems(page).getByRole("button", { name: /empty card/ })).toHaveCount(0)

  await field(page, "Answer 2").fill("Dos")
  await page.getByRole("button", { name: "Save deck" }).click()
  await expect(page).toHaveURL(/\/flashcards\/[^/]+$/)
  await expect(page.getByRole("heading", { level: 1, name: "Saved errors deck" })).toBeVisible()
})

test("workbench: a kept card with an empty side stops Save + make deck the same way", async ({ page }) => {
  await page.goto("/notes/import")
  await page.getByRole("textbox", { name: "Your words" }).fill(
    "Plants make their own food. They use sunlight, water and carbon dioxide. This is called photosynthesis. It happens in the leaves.",
  )
  await page.getByRole("button", { name: "Use these words" }).click()
  await page.getByRole("region", { name: "What we found" }).getByRole("button", { name: "Make my notes" }).click()
  await expect(page.getByRole("textbox", { name: "Name your notes" })).toBeVisible({ timeout: 15_000 })
  await expect(page.getByText("Keeping 5 of 5")).toBeVisible()

  // One new card with only a question, and one left empty.
  await page.getByRole("button", { name: "Add a card" }).click()
  await page.getByRole("textbox", { name: "Question", exact: true }).fill("Where does it happen?")
  await page.getByRole("button", { name: "Done", exact: true }).click()
  await page.getByRole("button", { name: "Add a card" }).click()
  await page.getByRole("button", { name: "Done", exact: true }).click()
  await expect(page.getByText("Keeping 7 of 7")).toBeVisible()

  const saves = countRequests(page, (r) => r.method() === "POST" && /\/(notes|flashcards)$/.test(r.url()))
  await page.getByRole("button", { name: "Save + make deck (7)" }).click()
  await expect(problems(page)).toContainText("2 cards aren't filled in.")
  const answer = page.getByRole("textbox", { name: "Answer", exact: true })
  await expect(answer).toBeFocused()
  await expect(answer).toHaveAccessibleDescription("Not filled in")
  await expect(page.locator(".mini-card.has-problem")).toHaveCount(2)
  expect(saves.count).toBe(0)

  // "Toss 1 empty card" tosses only the empty one.
  await problems(page).getByRole("button", { name: "Toss 1 empty card" }).click()
  await expect(page.getByText("Keeping 6 of 7")).toBeVisible()
  await expect(problems(page)).toContainText("1 card isn't filled in.")
  await answer.fill("In the leaves")
  await expect(problems(page)).toHaveCount(0)

  await page.getByRole("button", { name: "Save + make deck (6)" }).click()
  await expect(page).toHaveURL(/\/flashcards\/[^/]+$/, { timeout: 15_000 })
  await expect(page.locator(".card-list .card-a", { hasText: "In the leaves" })).toBeVisible()
})
