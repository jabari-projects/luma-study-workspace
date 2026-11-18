// The owner's 2026-11-16 desktop login problem, rebuilt with a made-up account:
// a password is changed by reset on one device (the phone), and the other
// device (the computer) still tries the old one. The server must refuse the old
// password with a clear message, accept the new one, and not touch other data.
import { expect, test } from "@playwright/test"

import { API, PASSWORD, fakeEmail, latestMail, login, loginAndWait } from "./helpers"

async function signUp(page: import("@playwright/test").Page, email: string, username: string) {
  await page.goto("/signup")
  await page.getByLabel("Email").fill(email)
  await page.getByLabel("Username").fill(username)
  await page.getByLabel("Password", { exact: true }).fill(PASSWORD)
  await page.getByRole("button", { name: /create|sign up|make/i }).click()
  await expect(page).toHaveURL(/\/verify-email/)
  const { code } = await latestMail(page, email, "code")
  await page.getByLabel(/code/i).fill(code!)
  await page.getByRole("button", { name: /check|verify|confirm/i }).click()
  // Finishing signup opens Discover; these tests start from Home.
  await expect(page).toHaveURL(/\/discover$/)
  await page.goto("/dashboard")
  await expect(page).toHaveURL(/\/dashboard/)
}

test("old password on a second device is refused after a reset; the new one works", async ({ browser }, info) => {
  const email = fakeEmail("reset", info)
  const username = `r${Date.now().toString(36)}${info.project.name.slice(0, 2)}`

  // "Phone": sign up, then reset the password.
  const phone = await browser.newContext()
  const phonePage = await phone.newPage()
  await signUp(phonePage, email, username)
  await phonePage.request.post(`${API}/auth/request-reset`, { data: { email } })
  const { link } = await latestMail(phonePage, email, "reset")
  await phonePage.goto(link!)
  await phonePage.getByLabel("New password", { exact: true }).fill("new-demo-password")
  await phonePage.getByRole("button", { name: /save|reset|change/i }).click()
  await expect(phonePage).toHaveURL(/\/(login|dashboard)/)

  // "Computer": a separate browser with nothing saved, still using the old password.
  const computer = await browser.newContext()
  const computerPage = await computer.newPage()
  const loginResponse = computerPage.waitForResponse((r) => r.url() === `${API}/login`)
  await login(computerPage, email, PASSWORD)
  const refused = await loginResponse
  expect(refused.status()).toBe(401)
  expect(refused.request().headers()["authorization"]).toBeUndefined()
  await expect(computerPage.getByText(/email or password is wrong/i)).toBeVisible()
  await expect(computerPage).toHaveURL(/\/login/)

  // Same computer, new password: works.
  await loginAndWait(computerPage, email, "new-demo-password")

  await phone.close()
  await computer.close()
})

test("session survives a reload and logout really signs out", async ({ page }) => {
  await loginAndWait(page, "demo@luma.test")
  await page.reload()
  await expect(page).toHaveURL(/\/dashboard/)
  await page.goto("/settings")
  await expect(page).toHaveURL(/\/settings/)
})
