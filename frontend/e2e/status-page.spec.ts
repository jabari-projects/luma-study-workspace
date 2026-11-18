// The public status page (/status) against the FAKE API: it works signed out, says the
// phase in plain words, shows no technical text, sits near the top of the screen, and its
// own checks during a break are bounded (30 s, 1, 2 and 4 minutes, then they stop),
// pause while the tab is hidden, and start over when the student comes back.
import { expect, test, type Page } from "@playwright/test"

import { expectNoSeriousA11yIssues } from "./helpers"
import { expectNoTechnicalText, phaseBody, resetMaintenance, setMaintenance } from "./maintenance-helpers"
import type { FakePhase } from "./maintenance-helpers"

test.beforeEach(async ({ page }) => {
  await resetMaintenance(page)
})

test.afterEach(async ({ page }) => {
  await resetMaintenance(page)
})

const HEADLINES: Record<FakePhase, string> = {
  none: "Luma is working",
  announced: "A short break is coming",
  draining: "Luma is getting ready for a short break",
  active: "Luma is taking a short break",
  checking: "Luma is taking a short break",
}

async function countStatusChecks(page: Page) {
  const seen = { count: 0 }
  page.on("request", (request) => {
    if (request.url().includes("/maintenance/status")) seen.count += 1
  })
  return seen
}

for (const phase of Object.keys(HEADLINES) as FakePhase[]) {
  test(`shows the ${phase} phase in plain words, signed out`, async ({ page }, info) => {
    await setMaintenance(page, phaseBody(phase))
    await page.goto("/status")
    const heading = page.getByRole("heading", { level: 1, name: HEADLINES[phase] })
    await expect(heading).toBeVisible()
    await expect(page.getByText(/^Last checked \d{1,2}:\d{2} [AP]M$/)).toBeVisible()
    await expect(page.getByRole("button", { name: "Check again" })).toBeVisible()
    if (phase === "active" || phase === "checking") {
      await expect(page.getByText("Your saved work is safe.")).toBeVisible()
      await expect(page.getByText(/This is a guess, not a promise\./)).toBeVisible()
    }
    await expectNoTechnicalText(page)
    // Near the top: no big empty space above the heading.
    const box = await heading.boundingBox()
    const viewport = page.viewportSize()
    expect(box && viewport && box.y < viewport.height * 0.4, "heading in the top 40%").toBeTruthy()
    await expectNoSeriousA11yIssues(page, `status-${phase}-${info.project.name}`, info)
  })
}

test("during a break the page checks again 4 times, then stops and waits for Check again", async ({ page }) => {
  test.setTimeout(90_000)
  await page.clock.install()
  await setMaintenance(page, phaseBody("active"))
  const seen = await countStatusChecks(page)
  await page.goto("/status")
  await expect(page.getByText(/^Last checked/)).toBeVisible()
  await page.waitForTimeout(500)
  const start = seen.count
  const lastChecked = page.getByText(/^Last checked/)

  for (const [i, wait] of [30_000, 60_000, 120_000, 240_000].entries()) {
    await page.clock.fastForward(wait - 1_000)
    await page.waitForTimeout(300)
    expect(seen.count, `not before ${wait / 1000} s`).toBe(start + i)
    await page.clock.fastForward(1_500)
    await expect.poll(() => seen.count).toBe(start + i + 1)
    await expect(lastChecked).toBeVisible()
  }

  // It has stopped: nothing more, however long the page stays open.
  await page.clock.fastForward(30 * 60_000)
  await page.waitForTimeout(500)
  expect(seen.count).toBe(start + 4)
  const again = page.getByRole("button", { name: "Check again" })
  await expect(again).toHaveClass(/primary-button/)
  await again.click()
  await expect.poll(() => seen.count).toBe(start + 5)
})

test("the checks pause while the tab is hidden and start over when it comes back", async ({ page }) => {
  await page.clock.install()
  await setMaintenance(page, phaseBody("draining"))
  const seen = await countStatusChecks(page)
  await page.goto("/status")
  await expect(page.getByText(/^Last checked/)).toBeVisible()
  await page.waitForTimeout(500)
  const start = seen.count

  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" })
    document.dispatchEvent(new Event("visibilitychange"))
  })
  await page.clock.fastForward(10 * 60_000)
  await page.waitForTimeout(500)
  expect(seen.count, "no checks while hidden").toBe(start)

  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" })
    document.dispatchEvent(new Event("visibilitychange"))
  })
  await expect.poll(() => seen.count).toBeGreaterThan(start)
})

test("when the status can't be read it says so plainly", async ({ page }) => {
  await page.route("**/maintenance/status", (route) => route.abort("connectionrefused"))
  await page.goto("/status")
  await expect(page.getByRole("alert")).toHaveText("We can't reach Luma right now. Try again in a minute.")
  await expectNoTechnicalText(page)
})

test("no checks by itself when there is no break", async ({ page }) => {
  await page.clock.install()
  const seen = await countStatusChecks(page)
  await page.goto("/status")
  await expect(page.getByRole("heading", { level: 1, name: "Luma is working" })).toBeVisible()
  await page.waitForTimeout(500)
  const start = seen.count
  await page.clock.fastForward(20 * 60_000)
  await page.waitForTimeout(500)
  expect(seen.count).toBe(start)
})
