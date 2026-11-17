// Shared helpers for the browser tests. Everything talks to the FAKE API only.
import AxeBuilder from "@axe-core/playwright"
import { expect, type Page, type TestInfo } from "@playwright/test"

export const API = `http://127.0.0.1:${process.env.E2E_API_PORT || 8788}`
export const PASSWORD = "demo-password"

/** Seeded fake accounts (see dev/mock-api.mjs). */
export const SEEDED = {
  demo: { email: "demo@luma.test", username: "jabari" },
  sam: { email: "second@luma.test", username: "sam" },
  lee: { email: "third@luma.test", username: "lee" },
  unverified: { email: "unverified@luma.test", username: "new_student" },
}

let counter = 0
/** A made-up address that is unique for this run (never a real inbox). */
export function fakeEmail(label: string, info: TestInfo): string {
  counter += 1
  return `${label}-${info.project.name}-${Date.now().toString(36)}-${counter}@example.test`
}

/** Newest fake email of a kind for an address (codes and reset links). */
export async function latestMail(page: Page, email: string, kind: "code" | "reset") {
  let found: { code?: string; link?: string } | undefined
  await expect
    .poll(async () => {
      const response = await page.request.get(`${API}/__test/outbox?email=${encodeURIComponent(email)}`)
      const { messages } = (await response.json()) as { messages: Array<{ kind: string; code?: string; link?: string }> }
      found = [...messages].reverse().find((m) => m.kind === kind)
      return Boolean(found)
    })
    .toBe(true)
  return found!
}

export async function login(page: Page, email: string, password = PASSWORD) {
  await page.goto("/login")
  await page.getByLabel("Email").fill(email)
  await page.getByLabel("Password", { exact: true }).fill(password)
  await page.getByRole("button", { name: /^log in$/i }).click()
}

export async function loginAndWait(page: Page, email: string, password = PASSWORD) {
  await login(page, email, password)
  await expect(page).toHaveURL(/\/dashboard/)
}

/** Runs axe (WCAG 2.0/2.1/2.2 A and AA) and fails on serious or critical problems. */
export async function expectNoSeriousA11yIssues(page: Page, label: string, info: TestInfo) {
  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze()
  const serious = results.violations.filter((v) => v.impact === "serious" || v.impact === "critical")
  if (results.violations.length) {
    await info.attach(`axe-${label}.json`, {
      body: JSON.stringify(results.violations.map((v) => ({ id: v.id, impact: v.impact, help: v.help, nodes: v.nodes.map((n) => n.target) })), null, 2),
      contentType: "application/json",
    })
  }
  expect(serious.map((v) => `${v.id}: ${v.help} (${v.nodes.length})`), `axe on ${label}`).toEqual([])
}
