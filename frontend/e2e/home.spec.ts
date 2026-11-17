// Home (/dashboard) in the "Margins" layout: one stamped next-step card, a slim week strip,
// a short Recent list and Quick start links. Runs against the FAKE API only.
// The seeded demo account is only read from; anything that adds data uses a new made-up account.
import { expect, test, type Page, type TestInfo } from "@playwright/test"

import { API, PASSWORD, SEEDED, fakeEmail, latestMail, loginAndWait, setThemeMode } from "./helpers"

/** Makes a verified made-up account through the fake API and returns its token. */
async function makeAccount(page: Page, info: TestInfo) {
  const email = fakeEmail("home", info)
  const username = `h${Date.now().toString(36)}${info.project.name.slice(0, 2)}${Math.floor(Math.random() * 1000)}`
  const signup = await page.request.post(`${API}/signup`, { data: { email, username, password: PASSWORD } })
  expect(signup.status()).toBe(202)
  const { ticket } = (await signup.json()) as { ticket: string }
  const { code } = await latestMail(page, email, "code")
  const verified = await page.request.post(`${API}/auth/verify-email`, { data: { ticket, email, code } })
  expect(verified.ok()).toBe(true)
  const { access_token } = (await verified.json()) as { access_token: string }
  return { email, token: access_token }
}

/** Waits until the next-step card has looked at the decks (the demo account has cards due). */
async function waitForHome(page: Page) {
  await expect(page.getByRole("heading", { level: 2, name: /^Review \d+ cards? in/ })).toBeVisible()
  await page.waitForLoadState("networkidle")
}

const QUICK_START = [
  ["Write a note", "/notes"],
  ["Import a file", "/import"],
  ["Voice to notes", "/voice-input"],
  ["Image to notes", "/image-to-notes"],
  ["Review cards", "/flashcards"],
] as const

test.describe("Home layout (seeded account, read only)", () => {
  for (const theme of ["light", "dark"] as const) {
    test(`only the next-step card and its button carry the stamp shadow (${theme})`, async ({ page }) => {
      try {
        await setThemeMode(page, SEEDED.demo.email, theme)
        await loginAndWait(page, SEEDED.demo.email)
        await expect(page.locator("html")).toHaveAttribute("data-theme", theme)
        await waitForHome(page)
        // Keep the mouse away from everything, so no hover shadow is counted.
        await page.mouse.move(1, 1)
        await page.waitForTimeout(400)
        const stamped = await page.evaluate(() =>
          Array.from(document.querySelectorAll<HTMLElement>("body *"))
            .filter((el) => getComputedStyle(el).boxShadow.includes("3px 3px 0px"))
            .map((el) => (typeof el.className === "string" && el.className ? el.className : el.tagName.toLowerCase())),
        )
        expect(stamped.length, JSON.stringify(stamped)).toBeLessThanOrEqual(2)
        expect(stamped, JSON.stringify(stamped)).toContain("next-step")
        expect(stamped.some((name) => name.includes("primary-button")), JSON.stringify(stamped)).toBe(true)
      } finally {
        await setThemeMode(page, SEEDED.demo.email, "light")
      }
    })
  }

  test("the page never scrolls sideways", async ({ page }) => {
    await loginAndWait(page, SEEDED.demo.email)
    await waitForHome(page)
    const sizes = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, inner: window.innerWidth }))
    expect(sizes.scroll, JSON.stringify(sizes)).toBeLessThanOrEqual(sizes.inner)
  })

  test("header, week strip and Quick start (the + button does this on phones)", async ({ page }, info) => {
    await loginAndWait(page, SEEDED.demo.email)
    await waitForHome(page)
    const head = page.locator("header.page-head")
    await expect(head.getByRole("heading", { level: 1 })).toContainText(/^Good (morning|afternoon|evening), jabari$/)
    await expect(head.getByText("Here's what to do next.")).toBeVisible()
    await expect(page.getByRole("region", { name: "This week" }).locator("li")).toHaveCount(7)
    // The old tool tiles are gone.
    await expect(page.locator(".tool-grid, .tool-tile")).toHaveCount(0)

    const quick = page.getByRole("navigation", { name: "Quick start" })
    if (info.project.name === "phone") {
      await expect(quick).toBeHidden()
      return
    }
    await expect(quick).toBeVisible()
    await expect(quick.getByRole("link")).toHaveCount(QUICK_START.length)
    for (const [name, href] of QUICK_START) {
      await expect(quick.getByRole("link", { name, exact: true })).toHaveAttribute("href", href)
    }
    await quick.getByRole("link", { name: "Write a note", exact: true }).click()
    await expect(page).toHaveURL(/\/notes$/)
  })
})

test.describe("Home Recent list (fresh account)", () => {
  test("hidden while empty, then shows the newest notes and decks as rows that open them", async ({ page }, info) => {
    const owner = await makeAccount(page, info)
    await loginAndWait(page, owner.email)
    await expect(page.getByRole("heading", { level: 2, name: "Make your first flashcard deck" })).toBeVisible()
    await page.waitForLoadState("networkidle")
    await expect(page.getByRole("region", { name: "Recent" })).toHaveCount(0)

    const headers = { authorization: `Bearer ${owner.token}` }
    const deck = await page.request.post(`${API}/flashcards`, {
      headers,
      data: { title: "Made Up Rocks", tags: [], cards: [{ id: "r1", front: "Hard rock?", back: "Granite", review: null }] },
    })
    expect(deck.status()).toBe(201)
    const { id: deckId } = (await deck.json()) as { id: string }
    // A moment later, so the note is clearly the newest.
    await page.waitForTimeout(20)
    const note = await page.request.post(`${API}/notes`, {
      headers,
      data: { title: "Made Up Plant Notes", content: "Leaves make food from light.", tags: [] },
    })
    expect(note.status()).toBe(201)
    const { id: noteId } = (await note.json()) as { id: string }

    await page.reload()
    const recent = page.getByRole("region", { name: "Recent" })
    await expect(recent).toBeVisible()
    const rows = recent.getByRole("listitem")
    await expect(rows).toHaveCount(2)
    await expect(rows.nth(0)).toContainText("Made Up Plant Notes")
    await expect(rows.nth(0).locator(".row-main small")).toHaveText("Note")
    await expect(rows.nth(1)).toContainText("Made Up Rocks")
    await expect(rows.nth(1).locator(".row-main small")).toHaveText("Deck · 1 card")
    await expect(recent.getByRole("link", { name: "Made Up Plant Notes" })).toHaveAttribute("href", `/notes/${noteId}`)
    await expect(recent.getByRole("link", { name: "Made Up Rocks" })).toHaveAttribute("href", `/flashcards/${deckId}`)

    // The whole row opens the item, not just the title. Center it first, so the
    // phone's floating tab bar is not on top of it.
    await rows.nth(1).evaluate((el) => el.scrollIntoView({ block: "center" }))
    const box = await rows.nth(1).boundingBox()
    expect(box).not.toBeNull()
    await page.mouse.click(box!.x + box!.width - 12, box!.y + box!.height / 2)
    await expect(page).toHaveURL(new RegExp(`/flashcards/${deckId}$`))
    await expect(page.getByRole("heading", { level: 1, name: "Made Up Rocks" })).toBeVisible()
  })
})
