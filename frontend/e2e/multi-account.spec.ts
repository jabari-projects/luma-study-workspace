// Several accounts on one device, against the FAKE API only (dev/mock-api.mjs).
// Covers: adding a second account from the account menu (desktop sidebar popover,
// tablet rail popover, phone avatar sheet), switching, each tab keeping its own
// account, decks staying per account, signing out of one keeping the other, the
// 3-account limit, the AI chat owner order kept in localStorage "luma.auth" (v2),
// the "signed out in another tab" notice, and Escape closing the menu.
//
// Only seeded fake accounts are used. Signing out only changes this browser's
// storage, never the fake server, so nothing here changes a seeded account.
import { expect, test, type Locator, type Page } from "@playwright/test"

import { API, PASSWORD, SEEDED, expectNoSeriousA11yIssues, loginAndWait } from "./helpers"

type StoredBook = {
  v: number
  accounts: Record<string, { accessToken: string | null; signedInAt: number; status: string; user: { id: string; username: string } }>
  lastActiveId: string | null
}

async function readBook(page: Page): Promise<StoredBook | null> {
  const raw = await page.evaluate(() => window.localStorage.getItem("luma.auth"))
  return raw ? (JSON.parse(raw) as StoredBook) : null
}

/** Account ids, oldest sign-in first (the first one owns the AI chat). */
async function accountOrder(page: Page): Promise<string[]> {
  const book = await readBook(page)
  if (!book) return []
  return Object.entries(book.accounts)
    .sort(([a, x], [b, y]) => x.signedInAt - y.signedInAt || (a < b ? -1 : 1))
    .map(([id]) => id)
}

async function tabAccount(page: Page): Promise<string | null> {
  return page.evaluate(() => window.sessionStorage.getItem("luma.tabAccount"))
}

/** The button that opens the account menu: sidebar identity (desktop/tablet) or avatar (phone). */
function accountButton(page: Page): Locator {
  return page.getByRole("button", { name: /^Accounts/ })
}

async function openAccountMenu(page: Page): Promise<Locator> {
  await accountButton(page).click()
  const menu = page.getByRole("dialog", { name: "Accounts" })
  await expect(menu).toBeVisible()
  return menu
}

/** Adds an account through the menu's "Add another account" and the add-mode login page. */
async function addAccountFromMenu(page: Page, email: string, username: string) {
  const menu = await openAccountMenu(page)
  await menu.getByRole("button", { name: /add another account/i }).click()
  await expect(page).toHaveURL(/\/login\?add=1/)
  await expect(page.getByRole("heading", { name: "Add another account" })).toBeVisible()
  await page.getByLabel("Email").fill(email)
  await page.getByLabel("Password", { exact: true }).fill(PASSWORD)
  await page.getByRole("button", { name: "Add account" }).click()
  await expect(page).toHaveURL(/\/dashboard/)
  await expect(page.getByText(`Added ${username}. You're using it now.`)).toBeVisible()
}

/** Adds an account by opening the add-mode login page directly. */
async function addAccountDirect(page: Page, email: string) {
  await page.goto("/login?add=1")
  await expect(page.getByRole("heading", { name: "Add another account" })).toBeVisible()
  await page.getByLabel("Email").fill(email)
  await page.getByLabel("Password", { exact: true }).fill(PASSWORD)
  await page.getByRole("button", { name: "Add account" }).click()
  await expect(page).toHaveURL(/\/dashboard/)
}

/** The demo account owns the "Solar System" deck; sam has no decks. */
async function expectDecksOf(page: Page, who: "demo" | "empty") {
  await page.goto("/flashcards")
  if (who === "demo") {
    await expect(page.getByText("Solar System").first()).toBeVisible()
  } else {
    await expect(page.getByRole("heading", { name: "Make a deck first" })).toBeVisible()
    await expect(page.getByText("Solar System")).toHaveCount(0)
  }
}

test("add a second account from the account menu, switch, and keep decks separate", async ({ page }) => {
  await loginAndWait(page, SEEDED.demo.email)
  await expectDecksOf(page, "demo")

  await addAccountFromMenu(page, SEEDED.sam.email, SEEDED.sam.username)
  await expectDecksOf(page, "empty")
  expect(await tabAccount(page)).toBe("u2")

  // The menu lists both, the active one marked "Using now".
  const menu = await openAccountMenu(page)
  const samRow = menu.getByRole("button", { name: /second@luma\.test/ })
  const demoRow = menu.getByRole("button", { name: /demo@luma\.test/ })
  await expect(samRow).toHaveAttribute("aria-current", "true")
  await expect(samRow).toContainText("Using now")
  await expect(demoRow).not.toHaveAttribute("aria-current", "true")

  // Switch back to the first account.
  await demoRow.click()
  await expect(menu).toBeHidden()
  await expect(page.getByText(`Now using ${SEEDED.demo.username}.`)).toBeVisible()
  await expect(page).toHaveURL(/\/dashboard/)
  expect(await tabAccount(page)).toBe("u1")
  await expectDecksOf(page, "demo")

  const book = await readBook(page)
  expect(book?.v).toBe(2)
  expect(Object.keys(book!.accounts).sort()).toEqual(["u1", "u2"])
  expect(book!.accounts.u1.status).toBe("signed_in")
  expect(book!.accounts.u2.status).toBe("signed_in")
})

test("each tab keeps its own account, and each sees only its own decks", async ({ context }) => {
  const tabA = await context.newPage()
  await loginAndWait(tabA, SEEDED.demo.email)

  // A second tab in the same browser starts on the last account used, then adds sam.
  const tabB = await context.newPage()
  await tabB.goto("/dashboard")
  await expect(tabB).toHaveURL(/\/dashboard/)
  expect(await tabAccount(tabB)).toBe("u1")
  await addAccountFromMenu(tabB, SEEDED.sam.email, SEEDED.sam.username)
  expect(await tabAccount(tabB)).toBe("u2")

  // Tab A is still the first account, even after a reload.
  await tabA.reload()
  await expect(tabA).toHaveURL(/\/dashboard/)
  expect(await tabAccount(tabA)).toBe("u1")
  await expectDecksOf(tabA, "demo")
  await expectDecksOf(tabB, "empty")

  // Requests from each tab carry that tab's own token.
  const book = await readBook(tabA)
  const tokenFor = { u1: book!.accounts.u1.accessToken, u2: book!.accounts.u2.accessToken }
  const sentA = tabA.waitForRequest((r) => r.url() === `${API}/flashcards` && r.method() === "GET")
  await tabA.reload()
  expect(await (await sentA).headerValue("authorization")).toBe(`Bearer ${tokenFor.u1}`)
  const sentB = tabB.waitForRequest((r) => r.url() === `${API}/flashcards` && r.method() === "GET")
  await tabB.reload()
  expect(await (await sentB).headerValue("authorization")).toBe(`Bearer ${tokenFor.u2}`)

  // Switching in tab B does not move tab A.
  const menu = await openAccountMenu(tabB)
  await menu.getByRole("button", { name: /demo@luma\.test/ }).click()
  await expect(tabB.getByText(`Now using ${SEEDED.demo.username}.`)).toBeVisible()
  await openAccountMenu(tabB).then((m) => m.getByRole("button", { name: /second@luma\.test/ }).click())
  expect(await tabAccount(tabB)).toBe("u2")
  await tabA.reload()
  expect(await tabAccount(tabA)).toBe("u1")
})

test("signing out of the newer account keeps the first, and the oldest stays first for the AI chat", async ({ page }) => {
  await loginAndWait(page, SEEDED.demo.email)
  await addAccountFromMenu(page, SEEDED.sam.email, SEEDED.sam.username)
  const before = await readBook(page)
  const firstSignedInAt = before!.accounts.u1.signedInAt
  expect(firstSignedInAt).toBeLessThan(before!.accounts.u2.signedInAt)
  expect(await accountOrder(page)).toEqual(["u1", "u2"])

  // Sign out of sam (the active account) from the menu.
  const menu = await openAccountMenu(page)
  await menu.getByRole("button", { name: `Sign out of ${SEEDED.sam.username}` }).click()
  await expect(page.getByText(`Signed out of ${SEEDED.sam.username}. You're now using ${SEEDED.demo.username}.`)).toBeVisible()
  await expect(page).toHaveURL(/\/dashboard/)
  expect(await tabAccount(page)).toBe("u1")
  await expectDecksOf(page, "demo")

  const after = await readBook(page)
  expect(Object.keys(after!.accounts)).toEqual(["u1"])
  expect(after!.accounts.u1.signedInAt).toBe(firstSignedInAt)
  expect(after!.accounts.u1.status).toBe("signed_in")

  // Adding sam again puts sam after the first account, not before.
  await addAccountFromMenu(page, SEEDED.sam.email, SEEDED.sam.username)
  expect(await accountOrder(page)).toEqual(["u1", "u2"])
  expect((await readBook(page))!.accounts.u1.signedInAt).toBe(firstSignedInAt)
})

test("three accounts is the limit; signing out of the middle one keeps the oldest first", async ({ page }) => {
  await loginAndWait(page, SEEDED.demo.email)
  await addAccountDirect(page, SEEDED.sam.email)
  await addAccountFromMenu(page, SEEDED.lee.email, SEEDED.lee.username)
  expect(await accountOrder(page)).toEqual(["u1", "u2", "u3"])
  const firstSignedInAt = (await readBook(page))!.accounts.u1.signedInAt

  // The menu's add button is off and says why.
  const menu = await openAccountMenu(page)
  const add = menu.getByRole("button", { name: /add another account/i })
  await expect(add).toBeDisabled()
  await expect(add).toHaveAccessibleDescription("Up to 3 accounts")
  await page.keyboard.press("Escape")
  await expect(menu).toBeHidden()

  // Opening the add page directly sends you to Settings with the limit message.
  await page.goto("/login?add=1")
  await expect(page).toHaveURL(/\/settings#accounts/)
  await expect(page.getByText("You can have 3 accounts on this device. Sign out of one first.")).toBeVisible()

  // Sign out of sam (not the one in use) from Settings.
  const panel = page.getByRole("region", { name: "Accounts on this device" })
  await expect(panel).toBeVisible()
  await panel.getByRole("button", { name: `Sign out of ${SEEDED.sam.username}` }).click()
  await expect(page.getByText(`Signed out of ${SEEDED.sam.username}.`, { exact: true })).toBeVisible()
  expect(await tabAccount(page)).toBe("u3")
  expect(await accountOrder(page)).toEqual(["u1", "u3"])
  expect((await readBook(page))!.accounts.u1.signedInAt).toBe(firstSignedInAt)

  // There is room again.
  const menuAgain = await openAccountMenu(page)
  await expect(menuAgain.getByRole("button", { name: /add another account/i })).toBeEnabled()
  await page.keyboard.press("Escape")

  // Signing out of the oldest moves the AI chat to the next one.
  await page.goto("/settings")
  await panel.getByRole("button", { name: `Sign out of ${SEEDED.demo.username}` }).click()
  expect(await accountOrder(page)).toEqual(["u3"])
})

test("a tab whose account was signed out in another tab shows a notice and can use the other account", async ({ context }) => {
  const tabA = await context.newPage()
  await loginAndWait(tabA, SEEDED.demo.email)
  const tabB = await context.newPage()
  await tabB.goto("/dashboard")
  await addAccountFromMenu(tabB, SEEDED.sam.email, SEEDED.sam.username)

  // Tab B signs out of the first account (tab A's account) from Settings.
  await tabB.goto("/settings")
  const panel = tabB.getByRole("region", { name: "Accounts on this device" })
  await panel.getByRole("button", { name: `Sign out of ${SEEDED.demo.username}` }).click()
  await expect(tabB.getByText(`Signed out of ${SEEDED.demo.username}.`, { exact: true })).toBeVisible()
  expect(await tabAccount(tabB)).toBe("u2")

  // Tab A does not quietly become sam: it says what happened.
  const heading = tabA.getByRole("heading", { name: "Signed out" })
  await expect(heading).toBeVisible()
  await expect(tabA.getByText(`${SEEDED.demo.username} was signed out in another tab.`)).toBeVisible()
  await expect(heading).toBeFocused()
  expect(await tabAccount(tabA)).toBeNull()

  await tabA.getByRole("button", { name: `Use ${SEEDED.sam.username}` }).click()
  await expect(tabA).toHaveURL(/\/dashboard/)
  expect(await tabAccount(tabA)).toBe("u2")
  await expectDecksOf(tabA, "empty")
})

test("Escape closes the account menu and puts focus back on its button", async ({ page }, info) => {
  await loginAndWait(page, SEEDED.demo.email)
  const trigger = accountButton(page)
  await trigger.focus()
  await page.keyboard.press("Enter")
  const menu = page.getByRole("dialog", { name: "Accounts" })
  await expect(menu).toBeVisible()
  await expect(trigger).toHaveAttribute("aria-expanded", "true")

  await page.keyboard.press("Escape")
  await expect(menu).toBeHidden()
  await expect(trigger).toHaveAttribute("aria-expanded", "false")
  await expect(trigger).toBeFocused()

  // Opening again by keyboard still works after closing.
  await page.keyboard.press("Enter")
  await expect(menu).toBeVisible()
  await page.keyboard.press("Escape")
  await expect(menu).toBeHidden()
  await expect(trigger).toBeFocused()
  void info
})

test("the account menu with two accounts has no serious accessibility problems", async ({ page }, info) => {
  await loginAndWait(page, SEEDED.demo.email)
  await addAccountFromMenu(page, SEEDED.sam.email, SEEDED.sam.username)
  // Let the toast finish so only the menu is checked.
  await expect(page.getByText(`Added ${SEEDED.sam.username}. You're using it now.`)).toBeHidden({ timeout: 15_000 })
  await openAccountMenu(page)
  await expectNoSeriousA11yIssues(page, `account-menu-${info.project.name}`, info)
})

test("keyboard focus moves into the account menu when it opens", async ({ page }) => {
  await loginAndWait(page, SEEDED.demo.email)
  const trigger = accountButton(page)
  await trigger.focus()
  await page.keyboard.press("Enter")
  const menu = page.getByRole("dialog", { name: "Accounts" })
  await expect(menu).toBeVisible()
  // The next Tab lands on something inside the menu.
  await page.keyboard.press("Tab")
  const inside = await menu.evaluate((el) => el.contains(document.activeElement))
  expect(inside, "focus is inside the account menu after one Tab").toBe(true)
})

test("switching accounts in the middle of writing a note asks first, and keeps each account's draft", async ({ page }) => {
  await loginAndWait(page, SEEDED.demo.email)
  await addAccountFromMenu(page, SEEDED.sam.email, SEEDED.sam.username)
  expect(await tabAccount(page)).toBe("u2")

  // Sam starts a note. The editor is a page with unsaved work.
  await page.goto("/notes/new")
  const body = page.getByRole("textbox", { name: "Your notes" })
  await body.fill("Sam's half-written note")

  // Switching asks first. "Stay and save" keeps sam and the words on the page.
  let menu = await openAccountMenu(page)
  await menu.getByRole("button", { name: /demo@luma\.test/ }).click()
  const ask = page.getByRole("alertdialog", { name: "You have work that isn't saved yet." })
  await expect(ask).toBeVisible()
  await expect(ask.getByRole("button", { name: "Stay and save" })).toBeFocused()
  await ask.getByRole("button", { name: "Stay and save" }).click()
  await expect(page).toHaveURL(/\/notes\/new$/)
  expect(await tabAccount(page)).toBe("u2")
  await expect(body).toHaveValue("Sam's half-written note")

  // "Switch anyway" switches to the first account, which does not see sam's draft.
  menu = await openAccountMenu(page)
  await menu.getByRole("button", { name: /demo@luma\.test/ }).click()
  await ask.getByRole("button", { name: "Switch anyway" }).click()
  await expect(page).toHaveURL(/\/dashboard/)
  expect(await tabAccount(page)).toBe("u1")
  await page.goto("/notes/new")
  await expect(page.getByRole("textbox", { name: "Your notes" })).toHaveValue("")
  await expect(page.getByText("You have changes from earlier in this tab.")).toHaveCount(0)

  // Back on sam, the draft is still there (kept per account, in this tab only).
  menu = await openAccountMenu(page)
  await menu.getByRole("button", { name: /second@luma\.test/ }).click()
  await expect(page).toHaveURL(/\/dashboard/)
  await page.goto("/notes/new")
  await page.getByRole("button", { name: "Use them" }).click()
  await expect(page.getByRole("textbox", { name: "Your notes" })).toHaveValue("Sam's half-written note")
})
