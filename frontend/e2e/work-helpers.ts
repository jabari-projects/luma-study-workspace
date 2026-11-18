// Helpers for the student-work browser tests (saving, drafts, conflicts, retries).
// Everything talks to the FAKE API (dev/mock-api.mjs) and its local-only /__test hooks.
import { expect } from "@playwright/test"
import type { Page, Request, TestInfo } from "@playwright/test"

import { API, PASSWORD, fakeEmail, latestMail } from "./helpers"

/** A token for this fake account, straight from the fake API. */
export async function apiToken(page: Page, email: string, password = PASSWORD): Promise<string> {
  const res = await page.request.post(`${API}/login`, { data: { email, password } })
  expect(res.ok()).toBeTruthy()
  return ((await res.json()) as { access_token: string }).access_token
}

type Kind = "notes" | "summaries" | "flashcards" | "study-sessions"

export async function apiCreate(page: Page, email: string, kind: Kind, data: Record<string, unknown>) {
  const token = await apiToken(page, email)
  const res = await page.request.post(`${API}/${kind}`, { data, headers: { authorization: `Bearer ${token}` } })
  expect(res.status()).toBe(201)
  return (await res.json()) as { id: string; version: number } & Record<string, unknown>
}

export async function apiGet(page: Page, email: string, path: string) {
  const token = await apiToken(page, email)
  const res = await page.request.get(`${API}${path}`, { headers: { authorization: `Bearer ${token}` } })
  return { status: res.status(), body: res.ok() ? await res.json() : null }
}

export async function apiDelete(page: Page, email: string, path: string) {
  const token = await apiToken(page, email)
  const res = await page.request.delete(`${API}${path}`, { headers: { authorization: `Bearer ${token}` } })
  expect(res.ok()).toBeTruthy()
}

/** The next `times` saves to `path` wait `ms` first. */
export async function slowNext(page: Page, path: string, ms: number, times = 1) {
  expect((await page.request.post(`${API}/__test/slow`, { data: { path, ms, times } })).ok()).toBeTruthy()
}

/** The next `times` saves to `path` fail: a 500, or the connection is cut before or after the save. */
export async function failNext(page: Page, path: string, mode: "500" | "drop-after-commit" | "drop-before-commit", times = 1) {
  expect((await page.request.post(`${API}/__test/fail`, { data: { path, mode, times } })).ok()).toBeTruthy()
}

/** Another tab or device saves this item (its version goes up). */
export async function editElsewhere(page: Page, kind: Kind, id: string, fields: Record<string, unknown>) {
  expect((await page.request.post(`${API}/__test/edit-elsewhere`, { data: { kind, id, fields } })).ok()).toBeTruthy()
}

/** Ends every sign-in of this fake account, like a password reset elsewhere. */
export async function expireSignIns(page: Page, email: string) {
  expect((await page.request.post(`${API}/__test/expire`, { data: { email } })).ok()).toBeTruthy()
}

/** Signs up a brand-new made-up account (fake email code) and waits until it is in. */
export async function signUpFresh(page: Page, info: TestInfo, label = "work") {
  const email = fakeEmail(label, info)
  const username = `w${Date.now().toString(36)}${info.project.name.slice(0, 2)}${Math.floor(Math.random() * 1000)}`
  await page.goto("/signup")
  await page.getByLabel("Email").fill(email)
  await page.getByLabel("Username").fill(username)
  await page.getByLabel("Password", { exact: true }).fill(PASSWORD)
  await page.getByRole("button", { name: /create|sign up|make/i }).click()
  await expect(page).toHaveURL(/\/verify-email/)
  const { code } = await latestMail(page, email, "code")
  await page.getByLabel(/code/i).fill(code!)
  await page.getByRole("button", { name: /check|verify|confirm/i }).click()
  await expect(page).not.toHaveURL(/\/verify-email/)
  return { email, username }
}

/** The save line under an editor. */
export const saveLine = (page: Page) => page.locator(".save-status-text")

/** Counts the requests that match, from now on. */
export function countRequests(page: Page, match: (request: Request) => boolean) {
  const seen: Request[] = []
  const listener = (request: Request) => {
    if (match(request)) seen.push(request)
  }
  page.on("request", listener)
  return {
    get count() {
      return seen.length
    },
    get requests() {
      return seen
    },
    stop: () => page.off("request", listener),
  }
}

/** True when leaving the page now would show the browser's "Leave site?" warning. */
export async function warnsBeforeLeaving(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const event = new Event("beforeunload", { cancelable: true })
    window.dispatchEvent(event)
    return event.defaultPrevented
  })
}

/** This tab's draft keys (sessionStorage) and any draft-looking keys left on the device (localStorage). */
export async function draftKeys(page: Page) {
  return page.evaluate(() => ({
    tab: Object.keys(window.sessionStorage).filter((key) => key.startsWith("luma.draft:")).sort(),
    device: Object.keys(window.localStorage).filter((key) => /draft/i.test(key)).sort(),
  }))
}

/** A unique made-up title, so tests on shared fake accounts never clash. */
export const uniqueTitle = (label: string, info: TestInfo) =>
  `${label} ${info.project.name} ${Date.now().toString(36)}${Math.floor(Math.random() * 1000)}`
