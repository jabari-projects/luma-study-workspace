// "Share with the crowd?" (owner item 5): asked once, right after a student makes a deck, note or
// summary. Not now keeps it private and the Share button stays. Sharing rules stay the same:
// students signed in to Luma, username only. FAKE API only; brand-new made-up accounts.
import { expect, test } from "@playwright/test"
import type { Page } from "@playwright/test"

import { API, answerSharePrompt, expectNoSeriousA11yIssues, loginAndWait, makeAccount } from "./helpers"
import { apiCreate, apiGet, apiToken, uniqueTitle } from "./work-helpers"

const prompt = (page: Page) => page.getByRole("dialog", { name: "Share with the crowd?" })
const field = (page: Page, name: string) => page.getByRole("textbox", { name, exact: true })

async function makeDeck(page: Page, title: string) {
  await page.goto("/flashcards/new")
  await field(page, "Title").fill(title)
  await field(page, "Question 1").fill("Largest ocean?")
  await field(page, "Answer 1").fill("Pacific")
  await field(page, "Question 2").fill("Longest river?")
  await field(page, "Answer 2").fill("Nile")
  await page.getByRole("button", { name: "Save deck" }).click()
  await expect(page).toHaveURL(/\/flashcards\/[^/]+\/edit$/)
  await expect(page.getByText(/^Saved at /)).toBeVisible()
  return page.url().split("/").at(-2)!
}

test("after making a deck: asked once; Not now keeps it private and the Share button stays", async ({ page }, info) => {
  const { email, username } = await makeAccount(page, info, "prompt")
  await loginAndWait(page, email)
  const title = uniqueTitle("Oceans", info)
  const id = await makeDeck(page, title)
  await page.getByRole("button", { name: "Save deck" }).click()
  await expect(page).toHaveURL(new RegExp(`/flashcards/${id}$`))

  const dialog = prompt(page)
  await expect(dialog).toBeVisible()
  await expect(dialog).toContainText("People can learn from you.")
  await expect(dialog).toContainText(`@${username}`)
  await expect(dialog).toContainText("Nothing else about you")
  await expect(dialog.getByRole("button", { name: "Not now" })).toBeFocused()
  await expectNoSeriousA11yIssues(page, "share-prompt", info)
  await dialog.getByRole("button", { name: "Not now" }).click()
  await expect(dialog).toBeHidden()
  const share = page.locator("header.page-head").getByRole("button", { name: "Share", exact: true })
  await expect(share).toBeVisible()
  await expect(share).toBeFocused()
  expect((await apiGet(page, email, `/flashcards/${id}`)).body.is_public).toBe(false)

  // Never again: not on a reload, not when the deck is opened again in this tab.
  await page.reload()
  await expect(page.getByRole("heading", { level: 1, name: title })).toBeVisible()
  await page.waitForTimeout(500)
  await expect(prompt(page)).toHaveCount(0)
  await page.getByRole("link", { name: "Edit" }).click()
  await page.getByRole("button", { name: "Save deck" }).click()
  await expect(page).toHaveURL(new RegExp(`/flashcards/${id}$`))
  await page.waitForTimeout(500)
  await expect(prompt(page)).toHaveCount(0)

  // The ordinary Share button still asks the ordinary way.
  await share.click()
  await expect(page.getByRole("dialog", { name: "Share this deck?" })).toBeVisible()
  await page.getByRole("button", { name: "Not now" }).click()
})

test("after making a note: Share shares it, and other students find it in Discover", async ({ page, browser }, info) => {
  const { email, username } = await makeAccount(page, info, "promptn")
  await loginAndWait(page, email)
  const title = uniqueTitle("Volcano facts", info)
  await page.goto("/notes/new")
  await field(page, "Title").fill(title)
  await field(page, "Your notes").fill("Lava is melted rock that comes out of a volcano.")
  await page.getByRole("button", { name: "Save note" }).click()
  await expect(page).toHaveURL(/\/notes\/[0-9a-f-]{36}\/edit$/)
  await page.getByRole("button", { name: "Save changes" }).click()
  await expect(page).toHaveURL(/\/notes\/[0-9a-f-]{36}$/)
  await answerSharePrompt(page, "Share")
  await expect(page.getByText("Shared. Students signed in to Luma can find this note now.")).toBeVisible()
  await expect(page.getByText(`Shared by @${username}`)).toBeVisible()
  await expect(page.locator("header").getByRole("button", { name: "Stop sharing" })).toBeVisible()

  const other = await browser.newContext()
  const otherPage = await other.newPage()
  const classmate = await makeAccount(otherPage, info, "classm")
  await loginAndWait(otherPage, classmate.email)
  await otherPage.goto(`/discover?q=${encodeURIComponent(title)}`)
  const card = otherPage.getByRole("article").filter({ has: otherPage.getByRole("heading", { name: title, exact: true }) })
  await expect(card).toBeVisible()
  await expect(card.getByText(`Shared by @${username}`)).toBeVisible()
  await other.close()
})

test("after making a summary from a note: asked once on the new summary", async ({ page }, info) => {
  const { email } = await makeAccount(page, info, "prompts")
  await loginAndWait(page, email)
  const note = await apiCreate(page, email, "notes", {
    title: "Plants",
    content: "Plants make their own food from sunlight, water and air. This is photosynthesis.",
    tags: [],
  })
  await page.goto(`/notes/${note.id}`)
  // Opening a note that was made elsewhere never asks.
  await expect(page.getByRole("heading", { level: 1, name: "Plants" })).toBeVisible()
  await expect(prompt(page)).toHaveCount(0)
  await page.getByRole("button", { name: "Make a summary" }).click()
  await page.getByRole("button", { name: "Make summary" }).click()
  await expect(page).toHaveURL(/\/summaries\/[0-9a-f-]{36}$/, { timeout: 15_000 })
  await expect(prompt(page)).toBeVisible()
  await expect(prompt(page)).toContainText("this summary")
  await prompt(page).getByRole("button", { name: "Not now" }).click()
  await expect(page.locator("header").getByRole("button", { name: "Share", exact: true })).toBeVisible()
})

test("an item already shared before its page opens is never asked about", async ({ page }, info) => {
  const { email } = await makeAccount(page, info, "prompta")
  await loginAndWait(page, email)
  const id = await makeDeck(page, uniqueTitle("Rivers", info))
  // Shared from somewhere else (another tab) before the deck page opens.
  const token = await apiToken(page, email)
  const deck = (await apiGet(page, email, `/flashcards/${id}`)).body
  const shared = await page.request.put(`${API}/flashcards/${id}`, {
    data: { is_public: true, expected_version: deck.version },
    headers: { authorization: `Bearer ${token}` },
  })
  expect(shared.ok()).toBe(true)
  // Save deck opens the deck page in this tab (no reload), which would ask about a private deck.
  await page.getByRole("button", { name: "Save deck" }).click()
  await expect(page).toHaveURL(new RegExp(`/flashcards/${id}$`))
  await expect(page.locator("header").getByRole("button", { name: "Stop sharing" })).toBeVisible()
  await page.waitForTimeout(500)
  await expect(prompt(page)).toHaveCount(0)
})
