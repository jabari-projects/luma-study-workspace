// Signed-in pages are a student's own space, so search engines are asked not to
// list them. The Vercel X-Robots-Tag header is checked in src/hosting.test.ts,
// because these tests run against Vite.
import { expect, test } from "@playwright/test"

import { SEEDED, loginAndWait } from "./helpers"

// A noindex only works when the crawler may fetch the page, so robots.txt must
// not block the app pages (Google's rule for noindex).
test("robots.txt lets crawlers reach the app pages so they see the noindex", async ({ page }) => {
  const response = await page.request.get("/robots.txt")
  expect(response.ok()).toBe(true)
  const body = await response.text()
  const lines = body.split(/\r?\n/).map((line) => line.trim())
  expect(lines).toContain("User-agent: *")
  expect(lines).toContain("Allow: /")
  expect(lines.filter((line) => /^disallow:\s*\S/i.test(line))).toEqual([])
})

test("signed-in pages carry a noindex robots tag; the front page does not", async ({ page }) => {
  await page.goto("/")
  await expect(page.getByRole("heading", { level: 1, name: "Luma" })).toBeVisible()
  await expect(page.locator('meta[name="robots"]')).toHaveCount(0)

  await loginAndWait(page, SEEDED.demo.email)
  const meta = page.locator('meta[name="robots"]')
  await expect(meta).toHaveCount(1)
  await expect(meta).toHaveAttribute("content", "noindex")

  // Still exactly one tag after moving around the app.
  await page.goto("/settings")
  await expect(page).toHaveURL(/\/settings/)
  await expect(meta).toHaveCount(1)
  await expect(meta).toHaveAttribute("content", "noindex")

  // After signing out, the public pages lose the tag again.
  await page.getByRole("button", { name: /^Accounts/ }).filter({ visible: true }).first().click()
  const menu = page.getByRole("dialog", { name: "Accounts" })
  await menu.getByRole("button", { name: `Sign out of ${SEEDED.demo.username}` }).click()
  await expect(page).toHaveURL(/\/$|\/login/)
  await expect(meta).toHaveCount(0)
})
