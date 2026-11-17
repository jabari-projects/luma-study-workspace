// Theme checks against the FAKE API (dev/mock-api.mjs): every accent color is
// readable in light and dark, the dark page is not tinted by the accent, focus
// rings are solid ink, and a profile with no saved color shows Teal.
// Made-up accounts only; each test puts back the colors it changes.
import AxeBuilder from "@axe-core/playwright"
import { expect, test, type Page, type TestInfo } from "@playwright/test"

import { DEFAULT_ACCENT, themeColors } from "../src/ui/themeColors"
import { SEEDED, expectFocusRing, loginAndWait, setProfileTheme, setThemeMode } from "./helpers"

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
          ? page.getByRole("navigation", { name: "Main navigation" }).getByRole("link", { name: "Me" })
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
    await setProfileTheme(page, account.email, { theme_mode: "light", theme_color: null })
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

test("the Settings theme preview shows the picked mode in its own colors", async ({ page }) => {
  try {
    await setThemeMode(page, SEEDED.demo.email, "light")
    await loginAndWait(page, SEEDED.demo.email)
    await page.goto("/settings")
    await settle(page)
    const preview = page.locator(".theme-preview")
    await expect(preview).toHaveAttribute("data-theme", "light")
    const lightBg = await preview.evaluate((el) => getComputedStyle(el).backgroundColor)
    await page.getByRole("button", { name: "Dark", exact: true }).click()
    await expect(preview).toHaveAttribute("data-theme", "dark")
    // Only the preview changes; the page stays light until the theme is saved.
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light")
    await expect(preview).toHaveCSS("background-color", "rgb(33, 31, 25)") // dark --card #211f19
    expect(lightBg).toBe("rgb(255, 253, 248)") // light --card #fffdf8
  } finally {
    await setThemeMode(page, SEEDED.demo.email, "light")
  }
})
