// Discover (PR-B2): the newest shared notes and decks, topic search, People by username,
// the empty state and the slow-server message. FAKE API only (dev/mock-api.mjs); anything
// that changes state uses a made-up account or is undone at the end.
import { expect, test, type Page, type TestInfo } from "@playwright/test"

import { API, PASSWORD, SEEDED, expectNoSeriousA11yIssues, fakeEmail, latestMail, loginAndWait, setThemeMode } from "./helpers"

const heading = (page: Page) => page.getByRole("heading", { level: 1, name: "Discover notes" })
/** The status line screen readers hear (it is always on the page, but visually hidden). */
const status = (page: Page) => page.getByTestId("discover-status")
const row = (page: Page, title: string) =>
  page.getByRole("article").filter({ has: page.getByRole("heading", { name: title, exact: true }) })

async function tokenFor(page: Page, email: string): Promise<string> {
  const response = await page.request.post(`${API}/login`, { data: { email, password: PASSWORD } })
  expect(response.ok()).toBe(true)
  return ((await response.json()) as { access_token: string }).access_token
}

/** A verified made-up account, made through the fake API (no browser steps). */
async function makeAccount(page: Page, info: TestInfo): Promise<string> {
  const email = fakeEmail("discover", info)
  const username = `dsc${Date.now().toString(36)}${info.project.name.slice(0, 2)}`
  const signup = await page.request.post(`${API}/signup`, { data: { email, username, password: PASSWORD } })
  expect(signup.status()).toBe(202)
  const { ticket } = (await signup.json()) as { ticket: string }
  const { code } = await latestMail(page, email, "code")
  expect((await page.request.post(`${API}/auth/verify-email`, { data: { ticket, email, code } })).ok()).toBe(true)
  return email
}

/** Every shared-notes search answers with nothing, as if no one had shared yet. */
async function emptyShelf(page: Page) {
  await page.route(`${API}/public/search**`, (route) => {
    if (route.request().method() === "OPTIONS") return route.continue()
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: {
        "access-control-allow-origin": new URL(page.url()).origin,
        "access-control-allow-credentials": "true",
      },
      body: JSON.stringify({ items: [], total: 0, next_offset: null, facets: { subjects: [], subtopics: [], types: [] } }),
    })
  })
}

test("the old /search address opens Discover", async ({ page }) => {
  await loginAndWait(page, SEEDED.sam.email)
  await page.goto("/search")
  await expect(page).toHaveURL(/\/discover$/)
  await expect(heading(page)).toBeVisible()
})

test("Discover opens on the newest shared items, each with @username only", async ({ page }) => {
  await loginAndWait(page, SEEDED.sam.email)
  await page.goto("/discover")
  await expect(heading(page)).toBeVisible()
  await expect(page.getByText("Only people signed in to Luma can see them.")).toBeVisible()
  await expect(page.getByRole("heading", { level: 2, name: "Newest shared" })).toBeVisible()

  // The seeded shared deck: its kind, title, preview and the owner's @username. Nothing else about them.
  const deck = row(page, "Spanish Basics")
  await expect(deck).toBeVisible()
  await expect(deck.getByText("Deck", { exact: true })).toBeVisible()
  await expect(deck.getByText("Shared by @jabari")).toBeVisible()
  await expect(deck.locator("img, .avatar")).toHaveCount(0)

  // No popularity anywhere: no "public" counts, likes, views or followers.
  const text = await page.locator("main").innerText()
  expect(text).not.toMatch(/\bpublic\b/i)
  expect(text).not.toMatch(/\d+\s+(likes?|views?|followers?|saves?)\b/i)

  // Someone else's shared item can be reported.
  await expect(deck.getByRole("button", { name: /^Report/ })).toBeVisible()
  await expect(deck.getByText("You shared this")).toHaveCount(0)

  // A topic search narrows the list, and the status line says what was found.
  await expect(status(page)).toHaveText(/^\d+ shared items?\.$/)
  await page.getByLabel("Search", { exact: true }).fill("spanish")
  await page.getByRole("button", { name: "Search", exact: true }).click()
  await expect(page.getByRole("heading", { level: 2, name: "Shared notes about “spanish”" })).toBeVisible()
  await expect(row(page, "Spanish Basics")).toBeVisible()
  await expect(status(page)).toHaveText(/^\d+ shared items? for “spanish”\.$/)

  // Show newest goes back. Pressed with the keyboard, focus lands in the search box, not on the page.
  await page.getByRole("button", { name: "Show newest" }).focus()
  await page.keyboard.press("Enter")
  await expect(page.getByRole("heading", { level: 2, name: "Newest shared" })).toBeVisible()
  await expect(page.getByLabel("Search", { exact: true })).toHaveValue("")
  await expect(page.getByLabel("Search", { exact: true })).toBeFocused()
  await expect(page.getByRole("button", { name: "Show newest" })).toHaveCount(0)
})

test("your own shared items say You shared this, with no Report button", async ({ page }) => {
  await loginAndWait(page, SEEDED.demo.email)
  await page.goto("/discover")
  const deck = row(page, "Spanish Basics")
  await expect(deck.getByText("Shared by @jabari")).toBeVisible()
  await expect(deck.getByText("You shared this")).toBeVisible()
  await expect(deck.getByRole("button", { name: /^Report/ })).toHaveCount(0)
})

test("People search for sam shows @sam with no picture, name or count", async ({ page }, info) => {
  // sam shares one note for this test; it is deleted at the end.
  const samToken = await tokenFor(page, SEEDED.sam.email)
  const headers = { authorization: `Bearer ${samToken}` }
  const title = `Sam's leaf notes ${Date.now().toString(36)}${info.project.name.slice(0, 2)}`
  const created = await page.request.post(`${API}/notes`, {
    headers,
    data: { title, tags: [], content: "Leaves make food from light." },
  })
  expect(created.status()).toBe(201)
  const noteId = ((await created.json()) as { id: string }).id
  try {
    const shared = await page.request.put(`${API}/notes/${noteId}`, {
      headers,
      data: { is_public: true, published_at: new Date().toISOString(), study_type: "note" },
    })
    expect(shared.ok()).toBe(true)

    await loginAndWait(page, SEEDED.lee.email)
    await page.goto("/discover")
    await page.getByRole("button", { name: "People", exact: true }).click()
    await expect(page.getByRole("button", { name: "People", exact: true })).toHaveAttribute("aria-pressed", "true")
    await expect(page.getByPlaceholder("Find a username")).toBeVisible()
    await page.getByLabel("Search", { exact: true }).fill("sam")
    const done = page.waitForResponse((r) => r.url().startsWith(`${API}/public/users`))
    await page.getByRole("button", { name: "Search", exact: true }).click()
    await done

    const person = page.locator("section.person").filter({ has: page.getByRole("heading", { name: "@sam", exact: true }) })
    await expect(person).toBeVisible()
    await expect(person.locator("img, .avatar")).toHaveCount(0)
    await expect(person.getByRole("heading", { name: title, exact: true })).toBeVisible()
    await expect(person).not.toContainText(/second@luma\.test/)
    const text = await page.locator("main").innerText()
    expect(text).not.toMatch(/\d+\s+(public|shared)\s+study\s+sets?/i)
    expect(text).not.toMatch(/\d+\s+(followers?|likes?)\b/i)
  } finally {
    expect((await page.request.delete(`${API}/notes/${noteId}`, { headers })).ok()).toBe(true)
  }
})

test("with nothing shared, Discover shows a friendly empty state (dark theme, axe)", async ({ page }, info) => {
  const email = await makeAccount(page, info)
  await setThemeMode(page, email, "dark")
  await emptyShelf(page)
  await loginAndWait(page, email)
  await page.goto("/discover")
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark")
  await expect(page.getByRole("heading", { name: "Nothing here yet." })).toBeVisible()
  await expect(page.getByText("Share your own notes so others can learn too.")).toBeVisible()
  await expect(page.getByRole("link", { name: "Go to my notes" })).toHaveAttribute("href", "/notes")
  await expect(page.getByRole("article")).toHaveCount(0)
  await page.waitForTimeout(600) // the heading's underline draws itself
  await expectNoSeriousA11yIssues(page, "discover-empty-dark", info)

  await expect(status(page)).toHaveText("Nothing here yet. No one has shared notes or flashcards yet.")

  // A topic search with no matches says so plainly, out loud too.
  await page.getByLabel("Search", { exact: true }).fill("volcanoes")
  await page.getByRole("button", { name: "Search", exact: true }).click()
  await expect(page.getByRole("heading", { name: "Nothing found for “volcanoes”." })).toBeVisible()
  await expect(status(page)).toHaveText("Nothing found for “volcanoes”.")
  await expect(status(page)).toHaveAttribute("role", "status")

  // People: a username with no shared items is announced as well.
  await page.getByRole("button", { name: "People", exact: true }).click()
  await page.getByLabel("Search", { exact: true }).fill("zzznobody")
  await page.getByRole("button", { name: "Search", exact: true }).click()
  await expect(page.locator(".search-results").getByText("No one with that username has shared anything yet.")).toBeVisible()
  await expect(status(page)).toHaveText("No one with that username has shared anything yet.")
})

test("a slow server shows placeholder rows and says Luma is waking up", async ({ page }) => {
  await loginAndWait(page, SEEDED.sam.email)
  await page.route(`${API}/public/search**`, async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 4500))
    await route.continue()
  })
  await page.goto("/discover")
  await expect(status(page)).toHaveText("Loading shared notes…")
  await expect(page.locator(".discover-loading").getByText("Loading shared notes…")).toBeVisible()
  await expect(page.locator(".skeleton-list")).toHaveAttribute("aria-hidden", "true")

  // The People panel is not busy: it shows its own hint, not the notes loading rows.
  await page.getByRole("button", { name: "People", exact: true }).click()
  await expect(page.getByText("Type at least 3 letters of a username.")).toBeVisible()
  await expect(page.locator(".skeleton-list")).toHaveCount(0)
  await expect(status(page)).toHaveText("")
  await page.getByRole("button", { name: "Notes and cards", exact: true }).click()

  await expect(status(page)).toHaveText("Waking up Luma… This can take a minute.", { timeout: 4000 })
  await expect(page.locator(".skeleton-list")).toBeVisible()
  await expect(row(page, "Spanish Basics")).toBeVisible({ timeout: 10_000 })
  await expect(page.locator(".skeleton-list")).toHaveCount(0)
  await expect(status(page)).toHaveText(/^\d+ shared items?\.$/)
})
