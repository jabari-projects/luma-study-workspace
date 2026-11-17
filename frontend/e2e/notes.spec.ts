// Notes: making notes from pasted text, Voice to Notes (with a fake sound file,
// no microphone), Image to Notes, saved notes at /notes/:id, summaries, and the
// phone "Create something" (+) sheet. Everything runs against the FAKE API.
import { expect, test } from "@playwright/test"
import type { Page } from "@playwright/test"

import AxeBuilder from "@axe-core/playwright"
import type { TestInfo } from "@playwright/test"

import { SEEDED, loginAndWait } from "./helpers"

/**
 * Same rules as helpers.expectNoSeriousA11yIssues, but can leave out parts that
 * have their own test below, so the rest of the page is still checked:
 * - ".identity": the sidebar account button (see "account button name" test)
 * - ".mini-card-face": draft card buttons (see "draft card buttons" test)
 */
async function expectNoSeriousA11yIssues(page: Page, label: string, info: TestInfo, exclude: string[] = [".identity"]) {
  let builder = new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
  for (const selector of exclude) builder = builder.exclude(selector)
  const results = await builder.analyze()
  const serious = results.violations.filter((v) => v.impact === "serious" || v.impact === "critical")
  if (results.violations.length) {
    await info.attach(`axe-${label}.json`, {
      body: JSON.stringify(results.violations.map((v) => ({ id: v.id, impact: v.impact, help: v.help, nodes: v.nodes.map((n) => n.target) })), null, 2),
      contentType: "application/json",
    })
  }
  expect(serious.map((v) => `${v.id}: ${v.help} (${v.nodes.length})`), `axe on ${label}`).toEqual([])
}

const LESSON =
  "Plants make their own food using sunlight. They take in water through their roots and carbon dioxide from the air. " +
  "Inside the leaves, chloroplasts use light energy to turn these into sugar and oxygen."

/** The page's own heading (h1), so the sidebar and sheets don't get in the way. */
const pageTitle = (page: Page) => page.getByRole("heading", { level: 1 })

/** A few made-up bytes that look like a sound file. The fake API never reads them. */
const fakeAudio = { name: "class-recording.mp3", mimeType: "audio/mpeg", buffer: Buffer.from("ID3 fake audio bytes for a test") }

test.describe("making notes", () => {
  test.beforeEach(async ({ page }) => {
    await loginAndWait(page, SEEDED.demo.email)
  })

  test("import: paste text, check the words, make notes, save, and open the note", async ({ page }, info) => {
    await page.goto("/import")
    await expect(pageTitle(page)).toContainText("Make it notes")
    await expect(page.getByRole("tab", { name: "Paste text" })).toHaveAttribute("aria-selected", "true")
    await expectNoSeriousA11yIssues(page, "import", info)

    const pad = page.getByRole("textbox", { name: "Your words" })
    const useWords = page.getByRole("button", { name: "Use these words" })
    await expect(useWords).toBeDisabled()
    await pad.fill(LESSON)
    await useWords.click()

    const found = page.getByRole("region", { name: "What we found" })
    await expect(found).toBeVisible()
    await expect(found.getByText("Pasted text")).toBeVisible()
    await expect(found.getByText(/\d+ words/)).toBeVisible()
    await found.getByRole("button", { name: "Make my notes" }).click()

    // Waiting steps, then the draft workbench.
    const title = page.getByRole("textbox", { name: "Name your notes" })
    await expect(title).toBeVisible({ timeout: 15_000 })
    await expect(title).toHaveValue("How Plants Make Food")
    await expect(title).toBeFocused()
    await expect(page.getByRole("textbox", { name: "Your notes (you can change them)" })).toHaveValue(/photosynthesis/)
    await expect(page.getByText("Keeping 5 of 5")).toBeVisible()
    await expectNoSeriousA11yIssues(page, "import-draft", info, [".identity", ".mini-card-face"])

    // Students can change the draft before saving.
    const myTitle = `Plants test ${info.project.name} ${Date.now().toString(36)}`
    await title.fill(myTitle)
    await page.getByRole("button", { name: "Toss" }).first().click()
    await expect(page.getByText("Keeping 4 of 5")).toBeVisible()

    await page.getByRole("button", { name: "Save note" }).click()
    await expect(page).toHaveURL(/\/notes\/[0-9a-f-]{36}$/)
    await expect(pageTitle(page)).toHaveText(myTitle)
    await expect(page.getByText(/^Note · Private/)).toBeVisible()
    const sheet = page.getByRole("article", { name: myTitle })
    await expect(sheet.getByRole("heading", { name: "What is photosynthesis?" })).toBeVisible()
    await expect(sheet.getByText(/Source: Pasted text/)).toBeVisible()
    await expect(page.getByRole("link", { name: "All notes" })).toHaveAttribute("href", "/notes")
    await expectNoSeriousA11yIssues(page, "note-page", info)

    // It survives a reload (it really was saved, not just kept in memory).
    await page.reload()
    await expect(pageTitle(page)).toHaveText(myTitle)

    // And it shows up in the notes list with a View link back to it.
    const url = page.url()
    await page.goto("/notes")
    const card = page.locator("article.item-card", { hasText: myTitle })
    await expect(card).toBeVisible()
    await card.getByRole("link", { name: "View" }).click()
    await expect(page).toHaveURL(url)
  })

  test("import: too few words is refused with a clear message", async ({ page }) => {
    await page.goto("/import")
    await page.getByRole("textbox", { name: "Your words" }).fill("too short")
    await page.getByRole("button", { name: "Use these words" }).click()
    await expect(page.getByText("Paste a few more words first.")).toBeVisible()
    await expect(page.getByRole("region", { name: "What we found" })).toHaveCount(0)
  })

  test("import: source tabs work with arrow keys and ?from= picks a tab", async ({ page }) => {
    await page.goto("/import")
    await page.getByRole("tab", { name: "Paste text" }).focus()
    await page.keyboard.press("ArrowRight")
    const fileTab = page.getByRole("tab", { name: "Upload a file" })
    await expect(fileTab).toBeFocused()
    await expect(fileTab).toHaveAttribute("aria-selected", "true")
    await expect(page.getByRole("tabpanel")).toContainText("Drop a file here")
    await page.keyboard.press("ArrowLeft")
    await page.keyboard.press("ArrowLeft")
    await expect(page.getByRole("tab", { name: "YouTube" })).toBeFocused()
    await expect(page.getByRole("textbox", { name: "Video words" })).toBeVisible()

    await page.goto("/import?from=link")
    await expect(page.getByRole("tab", { name: "Web link" })).toHaveAttribute("aria-selected", "true")
    await expect(page.getByLabel("Paste a web page link")).toBeVisible()
  })

  test("import: draft 'Start over' asks first, then clears", async ({ page }) => {
    await page.goto("/import")
    await page.getByRole("textbox", { name: "Your words" }).fill(LESSON)
    await page.getByRole("button", { name: "Use these words" }).click()
    await page.getByRole("button", { name: "Make my notes" }).click()
    await expect(page.getByRole("textbox", { name: "Name your notes" })).toBeVisible({ timeout: 15_000 })
    await page.getByRole("button", { name: "Start over" }).click()
    await expect(page.getByText("Throw this away?")).toBeVisible()
    await page.getByRole("button", { name: "No", exact: true }).click()
    await expect(page.getByRole("textbox", { name: "Name your notes" })).toBeVisible()
    await page.getByRole("button", { name: "Start over" }).click()
    await page.getByRole("button", { name: "Yes", exact: true }).click()
    await expect(page.getByRole("textbox", { name: "Name your notes" })).toHaveCount(0)
    await expect(page.getByRole("textbox", { name: "Your words" })).toHaveValue("")
  })

  test("voice to notes: hint field, 'Check the words', fix them, then notes", async ({ page }, info) => {
    await page.goto("/voice-input")
    await expect(pageTitle(page)).toContainText("keep it")
    await expect(page.getByRole("button", { name: "Start recording" })).toBeVisible()
    await expectNoSeriousA11yIssues(page, "voice", info)

    // No microphone: pick a (fake) sound file instead.
    await page.getByLabel(/Or pick a sound file/).setInputFiles(fakeAudio)
    await expect(page.getByText(`File: ${fakeAudio.name}`)).toBeVisible()
    const hint = page.getByRole("textbox", { name: /Names or words to listen for/ })
    await expect(hint).toBeVisible()
    await expect(hint).toHaveAccessibleDescription("Helps Luma spell names and new words right.")
    await hint.fill("chloroplast, chlorophyll")

    // The hint goes with the sound; the student's file name does not. The upload
    // is read in the page (Playwright can't always see multipart bodies).
    await page.evaluate(() => {
      const w = window as unknown as { __sent?: string[] }
      w.__sent = []
      const send = XMLHttpRequest.prototype.send
      XMLHttpRequest.prototype.send = function (body?: Document | XMLHttpRequestBodyInit | null) {
        if (body instanceof FormData) {
          w.__sent!.push(JSON.stringify([...body.entries()].map(([k, v]) => [k, typeof v === "string" ? v : `file:${(v as File).name}`])))
        }
        return send.call(this, body)
      }
    })
    await page.getByRole("button", { name: "Turn it into words" }).click()
    const body = await page.evaluate(() => ((window as unknown as { __sent?: string[] }).__sent ?? []).join(" | "))
    expect(body).toContain("chloroplast, chlorophyll")
    expect(body).not.toContain(fakeAudio.name)
    expect(body).toContain("file:recording.mp3")

    await expect(page.getByRole("heading", { name: "Check the words" })).toBeVisible({ timeout: 15_000 })
    const heard = page.getByRole("textbox", { name: "What we heard" })
    await expect(heard).toHaveValue(/photosynthesis/)
    await expectNoSeriousA11yIssues(page, "voice-check-words", info)

    // Fix a word; the notes request must use the corrected words.
    const fixed = (await heard.inputValue()).replace("Today", "On Monday")
    await heard.fill(fixed)
    const notesRequest = page.waitForRequest((r) => r.url().endsWith("/api/notes-from-text"))
    await page.getByRole("button", { name: "Make my notes" }).click()
    expect((await notesRequest).postDataJSON()).toMatchObject({ text: fixed, source_kind: "audio" })

    await expect(page.getByRole("textbox", { name: "Name your notes" })).toBeVisible({ timeout: 15_000 })
    await expect(page.getByRole("button", { name: /Save \+ make deck \(5\)/ })).toBeEnabled()

    // Narrow layouts hide the source behind "Back to my audio"; wide ones keep it beside
    // the notes. Either way the heard words stay and can be fixed again.
    const back = page.getByRole("button", { name: "Back to my audio" })
    if (await back.isVisible()) {
      await back.click()
      await expect(page.getByRole("button", { name: "Back to my notes" })).toBeVisible()
    }
    await expect(page.getByRole("button", { name: "Fix the words and make new notes" })).toBeVisible()
  })

  test("voice to notes: empty words are not sent", async ({ page }) => {
    await page.goto("/voice-input")
    await page.getByLabel(/Or pick a sound file/).setInputFiles(fakeAudio)
    await page.getByRole("button", { name: "Turn it into words" }).click()
    const heard = page.getByRole("textbox", { name: "What we heard" })
    await expect(heard).toBeVisible({ timeout: 15_000 })
    await heard.fill("   ")
    let sent = false
    page.on("request", (r) => {
      if (r.url().endsWith("/api/notes-from-text")) sent = true
    })
    await page.getByRole("button", { name: "Make my notes" }).click()
    await expect(page.getByText(/There are no words to make notes from/)).toBeVisible()
    expect(sent).toBe(false)
  })

  test("image to notes page loads and asks for a picture first", async ({ page }, info) => {
    await page.goto("/image-to-notes")
    await expect(pageTitle(page)).toHaveText("Image to notes")
    const picker = page.getByLabel("Image")
    await expect(picker).toHaveAttribute("type", "file")
    await expect(picker).toHaveAttribute("accept", /image\/png/)
    await expect(page.getByText(/sends your picture to OpenAI/)).toBeVisible()
    await expectNoSeriousA11yIssues(page, "image-to-notes", info)

    await page.getByRole("button", { name: "Make notes" }).click()
    await expect(page.getByText("Choose an image first.")).toBeVisible()

    // Picking a picture shows its name (no AI call is made here).
    await picker.setInputFiles({ name: "worksheet.png", mimeType: "image/png", buffer: Buffer.from("89504e470d0a1a0a", "hex") })
    await expect(page.getByText("Selected: worksheet.png")).toBeVisible()
  })

  test("written note with 'question :: answer' lines opens at /notes/:id with cards", async ({ page }, info) => {
    await page.goto("/notes")
    await expect(pageTitle(page)).toHaveText("Notes")
    const myTitle = `Capitals ${info.project.name} ${Date.now().toString(36)}`
    await page.getByRole("textbox", { name: "Title" }).fill(myTitle)
    await page.getByRole("textbox", { name: "Content" }).fill("Capital of France :: Paris\nCapital of Japan :: Tokyo")
    await page.getByRole("button", { name: "Save" }).click()
    await expect(page).toHaveURL(/\/notes\/[0-9a-f-]{36}$/)
    await expect(pageTitle(page)).toHaveText(myTitle)
    await expect(page.getByText(/We found 2 cards in your note/)).toBeVisible()
    await expect(page.getByRole("button", { name: "Make a deck (2)" })).toBeEnabled()
    await page.getByRole("button", { name: /Keeping: Capital of France/ }).click()
    await expect(page.getByRole("button", { name: "Make a deck (1)" })).toBeEnabled()
  })

  test("a note that does not exist shows a friendly 'not found'", async ({ page }) => {
    await page.goto("/notes/00000000-0000-0000-0000-000000000000")
    await expect(pageTitle(page)).toHaveText("Note not found")
    await expect(page.getByText("Note not found", { exact: true }).last()).toBeVisible()
    await page.getByRole("link", { name: "Back" }).click()
    await expect(page).toHaveURL(/\/notes$/)
  })

  test("summaries page is reachable and a summary opens", async ({ page }, info) => {
    await page.goto("/summaries")
    await expect(pageTitle(page)).toHaveText("Summaries")
    await expect(page.getByRole("textbox", { name: "Title" })).toBeVisible()
    await expect(page.getByRole("textbox", { name: "Summary" })).toBeVisible()
    await expectNoSeriousA11yIssues(page, "summaries", info)
    // The fake API has one summary; its View link opens /summaries/:id.
    await page.getByRole("link", { name: "View" }).first().click()
    await expect(page).toHaveURL(/\/summaries\/[^/]+$/)
    await expect(page.getByText(/^Summary · /)).toBeVisible()
    await expect(page.getByRole("link", { name: "All summarys" })).toHaveAttribute("href", "/summaries")
  })

  // The sidebar and its + New menu (desktop and tablet) are tested in nav.spec.ts.
})

test.describe("phone + (Create something) sheet", () => {
  test.beforeEach(async ({ page }, info) => {
    test.skip(info.project.name !== "phone", "The + sheet is only on phone layouts.")
    await loginAndWait(page, SEEDED.demo.email)
  })

  const plus = (page: Page) => page.getByRole("navigation", { name: "Main navigation" }).getByRole("button", { name: "Create something" })
  const sheet = (page: Page) => page.getByRole("dialog", { name: "What do you want to make?" })

  test("opens, lists the creation tools, and closes with the X button", async ({ page }, info) => {
    await expect(plus(page)).toHaveAttribute("aria-expanded", "false")
    await plus(page).click()
    await expect(sheet(page)).toBeVisible()
    await expect(plus(page)).toHaveAttribute("aria-expanded", "true")
    await expect(sheet(page).getByRole("heading", { name: "What do you want to make?" })).toBeVisible()
    // Only things you make. Studying (quizzes, study plans) lives under Study.
    const links = sheet(page).getByRole("link")
    await expect(links).toHaveCount(5)
    const expected = [
      ["Write a note", "/notes"],
      ["Import a file or link", "/import"],
      ["Voice to notes", "/voice-input"],
      ["Image to notes", "/image-to-notes"],
      ["New flashcard deck", "/flashcards/new"],
    ] as const
    for (const [index, [name, href]] of expected.entries()) {
      await expect(links.nth(index)).toHaveAccessibleName(new RegExp(`^${name} `))
      await expect(links.nth(index)).toHaveAttribute("href", href)
    }
    await expect(sheet(page).getByRole("link", { name: /^(Quiz|Study plan|Summary)\b/ })).toHaveCount(0)
    await expectNoSeriousA11yIssues(page, "create-sheet", info)

    await sheet(page).getByRole("button", { name: "Close" }).click()
    await expect(sheet(page)).toHaveCount(0)
    await expect(plus(page)).toHaveAttribute("aria-expanded", "false")
  })

  test("Escape closes the sheet, and tapping a tool goes there and closes it", async ({ page }) => {
    await plus(page).click()
    await expect(sheet(page)).toBeVisible()
    await page.keyboard.press("Escape")
    await expect(sheet(page)).toHaveCount(0)

    await plus(page).click()
    await sheet(page).getByRole("link", { name: /^Import a file or link / }).click()
    await expect(page).toHaveURL(/\/import$/)
    await expect(sheet(page)).toHaveCount(0)
    await expect(pageTitle(page)).toContainText("Make it notes")

    // Tapping the dimmed backdrop also closes it.
    await plus(page).click()
    await expect(sheet(page)).toBeVisible()
    await page.mouse.click(187, 40)
    await expect(sheet(page)).toHaveCount(0)
  })

  test("focus moves into the sheet when it opens", async ({ page }) => {
    await plus(page).focus()
    await page.keyboard.press("Enter")
    await expect(sheet(page)).toBeVisible()
    await expect.poll(() => sheet(page).evaluate((el) => el.contains(document.activeElement))).toBe(true)
  })

  test("Tab stays inside the open sheet", async ({ page }) => {
    await plus(page).click()
    await expect(sheet(page)).toBeVisible()
    await sheet(page).getByRole("button", { name: "Close" }).focus()
    for (let i = 0; i < 12; i += 1) {
      await page.keyboard.press("Tab")
      expect(await sheet(page).evaluate((el) => el.contains(document.activeElement))).toBe(true)
    }
  })

  test("focus goes back to the + button after Escape", async ({ page }) => {
    await plus(page).focus()
    await page.keyboard.press("Enter")
    await expect(sheet(page)).toBeVisible()
    await sheet(page).getByRole("button", { name: "Close" }).focus()
    await page.keyboard.press("Escape")
    await expect(sheet(page)).toHaveCount(0)
    await expect(plus(page)).toBeFocused({ timeout: 2_000 })
  })
})

test.describe("accessible names", () => {
  test.beforeEach(async ({ page }) => {
    await loginAndWait(page, SEEDED.demo.email)
  })

  test("draft card buttons: accessible name includes the visible question", async ({ page }) => {
    await page.goto("/import")
    await page.getByRole("textbox", { name: "Your words" }).fill(LESSON)
    await page.getByRole("button", { name: "Use these words" }).click()
    await page.getByRole("button", { name: "Make my notes" }).click()
    await expect(page.getByRole("textbox", { name: "Name your notes" })).toBeVisible({ timeout: 15_000 })
    await expect(page.getByRole("button", { name: /What is photosynthesis\?/ })).toBeVisible({ timeout: 2_000 })
  })

  test("sidebar account button: accessible name includes its visible text", async ({ page }, info) => {
    test.skip(info.project.name !== "desktop", "Only the full desktop sidebar shows the name and plan text.")
    await page.goto("/notes")
    const results = await new AxeBuilder({ page }).include(".identity").withRules(["label-content-name-mismatch"]).analyze()
    expect(results.violations).toEqual([])
  })
})
