// Discover search with filter chips (owner item 6): type anything, then narrow with subject,
// subtopic and type chips that show how many items each holds. Filters combine, clear, live in
// the address (Back undoes a tap, a reload keeps them) and work on a phone.
// FAKE API only: the seeded classmate (riley) shared 24 items; "1+1" is in 7 of them.
import { expect, test } from "@playwright/test"
import type { Page } from "@playwright/test"

import { SEEDED, expectNoSeriousA11yIssues, loginAndWait, setThemeMode } from "./helpers"

const status = (page: Page) => page.getByTestId("discover-status")
const chip = (page: Page, row: string, name: string) =>
  page.getByRole("group", { name: row }).getByRole("button", { name: new RegExp(`^${name} \\d+$`) })
const results = (page: Page) => page.locator(".result-list article")
const filtersToggle = (page: Page) => page.getByRole("button", { name: /^Filters/ })
/** On a phone the chip rows fold under "Filters": open them (wider screens always show them). */
async function openFilters(page: Page) {
  const toggle = filtersToggle(page)
  if ((await toggle.isVisible()) && (await toggle.getAttribute("aria-expanded")) === "false") await toggle.click()
}

test("1+1: everything shared, then Math, then a subtopic, then Flashcards; back up, Back, reload and Clear all", async ({ page }, info) => {
  await loginAndWait(page, SEEDED.lee.email)
  await page.goto("/discover")
  await expect(page.getByPlaceholder("Search anything, like photosynthesis or 1+1")).toBeVisible()
  await page.getByLabel("Search", { exact: true }).fill("1+1")
  await page.getByRole("button", { name: "Search", exact: true }).click()
  await expect(page).toHaveURL(/\/discover\?q=1%2B1$/)
  await expect(status(page)).toHaveText("7 shared items for “1+1”.")
  await expect(results(page)).toHaveCount(7)
  await openFilters(page)
  // The subject chips show counts; no chip for "No subject" (it can't be chosen).
  await expect(chip(page, "Subject", "Math")).toHaveText("Math 5")
  await expect(chip(page, "Subject", "Math")).toHaveAttribute("aria-pressed", "false")
  await expect(page.getByRole("group", { name: "Subject" })).not.toContainText("No subject")
  await expect(chip(page, "Type", "Flashcards")).toHaveText("Flashcards 3")
  await expect(page.getByText("Want a quiz? Open one of your decks and tap Quiz yourself.")).toBeVisible()
  await expectNoSeriousA11yIssues(page, "discover-chips", info)

  await chip(page, "Subject", "Math").click()
  await expect(page).toHaveURL(/subject=math/)
  await expect(status(page)).toHaveText("5 shared items for “1+1” in Math.")
  await expect(chip(page, "Subject", "Math")).toHaveAttribute("aria-pressed", "true")
  // Its subtopics, with counts.
  await expect(chip(page, "Topics in Math", "Arithmetic and basic math")).toHaveText("Arithmetic and basic math 4")
  await expect(chip(page, "Topics in Math", "Algebra 1")).toHaveText("Algebra 1 1")

  await chip(page, "Topics in Math", "Arithmetic and basic math").click()
  await expect(status(page)).toHaveText("4 shared items for “1+1” in Math › Arithmetic and basic math.")
  await expect(chip(page, "Type", "Flashcards")).toHaveText("Flashcards 2")
  await chip(page, "Type", "Flashcards").click()
  await expect(status(page)).toHaveText("2 shared decks for “1+1” in Math › Arithmetic and basic math.")
  await expect(results(page)).toHaveCount(2)
  await expect(results(page).first()).toContainText("Deck")
  await expect(results(page).first().locator(".result-subject")).toHaveText("Subject: Math › Arithmetic and basic math")
  await expect(page).toHaveURL(/\?q=1%2B1&subject=math&subtopic=basic-math&type=flashcards$/)

  // The trail says where we are; each part goes back to that level.
  const trail = page.getByRole("navigation", { name: "Filters" })
  await expect(trail).toContainText("All")
  await expect(trail.getByText("Flashcards")).toHaveAttribute("aria-current", "true")

  // A reload keeps the filters.
  await page.reload()
  await expect(status(page)).toHaveText("2 shared decks for “1+1” in Math › Arithmetic and basic math.")
  await openFilters(page)
  await expect(page.getByLabel("Search", { exact: true })).toHaveValue("1+1")

  await trail.getByRole("button", { name: "Math", exact: true }).click()
  await expect(status(page)).toHaveText("5 shared items for “1+1” in Math.")
  await expect(page).toHaveURL(/\?q=1%2B1&subject=math$/)

  // Back undoes that tap.
  await page.goBack()
  await expect(status(page)).toHaveText("2 shared decks for “1+1” in Math › Arithmetic and basic math.")

  // Tapping a chosen chip again clears just that filter.
  await chip(page, "Type", "Flashcards").click()
  await expect(status(page)).toHaveText("4 shared items for “1+1” in Math › Arithmetic and basic math.")

  await trail.getByRole("button", { name: "Clear all" }).click()
  await expect(status(page)).toHaveText("7 shared items for “1+1”.")
  await expect(page).toHaveURL(/\/discover\?q=1%2B1$/)
  await expect(trail).toHaveCount(0)
})

test("a subject name finds items in it; bad values in the address are dropped quietly", async ({ page }) => {
  await loginAndWait(page, SEEDED.lee.email)
  // "biology" is not in any title, but it is a subject name.
  await page.goto("/discover?q=genetics")
  await expect(status(page)).toHaveText(/^2 shared items for “genetics”\.$/)
  await page.goto("/discover?subject=Not!A!Slug&type=quiz")
  await expect(status(page)).toHaveText(/^\d+ shared items?\.$/)
  await expect(page.getByRole("navigation", { name: "Filters" })).toHaveCount(0)
  // A well-formed slug that isn't on the list: the server says so, and the page drops it.
  await page.goto("/discover?subject=astrology")
  await expect(page).toHaveURL(/\/discover$/)
  await expect(status(page)).toHaveText(/^\d+ shared items?\.$/)
})

test("filters that find nothing say so, with Clear filters", async ({ page }) => {
  await loginAndWait(page, SEEDED.lee.email)
  await page.goto("/discover?q=1%2B1&subject=biology")
  await expect(page.getByRole("heading", { name: "Nothing here with these filters." })).toBeVisible()
  await expect(status(page)).toHaveText("Nothing here with these filters.")
  await page.getByRole("button", { name: "Clear filters" }).click()
  await expect(status(page)).toHaveText("7 shared items for “1+1”.")
})

test("on a narrow phone the chips wrap and nothing scrolls sideways (dark theme)", async ({ page }, info) => {
  await setThemeMode(page, SEEDED.lee.email, "dark")
  try {
    await page.setViewportSize({ width: 320, height: 720 })
    await loginAndWait(page, SEEDED.lee.email)
    await page.goto("/discover?q=1%2B1&subject=math")
    await expect(status(page)).toHaveText("5 shared items for “1+1” in Math.")
    // The chips fold under "Filters (1)", so the count and the first result show on the first screen.
    await expect(page.locator(".result-line")).toBeInViewport()
    await expect(results(page).first()).toBeInViewport()
    await expect(filtersToggle(page)).toHaveText("Filters (1)")
    await expect(filtersToggle(page)).toHaveAttribute("aria-expanded", "false")
    await expect(page.locator(".filter-chip").first()).toBeHidden()
    await filtersToggle(page).click()
    await expect(filtersToggle(page)).toHaveAttribute("aria-expanded", "true")
    await expect(chip(page, "Subject", "Math")).toBeVisible()
    // A chosen chip keeps the accent's own text color (4.5:1 or more in dark too).
    const pressed = chip(page, "Subject", "Math")
    await expect(pressed).toHaveAttribute("aria-pressed", "true")
    const colors = await pressed.evaluate((el) => {
      const style = getComputedStyle(el)
      return { fg: style.color, bg: style.backgroundColor }
    })
    expect(contrast(colors.fg, colors.bg)).toBeGreaterThanOrEqual(4.5)
    const sideways = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
    expect(sideways).toBeLessThanOrEqual(0)
    for (const button of await page.locator(".filter-chip").all()) {
      const box = await button.boundingBox()
      expect(box!.x + box!.width).toBeLessThanOrEqual(320)
      expect(box!.height).toBeGreaterThanOrEqual(44)
    }
    await expectNoSeriousA11yIssues(page, "discover-chips-dark-phone", info)
  } finally {
    await setThemeMode(page, SEEDED.lee.email, "light")
  }
})

/** WCAG contrast of two computed rgb() colors. */
function contrast(a: string, b: string): number {
  const lum = (css: string) => {
    // rgb(r, g, b) in 0-255, or color(srgb r g b) in 0-1.
    const scale = css.startsWith("color(") ? 1 : 255
    const [r, g, bl] = (css.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number).map((v) => {
      const c = v / scale
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
    })
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl
  }
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}
