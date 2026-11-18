// Main navigation: the four places (Home, Study, Notes, Search), Settings apart,
// the + New menu on desktop and tablet, and the phone bottom bar and + sheet.
// Runs against the FAKE API with the seeded demo account (read only).
import { expect, test, type Page } from "@playwright/test"

import { SEEDED, loginAndWait } from "./helpers"

const sidebar = (page: Page) => page.getByRole("complementary", { name: "Main navigation" })
const tabBar = (page: Page) => page.getByRole("navigation", { name: "Main navigation" })

const PLACES = [
  ["Home", "/dashboard"],
  ["Study", "/flashcards"],
  ["Notes", "/notes"],
  // The label stays "Search"; the page it opens is Discover.
  ["Search", "/discover"],
] as const

const MAKE = [
  ["Write a note", "/notes/new"],
  ["Import a file or link", "/notes/import"],
  ["Voice to notes", "/notes/voice"],
  ["Image to notes", "/notes/image"],
  ["New flashcard deck", "/flashcards/new"],
] as const

// Which place lights up on pages that belong to it.
const LIGHTS_UP = [
  ["/quizzes", "Study"],
  ["/study-sessions", "Study"],
  ["/flashcards/new", "Study"],
  ["/notes/new", "Notes"],
  ["/notes/import", "Notes"],
  ["/notes/voice", "Notes"],
  ["/notes/image", "Notes"],
  // Old addresses redirect into Notes, and Notes lights up there too.
  ["/import", "Notes"],
  ["/summaries", "Notes"],
  ["/discover", "Search"],
  // The old address redirects to Discover, and Search lights up there too.
  ["/search", "Search"],
] as const

test.beforeEach(async ({ page }) => {
  await loginAndWait(page, SEEDED.demo.email)
})

test.describe("sidebar and icon rail (desktop and tablet)", () => {
  // The phone project is the only mobile one (Pixel 7).
  test.skip(({ isMobile }) => isMobile, "Phones use the bottom bar (tested below).")

  test("has Home, Study, Notes, Search and Settings, and none of the old entries", async ({ page }) => {
    const nav = sidebar(page)
    await expect(nav).toBeVisible()
    // The brand, the four places and Settings. Nothing else is a link.
    await expect(nav.getByRole("link")).toHaveCount(6)
    await expect(nav.getByRole("link", { name: "Luma home" })).toHaveAttribute("href", "/dashboard")
    for (const [name, href] of [...PLACES, ["Settings", "/settings"] as const]) {
      await expect(nav.getByRole("link", { name, exact: true })).toHaveAttribute("href", href)
    }
    for (const old of ["Today", "Summaries", "Quizzes", "Flashcards", "Voice to Notes", "Import to Notes", "Image to Notes", "Study Sessions"]) {
      await expect(nav).not.toContainText(old)
    }
    // Home is the page we are on.
    await expect(nav.getByRole("link", { name: "Home", exact: true })).toHaveAttribute("aria-current", "page")

    for (const [name, href] of PLACES) {
      await nav.getByRole("link", { name, exact: true }).click()
      await expect(page).toHaveURL(new RegExp(`${href}$`))
      await expect(nav.getByRole("link", { name, exact: true })).toHaveAttribute("aria-current", "page")
      await expect(nav.locator('[aria-current="page"]')).toHaveCount(1)
    }
  })

  test("the right place lights up on the pages inside it", async ({ page }) => {
    for (const [path, place] of [...LIGHTS_UP, ["/settings", "Settings"] as const]) {
      await page.goto(path)
      await expect(page.getByRole("heading", { level: 1 }).first()).toBeVisible()
      await expect(sidebar(page).locator('[aria-current="page"]')).toHaveCount(1)
      await expect(sidebar(page).getByRole("link", { name: place, exact: true })).toHaveAttribute("aria-current", "page")
    }
  })

  test("+ New opens a menu with the five things to make; arrows move and Escape closes", async ({ page }) => {
    const button = sidebar(page).getByRole("button", { name: "Make something new" })
    await expect(button).toHaveAttribute("aria-haspopup", "menu")
    await expect(button).toHaveAttribute("aria-expanded", "false")

    await button.click()
    const menu = page.getByRole("menu", { name: "Make something new" })
    await expect(menu).toBeVisible()
    await expect(button).toHaveAttribute("aria-expanded", "true")
    const items = menu.getByRole("menuitem")
    await expect(items).toHaveCount(MAKE.length)
    for (const [index, [name, href]] of MAKE.entries()) {
      await expect(items.nth(index)).toHaveAccessibleName(name)
      await expect(items.nth(index)).toHaveAttribute("href", href)
    }
    await expect(menu.getByRole("menuitem", { name: /quiz|study plan|summar/i })).toHaveCount(0)

    // The first item has focus; arrows move and wrap; Home and End jump.
    await expect(items.nth(0)).toBeFocused()
    await page.keyboard.press("ArrowDown")
    await expect(items.nth(1)).toBeFocused()
    await page.keyboard.press("ArrowUp")
    await page.keyboard.press("ArrowUp")
    await expect(items.nth(MAKE.length - 1)).toBeFocused()
    await page.keyboard.press("Home")
    await expect(items.nth(0)).toBeFocused()
    await page.keyboard.press("End")
    await expect(items.nth(MAKE.length - 1)).toBeFocused()
    // Typing a letter jumps to the item that starts with it.
    await page.keyboard.press("v")
    await expect(menu.getByRole("menuitem", { name: "Voice to notes" })).toBeFocused()

    // Escape closes the menu and puts focus back on the button.
    await page.keyboard.press("Escape")
    await expect(menu).toHaveCount(0)
    await expect(button).toBeFocused()
    await expect(button).toHaveAttribute("aria-expanded", "false")
  })

  test("+ New works from the keyboard, and Tab or a click outside closes it", async ({ page }) => {
    const button = sidebar(page).getByRole("button", { name: "Make something new" })
    const menu = page.getByRole("menu", { name: "Make something new" })

    // Arrow Down on the button opens the menu; Enter on an item goes there.
    await button.focus()
    await page.keyboard.press("ArrowDown")
    await expect(menu).toBeVisible()
    await page.keyboard.press("i")
    await page.keyboard.press("i")
    await expect(menu.getByRole("menuitem", { name: "Image to notes" })).toBeFocused()
    await page.keyboard.press("Enter")
    await expect(page).toHaveURL(/\/notes\/image$/)
    await expect(menu).toHaveCount(0)
    await expect(sidebar(page).getByRole("link", { name: "Notes", exact: true })).toHaveAttribute("aria-current", "page")

    // Tab moves on and the menu closes behind it.
    await button.focus()
    await page.keyboard.press("Enter")
    await expect(menu).toBeVisible()
    await page.keyboard.press("Tab")
    await expect(menu).toHaveCount(0)
    await expect(button).toHaveAttribute("aria-expanded", "false")

    // A click outside closes it without going anywhere.
    await button.click()
    await expect(menu).toBeVisible()
    const viewport = page.viewportSize()!
    await page.mouse.click(viewport.width - 8, viewport.height - 8)
    await expect(menu).toHaveCount(0)
    await expect(page).toHaveURL(/\/notes\/image$/)

    // Clicking an item goes there.
    await button.click()
    await menu.getByRole("menuitem", { name: "New flashcard deck" }).click()
    await expect(page).toHaveURL(/\/flashcards\/new$/)
    await expect(menu).toHaveCount(0)
  })

  test("the menu fits on the screen and does not cover the sidebar links", async ({ page }) => {
    await sidebar(page).getByRole("button", { name: "Make something new" }).click()
    const menu = page.getByRole("menu", { name: "Make something new" })
    await expect(menu).toBeVisible()
    const box = (await menu.boundingBox())!
    const viewport = page.viewportSize()!
    expect(box.x + box.width).toBeLessThanOrEqual(viewport.width)
    expect(box.y + box.height).toBeLessThanOrEqual(viewport.height)
    expect(box.x).toBeGreaterThanOrEqual(0)

    // On a wide screen it opens under the button, lines up with it and stays inside the sidebar.
    if (viewport.width >= 1100) {
      const button = (await sidebar(page).getByRole("button", { name: "Make something new" }).boundingBox())!
      const side = (await sidebar(page).boundingBox())!
      expect(Math.abs(box.x - button.x)).toBeLessThanOrEqual(1)
      expect(Math.abs(box.width - button.width)).toBeLessThanOrEqual(1)
      expect(box.x + box.width).toBeLessThanOrEqual(side.x + side.width)
    }
  })
})

test.describe("study plans", () => {
  test("Study has a Study plans link that opens your plans", async ({ page }) => {
    await page.goto("/flashcards")
    await expect(page.getByRole("heading", { level: 1 }).first()).toBeVisible()
    const link = page.getByRole("main").getByRole("link", { name: "Study plans", exact: true })
    await expect(link).toBeVisible()
    await expect(link).toHaveAttribute("href", "/study-sessions")
    await link.click()
    await expect(page).toHaveURL(/\/study-sessions$/)
    await expect(page.getByRole("heading", { level: 1, name: "Study plans" })).toBeVisible()
    // Study is still the place that lights up.
    await expect(page.getByRole("link", { name: "Back to Study" })).toHaveAttribute("href", "/flashcards")
  })
})

test.describe("phone bottom bar", () => {
  test.skip(({ isMobile }) => !isMobile, "The bottom bar is only on phones.")

  test("has exactly five entries: Home, Study, +, Notes, Search", async ({ page }) => {
    const bar = tabBar(page)
    await expect(bar).toBeVisible()
    const entries = bar.locator(":scope > a, :scope > button")
    await expect(entries).toHaveCount(5)
    const names = ["Home", "Study", "Create something", "Notes", "Search"]
    for (const [index, name] of names.entries()) {
      await expect(entries.nth(index)).toHaveAccessibleName(name)
    }
    for (const [name, href] of PLACES) {
      await expect(bar.getByRole("link", { name, exact: true })).toHaveAttribute("href", href)
    }
    await expect(bar.getByRole("link", { name: "Home", exact: true })).toHaveAttribute("aria-current", "page")
    await expect(bar).not.toContainText(/Today|\bMe\b/)
    // The sidebar copy is hidden on phones.
    await expect(sidebar(page)).toBeHidden()
  })

  test("the right tab lights up on the pages inside it", async ({ page }) => {
    for (const [path, place] of LIGHTS_UP) {
      await page.goto(path)
      await expect(page.getByRole("heading", { level: 1 }).first()).toBeVisible()
      await expect(tabBar(page).locator('[aria-current="page"]')).toHaveCount(1)
      await expect(tabBar(page).getByRole("link", { name: place, exact: true })).toHaveAttribute("aria-current", "page")
    }
  })

  test("Settings opens from the avatar at the top", async ({ page }) => {
    await page.getByRole("button", { name: "Accounts and settings" }).click()
    const sheet = page.getByRole("dialog", { name: "Accounts" })
    await expect(sheet).toBeVisible()
    await sheet.getByRole("link", { name: "Settings" }).click()
    await expect(page).toHaveURL(/\/settings$/)
    await expect(page.getByRole("heading", { level: 1, name: "Settings" })).toBeVisible()
    await expect(sheet).toHaveCount(0)
  })
})
