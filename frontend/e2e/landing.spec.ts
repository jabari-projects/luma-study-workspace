// The start page (/) and the log in and sign up pages, signed out, against the FAKE API.
// They never show a server address, status text or code errors, never scroll sideways,
// and fill the screen instead of sitting in one corner with empty space around them.
// Made-up data only; nothing leaves localhost.
import { expect, test, type Page } from "@playwright/test"

import { API, longestMotion } from "./helpers"

/**
 * The sizes each project checks. Tablets include 768x954: a 768x1024 iPad once Safari's bars
 * take their room. Desktops go up to big 1920x1080 and 2560x1440 screens.
 */
const SIZES: Record<string, Array<{ width: number; height: number }>> = {
  phone: [
    { width: 375, height: 812 },
    { width: 360, height: 740 },
  ],
  tablet: [
    { width: 820, height: 1180 },
    { width: 768, height: 954 },
  ],
  desktop: [
    { width: 1280, height: 800 },
    { width: 1536, height: 864 },
    { width: 1920, height: 1080 },
    { width: 2560, height: 1440 },
  ],
}

/** How much of the screen's height the content must cover. Phones have the least room, so the most is asked. */
const MIN_HEIGHT: Record<string, number> = { phone: 0.65, tablet: 0.5, desktop: 0.5 }

/** Text that would give away a server address, internal status or a code error. */
const EXPOSED = [/https?:\/\//i, /127\.0\.0\.1/, /localhost/i, /onrender/i, /checking luma/i, /status code/i, /\berror:/i]

const PAGES = [
  { path: "/", label: "start page", content: [".landing-copy", ".landing-preview"], heading: "Luma" },
  { path: "/login", label: "log in", content: [".auth-card", ".auth-side"], heading: "Log in" },
  { path: "/signup", label: "sign up", content: [".auth-card", ".auth-side"], heading: "Make your account" },
  { path: "/forgot-password", label: "forgot password", content: [".auth-card", ".auth-side"], heading: "Reset your password" },
] as const

/** How far the page is wider than the screen, and the box around the page's own content. */
async function measure(page: Page, selectors: readonly string[]) {
  return page.evaluate((list) => {
    const boxes = list
      .flatMap((selector) => Array.from(document.querySelectorAll(selector)))
      .map((el) => el.getBoundingClientRect())
      .filter((box) => box.width > 0 && box.height > 0)
    const left = Math.min(...boxes.map((b) => b.left))
    const right = Math.max(...boxes.map((b) => b.right))
    const top = Math.min(...boxes.map((b) => b.top))
    const bottom = Math.max(...boxes.map((b) => b.bottom))
    return {
      extra: document.documentElement.scrollWidth - window.innerWidth,
      viewport: { width: window.innerWidth, height: window.innerHeight },
      content: { left: Math.round(left), right: Math.round(right), top: Math.round(top), bottom: Math.round(bottom) },
    }
  }, selectors)
}

for (const { path, label, content, heading } of PAGES) {
  test(`${label}: no server details, no sideways scrolling, and no big empty areas`, async ({ page }, info) => {
    const healthChecks: string[] = []
    page.on("request", (request) => {
      if (request.url().startsWith(`${API}/health`)) healthChecks.push(request.url())
    })

    for (const size of SIZES[info.project.name] ?? []) {
      await page.setViewportSize(size)
      await page.goto(path)
      await expect(page.getByRole("heading", { level: 1, name: heading })).toBeVisible()
      await page.waitForLoadState("networkidle")

      const text = await page.locator("body").innerText()
      for (const pattern of EXPOSED) {
        expect(text, `${label} at ${size.width}x${size.height} shows ${pattern}`).not.toMatch(pattern)
      }

      const m = await measure(page, content)
      const where = `${label} at ${size.width}x${size.height}: ${JSON.stringify(m)}`
      expect(m.extra, `sideways scrolling on ${where}`).toBeLessThanOrEqual(0)

      // The content is spread over the screen and centered left to right, not stuck in a corner.
      const width = m.content.right - m.content.left
      const height = m.content.bottom - m.content.top
      const centerX = (m.content.left + m.content.right) / 2
      expect(width / m.viewport.width, `content width on ${where}`).toBeGreaterThanOrEqual(0.55)
      expect(height / m.viewport.height, `content height on ${where}`).toBeGreaterThanOrEqual(MIN_HEIGHT[info.project.name] ?? 0.5)
      expect(Math.abs(centerX - m.viewport.width / 2) / m.viewport.width, `left-right balance on ${where}`).toBeLessThanOrEqual(0.08)
      if (path === "/" && height <= m.viewport.height) {
        // The start page is centered top to bottom too (when it fits on the screen).
        const centerY = (m.content.top + m.content.bottom) / 2
        expect(Math.abs(centerY - m.viewport.height / 2) / m.viewport.height, `top-bottom balance on ${where}`).toBeLessThanOrEqual(0.08)
      }
    }

    // The start page no longer checks the server at all.
    expect(healthChecks, "requests to the health check").toEqual([])
  })
}

test("the start page links to log in and sign up with the same words those pages use", async ({ page }) => {
  await page.goto("/")
  await page.getByRole("link", { name: "Log in", exact: true }).click()
  await expect(page).toHaveURL(/\/login$/)
  await expect(page.getByRole("heading", { level: 1, name: "Log in" })).toBeVisible()

  await page.goto("/")
  await page.getByRole("link", { name: "Make an account", exact: true }).click()
  await expect(page).toHaveURL(/\/signup$/)
  await expect(page.getByRole("heading", { level: 1, name: "Make your account" })).toBeVisible()
})

test("the start page stays still with reduced motion", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" })
  await page.goto("/")
  await expect(page.getByRole("heading", { level: 1, name: "Luma" })).toBeVisible()
  const motion = await longestMotion(page)
  expect(motion.animation, `longest animation: ${motion.worst}`).toBeLessThanOrEqual(1)
  expect(motion.transition, `longest transition: ${motion.worst}`).toBeLessThanOrEqual(1)
})

// A server problem shows a plain message, never the server's address, "status code 500",
// or the server's own words about how it is set up.
for (const { name, fail } of [
  { name: "the server can't be reached", fail: "abort" },
  { name: "the server answers with a broken page", fail: "500" },
  { name: "the server answers with setup details", fail: "setup" },
] as const) {
  test(`log in when ${name} shows a friendly message only`, async ({ page }) => {
    await page.route(`${API}/login`, (route) =>
      fail === "abort"
        ? route.abort()
        : fail === "setup"
          ? route.fulfill({ status: 500, json: { error: "Stripe is not configured" } })
          : route.fulfill({ status: 500, contentType: "text/plain", body: "Internal Server Error" }),
    )
    await page.goto("/login")
    await page.getByLabel("Email").fill("someone@example.test")
    await page.getByLabel("Password", { exact: true }).fill("made-up-password")
    await page.getByRole("button", { name: /^log in$/i }).click()
    const alert = page.getByRole("alert")
    await expect(alert).toBeVisible()
    const message = await alert.innerText()
    for (const pattern of [...EXPOSED, /internal server error/i, /\b500\b/, /stripe/i, /configured/i]) {
      expect(message).not.toMatch(pattern)
    }
    expect(message).toMatch(fail === "abort" ? /can't reach Luma/i : /couldn't log you in/i)
  })
}
