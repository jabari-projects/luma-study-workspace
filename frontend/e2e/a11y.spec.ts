// Accessibility checks for Luma against the FAKE API (dev/mock-api.mjs).
// axe scans on the main pages in light, dark and automatic theme, keyboard order and
// focus rings on login, how login errors are announced, and reduced motion.
// Made-up data only; nothing leaves localhost.
import AxeBuilder from "@axe-core/playwright"
import { expect, test, type Page, type TestInfo } from "@playwright/test"

import { SEEDED, expectNoSeriousA11yIssues, loginAndWait, setThemeMode } from "./helpers"

/** Waits until the page has its heading and any loading spinners are gone, so axe sees the real page. */
async function settle(page: Page) {
  await expect(page.getByRole("heading", { level: 1 }).first()).toBeVisible()
  await page.waitForLoadState("networkidle")
  await expect(page.locator(".spinner, [aria-busy='true']")).toHaveCount(0)
  // Let entrance animations finish so colors are final.
  await page.waitForTimeout(800)
}

/**
 * Same check as expectNoSeriousA11yIssues, but leaves out the sidebar account button,
 * which has its own full-scan test below.
 */
async function expectNoSeriousA11yIssuesExceptKnown(page: Page, label: string, info: TestInfo) {
  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
    .exclude(".sidebar .identity")
    .analyze()
  const serious = results.violations.filter((v) => v.impact === "serious" || v.impact === "critical")
  if (results.violations.length) {
    await info.attach(`axe-${label}.json`, {
      body: JSON.stringify(results.violations.map((v) => ({ id: v.id, impact: v.impact, help: v.help, nodes: v.nodes.map((n) => n.target) })), null, 2),
      contentType: "application/json",
    })
  }
  expect(serious.map((v) => `${v.id}: ${v.help} (${v.nodes.length})`), `axe on ${label}`).toEqual([])
}

// ---------------------------------------------------------------- public pages
// The account pages have no dark mode (data-theme is only set inside the signed-in app),
// so they are scanned once, with the OS asking for dark too, to make sure nothing breaks.
for (const scheme of ["light", "dark"] as const) {
  test.describe(`public pages, OS color scheme ${scheme}`, () => {
    test.use({ colorScheme: scheme })

    test("login, signup and forgot password have no serious axe issues", async ({ page }, info) => {
      for (const [path, label] of [
        ["/login", "login"],
        ["/signup", "signup"],
        ["/forgot-password", "forgot-password"],
      ] as const) {
        await page.goto(path)
        await settle(page)
        // Public pages never get a theme (only the signed-in app does).
        await expect(page.locator("html")).not.toHaveAttribute("data-theme", /.+/)
        await expectNoSeriousA11yIssues(page, `${label}-${scheme}`, info)
      }
    })
  })
}

// --------------------------------------------------------------- signed-in pages
const appPages = [
  { path: "/dashboard", label: "dashboard" },
  { path: "/import", label: "import" },
  { path: "/voice-input", label: "voice-to-notes" },
  { path: "/flashcards", label: "decks" },
  { path: "/settings", label: "settings" },
]

for (const theme of ["light", "dark"] as const) {
  test.describe(`app pages, ${theme} theme`, () => {
    for (const { path, label } of appPages) {
      test(`${label} has no serious axe issues (${theme})`, async ({ page }, info) => {
        await setThemeMode(page, SEEDED.demo.email, theme)
        await loginAndWait(page, SEEDED.demo.email)
        if (path !== "/dashboard") await page.goto(path)
        await expect(page.locator("html")).toHaveAttribute("data-theme", theme)
        await settle(page)
        await expectNoSeriousA11yIssuesExceptKnown(page, `${label}-${theme}`, info)
      })
    }

    test(`sidebar account button passes the full axe scan (${theme})`, async ({ page }, info) => {
      await setThemeMode(page, SEEDED.demo.email, theme)
      await loginAndWait(page, SEEDED.demo.email)
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme)
      await settle(page)
      await expectNoSeriousA11yIssues(page, `dashboard-full-${theme}`, info)
    })

    test(`phone Add menu open has no serious axe issues (${theme})`, async ({ page }, info) => {
      test.skip(info.project.name !== "phone", "The Add (create) sheet is the phone tab bar")
      await setThemeMode(page, SEEDED.demo.email, theme)
      await loginAndWait(page, SEEDED.demo.email)
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme)
      await settle(page)
      const add = page.getByRole("button", { name: "Create something" })
      await add.click()
      const sheet = page.getByRole("dialog", { name: "Create something" })
      await expect(sheet).toBeVisible()
      await expect(add).toHaveAttribute("aria-expanded", "true")
      await page.waitForTimeout(800) // spring animation
      await expectNoSeriousA11yIssues(page, `add-menu-${theme}`, info)
      // Escape closes it.
      await page.keyboard.press("Escape")
      await expect(sheet).toBeHidden()
    })
  })
}

// ------------------------------------------------- Automatic theme (by the clock)
// Automatic is light from 7 am to 6:59 pm and dark from 7 pm to 6:59 am, on the device clock.
test.describe("app pages, automatic theme (Chicago time)", () => {
  test.use({ timezoneId: "America/Chicago" })

  for (const { time, expected } of [
    { time: "2026-11-16T20:00:00-06:00", expected: "dark" },
    { time: "2026-11-16T10:00:00-06:00", expected: "light" },
  ] as const) {
    test(`at ${time.slice(11, 16)} the page is ${expected} with no serious axe issues`, async ({ page }, info) => {
      try {
        await setThemeMode(page, SEEDED.demo.email, "auto")
        await page.clock.setFixedTime(new Date(time))
        await loginAndWait(page, SEEDED.demo.email)
        for (const path of ["/dashboard", "/settings"]) {
          if (path !== "/dashboard") await page.goto(path)
          await expect(page.locator("html")).toHaveAttribute("data-theme", expected)
          await settle(page)
          await expectNoSeriousA11yIssuesExceptKnown(page, `${path.slice(1)}-auto-${expected}`, info)
        }
        // Settings says which one Automatic shows right now.
        await expect(page.getByText(`Right now: ${expected}.`)).toBeVisible()
      } finally {
        await setThemeMode(page, SEEDED.demo.email, "light")
      }
    })
  }
})

// ------------------------------------------------------------------- keyboard
test("Tab on login reaches every control in order, each with a visible focus ring", async ({ page }) => {
  await page.goto("/login")
  await settle(page)

  // The page puts focus on the heading (tabindex -1) when it opens, so Tab starts at the
  // first control after it; the "Luma" home link sits before the heading and is reached with Shift+Tab.
  const brand = page.getByRole("link", { name: "Luma" })
  const expected = [
    page.getByLabel("Email"),
    page.getByRole("link", { name: "Forgot password?" }),
    page.getByLabel("Password", { exact: true }),
    page.getByRole("button", { name: /show password/i }),
    page.getByRole("button", { name: /^log in$/i }),
    page.getByRole("link", { name: "Make an account" }),
  ]
  await expect(page.getByRole("heading", { level: 1, name: "Log in" })).toBeFocused()

  const ringOf = () =>
    page.evaluate(() => {
      const el = document.activeElement as HTMLElement
      const s = getComputedStyle(el)
      return {
        tag: el.tagName,
        text: (el.getAttribute("aria-label") || el.textContent || el.getAttribute("name") || "").trim(),
        outline: s.outlineStyle !== "none" && parseFloat(s.outlineWidth) > 0 ? `${s.outlineStyle} ${s.outlineWidth} ${s.outlineColor}` : "none",
        boxShadow: s.boxShadow,
        borderColor: s.borderColor,
      }
    })

  // Unfocused look of each control (the page focuses the heading on load, not a control).
  const unfocused = []
  for (const locator of [...expected, brand]) {
    unfocused.push(
      await locator.evaluate((el) => {
        const s = getComputedStyle(el)
        return {
          outline: s.outlineStyle !== "none" && parseFloat(s.outlineWidth) > 0 ? `${s.outlineStyle} ${s.outlineWidth} ${s.outlineColor}` : "none",
          boxShadow: s.boxShadow,
        }
      }),
    )
  }

  for (let i = 0; i < expected.length; i++) {
    await page.keyboard.press("Tab")
    await expect(expected[i], `tab stop ${i + 1}`).toBeFocused()
    const focused = await ringOf()
    const changed = focused.outline !== unfocused[i].outline || focused.boxShadow !== unfocused[i].boxShadow
    expect(changed, `visible focus ring on tab stop ${i + 1} (${focused.tag} "${focused.text}"): ${JSON.stringify(focused)}`).toBe(true)
    // A ring has to be something you can see: a real outline or a non-empty shadow.
    expect(focused.outline !== "none" || focused.boxShadow !== "none").toBe(true)
  }

  // Shift+Tab goes back the same way.
  await page.keyboard.press("Shift+Tab")
  await expect(expected[expected.length - 2]).toBeFocused()

  // From the first field, Shift+Tab reaches the home link before the heading, also with a ring.
  await expected[0].focus()
  await page.keyboard.press("Shift+Tab")
  await expect(brand).toBeFocused()
  const brandRing = await ringOf()
  const brandBefore = unfocused[unfocused.length - 1]
  expect(brandRing.outline !== brandBefore.outline || brandRing.boxShadow !== brandBefore.boxShadow, JSON.stringify(brandRing)).toBe(true)
})

// ---------------------------------------------------------------- form errors
test("a wrong password shows an error that is linked to the fields and announced", async ({ page }) => {
  await page.goto("/login")
  await settle(page)
  await page.getByLabel("Email").fill(SEEDED.demo.email)
  await page.getByLabel("Password", { exact: true }).fill("not-the-password")
  await page.getByRole("button", { name: /^log in$/i }).click()

  const alert = page.getByRole("alert")
  await expect(alert).toContainText(/email or password is wrong/i)
  await expect(page).toHaveURL(/\/login/)

  // The message sits inside a polite live region...
  const region = page.locator("[aria-live]").filter({ has: alert })
  await expect(region).toHaveCount(1)
  const regionId = await region.getAttribute("id")
  expect(regionId).toBeTruthy()

  // ...that both fields point at, and both fields say they are invalid.
  for (const field of [page.getByLabel("Email"), page.getByLabel("Password", { exact: true })]) {
    const describedBy = (await field.getAttribute("aria-describedby")) ?? ""
    expect(describedBy.split(/\s+/)).toContain(regionId)
    await expect(field).toHaveAttribute("aria-invalid", "true")
  }

  // Focus moves to the message so keyboard and screen-reader users land on it.
  await expect(alert).toBeFocused()
})

// ------------------------------------------------------------- reduced motion
/** Longest animation/transition duration (in ms) among visible elements and the scribble paths. */
async function longestMotion(page: Page) {
  return page.evaluate(() => {
    const toMs = (value: string) =>
      Math.max(0, ...value.split(",").map((v) => (v.trim().endsWith("ms") ? parseFloat(v) : parseFloat(v) * 1000) || 0))
    let animation = 0
    let transition = 0
    let worst = ""
    for (const el of Array.from(document.querySelectorAll<Element>("body *"))) {
      const s = getComputedStyle(el)
      const a = s.animationName !== "none" ? toMs(s.animationDuration) : 0
      const t = toMs(s.transitionDuration)
      if (a > animation) {
        animation = a
        worst = `${el.tagName}.${el.getAttribute("class")} animation ${s.animationDuration}`
      }
      if (t > transition) {
        transition = t
        if (t > animation) worst = `${el.tagName}.${el.getAttribute("class")} transition ${s.transitionDuration}`
      }
    }
    const paths = Array.from(document.querySelectorAll("svg.rough-annotation path")).map((p) => {
      const s = getComputedStyle(p)
      return { name: s.animationName, duration: s.animationDuration }
    })
    return { animation, transition, worst, paths }
  })
}

test("with reduced motion, animations and transitions are effectively off", async ({ page }) => {
  // Baseline without reduced motion, so we know the page really animates.
  await loginAndWait(page, SEEDED.demo.email)
  await settle(page)
  const normal = await longestMotion(page)
  expect(normal.transition + normal.animation, "the page has some motion normally").toBeGreaterThan(50)
  expect(normal.paths.length, "the scribble underline under the name is drawn").toBeGreaterThan(0)

  await page.emulateMedia({ reducedMotion: "reduce" })
  await page.reload()
  await expect(page).toHaveURL(/\/dashboard/)
  await settle(page)
  const reduced = await longestMotion(page)
  expect(reduced.animation, `longest animation: ${reduced.worst}`).toBeLessThanOrEqual(1)
  expect(reduced.transition, `longest transition: ${reduced.worst}`).toBeLessThanOrEqual(1)
  // The hand-drawn underline is drawn at once, not animated stroke by stroke.
  expect(reduced.paths.length).toBeGreaterThan(0)
  for (const p of reduced.paths) {
    expect(p.name === "none" || parseFloat(p.duration) <= 0.001, JSON.stringify(p)).toBe(true)
  }
})
