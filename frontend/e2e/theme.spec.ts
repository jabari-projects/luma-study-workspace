// Theme checks against the FAKE API (dev/mock-api.mjs): every accent color is
// readable in light and dark, the dark page is not tinted by the accent, focus
// rings are solid ink, a profile with no saved color shows Teal, and Light / Dark /
// Automatic works (Settings radios, no flash on load, the 7 am / 7 pm clock, other
// tabs following, and sign-out clearing the copy kept on this device).
// Made-up accounts only; each test puts back the colors it changes.
import AxeBuilder from "@axe-core/playwright"
import { expect, test, type Page, type TestInfo } from "@playwright/test"

import { DEFAULT_ACCENT, themeColors } from "../src/ui/themeColors"
import { API, PASSWORD, SEEDED, clearProfileColor, expectFocusRing, loginAndWait, setProfileTheme, setThemeMode } from "./helpers"

/** Waits for the heading, data, and entrance animations, so the colors axe sees are final. */
async function settle(page: Page) {
  await expect(page.getByRole("heading", { level: 1 }).first()).toBeVisible()
  await page.waitForLoadState("networkidle")
  await expect(page.locator(".spinner, [aria-busy='true']")).toHaveCount(0)
  await page.waitForTimeout(800)
}

async function expectNoContrastIssues(page: Page, label: string, info: TestInfo) {
  const results = await new AxeBuilder({ page }).withRules(["color-contrast"]).analyze()
  if (results.violations.length) {
    await info.attach(`contrast-${label}.json`, {
      body: JSON.stringify(
        results.violations.flatMap((v) => v.nodes.map((n) => ({ target: n.target, summary: n.failureSummary }))),
        null,
        2,
      ),
      contentType: "application/json",
    })
  }
  const nodes = results.violations.flatMap((v) => v.nodes.map((n) => `${n.target.join(" ")}: ${n.failureSummary}`))
  expect(nodes, `color contrast on ${label}`).toEqual([])
}

/** The accent the app put on <html> for the signed-in student. */
const accentOf = (page: Page) => page.evaluate(() => document.documentElement.style.getPropertyValue("--accent"))

/** Every rgb()/rgba()/color(srgb ...) in a computed CSS value, as 0-255 channels. */
function colorsIn(value: string): number[][] {
  const found: number[][] = []
  for (const m of value.matchAll(/rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/g)) {
    found.push([Number(m[1]), Number(m[2]), Number(m[3])])
  }
  for (const m of value.matchAll(/color\(srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)/g)) {
    found.push([Number(m[1]) * 255, Number(m[2]) * 255, Number(m[3]) * 255])
  }
  return found
}

for (const theme of ["light", "dark"] as const) {
  test(`all 10 accent colors pass color contrast on Today and Flashcards (${theme})`, async ({ page }, info) => {
    test.setTimeout(300_000)
    try {
      await setProfileTheme(page, SEEDED.demo.email, { theme_mode: theme, theme_color: DEFAULT_ACCENT })
      await loginAndWait(page, SEEDED.demo.email)
      for (const swatch of themeColors) {
        await setProfileTheme(page, SEEDED.demo.email, { theme_color: swatch.value })
        for (const path of ["/dashboard", "/flashcards"]) {
          await page.goto(path)
          await expect(page.locator("html")).toHaveAttribute("data-theme", theme)
          await expect
            .poll(() => accentOf(page))
            .toBe(swatch.value)
          await settle(page)
          await expectNoContrastIssues(page, `${path.slice(1)}-${swatch.name}-${theme}`, info)
        }
      }
    } finally {
      await setProfileTheme(page, SEEDED.demo.email, { theme_mode: "light", theme_color: DEFAULT_ACCENT })
    }
  })
}

test("the dark page background is not tinted by the accent color (Purple)", async ({ page }) => {
  const purple = themeColors.find((swatch) => swatch.name === "Purple")!.value
  try {
    await setProfileTheme(page, SEEDED.demo.email, { theme_mode: "dark", theme_color: purple })
    await loginAndWait(page, SEEDED.demo.email)
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark")
    await expect.poll(() => accentOf(page)).toBe(purple)

    const background = await page.evaluate(() => getComputedStyle(document.body).backgroundImage)
    expect(background).not.toBe("none")
    // #7c3aed is rgb(124, 58, 237). Look for it (or anything close) in any color form.
    const nearPurple = colorsIn(background).filter(
      ([r, g, b]) => Math.abs(r - 124) <= 3 && Math.abs(g - 58) <= 3 && Math.abs(b - 237) <= 3,
    )
    expect(nearPurple, background).toEqual([])
    expect(background).not.toContain("rgb(124, 58, 237)")
  } finally {
    await setProfileTheme(page, SEEDED.demo.email, { theme_mode: "light", theme_color: DEFAULT_ACCENT })
  }
})

test("the Log in button has a solid ink focus ring", async ({ page }) => {
  await page.goto("/login")
  await settle(page)
  await expectFocusRing(page.getByRole("button", { name: /^log in$/i }))
})

test("a focused stamped button keeps its stamp shadow and gets the yellow halo too", async ({ page }) => {
  await page.goto("/login")
  await settle(page)
  const button = page.getByRole("button", { name: /^log in$/i })
  await expectFocusRing(button)
  // Two shadows: the 3px stamp and the 6px halo (it grows in, so wait for the end).
  const shadow = () => button.evaluate((el) => getComputedStyle(el).boxShadow)
  await expect.poll(shadow).toMatch(/0px 0px 0px 6px/)
  expect(await shadow()).toMatch(/3px 3px 0px 0px/)
})

test("the study and quiz stages show focus without a big yellow frame", async ({ page }) => {
  await loginAndWait(page, SEEDED.demo.email)

  // Study: Tab onto the card area. The card's own accent shadow shows focus.
  await page.goto("/flashcards/d1/study")
  // The review intro comes first.
  await page.getByRole("button", { name: "Start", exact: true }).click()
  const stage = page.locator(".study-stage")
  await expect(stage).toBeVisible()
  await stage.evaluate((el) => (el as HTMLElement).blur())
  for (let i = 0; i < 40 && !(await stage.evaluate((el) => el === document.activeElement)); i++) {
    await page.keyboard.press("Tab")
  }
  await expect(stage).toBeFocused()
  const study = await stage.evaluate((el) => ({
    focusVisible: el.matches(":focus-visible"),
    shadow: getComputedStyle(el).boxShadow,
    outline: getComputedStyle(el).outlineStyle,
    card: getComputedStyle(el.querySelector(".flip-face.front")!).boxShadow,
  }))
  expect(study.focusVisible, JSON.stringify(study)).toBe(true)
  expect(study.shadow, JSON.stringify(study)).toBe("none")
  expect(study.outline, JSON.stringify(study)).toBe("none")
  expect(study.card, JSON.stringify(study)).toMatch(/6px 6px 0px/)

  // Quiz: start with the keyboard; the app moves focus to the stage.
  await page.goto("/quizzes?deck=d2")
  await page.getByRole("button", { name: "Type the answer" }).click()
  const start = page.getByRole("button", { name: "Start quiz" })
  await start.focus()
  await page.keyboard.press("Enter")
  const quiz = page.locator(".quiz-stage")
  await expect(quiz).toBeFocused()
  const quizRing = await quiz.evaluate((el) => ({
    shadow: getComputedStyle(el).boxShadow,
    outline: getComputedStyle(el).outlineStyle,
  }))
  expect(quizRing.shadow, JSON.stringify(quizRing)).toBe("none")
  expect(quizRing.outline, JSON.stringify(quizRing)).toBe("none")
})

for (const theme of ["light", "dark"] as const) {
  test(`a main navigation link has a solid ink focus ring (${theme})`, async ({ page }, info) => {
    try {
      await setThemeMode(page, SEEDED.demo.email, theme)
      await loginAndWait(page, SEEDED.demo.email)
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme)
      await settle(page)
      // Desktop and tablet use the sidebar; phones use the bottom tab bar.
      const link =
        info.project.name === "phone"
          ? page.getByRole("navigation", { name: "Main navigation" }).getByRole("link", { name: "Notes" })
          : page.getByRole("complementary", { name: "Main navigation" }).getByRole("link", { name: "Settings" })
      await expectFocusRing(link)
    } finally {
      await setThemeMode(page, SEEDED.demo.email, "light")
    }
  })
}

test("with no saved color, Settings shows Teal picked (not Red) and saving keeps Teal", async ({ page }) => {
  const account = SEEDED.lee // orange by default; share-report uses that, so it is put back below
  const orange = themeColors.find((swatch) => swatch.name === "Orange")!.value
  try {
    await setProfileTheme(page, account.email, { theme_mode: "light" })
    await clearProfileColor(page, account.email)
    await loginAndWait(page, account.email)
    await page.goto("/settings")
    await settle(page)
    await expect.poll(() => accentOf(page)).toBe(DEFAULT_ACCENT)

    const colors = page.locator('[aria-label="Theme colors"]')
    await expect(colors.getByRole("button", { name: "Teal" })).toHaveAttribute("aria-pressed", "true")
    await expect(colors.getByRole("button", { name: "Red" })).toHaveAttribute("aria-pressed", "false")

    // Saving without touching anything keeps Teal.
    await page.getByRole("button", { name: "Save theme" }).click()
    await expect(page.getByText("Theme saved.")).toBeVisible()
    await page.reload()
    await settle(page)
    await expect(colors.getByRole("button", { name: "Teal" })).toHaveAttribute("aria-pressed", "true")
    await expect.poll(() => accentOf(page)).toBe(DEFAULT_ACCENT)
  } finally {
    await setProfileTheme(page, account.email, { theme_mode: "light", theme_color: orange })
  }
})

// ------------------------------------------------------- Light / Dark / Automatic
/** Every localStorage key on this page that holds a saved theme. */
const themeCacheKeys = (page: Page) =>
  page.evaluate(() => Object.keys(window.localStorage).filter((key) => key.startsWith("luma.theme:")))

test("Settings has a Theme radio group with Light, Dark and Automatic, and the choice survives a reload", async ({ page }) => {
  try {
    await setThemeMode(page, SEEDED.demo.email, "light")
    await loginAndWait(page, SEEDED.demo.email)
    await page.goto("/settings")
    await settle(page)

    const group = page.getByRole("radiogroup", { name: "Theme" })
    await expect(group.getByRole("radio")).toHaveCount(3)
    const light = group.getByRole("radio", { name: "Light", exact: true })
    const dark = group.getByRole("radio", { name: "Dark", exact: true })
    const auto = group.getByRole("radio", { name: "Automatic", exact: true })
    await expect(light).toBeChecked()
    await expect(dark).not.toBeChecked()
    await expect(auto).not.toBeChecked()
    await expect(light).toHaveAccessibleDescription("Cream paper all day.")
    await expect(dark).toHaveAccessibleDescription("Easy on your eyes at night.")
    await expect(auto).toHaveAccessibleDescription(/^Light in the day, dark from 7\spm to 7\sam\.$/)

    // Each choice has a tiny page drawn in its own theme's colors.
    const previewOf = (value: string) => group.locator(`label.mode-option:has(input[value="${value}"]) .mode-preview`)
    await expect(previewOf("light")).toHaveCSS("background-color", "rgb(251, 246, 236)") // light --paper #fbf6ec
    await expect(previewOf("dark")).toHaveCSS("background-color", "rgb(21, 20, 15)") // dark --paper #15140f
    // Automatic shows both halves.
    await expect(previewOf("auto").locator('[data-theme="light"]')).toHaveCSS("background-color", "rgb(251, 246, 236)")
    await expect(previewOf("auto").locator('[data-theme="dark"]')).toHaveCSS("background-color", "rgb(21, 20, 15)")

    // The checked radio takes keyboard focus with a round ink ring (a 20 x 20 box, not a tall oval).
    await expectFocusRing(light)
    const box = await light.boundingBox()
    expect(box, "the Light radio has a box").not.toBeNull()
    expect(Math.round(box!.width)).toBe(20)
    expect(Math.round(box!.height)).toBe(20)
    await expect(light).toHaveCSS("border-radius", "50%")

    // Picking only changes the form; the page changes when the theme is saved.
    await expect(page.getByText(/^Right now:/)).toHaveCount(0)
    await auto.check()
    await expect(auto).toBeChecked()
    await expect(page.getByText(/^Right now: (light|dark)\.$/)).toBeVisible()
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light")

    await dark.check()
    await expect(page.getByText(/^Right now:/)).toHaveCount(0)
    await page.getByRole("button", { name: "Save theme" }).click()
    await expect(page.getByText("Theme saved.")).toBeVisible()
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark")

    await page.reload()
    await settle(page)
    await expect(dark).toBeChecked()
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark")

    // Automatic saves too (the fake API keeps "auto" like the real one).
    await auto.check()
    await page.getByRole("button", { name: "Save theme" }).click()
    await expect(page.getByText("Theme saved.")).toBeVisible()
    await page.reload()
    await settle(page)
    await expect(auto).toBeChecked()
    await expect(page.getByText(/^Right now: (light|dark)\.$/)).toBeVisible()
  } finally {
    await setThemeMode(page, SEEDED.demo.email, "light")
  }
})

test("the saved theme only takes Light, Dark or Automatic, and a turned-away save changes nothing", async ({ page }) => {
  try {
    const signIn = await page.request.post(`${API}/login`, { data: { email: SEEDED.demo.email, password: PASSWORD } })
    expect(signIn.ok()).toBeTruthy()
    const { access_token } = (await signIn.json()) as { access_token: string }
    const headers = { authorization: `Bearer ${access_token}` }
    const savedMode = async () => {
      const me = await page.request.get(`${API}/me/profile`, { headers })
      expect(me.ok()).toBeTruthy()
      return ((await me.json()) as { theme_mode: string | null }).theme_mode
    }

    for (const mode of ["light", "dark", "auto"] as const) {
      const put = await page.request.put(`${API}/me/profile`, { data: { theme_mode: mode }, headers })
      expect(put.status(), mode).toBe(200)
      expect(await savedMode()).toBe(mode)
    }

    for (const bad of ["purple", "", "Dark", 1]) {
      const put = await page.request.put(`${API}/me/profile`, { data: { theme_mode: bad, theme_color: "#7c3aed" }, headers })
      expect(put.status(), String(bad)).toBe(422)
    }
    expect(await savedMode()).toBe("auto")

    // The app still opens on the saved choice.
    await loginAndWait(page, SEEDED.demo.email)
    await page.goto("/settings")
    await settle(page)
    await expect(page.getByRole("radiogroup", { name: "Theme" }).getByRole("radio", { name: "Automatic", exact: true })).toBeChecked()
    // The other fields in a turned-away save were not kept either.
    await expect.poll(() => accentOf(page)).toBe(DEFAULT_ACCENT)
  } finally {
    await setProfileTheme(page, SEEDED.demo.email, { theme_mode: "light", theme_color: DEFAULT_ACCENT })
  }
})

test("a student on Dark never sees the light page on reload, even while the profile is slow", async ({ page }) => {
  try {
    await setThemeMode(page, SEEDED.demo.email, "dark")
    await loginAndWait(page, SEEDED.demo.email)
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark")
    // The app keeps a copy on this device for the next load.
    await expect.poll(() => themeCacheKeys(page)).toEqual(["luma.theme:u1"])

    // Record the theme when the HTML is ready, and every change after that.
    await page.addInitScript(() => {
      const log: string[] = []
      ;(window as unknown as { __themeLog: string[] }).__themeLog = log
      const now = () => document.documentElement.dataset.theme ?? "none"
      document.addEventListener("DOMContentLoaded", () => log.push(`ready:${now()}`))
      new MutationObserver(() => log.push(`change:${now()}`)).observe(document.documentElement, {
        attributes: true,
        attributeFilter: ["data-theme"],
      })
    })
    // The profile (which also says "dark") takes 2 seconds to come back.
    let profileAnswered = false
    await page.route("**/me/profile", async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 2000))
      await route.continue()
      profileAnswered = true
    })

    await page.reload({ waitUntil: "domcontentloaded" })
    // While the profile is still on its way, the page is already dark.
    await expect(page.locator("#root")).not.toBeEmpty()
    const early = await page.evaluate(() => ({
      theme: document.documentElement.dataset.theme ?? "none",
      bar: document.querySelector('meta[name="theme-color"]')?.getAttribute("content"),
    }))
    expect(profileAnswered, "checked before the profile came back").toBe(false)
    expect(early).toEqual({ theme: "dark", bar: "#15140f" })
    await expect.poll(() => profileAnswered, { timeout: 10_000 }).toBe(true)
    await expect(page.getByRole("heading", { level: 1 }).first()).toBeVisible()
    await page.waitForLoadState("networkidle")
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark")

    const log = await page.evaluate(() => (window as unknown as { __themeLog: string[] }).__themeLog)
    expect(log[0], JSON.stringify(log)).toBe("ready:dark")
    expect(
      log.filter((entry) => !entry.endsWith(":dark")),
      JSON.stringify(log),
    ).toEqual([])
  } finally {
    await page.unroute("**/me/profile")
    await setThemeMode(page, SEEDED.demo.email, "light")
  }
})

/** Records, on every animation frame, the page path, the theme and whether the app is drawn. */
async function recordFrames(page: Page) {
  await page.addInitScript(() => {
    const frames: Array<{ path: string; theme: string; app: boolean }> = []
    ;(window as unknown as { __frames: typeof frames }).__frames = frames
    const tick = () => {
      frames.push({
        path: location.pathname,
        theme: document.documentElement.dataset.theme ?? "none",
        app: Boolean(document.querySelector(".app-shell")),
      })
      requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  })
}

const framesOf = (page: Page) =>
  page.evaluate(() => (window as unknown as { __frames: Array<{ path: string; theme: string; app: boolean }> }).__frames)

test("a student on Dark sees the dashboard dark from the first frame after logging in, even while the profile is slow", async ({ page }) => {
  try {
    await setThemeMode(page, SEEDED.demo.email, "dark")
    // A fresh device: no theme saved here yet (signing out removes it too).
    await recordFrames(page)
    await page.route("**/me/profile", async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 2000))
      await route.continue()
    })
    await page.goto("/login")
    expect(await themeCacheKeys(page)).toEqual([])
    await page.getByLabel("Email").fill(SEEDED.demo.email)
    await page.getByLabel("Password", { exact: true }).fill(PASSWORD)
    await page.getByRole("button", { name: /^log in$/i }).click()
    await expect(page).toHaveURL(/\/dashboard/, { timeout: 15_000 })
    await expect(page.getByRole("heading", { level: 1 }).first()).toBeVisible()
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark")

    const drawn = (await framesOf(page)).filter((frame) => frame.path.startsWith("/dashboard") && frame.app)
    expect(drawn.length, "the dashboard was drawn").toBeGreaterThan(0)
    expect(
      drawn.filter((frame) => frame.theme !== "dark"),
      "dashboard frames that were not dark",
    ).toEqual([])
  } finally {
    await page.unroute("**/me/profile")
    await setThemeMode(page, SEEDED.demo.email, "light")
  }
})

test("a signed-in student on Dark who opens the home page never sees it light", async ({ page }) => {
  try {
    await setThemeMode(page, SEEDED.demo.email, "dark")
    await loginAndWait(page, SEEDED.demo.email)
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark")
    await expect.poll(() => themeCacheKeys(page)).toEqual(["luma.theme:u1"])

    await page.addInitScript(() => {
      const log: string[] = []
      ;(window as unknown as { __themeLog: string[] }).__themeLog = log
      const now = () => document.documentElement.dataset.theme ?? "none"
      document.addEventListener("DOMContentLoaded", () => log.push(`ready:${now()}`))
      new MutationObserver(() => log.push(`change:${now()}`)).observe(document.documentElement, {
        attributes: true,
        attributeFilter: ["data-theme"],
      })
    })
    await page.route("**/me/profile", async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 1000))
      await route.continue()
    })

    await page.goto("/", { waitUntil: "domcontentloaded" })
    await expect(page).toHaveURL(/\/dashboard/)
    await expect(page.getByRole("heading", { level: 1 }).first()).toBeVisible()
    await page.waitForLoadState("networkidle")
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark")

    const log = await page.evaluate(() => (window as unknown as { __themeLog: string[] }).__themeLog)
    expect(log[0], JSON.stringify(log)).toBe("ready:dark")
    expect(
      log.filter((entry) => !entry.endsWith(":dark")),
      JSON.stringify(log),
    ).toEqual([])
  } finally {
    await page.unroute("**/me/profile")
    await setThemeMode(page, SEEDED.demo.email, "light")
  }
})

test.describe("Automatic by the clock (Chicago time)", () => {
  test.use({ timezoneId: "America/Chicago" })

  test("at 6:59:30 pm it turns dark a minute later without a reload", async ({ page }) => {
    try {
      await setThemeMode(page, SEEDED.demo.email, "auto")
      await page.clock.install({ time: new Date("2026-11-16T18:59:30-06:00") })
      await loginAndWait(page, SEEDED.demo.email)
      await expect(page.locator("html")).toHaveAttribute("data-theme", "light")
      await page.clock.runFor(60_000)
      await expect(page.locator("html")).toHaveAttribute("data-theme", "dark")
      await expect(page).toHaveURL(/\/dashboard/)
      await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute("content", "#15140f")
    } finally {
      await setThemeMode(page, SEEDED.demo.email, "light")
    }
  })

  test("while studying, the 7 pm switch waits for the next page", async ({ page }) => {
    try {
      await setThemeMode(page, SEEDED.demo.email, "auto")
      await page.clock.install({ time: new Date("2026-11-16T18:59:30-06:00") })
      await loginAndWait(page, SEEDED.demo.email)
      await page.goto("/flashcards/d1/study")
      await page.getByRole("button", { name: "Start", exact: true }).click()
      await expect(page.locator(".study-stage")).toBeVisible()
      await expect(page.locator("html")).toHaveAttribute("data-theme", "light")

      await page.clock.runFor(60_000)
      // Still light: colors don't jump in the middle of a review.
      await page.waitForTimeout(500)
      await expect(page.locator("html")).toHaveAttribute("data-theme", "light")

      // Leaving the study page catches up with the clock.
      await page.getByRole("link", { name: "Luma" }).filter({ visible: true }).first().click()
      await expect(page).not.toHaveURL(/\/study$/)
      await expect(page.locator("html")).toHaveAttribute("data-theme", "dark")
    } finally {
      await setThemeMode(page, SEEDED.demo.email, "light")
    }
  })
})

test("another tab of the same account follows a saved theme without a reload", async ({ context }) => {
  const tabA = await context.newPage()
  try {
    await setThemeMode(tabA, SEEDED.demo.email, "light")
    await loginAndWait(tabA, SEEDED.demo.email)
    const tabB = await context.newPage()
    await tabB.goto("/dashboard")
    await expect(tabB.locator("html")).toHaveAttribute("data-theme", "light")

    await tabA.goto("/settings")
    await settle(tabA)
    await tabA.getByRole("radiogroup", { name: "Theme" }).getByRole("radio", { name: "Dark", exact: true }).check()
    await tabA.getByRole("button", { name: "Save theme" }).click()
    await expect(tabA.getByText("Theme saved.")).toBeVisible()
    await expect(tabA.locator("html")).toHaveAttribute("data-theme", "dark")
    await expect(tabB.locator("html")).toHaveAttribute("data-theme", "dark")
  } finally {
    await setThemeMode(tabA, SEEDED.demo.email, "light")
  }
})

test("signing out removes the saved theme from this device, and the public pages stay light", async ({ page }) => {
  try {
    await setThemeMode(page, SEEDED.demo.email, "dark")
    await setThemeMode(page, SEEDED.sam.email, "dark")

    // One account: "Sign out of <name>".
    await loginAndWait(page, SEEDED.demo.email)
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark")
    await expect.poll(() => themeCacheKeys(page)).toEqual(["luma.theme:u1"])
    await page.getByRole("button", { name: /^Accounts/ }).filter({ visible: true }).first().click()
    await page
      .getByRole("dialog", { name: "Accounts" })
      .getByRole("button", { name: `Sign out of ${SEEDED.demo.username}` })
      .click()
    await expect(page).toHaveURL(/\/$|\/login/)
    expect(await themeCacheKeys(page)).toEqual([])
    await expect(page.locator("html")).not.toHaveAttribute("data-theme", /.+/)

    // Two accounts: "Sign out of all accounts".
    await loginAndWait(page, SEEDED.demo.email)
    await page.goto("/login?add=1")
    await page.getByLabel("Email").fill(SEEDED.sam.email)
    await page.getByLabel("Password", { exact: true }).fill(PASSWORD)
    await page.getByRole("button", { name: "Add account" }).click()
    await expect(page).toHaveURL(/\/dashboard/)
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark")
    await expect
      .poll(() => themeCacheKeys(page).then((keys) => keys.sort()))
      .toEqual(["luma.theme:u1", "luma.theme:u2"])

    await page.getByRole("button", { name: /^Accounts/ }).filter({ visible: true }).first().click()
    const menu = page.getByRole("dialog", { name: "Accounts" })
    await menu.getByRole("button", { name: "Sign out of all accounts" }).click()
    await menu.getByRole("button", { name: "Sign out all" }).click()
    await expect(page).toHaveURL(/\/$|\/login/)
    expect(await themeCacheKeys(page)).toEqual([])

    // The log in page has no theme, even after a reload.
    await page.goto("/login")
    await expect(page.getByRole("heading", { level: 1, name: "Log in" })).toBeVisible()
    await expect(page.locator("html")).not.toHaveAttribute("data-theme", /.+/)
  } finally {
    await setThemeMode(page, SEEDED.demo.email, "light")
    await setThemeMode(page, SEEDED.sam.email, "light")
  }
})
