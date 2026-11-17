// Notes: the Notes hub (/notes) with its start links, tabs, "Find in my notes" and row
// menus; writing and changing a note; deleting with "are you sure?"; making notes from
// pasted text, Voice to notes (a fake sound file, no microphone) and Image to notes;
// saved notes at /notes/:id; summaries; old addresses that redirect; the draft kept on
// this device; and the phone "Create something" (+) sheet. Everything runs against the
// FAKE API. The seeded demo account is read; new notes always get a unique made-up title.
import { expect, test } from "@playwright/test"
import type { Page } from "@playwright/test"

import AxeBuilder from "@axe-core/playwright"
import type { TestInfo } from "@playwright/test"

import { API, PASSWORD, SEEDED, loginAndWait } from "./helpers"

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

/** A unique made-up title, so tests on the shared fake account never clash. */
const uniqueTitle = (label: string, info: TestInfo) =>
  `${label} ${info.project.name} ${Date.now().toString(36)}${Math.floor(Math.random() * 1000)}`

/** Saves a note or summary straight through the fake API for the demo account and returns its id. */
async function makeItem(page: Page, kind: "notes" | "summaries", title: string, content = "Leaves make food from light.") {
  const login = await page.request.post(`${API}/login`, { data: { email: SEEDED.demo.email, password: PASSWORD } })
  const { access_token } = (await login.json()) as { access_token: string }
  const res = await page.request.post(`${API}/${kind}`, {
    data: { title, content, tags: [] },
    headers: { authorization: `Bearer ${access_token}` },
  })
  expect(res.status()).toBe(201)
  return ((await res.json()) as { id: string }).id
}

/** The Notes hub row whose title link has this exact name. */
const hubRow = (page: Page, title: string) =>
  page.locator("li.note-row", { has: page.getByRole("link", { name: title, exact: true }) })

/** A few made-up bytes that look like a sound file. The fake API never reads them. */
const fakeAudio = { name: "class-recording.mp3", mimeType: "audio/mpeg", buffer: Buffer.from("ID3 fake audio bytes for a test") }

test.describe("making notes", () => {
  test.beforeEach(async ({ page }) => {
    await loginAndWait(page, SEEDED.demo.email)
  })

  test("import: paste text, check the words, make notes, save, and open the note", async ({ page }, info) => {
    await page.goto("/notes/import")
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
    const myTitle = uniqueTitle("Plants test", info)
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
    await expect(page.getByRole("link", { name: "Back to notes" })).toHaveAttribute("href", "/notes")
    await expectNoSeriousA11yIssues(page, "note-page", info)

    // It survives a reload (it really was saved, not just kept in memory).
    await page.reload()
    await expect(pageTitle(page)).toHaveText(myTitle)

    // And it shows up in the Notes hub as a row that opens it.
    const url = page.url()
    await page.goto("/notes")
    const row = hubRow(page, myTitle)
    await expect(row).toBeVisible()
    await expect(row.locator(".row-kind")).toHaveText("Note")
    await expect(row).toContainText(/Changed [A-Z][a-z]{2} \d{1,2}/)
    await row.getByRole("link", { name: myTitle, exact: true }).click()
    await expect(page).toHaveURL(url)
  })

  test("import: too few words is refused with a clear message", async ({ page }) => {
    await page.goto("/notes/import")
    await page.getByRole("textbox", { name: "Your words" }).fill("too short")
    await page.getByRole("button", { name: "Use these words" }).click()
    await expect(page.getByText("Paste a few more words first.")).toBeVisible()
    await expect(page.getByRole("region", { name: "What we found" })).toHaveCount(0)
  })

  test("import: source tabs work with arrow keys and ?from= picks a tab", async ({ page }) => {
    await page.goto("/notes/import")
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

    await page.goto("/notes/import?from=link")
    await expect(page.getByRole("tab", { name: "Web link" })).toHaveAttribute("aria-selected", "true")
    await expect(page.getByLabel("Paste a web page link")).toBeVisible()
  })

  test("import: draft 'Start over' asks first, then clears", async ({ page }) => {
    await page.goto("/notes/import")
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
    await page.goto("/notes/voice")
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
    await page.goto("/notes/voice")
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

  test("image to notes: asks for an image, makes notes, and saves them as a note", async ({ page }, info) => {
    await page.goto("/notes/image")
    await expect(pageTitle(page)).toHaveText("Image to notes")
    await expect(page.getByRole("link", { name: "Back to notes" })).toHaveAttribute("href", "/notes")
    const picker = page.getByLabel("Choose an image")
    await expect(picker).toHaveAttribute("type", "file")
    await expect(picker).toHaveAttribute("accept", /image\/png/)
    await expect(page.getByText(/sends your picture to OpenAI/)).toBeVisible()
    await expectNoSeriousA11yIssues(page, "image-to-notes", info)

    await page.getByRole("button", { name: "Make notes" }).click()
    await expect(page.getByText("Choose an image first.")).toBeVisible()

    // A made-up picture goes to the fake /api/generate-notes (no real AI call).
    await picker.setInputFiles({ name: "worksheet.png", mimeType: "image/png", buffer: Buffer.from("89504e470d0a1a0a", "hex") })
    await expect(page.getByText("Selected: worksheet.png")).toBeVisible()
    const request = page.waitForRequest((r) => r.url().endsWith("/api/generate-notes"))
    await page.getByRole("button", { name: "Make notes" }).click()
    expect((await request).postDataJSON().image).toMatch(/^data:image\/png;base64,/)

    const text = page.getByRole("textbox", { name: "Your notes (you can change them)" })
    await expect(text).toHaveValue(/Photosynthesis/, { timeout: 15_000 })
    const name = page.getByRole("textbox", { name: "Name your notes" })
    await expect(name).toHaveValue(/^Notes for [A-Z][a-z]{2} \d{1,2}$/)
    await expectNoSeriousA11yIssues(page, "image-to-notes-result", info)

    const myTitle = uniqueTitle("Photo notes", info)
    await name.fill(myTitle)
    await text.fill(`${await text.inputValue()}\nChecked by me.`)
    const saved = page.waitForRequest((r) => r.url() === `${API}/notes` && r.method() === "POST")
    await page.getByRole("button", { name: "Save as note" }).click()
    expect((await saved).postDataJSON()).toMatchObject({ title: myTitle, content: expect.stringContaining("Checked by me.") })
    await expect(page).toHaveURL(/\/notes\/[0-9a-f-]{36}$/)
    await expect(pageTitle(page)).toHaveText(myTitle)
    const sheet = page.getByRole("article", { name: myTitle })
    await expect(sheet).toContainText("Plants use sunlight to make food.")
    await expect(sheet).toContainText("Checked by me.")
  })

  test("Notes hub: four ways to start, then write a note with 'question :: answer' lines", async ({ page }, info) => {
    await page.goto("/notes")
    await expect(pageTitle(page)).toHaveText("Your notes")
    const start = page.getByRole("navigation", { name: "Start a note" })
    const links = start.getByRole("link")
    await expect(links).toHaveCount(4)
    const expected = [
      ["Write a note", "/notes/new"],
      ["Import a file or link", "/notes/import"],
      ["Voice to notes", "/notes/voice"],
      ["Image to notes", "/notes/image"],
    ] as const
    for (const [index, [name, href]] of expected.entries()) {
      await expect(links.nth(index)).toHaveAccessibleName(new RegExp(`^${name} `))
      await expect(links.nth(index)).toHaveAttribute("href", href)
    }
    if (info.project.name === "phone") {
      // Phones: each name sits centered next to its icon, and the hint is for screen readers only.
      const first = links.first()
      await expect(first).toHaveCSS("align-items", "center")
      const icon = await first.locator(".start-icon").boundingBox()
      const name = await first.locator("strong").boundingBox()
      expect(icon && name).toBeTruthy()
      expect(Math.abs(icon!.y + icon!.height / 2 - (name!.y + name!.height / 2))).toBeLessThan(3)
      await expect(first.locator("small")).toHaveCSS("position", "absolute")
    }
    await expect(page.getByRole("tab", { name: /^All/ })).toHaveAttribute("aria-selected", "true")
    await expectNoSeriousA11yIssues(page, "notes-hub", info)

    await start.getByRole("link", { name: /^Write a note / }).click()
    await expect(page).toHaveURL(/\/notes\/new$/)
    await expect(pageTitle(page)).toHaveText("Write a note")
    const title = page.getByRole("textbox", { name: "Title" })
    await expect(title).toHaveValue(/^Notes for [A-Z][a-z]{2} \d{1,2}$/)
    const body = page.getByRole("textbox", { name: "Your notes" })
    await expect(body).toHaveAttribute("placeholder", "Write your notes here.")
    await expect(page.getByText("on a line to make a flashcard.")).toBeVisible()
    await expectNoSeriousA11yIssues(page, "note-editor", info)

    // An empty note is not sent.
    await page.getByRole("button", { name: "Save note" }).click()
    await expect(page.getByText("Write something first.")).toBeVisible()
    await expect(page).toHaveURL(/\/notes\/new$/)

    const myTitle = uniqueTitle("Capitals", info)
    await title.fill(myTitle)
    await body.fill("Capital of France :: Paris\nCapital of Japan :: Tokyo")
    await expect(page.getByText("Draft saved on this device.")).toBeVisible()
    await page.getByRole("button", { name: "Save note" }).click()
    await expect(page).toHaveURL(/\/notes\/[0-9a-f-]{36}$/)
    await expect(pageTitle(page)).toHaveText(myTitle)
    await expect(page.getByText(/We found 2 cards in your note/)).toBeVisible()
    await expect(page.getByRole("button", { name: "Make a deck (2)" })).toBeEnabled()
    await page.getByRole("button", { name: /Keeping: Capital of France/ }).click()
    await expect(page.getByRole("button", { name: "Make a deck (1)" })).toBeEnabled()

    // Saved, so the draft is gone: a new note starts fresh.
    await page.goto("/notes/new")
    await expect(page.getByRole("textbox", { name: "Your notes" })).toHaveValue("")
    await expect(page.getByText("Draft saved on this device.")).toHaveCount(0)
  })

  test("edit a note: change the title and words, save, and the new title shows", async ({ page }, info) => {
    const oldTitle = uniqueTitle("Old title", info)
    const id = await makeItem(page, "notes", oldTitle, "Cells are tiny.")
    await page.goto(`/notes/${id}`)
    await expect(pageTitle(page)).toHaveText(oldTitle)
    await page.getByRole("link", { name: "Edit", exact: true }).click()
    await expect(page).toHaveURL(new RegExp(`/notes/${id}/edit$`))
    await expect(pageTitle(page)).toHaveText("Change your note")
    const title = page.getByRole("textbox", { name: "Title" })
    await expect(title).toHaveValue(oldTitle)
    await expect(page.getByRole("textbox", { name: "Your notes" })).toHaveValue("Cells are tiny.")
    await expectNoSeriousA11yIssues(page, "note-edit", info)

    // Cancel goes back without saving.
    await page.getByRole("link", { name: "Cancel" }).click()
    await expect(page).toHaveURL(new RegExp(`/notes/${id}$`))
    await page.getByRole("link", { name: "Edit", exact: true }).click()

    const newTitle = uniqueTitle("New title", info)
    await title.fill(newTitle)
    await page.getByRole("textbox", { name: "Your notes" }).fill("Cells are tiny.\nThey have a nucleus.")
    const sent = page.waitForRequest((r) => r.url().endsWith(`/notes/${id}`) && r.method() === "PUT")
    await page.getByRole("button", { name: "Save changes" }).click()
    expect((await sent).postDataJSON()).toMatchObject({ title: newTitle, content: "Cells are tiny.\nThey have a nucleus." })
    await expect(page).toHaveURL(new RegExp(`/notes/${id}$`))
    await expect(pageTitle(page)).toHaveText(newTitle)
    await expect(page.getByRole("article", { name: newTitle })).toContainText("They have a nucleus.")

    // The hub shows the new title, and the row's Edit opens the editor too.
    await page.goto("/notes")
    const row = hubRow(page, newTitle)
    await expect(row).toBeVisible()
    await expect(hubRow(page, oldTitle)).toHaveCount(0)
    await row.getByRole("button", { name: `More for ${newTitle}` }).click()
    await page.getByRole("menuitem", { name: "Edit" }).click()
    await expect(page).toHaveURL(new RegExp(`/notes/${id}/edit$`))
  })

  test("delete from the hub asks first: 'Keep it' keeps the row, 'Delete' removes it", async ({ page }, info) => {
    const myTitle = uniqueTitle("Throwaway", info)
    await makeItem(page, "notes", myTitle)
    await page.goto("/notes")
    const row = hubRow(page, myTitle)
    await expect(row).toBeVisible()

    // The row menu: Open, Edit, Delete. Escape closes it and puts focus back.
    const more = row.getByRole("button", { name: `More for ${myTitle}` })
    await expect(more).toHaveAttribute("aria-haspopup", "menu")
    await more.click()
    const menu = page.getByRole("menu", { name: `More for ${myTitle}` })
    await expect(menu.getByRole("menuitem")).toHaveText(["Open", "Edit", "Delete"])
    await expect(menu.getByRole("menuitem", { name: "Open" })).toBeFocused()
    await expectNoSeriousA11yIssues(page, "notes-row-menu", info)
    await page.keyboard.press("Escape")
    await expect(menu).toHaveCount(0)
    await expect(more).toBeFocused()

    await more.click()
    await menu.getByRole("menuitem", { name: "Delete" }).click()
    const dialog = page.getByRole("alertdialog", { name: `Delete “${myTitle}”?` })
    await expect(dialog).toBeVisible()
    await expect(dialog).toHaveAccessibleDescription("You can't get it back.")
    // Focus starts on the safe choice.
    await expect(dialog.getByRole("button", { name: "Keep it" })).toBeFocused()
    await expectNoSeriousA11yIssues(page, "notes-delete-dialog", info)
    await dialog.getByRole("button", { name: "Keep it" }).click()
    await expect(dialog).toHaveCount(0)
    await expect(row).toBeVisible()
    await expect(more).toBeFocused()

    // Escape also means "keep it".
    await more.click()
    await menu.getByRole("menuitem", { name: "Delete" }).click()
    await expect(dialog).toBeVisible()
    await page.keyboard.press("Escape")
    await expect(dialog).toHaveCount(0)
    await expect(row).toBeVisible()

    // Hold the delete for a moment: while it runs, both buttons are off and Tab stays in the box.
    let release = () => {}
    const held = new Promise<void>((resolve) => (release = resolve))
    await page.route(/\/notes\/[0-9a-f-]{36}$/, async (route) => {
      if (route.request().method() === "DELETE") await held
      await route.continue()
    })
    const sent = page.waitForRequest((r) => r.method() === "DELETE" && /\/notes\/[0-9a-f-]{36}$/.test(r.url()))
    await more.click()
    await menu.getByRole("menuitem", { name: "Delete" }).click()
    await dialog.getByRole("button", { name: "Delete", exact: true }).click()
    await sent
    await expect(dialog.getByRole("button", { name: "Deleting..." })).toBeDisabled()
    await expect(dialog).toBeFocused()
    await page.keyboard.press("Tab")
    expect(await dialog.evaluate((box) => box.contains(document.activeElement))).toBe(true)
    release()
    await expect(dialog).toHaveCount(0)
    await expect(row).toHaveCount(0)
    await expect(page.getByText(`Deleted “${myTitle}”.`)).toBeVisible()
    await page.reload()
    await expect(page.getByRole("tab", { name: /^All/ })).toBeVisible()
    await expect(page.getByRole("tabpanel")).not.toContainText(myTitle)
  })

  test("delete from the note page asks first, then goes back to the hub", async ({ page }, info) => {
    const myTitle = uniqueTitle("Page delete", info)
    const id = await makeItem(page, "notes", myTitle)
    await page.goto(`/notes/${id}`)
    await page.getByRole("button", { name: "Delete", exact: true }).click()
    const dialog = page.getByRole("alertdialog", { name: `Delete “${myTitle}”?` })
    await expect(dialog).toContainText("You can't get it back.")
    await dialog.getByRole("button", { name: "Keep it" }).click()
    await expect(dialog).toHaveCount(0)
    await expect(pageTitle(page)).toHaveText(myTitle)

    await page.getByRole("button", { name: "Delete", exact: true }).click()
    await dialog.getByRole("button", { name: "Delete", exact: true }).click()
    await expect(page).toHaveURL(/\/notes$/)
    await expect(page.getByText(`Deleted “${myTitle}”.`)).toBeVisible()
    await expect(hubRow(page, myTitle)).toHaveCount(0)
    await page.goto(`/notes/${id}`)
    await expect(pageTitle(page)).toHaveText("Note not found")
  })

  test("hub tabs and 'Find in my notes' narrow the list", async ({ page }, info) => {
    const word = `zebra${Date.now().toString(36)}`
    const noteTitle = uniqueTitle(`Find ${word}`, info)
    await makeItem(page, "notes", noteTitle)
    await page.goto("/notes")
    await expect(hubRow(page, noteTitle)).toBeVisible()
    await expect(hubRow(page, "The water cycle in short")).toBeVisible()

    // Tabs: arrow keys move between them and the address remembers the choice.
    const all = page.getByRole("tab", { name: /^All/ })
    await all.focus()
    await page.keyboard.press("ArrowRight")
    const notesTab = page.getByRole("tab", { name: /^Notes/ })
    await expect(notesTab).toBeFocused()
    await expect(notesTab).toHaveAttribute("aria-selected", "true")
    await expect(page).toHaveURL(/\/notes\?show=notes$/)
    await expect(hubRow(page, "The water cycle in short")).toHaveCount(0)
    await expect(hubRow(page, noteTitle)).toBeVisible()
    await page.keyboard.press("ArrowRight")
    await expect(page.getByRole("tab", { name: /^Summaries/ })).toHaveAttribute("aria-selected", "true")
    await expect(hubRow(page, "The water cycle in short")).toBeVisible()
    await expect(hubRow(page, noteTitle)).toHaveCount(0)
    await page.keyboard.press("Home")
    await expect(all).toHaveAttribute("aria-selected", "true")
    await expect(page).toHaveURL(/\/notes$/)

    const find = page.getByRole("searchbox", { name: "Find in my notes" })
    await find.fill(word.toUpperCase())
    await expect(page.locator("li.note-row")).toHaveCount(1)
    await expect(hubRow(page, noteTitle)).toBeVisible()
    await find.fill(`${word} nothing-like-this`)
    await expect(page.locator("li.note-row")).toHaveCount(0)
    await expect(page.getByRole("tabpanel")).toContainText(`Nothing matches “${word} nothing-like-this”.`)
  })

  test("if summaries don't load, the hub says so instead of 'No summaries yet'", async ({ page }) => {
    await page.route(`${API}/summaries`, (route) => route.fulfill({ status: 500, json: {} }))
    await page.goto("/notes?show=summaries")
    await expect(page.getByRole("alert")).toHaveText("We couldn't load your summaries. Try again in a moment.")
    const panel = page.getByRole("tabpanel")
    await expect(panel).toContainText("We couldn't load this list. Try again in a moment.")
    await expect(panel).not.toContainText("No summaries yet.")
    // Notes still show.
    await page.getByRole("tab", { name: /^Notes/ }).click()
    await expect(page.locator("li.note-row").first()).toBeVisible()
  })

  test("a summary with no title can still be changed and saved", async ({ page }, info) => {
    const id = await makeItem(page, "summaries", "", "Short words with no title.")
    await page.goto(`/summaries/${id}/edit`)
    await expect(pageTitle(page)).toHaveText("Change your summary")
    const words = page.getByRole("textbox", { name: "Your notes" })
    await expect(words).toHaveValue("Short words with no title.")
    const extra = uniqueTitle("Fixed", info)
    await words.fill(`Short words with no title. ${extra}`)
    const saved = page.waitForRequest((r) => r.url() === `${API}/summaries/${id}` && r.method() === "PUT")
    await page.getByRole("button", { name: "Save changes" }).click()
    expect((await saved).postDataJSON()).toMatchObject({ title: "", content: expect.stringContaining(extra) })
    await expect(page).toHaveURL(new RegExp(`/summaries/${id}$`))
    await expect(page.getByText(extra)).toBeVisible()
  })

  test("a note that does not exist shows a friendly 'not found'", async ({ page }) => {
    await page.goto("/notes/00000000-0000-0000-0000-000000000000")
    await expect(pageTitle(page)).toHaveText("Note not found")
    await expect(page.getByText("Note not found", { exact: true }).last()).toBeVisible()
    await page.getByRole("link", { name: "Back to notes" }).click()
    await expect(page).toHaveURL(/\/notes$/)
  })

  test("/summaries opens the hub's Summaries tab, and a summary opens and can be changed", async ({ page }, info) => {
    await page.goto("/summaries")
    await expect(page).toHaveURL(/\/notes\?show=summaries$/)
    await expect(pageTitle(page)).toHaveText("Your notes")
    await expect(page.getByRole("tab", { name: /^Summaries/ })).toHaveAttribute("aria-selected", "true")
    const row = hubRow(page, "The water cycle in short")
    await expect(row.locator(".row-kind")).toHaveText("Summary")
    await expect(row).toContainText("Water goes up as vapor")
    await expectNoSeriousA11yIssues(page, "summaries-tab", info)

    await row.getByRole("link", { name: "The water cycle in short" }).click()
    await expect(page).toHaveURL(/\/summaries\/[^/]+$/)
    await expect(page.getByText(/^Summary · /)).toBeVisible()
    await expect(page.getByRole("link", { name: "Back to notes" })).toHaveAttribute("href", "/notes?show=summaries")
    expect(await page.locator("body").innerText()).not.toMatch(/summarys/i)

    // A summary can be changed too (a made-up one, so the seeded one stays the same).
    const oldTitle = uniqueTitle("Short version", info)
    const id = await makeItem(page, "summaries", oldTitle, "Short words.")
    await page.goto(`/summaries/${id}`)
    await page.getByRole("link", { name: "Edit", exact: true }).click()
    await expect(page).toHaveURL(new RegExp(`/summaries/${id}/edit$`))
    await expect(pageTitle(page)).toHaveText("Change your summary")
    const newTitle = uniqueTitle("Shorter version", info)
    await page.getByRole("textbox", { name: "Title" }).fill(newTitle)
    await page.getByRole("button", { name: "Save changes" }).click()
    await expect(page).toHaveURL(new RegExp(`/summaries/${id}$`))
    await expect(pageTitle(page)).toHaveText(newTitle)
    await page.getByRole("link", { name: "Back to notes" }).click()
    await expect(page).toHaveURL(/\/notes\?show=summaries$/)
    await expect(hubRow(page, newTitle)).toBeVisible()
    expect(await page.locator("body").innerText()).not.toMatch(/summarys/i)
  })

  test("old addresses go to their new places inside Notes, keeping the ?query", async ({ page }) => {
    await page.goto("/import?from=link")
    await expect(page).toHaveURL(/\/notes\/import\?from=link$/)
    await expect(page.getByRole("tab", { name: "Web link" })).toHaveAttribute("aria-selected", "true")

    for (const [from, to] of [
      ["/voice-input", /\/notes\/voice$/],
      ["/audio-to-notes", /\/notes\/voice$/],
      ["/image-to-notes", /\/notes\/image$/],
      ["/notes/picture", /\/notes\/image$/],
      ["/summaries", /\/notes\?show=summaries$/],
    ] as const) {
      await page.goto(from)
      await expect(page).toHaveURL(to)
      await expect(pageTitle(page)).toBeVisible()
    }
    await expect(page.getByRole("tab", { name: /^Summaries/ })).toHaveAttribute("aria-selected", "true")
  })

  test("a new note's draft stays on this device, and signing out clears it", async ({ page }) => {
    await page.goto("/notes/new")
    const body = page.getByRole("textbox", { name: "Your notes" })
    await body.fill("Half a thought about volcanoes")
    await expect(page.getByText("Draft saved on this device.")).toBeVisible()
    const draftKeys = () =>
      page.evaluate(() => Object.keys(window.localStorage).filter((key) => key.startsWith("luma.noteDraft:")))
    expect(await draftKeys()).toEqual(["luma.noteDraft:u1"])

    // It comes back after a reload.
    await page.reload()
    await expect(page.getByRole("textbox", { name: "Your notes" })).toHaveValue("Half a thought about volcanoes")
    await expect(page.getByText("Draft saved on this device.")).toBeVisible()

    // Signing out asks first (the note is not saved yet), then forgets the draft.
    page.once("dialog", (dialog) => {
      expect(dialog.message()).toContain("Your work on this page is not saved yet.")
      void dialog.accept()
    })
    await page.getByRole("button", { name: /^Accounts/ }).click()
    await page
      .getByRole("dialog", { name: "Accounts" })
      .getByRole("button", { name: `Sign out of ${SEEDED.demo.username}` })
      .click()
    await expect(page).not.toHaveURL(/\/notes\/new/)
    await expect.poll(draftKeys).toEqual([])
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
      ["Write a note", "/notes/new"],
      ["Import a file or link", "/notes/import"],
      ["Voice to notes", "/notes/voice"],
      ["Image to notes", "/notes/image"],
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
    await expect(page).toHaveURL(/\/notes\/import$/)
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
    await page.goto("/notes/import")
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
