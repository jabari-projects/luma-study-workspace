// Layout checks against the FAKE API (dev/mock-api.mjs), made-up data only.
// On a 375px phone, no page may scroll sideways: every signed-in page and every public page.
import { expect, test, type Page } from "@playwright/test"

import { SEEDED, loginAndWait } from "./helpers"
import { APP_PAGES, PUBLIC_PAGES } from "./pages"

/** How far the page is wider than the screen, and the widest element that sticks out (to fix it fast). */
async function sidewaysOverflow(page: Page) {
  return page.evaluate(() => {
    const width = window.innerWidth
    let widest = ""
    let right = width
    for (const el of Array.from(document.querySelectorAll<HTMLElement>("body *"))) {
      const box = el.getBoundingClientRect()
      if (box.width > 0 && box.right > right + 0.5) {
        right = box.right
        widest = `${el.tagName.toLowerCase()}.${el.getAttribute("class") ?? ""}`
      }
    }
    return { extra: document.documentElement.scrollWidth - width, widest, right: Math.round(right), width }
  })
}

async function settle(page: Page) {
  await expect(page.getByRole("heading", { level: 1 }).first()).toBeVisible()
  await page.waitForLoadState("networkidle")
  await expect(page.locator(".spinner, [aria-busy='true']")).toHaveCount(0)
  await page.waitForTimeout(400)
}

test.describe("phone width (375px)", () => {
  test.beforeEach(({ page }, info) => {
    test.skip(info.project.name !== "phone", "Checked on the 375px phone layout")
    expect(page.viewportSize()?.width).toBe(375)
  })

  test("no signed-in page scrolls sideways", async ({ page }) => {
    test.setTimeout(180_000)
    await loginAndWait(page, SEEDED.demo.email)
    for (const { path, label } of APP_PAGES) {
      if (path !== "/dashboard") await page.goto(path)
      await settle(page)
      const overflow = await sidewaysOverflow(page)
      expect(overflow.extra, `${label} (${path}) is ${overflow.extra}px too wide: ${JSON.stringify(overflow)}`).toBeLessThanOrEqual(0)
    }
  })

  test("the import source tabs stay on one line", async ({ page }) => {
    await loginAndWait(page, SEEDED.demo.email)
    await page.goto("/notes/import")
    await settle(page)
    const tabs = page.getByRole("tablist", { name: "Where is it from?" }).getByRole("tab")
    await expect(tabs).toHaveCount(4)
    const tops = await tabs.evaluateAll((elements) => elements.map((el) => (el as HTMLElement).offsetTop))
    expect(new Set(tops).size, `tab tops: ${tops.join(", ")}`).toBe(1)
    // At 375px all four fit without sliding the strip.
    const strip = await page.getByRole("tablist", { name: "Where is it from?" }).evaluate((el) => ({ scroll: el.scrollWidth, client: el.clientWidth }))
    expect(strip.scroll, `strip ${JSON.stringify(strip)}`).toBeLessThanOrEqual(strip.client)
    // Every tab can be reached, even if the strip has to slide.
    for (const tab of await tabs.all()) {
      await tab.scrollIntoViewIfNeeded()
      await expect(tab).toBeInViewport()
    }
  })

  test("no public page scrolls sideways", async ({ page }) => {
    for (const { path, label } of PUBLIC_PAGES) {
      await page.goto(path)
      await settle(page)
      const overflow = await sidewaysOverflow(page)
      expect(overflow.extra, `${label} (${path}) is ${overflow.extra}px too wide: ${JSON.stringify(overflow)}`).toBeLessThanOrEqual(0)
    }
  })
})
