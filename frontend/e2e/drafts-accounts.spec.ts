// Drafts are private: kept only in this tab (sessionStorage), per account. Another account
// never sees them, another tab never sees them, and they are cleared on sign-out, sign-out of
// all accounts, and account deletion. Nothing is left in localStorage.
// FAKE API only (dev/mock-api.mjs).
import { expect, test } from "@playwright/test"
import type { Page } from "@playwright/test"

import { PASSWORD, SEEDED, loginAndWait } from "./helpers"
import { draftKeys, signUpFresh } from "./work-helpers"

const notesBox = (page: Page) => page.getByRole("textbox", { name: "Your notes" })
const OFFER = "You have changes from earlier in this tab."

async function startDraft(page: Page, words: string) {
  await page.goto("/notes/new")
  await notesBox(page).fill(words)
  await expect.poll(async () => (await draftKeys(page)).tab.length).toBeGreaterThan(0)
}

/** Leaves a page with unsaved work by a full load, accepting the browser's "Leave site?". */
async function goAway(page: Page, url: string) {
  page.once("dialog", (dialog) => void dialog.accept())
  await page.goto(url)
}

async function addAccount(page: Page, email: string) {
  await page.goto("/login?add=1")
  await page.getByLabel("Email").fill(email)
  await page.getByLabel("Password", { exact: true }).fill(PASSWORD)
  await page.getByRole("button", { name: "Add account" }).click()
  await expect(page).toHaveURL(/\/dashboard/)
}

async function switchTo(page: Page, email: RegExp) {
  await page.getByRole("button", { name: /^Accounts/ }).click()
  await page.getByRole("dialog", { name: "Accounts" }).getByRole("button", { name: email }).click()
  await expect(page).toHaveURL(/\/dashboard/)
}

test("a draft lives only in this tab, for its account, and never on the device", async ({ page, context }) => {
  await loginAndWait(page, SEEDED.demo.email)
  await startDraft(page, "SYNTH private draft of tab one")
  expect(await draftKeys(page)).toEqual({ tab: ["luma.draft:v1:u1:note:new"], device: [] })
  const raw = await page.evaluate(() => window.sessionStorage.getItem("luma.draft:v1:u1:note:new"))
  expect(JSON.parse(raw!)).toMatchObject({ v: 1, accountId: "u1", kind: "note", itemId: "new", baseVersion: null })
  expect(JSON.parse(raw!).createKey).toMatch(/^[0-9a-f-]{36}$/)

  // Another tab of the same account starts with nothing.
  const other = await context.newPage()
  await other.goto("/notes/new")
  await expect(notesBox(other)).toHaveValue("")
  await expect(other.getByText(OFFER)).toHaveCount(0)
  expect((await draftKeys(other)).tab).toEqual([])
})

test("another account in the same tab never sees the draft; it comes back for its own account", async ({ page }) => {
  await loginAndWait(page, SEEDED.demo.email)
  await addAccount(page, SEEDED.lee.email)
  // lee (u3) writes; then the tab switches to demo (u1).
  await startDraft(page, "SYNTH lee's words")
  await goAway(page, "/dashboard")
  await switchTo(page, /demo@luma\.test/)
  await page.goto("/notes/new")
  await expect(page.getByText(OFFER)).toHaveCount(0)
  await expect(notesBox(page)).toHaveValue("")
  expect((await draftKeys(page)).tab).toEqual(["luma.draft:v1:u3:note:new"])

  // Back on lee, the draft is offered again.
  await switchTo(page, /third@luma\.test/)
  await page.goto("/notes/new")
  await page.getByRole("button", { name: "Use them" }).click()
  await expect(notesBox(page)).toHaveValue("SYNTH lee's words")

  // Sign out of all accounts clears every draft in this tab.
  await page.getByRole("button", { name: /^Accounts/ }).click()
  const menu = page.getByRole("dialog", { name: "Accounts" })
  await menu.getByRole("button", { name: "Sign out of all accounts" }).click()
  await expect(menu.getByText("Signing out throws away work that isn't saved.")).toBeVisible()
  await menu.getByRole("button", { name: "Sign out all" }).click()
  await expect(page).toHaveURL(/\/$/)
  expect(await draftKeys(page)).toEqual({ tab: [], device: [] })
})

test("a draft saved under one account's key but naming another is never shown", async ({ page }) => {
  await loginAndWait(page, SEEDED.demo.email)
  await page.evaluate(() => {
    const now = Date.now()
    const forged = { v: 1, accountId: "u2", kind: "note", itemId: "new", baseVersion: null, savedAt: now, data: { title: "x", content: "SYNTH someone else's", tags: "" } }
    window.sessionStorage.setItem("luma.draft:v1:u1:note:new", JSON.stringify(forged))
    window.sessionStorage.setItem("luma.draft:v1:u2:note:new", JSON.stringify({ ...forged, accountId: "u2" }))
  })
  await page.goto("/notes/new")
  await expect(page.getByText(OFFER)).toHaveCount(0)
  await expect(notesBox(page)).toHaveValue("")
})

test("deleting the account clears its drafts from this tab", async ({ page }, info) => {
  await signUpFresh(page, info, "deldraft")
  await startDraft(page, "SYNTH words of an account about to be deleted")
  await goAway(page, "/settings")
  expect((await draftKeys(page)).tab).toHaveLength(1)
  const panel = page.getByRole("region", { name: "Delete account" }).filter({ has: page.locator("form.danger-zone") })
  await panel.scrollIntoViewIfNeeded()
  await panel.getByLabel("Type delete to confirm").fill("delete")
  await panel.getByLabel("Your password").fill(PASSWORD)
  await panel.getByRole("button", { name: "Delete my account" }).click()
  await expect(page).toHaveURL(/\/account-deleted$/)
  await expect.poll(async () => (await draftKeys(page)).tab).toEqual([])
})
