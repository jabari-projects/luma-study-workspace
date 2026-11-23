// The release before this one kept an unsaved new note on the device (localStorage
// "luma.noteDraft:<account id>") and told the student "Draft saved on this device." The new
// site must give those words back, never delete them unseen.
// FAKE API only (dev/mock-api.mjs); the draft text is made up.
import { expect, test } from "@playwright/test"
import type { Page } from "@playwright/test"

import { SEEDED, loginAndWait } from "./helpers"
import { draftKeys } from "./work-helpers"

const OLD_KEY = "luma.noteDraft:u1"
const OLD_DRAFT = { title: "SYNTH cell biology", content: "SYNTH mitochondria make energy for the cell.", tags: "bio, cells" }
const OFFER = /We found a note you did not save on this device/
const notesBox = (page: Page) => page.getByRole("textbox", { name: "Your notes" })

async function seedOldDraft(page: Page, key = OLD_KEY) {
  await page.evaluate(([k, v]) => window.localStorage.setItem(k, v), [key, JSON.stringify(OLD_DRAFT)] as const)
}

const hasKey = (page: Page, key: string) => page.evaluate((k) => window.localStorage.getItem(k) !== null, key)

test("an old device draft survives page loads and comes back on New note", async ({ page }) => {
  await loginAndWait(page, SEEDED.demo.email)
  await seedOldDraft(page)
  // Loading the new site (as after the deploy) keeps it.
  await page.goto("/notes")
  expect(await hasKey(page, OLD_KEY)).toBe(true)
  await page.getByRole("region", { name: "Note you did not save" }).getByRole("link", { name: "Open it" }).click()
  await expect(page).toHaveURL(/\/notes\/new$/)
  await expect(page.getByText(OFFER)).toBeVisible()
  // Reloading before choosing still keeps it.
  await page.reload()
  await expect(page.getByText(OFFER)).toBeVisible()
  expect(await hasKey(page, OLD_KEY)).toBe(true)

  await page.getByRole("button", { name: "Use them" }).click()
  await expect(page.getByLabel("Title")).toHaveValue(OLD_DRAFT.title)
  await expect(notesBox(page)).toHaveValue(OLD_DRAFT.content)
  await expect(page.getByLabel("Tags")).toHaveValue(OLD_DRAFT.tags)
  // It is in this tab's draft now, and the device copy stays until the note is saved.
  await expect.poll(async () => (await draftKeys(page)).tab).toEqual(["luma.draft:v1:u1:note:new"])
  await expect(page.getByText(OFFER)).toHaveCount(0)
  expect(await hasKey(page, OLD_KEY)).toBe(true)

  await page.getByRole("button", { name: "Save note" }).click()
  await expect(page).toHaveURL(/\/notes\/[^/]+\/edit$/)
  await expect(notesBox(page)).toHaveValue(OLD_DRAFT.content)
  expect(await hasKey(page, OLD_KEY)).toBe(false)
})

test("an offer that is ignored is never removed by saving another note", async ({ page }) => {
  await loginAndWait(page, SEEDED.demo.email)
  await seedOldDraft(page)
  await page.goto("/notes/new")
  await expect(page.getByText(OFFER)).toBeVisible()
  await page.getByLabel("Title").fill("SYNTH a different note")
  await notesBox(page).fill("SYNTH words that are not the old draft")
  await page.getByRole("button", { name: "Save note" }).click()
  await expect(page).toHaveURL(/\/notes\/[^/]+\/edit$/)
  expect(await hasKey(page, OLD_KEY)).toBe(true)
  await page.goto("/notes/new")
  await expect(page.getByText(OFFER)).toBeVisible()
})

test("throwing an old device draft away removes it; other accounts' drafts never show", async ({ page }) => {
  await loginAndWait(page, SEEDED.demo.email)
  await seedOldDraft(page)
  // A draft of an account that is not on this device is removed on the next load.
  await seedOldDraft(page, "luma.noteDraft:not-on-this-device")
  await page.goto("/notes/new")
  expect(await hasKey(page, "luma.noteDraft:not-on-this-device")).toBe(false)
  await expect(page.getByText(OFFER)).toBeVisible()
  await page.getByRole("button", { name: "Throw them away" }).click()
  await expect(page.getByText(OFFER)).toHaveCount(0)
  await expect(notesBox(page)).toHaveValue("")
  expect(await hasKey(page, OLD_KEY)).toBe(false)
  await page.goto("/notes")
  await expect(page.getByRole("region", { name: "Note you did not save" })).toHaveCount(0)
})

test("signing out removes the account's old device draft", async ({ page }) => {
  await loginAndWait(page, SEEDED.demo.email)
  await seedOldDraft(page)
  await page.getByRole("button", { name: /^Accounts/ }).click()
  const menu = page.getByRole("dialog", { name: "Accounts" })
  await menu.getByRole("button", { name: `Sign out of ${SEEDED.demo.username}` }).click()
  await expect.poll(() => hasKey(page, OLD_KEY)).toBe(false)
})
