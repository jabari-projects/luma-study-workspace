// Network loss and sign-in trouble never throw away the words on screen:
// offline waits and saves when back; an ended sign-in keeps the page and signs in again in
// place; a sign-out in another tab keeps the page while work isn't saved.
// FAKE API only (dev/mock-api.mjs); fresh made-up accounts for anything that ends sign-ins.
import { expect, test } from "@playwright/test"
import type { Page } from "@playwright/test"

import { PASSWORD, SEEDED, loginAndWait } from "./helpers"
import { apiCreate, apiGet, expireSignIns, failNext, saveLine, signUpFresh, uniqueTitle } from "./work-helpers"

const notesBox = (page: Page) => page.getByRole("textbox", { name: "Your notes" })

async function openEditor(page: Page, email: string, title: string) {
  const note = await apiCreate(page, email, "notes", { title, content: "SYNTH start.", tags: [] })
  await page.goto(`/notes/${note.id}/edit`)
  await expect(notesBox(page)).toHaveValue("SYNTH start.")
  return note.id
}

test("offline: says so, keeps the words, and saves when the browser is back online", async ({ page, context }, info) => {
  await loginAndWait(page, SEEDED.demo.email)
  const id = await openEditor(page, SEEDED.demo.email, uniqueTitle("Offline", info))
  await context.setOffline(true)
  try {
    await notesBox(page).fill("SYNTH typed while offline")
    await expect(saveLine(page)).toHaveText("You're offline. We'll save when you're back.")
    await expect(notesBox(page)).toHaveValue("SYNTH typed while offline")
    await expect(page).toHaveURL(new RegExp(`/notes/${id}/edit$`))
  } finally {
    await context.setOffline(false)
  }
  await expect(saveLine(page)).toHaveText(/^Saved at/, { timeout: 10_000 })
  const { body } = await apiGet(page, SEEDED.demo.email, `/notes/${id}`)
  expect(body.content).toBe("SYNTH typed while offline")
})

test("an ended sign-in keeps the editor open, signs in again in place, and the save goes through", async ({ page }, info) => {
  const { email } = await signUpFresh(page, info, "expired")
  const id = await openEditor(page, email, uniqueTitle("Expired", info))
  await expireSignIns(page, email)

  await notesBox(page).fill("SYNTH typed after the sign-in ended")
  const box = page.getByRole("dialog", { name: "Sign in again to save" })
  await expect(box).toBeVisible({ timeout: 10_000 })
  await expect(box).toContainText("Your work is still here.")
  // No redirect to the login page, and the words are still on screen.
  await expect(page).toHaveURL(new RegExp(`/notes/${id}/edit$`))
  await expect(notesBox(page)).toHaveValue("SYNTH typed after the sign-in ended")
  await expect(saveLine(page)).toHaveText("Sign in again to save.")
  // The email is fixed to this account.
  await expect(box.getByLabel("Email")).toHaveValue(email)
  await expect(box.getByLabel("Email")).toHaveAttribute("readonly", "")

  await box.getByLabel("Password", { exact: true }).fill("not-the-password")
  await box.getByRole("button", { name: "Sign in" }).click()
  await expect(box.getByRole("alert")).toBeVisible()
  await expect(box).toBeVisible()

  await box.getByLabel("Password", { exact: true }).fill(PASSWORD)
  await box.getByRole("button", { name: "Sign in" }).click()
  await expect(box).toBeHidden()
  await expect(saveLine(page)).toHaveText(/^Saved at/, { timeout: 10_000 })
  await expect(page).toHaveURL(new RegExp(`/notes/${id}/edit$`))
  const { body } = await apiGet(page, email, `/notes/${id}`)
  expect(body.content).toBe("SYNTH typed after the sign-in ended")
})

test("with nothing unsaved, an ended sign-in still goes to the login page like before", async ({ page }, info) => {
  const { email } = await signUpFresh(page, info, "expired-clean")
  await openEditor(page, email, uniqueTitle("Clean", info))
  await expireSignIns(page, email)
  await page.reload()
  await expect(page).toHaveURL(/\/login\?redirect=/)
})

test("signed out in another tab with unsaved work: the page stays, Copy my text, then sign in and save", async ({ context }, info) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"])
  const tabA = await context.newPage()
  const { email, username } = await signUpFresh(tabA, info, "elsewhere")
  const id = await openEditor(tabA, email, uniqueTitle("Elsewhere", info))
  // The first save fails, so this tab has unsaved work when the other tab signs out.
  await failNext(tabA, `/notes/${id}`, "500")
  await notesBox(tabA).fill("SYNTH words from tab A")
  await expect(saveLine(tabA)).toHaveText("Couldn't save. Your words are still here.")

  const tabB = await context.newPage()
  await tabB.goto("/dashboard")
  await tabB.getByRole("button", { name: /^Accounts/ }).click()
  await tabB.getByRole("dialog", { name: "Accounts" }).getByRole("button", { name: `Sign out of ${username}` }).click()
  await expect(tabB).not.toHaveURL(/\/dashboard/)

  const box = tabA.getByRole("dialog", { name: "You signed out in another tab" })
  await expect(box).toBeVisible()
  await expect(box).toContainText("Sign in again to save this, or copy your text.")
  await expect(tabA).toHaveURL(new RegExp(`/notes/${id}/edit$`))
  await expect(notesBox(tabA)).toHaveValue("SYNTH words from tab A")

  await box.getByRole("button", { name: "Copy my text" }).click()
  await expect(box.getByText("Copied. You can paste it anywhere.")).toBeVisible()
  expect(await tabA.evaluate(() => navigator.clipboard.readText())).toContain("SYNTH words from tab A")

  await box.getByLabel("Password", { exact: true }).fill(PASSWORD)
  await box.getByRole("button", { name: "Sign in" }).click()
  await expect(box).toBeHidden()
  // The save that waited for this sign-in goes out by itself (or with one tap on Try again).
  const tryAgain = tabA.getByRole("button", { name: "Try again" })
  if (await tryAgain.isVisible()) await tryAgain.click()
  await expect(saveLine(tabA)).toHaveText(/^Saved at/)
  const { body } = await apiGet(tabA, email, `/notes/${id}`)
  expect(body.content).toBe("SYNTH words from tab A")
})

test("signed out in another tab: Throw it away lets the tab show the signed-out notice", async ({ context }, info) => {
  const tabA = await context.newPage()
  const { email, username } = await signUpFresh(tabA, info, "throwaway")
  const id = await openEditor(tabA, email, uniqueTitle("Throw away", info))
  await failNext(tabA, `/notes/${id}`, "500")
  await notesBox(tabA).fill("SYNTH words to throw away")
  await expect(saveLine(tabA)).toHaveText("Couldn't save. Your words are still here.")

  const tabB = await context.newPage()
  await tabB.goto("/dashboard")
  await tabB.getByRole("button", { name: /^Accounts/ }).click()
  await tabB.getByRole("dialog", { name: "Accounts" }).getByRole("button", { name: `Sign out of ${username}` }).click()

  const box = tabA.getByRole("dialog", { name: "You signed out in another tab" })
  await box.getByRole("button", { name: "Throw it away" }).click()
  await box.getByRole("group", { name: "Throw your work away?" }).getByRole("button", { name: "Throw it away" }).click()
  await expect(tabA.getByRole("heading", { level: 1, name: "Signed out" })).toBeVisible()
  expect(await tabA.evaluate(() => Object.keys(window.sessionStorage).filter((key) => key.startsWith("luma.draft:")))).toEqual([])
})
