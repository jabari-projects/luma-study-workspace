// Account deletion from Settings, with made-up accounts made fresh by signup
// (seeded accounts are never deleted). Runs against the FAKE API only.
import { expect, test, type Page, type TestInfo } from "@playwright/test"

import { API, PASSWORD, expectNoSeriousA11yIssues, fakeEmail, latestMail, login } from "./helpers"

function fakeUsername(label: string, info: TestInfo) {
  return `${label}${Date.now().toString(36)}${info.project.name.slice(0, 2)}${Math.floor(Math.random() * 1000)}`
}

/** Sign up (or, while signed in, add) a new verified account, then go to the dashboard. */
async function signUp(page: Page, email: string, username: string, adding = false) {
  await page.goto(adding ? "/signup?add=1" : "/signup")
  await page.getByLabel("Email").fill(email)
  await page.getByLabel("Username").fill(username)
  await page.getByLabel("Password", { exact: true }).fill(PASSWORD)
  await page.getByRole("button", { name: /^make an account$/i }).click()
  await expect(page).toHaveURL(/\/verify-email/)
  const { code } = await latestMail(page, email, "code")
  await page.getByLabel(/code/i).fill(code!)
  await page.getByRole("button", { name: /check|verify|confirm/i }).click()
  // Finishing signup opens Discover; these tests start from Home.
  await expect(page).toHaveURL(/\/discover$/)
  await page.goto("/dashboard")
  await expect(page).toHaveURL(/\/dashboard/)
}

/** The last Settings group: its heading names the region, and the delete form sits inside it. */
function deletePanel(page: Page) {
  return page.getByRole("region", { name: "Delete account" }).filter({ has: page.locator("form.danger-zone") })
}

async function openDeletePanel(page: Page) {
  await page.goto("/settings")
  const panel = deletePanel(page)
  await expect(panel.getByRole("heading", { name: "Delete account" })).toBeVisible()
  await panel.scrollIntoViewIfNeeded()
  return panel
}

test("What stays list opens and lists what is kept", async ({ page }, info) => {
  const email = fakeEmail("stays", info)
  await signUp(page, email, fakeUsername("st", info))
  const panel = await openDeletePanel(page)

  const list = panel.getByRole("list")
  await expect(list).toBeHidden()
  await panel.getByText("What stays after you delete?").click()
  await expect(list).toBeVisible()
  await expect(list.getByRole("listitem")).toHaveCount(5)
  await expect(list).toContainText(/payment records stay with Stripe/i)
  await expect(list).toContainText(/backups/i)
  await expect(list).toContainText(/scrambled code/i)
})

test("Settings with the delete panel open has no serious a11y issues", async ({ page }, info) => {
  const email = fakeEmail("axe", info)
  await signUp(page, email, fakeUsername("ax", info))
  const panel = await openDeletePanel(page)
  await panel.getByText("What stays after you delete?").click()
  await expect(panel.getByRole("list")).toBeVisible()
  await expectNoSeriousA11yIssues(page, "settings-delete-panel", info)
})

test("delete needs the word delete typed; a wrong word deletes nothing", async ({ page }, info) => {
  const email = fakeEmail("confirm", info)
  await signUp(page, email, fakeUsername("cf", info))
  const panel = await openDeletePanel(page)

  let deleteCalls = 0
  page.on("request", (r) => {
    if (r.method() === "DELETE" && r.url() === `${API}/me/account`) deleteCalls += 1
  })

  // Empty and wrong word: refused with a message next to the box, still on Settings.
  const confirmBox = panel.getByLabel("Type delete to confirm")
  await panel.getByRole("button", { name: "Delete my account" }).click()
  await expect(page.getByText("Type delete to confirm.", { exact: true })).toBeVisible()
  await expect(confirmBox).toBeFocused()
  await expect(confirmBox).toHaveAttribute("aria-invalid", "true")
  await expect(confirmBox).toHaveAttribute("aria-describedby", "delete-account-message")
  await confirmBox.fill("remove")
  await expect(confirmBox).not.toHaveAttribute("aria-invalid", "true")
  await panel.getByRole("button", { name: "Delete my account" }).click()
  await expect(page.getByText("Type delete to confirm.", { exact: true })).toBeVisible()
  await expect(page).toHaveURL(/\/settings/)
  expect(deleteCalls).toBe(0)

  // Account still works.
  const me = await page.request.post(`${API}/login`, { data: { email, password: PASSWORD } })
  expect(me.status()).toBe(200)
})

test("delete needs your password; a missing or wrong one deletes nothing", async ({ page }, info) => {
  const email = fakeEmail("pwcheck", info)
  await signUp(page, email, fakeUsername("pw", info))
  const panel = await openDeletePanel(page)

  let deleteCalls = 0
  page.on("request", (r) => {
    if (r.method() === "DELETE" && r.url() === `${API}/me/account`) deleteCalls += 1
  })

  // No password: asked for it, nothing sent.
  await panel.getByLabel("Type delete to confirm").fill("delete")
  await panel.getByRole("button", { name: "Delete my account" }).click()
  await expect(page.getByText("Type your password to delete your account.")).toBeVisible()
  await expect(panel.getByLabel("Your password")).toBeFocused()
  await expect(panel.getByLabel("Your password")).toHaveAttribute("aria-invalid", "true")
  await expect(panel.getByRole("button", { name: "Show password" })).toBeVisible()
  expect(deleteCalls).toBe(0)

  // Wrong password: the server says no, and the account stays.
  const answer = page.waitForResponse((r) => r.url() === `${API}/me/account` && r.request().method() === "DELETE")
  await panel.getByLabel("Your password").fill("not-my-password")
  await panel.getByRole("button", { name: "Delete my account" }).click()
  const response = await answer
  expect(response.status()).toBe(400)
  expect(response.request().postDataJSON()).toEqual({ current_password: "not-my-password" })
  await expect(page.getByText("That password is wrong. Your account is not deleted.")).toBeVisible()
  await expect(panel.getByLabel("Your password")).toHaveAttribute("aria-invalid", "true")
  await expect(panel.getByLabel("Your password")).toBeFocused()
  await expect(page).toHaveURL(/\/settings/)
  expect((await page.request.post(`${API}/login`, { data: { email, password: PASSWORD } })).status()).toBe(200)
})

test("deleting lands on /account-deleted and that account can no longer log in", async ({ page }, info) => {
  const email = fakeEmail("gone", info)
  await signUp(page, email, fakeUsername("gn", info))
  const panel = await openDeletePanel(page)

  await panel.getByLabel("Type delete to confirm").fill("  DELETE ")
  await panel.getByLabel("Your password").fill(PASSWORD)
  const deleted = page.waitForResponse((r) => r.url() === `${API}/me/account` && r.request().method() === "DELETE")
  await panel.getByRole("button", { name: "Delete my account" }).click()
  expect((await deleted).status()).toBe(200)

  await expect(page).toHaveURL(/\/account-deleted$/)
  await expect(page.getByRole("heading", { name: "Your account is deleted" })).toBeVisible()
  await expect(page.getByRole("heading", { name: /a few records stay/i })).toBeVisible()
  // No other accounts on this device, so only the start page link.
  await expect(page.getByRole("button", { name: /go back to luma as/i })).toHaveCount(0)
  await expect(page.getByRole("link", { name: "Go to the start page" })).toBeVisible()
  await expectNoSeriousA11yIssues(page, "account-deleted", info)

  // The session is gone: protected pages send you to login.
  await page.goto("/dashboard")
  await expect(page).toHaveURL(/\/login/)

  // Logging in with the deleted account is refused.
  const loginResponse = page.waitForResponse((r) => r.url() === `${API}/login`)
  await login(page, email, PASSWORD)
  expect((await loginResponse).status()).toBeGreaterThanOrEqual(400)
  await expect(page).toHaveURL(/\/login/)
  await expect(page.getByRole("alert").or(page.getByText(/email or password is wrong/i)).first()).toBeVisible()
})

test("with two accounts signed in, only the deleted one is removed", async ({ page }, info) => {
  const keepEmail = fakeEmail("keep", info)
  const keepName = fakeUsername("kp", info)
  const goneEmail = fakeEmail("drop", info)
  const goneName = fakeUsername("dr", info)

  await signUp(page, keepEmail, keepName)
  await signUp(page, goneEmail, goneName, true)

  // Both are on this device; the new one is in use.
  await page.goto("/settings")
  const accountsPanel = page.locator("#accounts")
  await expect(accountsPanel.getByText(keepEmail)).toBeVisible()
  await expect(accountsPanel.getByText(goneEmail)).toBeVisible()
  await expect(accountsPanel.locator('[aria-current="true"]')).toContainText(goneEmail)

  const panel = await openDeletePanel(page)
  await panel.getByLabel("Type delete to confirm").fill("delete")
  await panel.getByLabel("Your password").fill(PASSWORD)
  await panel.getByRole("button", { name: "Delete my account" }).click()
  await expect(page).toHaveURL(/\/account-deleted$/)

  const back = page.getByRole("button", { name: `Go back to Luma as ${keepName}` })
  await expect(back).toBeVisible()
  await back.click()
  await expect(page).toHaveURL(/\/dashboard/)

  // The kept account is still signed in and in use; the deleted one is gone.
  await page.goto("/settings")
  await expect(accountsPanel.getByText(keepEmail)).toBeVisible()
  await expect(accountsPanel.getByText(goneEmail)).toHaveCount(0)
  await expect(accountsPanel.getByRole("listitem")).toHaveCount(1)

  // Still signed in after a reload.
  await page.reload()
  await expect(page).toHaveURL(/\/settings/)
  await expect(accountsPanel.getByText(keepEmail)).toBeVisible()
  await expect(accountsPanel.getByText(goneEmail)).toHaveCount(0)

  // Server side: the kept one can log in, the deleted one cannot.
  expect((await page.request.post(`${API}/login`, { data: { email: keepEmail, password: PASSWORD } })).status()).toBe(200)
  expect((await page.request.post(`${API}/login`, { data: { email: goneEmail, password: PASSWORD } })).status()).toBeGreaterThanOrEqual(400)
})
