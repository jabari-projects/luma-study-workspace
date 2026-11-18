// Typing while Luma gets ready for a break (draining), and saving after the break, against
// the FAKE API (dev/mock-api.mjs), which follows the same rules as backend/app/maintenance.py:
// - an editor that opened before the drain still saves in the grace time, and its saves carry
//   the X-Luma-Edit-Session header from when it opened;
// - an editor opened after the drain began says "New work can't start right now." and its
//   save is refused with the words kept;
// - after the grace time, the open editor's save shows the break message and keeps the words;
// - words held during a break reach the server after Luma reopens, with no typing needed.
// Made-up accounts and text only.
import { expect, test, type Page } from "@playwright/test"

import { SEEDED, loginAndWait } from "./helpers"
import { apiCreate, apiGet, countRequests, saveLine, uniqueTitle } from "./work-helpers"
import { expectNoTechnicalText, minutesFromNow, nudgeFocusCheck, phaseBody, resetMaintenance, setMaintenance } from "./maintenance-helpers"

const notesBox = (page: Page) => page.getByRole("textbox", { name: "Your notes" })
const BREAK_LINE = "Luma is taking a short break. Your words are kept in this tab."

test.beforeEach(async ({ page }) => {
  await resetMaintenance(page)
})

test.afterEach(async ({ page }) => {
  await resetMaintenance(page)
})

/**
 * Opens a saved note's editor and waits until it has its edit-session token. Returns every
 * token the fake API issued to this page (in development React may open the editor twice).
 */
async function openEditor(page: Page, title: string, content = "SYNTH start.") {
  const note = await apiCreate(page, SEEDED.demo.email, "notes", { title, content, tags: [] })
  const tokens: string[] = []
  page.on("response", async (response) => {
    if (response.url().endsWith("/maintenance/edit-session") && response.request().method() === "POST" && response.ok()) {
      tokens.push(((await response.json()) as { token: string }).token)
    }
  })
  await page.goto(`/notes/${note.id}/edit`)
  await expect(notesBox(page)).toHaveValue(content)
  await expect.poll(() => tokens.length).toBeGreaterThan(0)
  await page.waitForLoadState("networkidle")
  return { id: note.id, tokens }
}

test("an editor opened before the drain still saves in the grace time, with its edit-session header", async ({ page }, info) => {
  await loginAndWait(page, SEEDED.demo.email)
  const { id, tokens } = await openEditor(page, uniqueTitle("Drain save", info))

  await setMaintenance(page, phaseBody("draining"))
  const puts = countRequests(page, (r) => r.method() === "PUT" && r.url().endsWith(`/notes/${id}`))
  await notesBox(page).fill("SYNTH start. Finished in the grace time.")
  await expect(saveLine(page)).toHaveText(/^Saved at \d{1,2}:\d{2}/)
  expect(puts.count).toBe(1)
  const sent = puts.requests[0].headers()["x-luma-edit-session"]
  expect(sent, "the save carries the editor's edit-session token").toBeTruthy()
  expect(tokens).toContain(sent)

  const { body } = await apiGet(page, SEEDED.demo.email, `/notes/${id}`)
  expect(body).toMatchObject({ content: "SYNTH start. Finished in the grace time.", version: 2 })
  // The drain notice shows, and the page never shows technical words.
  await expect(page.getByText("Luma is getting ready for a short break").first()).toBeVisible()
  await expectNoTechnicalText(page)
})

test("an editor opened after the drain began can't start new work, and keeps the words", async ({ page }, info) => {
  await loginAndWait(page, SEEDED.demo.email)
  const note = await apiCreate(page, SEEDED.demo.email, "notes", { title: uniqueTitle("Late editor", info), content: "SYNTH saved.", tags: [] })
  await setMaintenance(page, phaseBody("draining"))
  await page.goto(`/notes/${note.id}/edit`)
  await expect(notesBox(page)).toHaveValue("SYNTH saved.")
  await expect(page.getByText("New work can't start right now.")).toBeVisible()

  const puts = countRequests(page, (r) => r.method() === "PUT" && r.url().endsWith(`/notes/${note.id}`))
  await notesBox(page).fill("SYNTH saved. Typed too late.")
  await expect(saveLine(page)).toHaveText(BREAK_LINE)
  expect(puts.count).toBeGreaterThanOrEqual(1)
  expect(puts.requests[0].headers()["x-luma-edit-session"]).toBeUndefined()
  await expect(notesBox(page)).toHaveValue("SYNTH saved. Typed too late.")
  const { body } = await apiGet(page, SEEDED.demo.email, `/notes/${note.id}`)
  expect(body).toMatchObject({ content: "SYNTH saved.", version: 1 }) // the server refused it
  await expectNoTechnicalText(page)
})

test("after the grace time the open editor shows the break message and keeps the words", async ({ page }, info) => {
  await loginAndWait(page, SEEDED.demo.email)
  const { id } = await openEditor(page, uniqueTitle("After grace", info))
  await setMaintenance(page, { ...phaseBody("draining"), grace_ends_at: minutesFromNow(-1) })
  await notesBox(page).fill("SYNTH start. Typed after the grace time.")
  await expect(saveLine(page)).toHaveText(BREAK_LINE)
  await expect(page.getByRole("button", { name: "Try again" })).toBeVisible()
  await expect(notesBox(page)).toHaveValue("SYNTH start. Typed after the grace time.")
  const { body } = await apiGet(page, SEEDED.demo.email, `/notes/${id}`)
  expect(body).toMatchObject({ content: "SYNTH start.", version: 1 })
  await expectNoTechnicalText(page)
})

test("words held during a break reach the server after Luma reopens, with no typing", async ({ page }, info) => {
  await page.clock.install()
  await loginAndWait(page, SEEDED.demo.email)
  const { id } = await openEditor(page, uniqueTitle("Held words", info))

  await setMaintenance(page, phaseBody("active"))
  const puts = countRequests(page, (r) => r.method() === "PUT" && r.url().endsWith(`/notes/${id}`))
  await notesBox(page).fill("SYNTH start. Written during the break.")
  await page.clock.runFor(2_500) // the autosave wait
  await expect(saveLine(page)).toHaveText(BREAK_LINE)
  expect(puts.count).toBe(1)
  await expect(notesBox(page)).toHaveValue("SYNTH start. Written during the break.")
  // (The server can't be read during the break; the version check after reopening proves only
  // one save landed.)

  // Luma reopens. The tab learns it on focus (no polling), and the held save goes once.
  await setMaintenance(page, { phase: "none", reopened_at: minutesFromNow(0) })
  await nudgeFocusCheck(page)
  await expect(saveLine(page)).toHaveText(/^Saved at \d{1,2}:\d{2}/)
  expect(puts.count).toBe(2)
  const { body } = await apiGet(page, SEEDED.demo.email, `/notes/${id}`)
  expect(body).toMatchObject({ content: "SYNTH start. Written during the break.", version: 2 })
  await expect(notesBox(page)).toHaveValue("SYNTH start. Written during the break.")
})
