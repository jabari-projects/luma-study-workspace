// Helpers for the maintenance browser tests. They only talk to the FAKE API's local test
// hooks (dev/mock-api.mjs). Nothing here reaches a real server.
import { expect, type Page } from "@playwright/test"

import { API } from "./helpers"

/** The fake maintenance admin (dev/mock-api.mjs). Made-up address. */
export const MAINT_ADMIN = { email: "admin@example.test", username: "luma_admin" }

export type FakePhase = "none" | "announced" | "draining" | "active" | "checking"

export async function setMaintenance(page: Page, body: Record<string, unknown>) {
  const response = await page.request.post(`${API}/__test/maintenance`, { data: body })
  expect(response.ok()).toBeTruthy()
  return response.json()
}

export async function setRunningJobs(page: Page, count: number) {
  const response = await page.request.post(`${API}/__test/maintenance/jobs`, { data: { count } })
  expect(response.ok()).toBeTruthy()
}

export async function resetMaintenance(page: Page) {
  await setMaintenance(page, { phase: "none" })
  await setRunningJobs(page, 0)
}

export const minutesFromNow = (minutes: number) => new Date(Date.now() + minutes * 60_000).toISOString()

/** A break a couple of days ahead, in each phase. */
export function phaseBody(phase: FakePhase): Record<string, unknown> {
  const later = { start_at: minutesFromNow(2 * 24 * 60), estimated_end_at: minutesFromNow(2 * 24 * 60 + 60), reason: "website_update" }
  switch (phase) {
    case "none":
      return { phase }
    case "announced":
      return { phase, ...later }
    case "draining":
      return { phase, start_at: minutesFromNow(15), estimated_end_at: minutesFromNow(75), drain_started_at: minutesFromNow(0), grace_ends_at: minutesFromNow(10), reason: "website_update" }
    default:
      return { phase, start_at: minutesFromNow(-5), estimated_end_at: minutesFromNow(55), reason: "database_update" }
  }
}

/** A Chicago wall-clock value for a datetime-local field, `days` from now at hh:mm. */
export function centralInput(days: number, hhmm: string): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone: "America/Chicago", year: "numeric", month: "2-digit", day: "2-digit" })
      .formatToParts(new Date(Date.now() + days * 86_400_000))
      .map((p) => [p.type, p.value]),
  )
  return `${parts.year}-${parts.month}-${parts.day}T${hhmm}`
}

/**
 * The app checks the break again on focus once a minute has passed (no polling). With the
 * page clock installed, jump a minute ahead and send a focus event.
 */
export async function nudgeFocusCheck(page: Page) {
  await page.clock.fastForward(61_000)
  await page.evaluate(() => window.dispatchEvent(new Event("focus")))
}

/** The things no page may ever show (section 0 of the design). */
export async function expectNoTechnicalText(page: Page) {
  const text = await page.locator("body").innerText()
  for (const bad of [API, "127.0.0.1", "localhost:", "HTTP 5", "status code", "Error:", "503"]) {
    expect(text, `page shows "${bad}"`).not.toContain(bad)
  }
}
