// Account flows (signup code, verify, reset, logout, session restore, expired
// session, form error announcements). FAKE API only (dev/mock-api.mjs): every
// address is made up with fakeEmail(), codes and links come from the fake outbox.
import { expect, test, type Browser, type Page, type TestInfo } from "@playwright/test"

import { API, PASSWORD, SEEDED, expectNoSeriousA11yIssues, fakeEmail, latestMail, login, loginAndWait } from "./helpers"

type Mail = { kind: string; code?: string; link?: string }

async function outbox(page: Page, email: string): Promise<Mail[]> {
  const response = await page.request.get(`${API}/__test/outbox?email=${encodeURIComponent(email)}`)
  return ((await response.json()) as { messages: Mail[] }).messages
}

let names = 0
function fakeUsername(info: TestInfo): string {
  names += 1
  return `t${Date.now().toString(36)}${info.project.name.slice(0, 2)}${names}`
}

async function fillSignup(page: Page, email: string, username: string, password = PASSWORD) {
  await page.goto("/signup")
  await page.getByLabel("Email").fill(email)
  await page.getByLabel("Username").fill(username)
  await page.getByLabel("Password", { exact: true }).fill(password)
  await page.getByRole("button", { name: "Make account" }).click()
}

/** Makes a fresh verified account in this page and lands on the dashboard. */
async function signUpVerified(page: Page, info: TestInfo) {
  const email = fakeEmail("auth", info)
  const username = fakeUsername(info)
  await fillSignup(page, email, username)
  await expect(page).toHaveURL(/\/verify-email/)
  const { code } = await latestMail(page, email, "code")
  await page.getByLabel("6-number code").fill(code!)
  await page.getByRole("button", { name: "Check code" }).click()
  await expect(page).toHaveURL(/\/dashboard/)
  return { email, username }
}

/** The account button: sidebar on desktop/tablet, top bar avatar on phone. */
async function openAccountMenu(page: Page) {
  await page.getByRole("button", { name: /^Accounts/ }).filter({ visible: true }).first().click()
  const menu = page.getByRole("dialog", { name: "Accounts" })
  await expect(menu).toBeVisible()
  return menu
}

async function newPage(browser: Browser) {
  const context = await browser.newContext()
  return { context, page: await context.newPage() }
}

test.describe("signup with an emailed code", () => {
  test("wrong code is refused and announced, resend sends a working new code", async ({ page }, info) => {
    test.setTimeout(150_000) // the resend button waits the real 60 second cooldown
    const email = fakeEmail("signup", info)
    const username = fakeUsername(info)

    await page.goto("/signup")
    await expect(page.getByRole("heading", { level: 1, name: "Make your account" })).toBeVisible()
    await expectNoSeriousA11yIssues(page, "signup", info)

    await fillSignup(page, email, username)
    await expect(page).toHaveURL(/\/verify-email\?.*email=/)
    await expect(page.getByRole("heading", { level: 1, name: "Check your email" })).toBeVisible()
    await expect(page.getByText(email)).toBeVisible()
    const first = await latestMail(page, email, "code")
    expect(first.code).toMatch(/^\d{6}$/)
    await expectNoSeriousA11yIssues(page, "verify-email", info)

    // Resend is held back with a visible countdown.
    const resend = page.getByRole("button", { name: "Send a new code" })
    await expect(resend).toBeDisabled()
    await expect(page.getByText(/You can ask for a new code in \d+ seconds/)).toBeVisible()

    // Too short: caught before any request.
    const codeInput = page.getByLabel("6-number code")
    await codeInput.fill("123")
    await page.getByRole("button", { name: "Check code" }).click()
    await expect(page.getByRole("alert")).toHaveText("Type all 6 numbers from the email.")

    // Wrong code: clear message, field marked invalid and pointed at the message.
    const wrong = first.code === "000000" ? "111111" : "000000"
    await codeInput.fill(wrong)
    await page.getByRole("button", { name: "Check code" }).click()
    const alert = page.getByRole("alert")
    await expect(alert).toHaveText(/That code doesn't match/)
    await expect(codeInput).toHaveAttribute("aria-invalid", "true")
    const alertSlotId = await alert.evaluate((el) => el.parentElement!.id)
    expect((await codeInput.getAttribute("aria-describedby"))!.split(" ")).toContain(alertSlotId)
    await expect(page).toHaveURL(/\/verify-email/)

    // Resend after the cooldown.
    const before = (await outbox(page, email)).filter((m) => m.kind === "code").length
    await expect(resend).toBeEnabled({ timeout: 80_000 })
    await resend.click()
    await expect(page.getByText(/a new one is on its way/)).toBeVisible()
    await expect
      .poll(async () => (await outbox(page, email)).filter((m) => m.kind === "code").length)
      .toBe(before + 1)
    const second = await latestMail(page, email, "code")
    await expect(resend).toBeDisabled()

    // The old code no longer works (when the two random codes happen to differ).
    if (second.code !== first.code) {
      await codeInput.fill(first.code!)
      await page.getByRole("button", { name: "Check code" }).click()
      await expect(page.getByRole("alert")).toHaveText(/That code doesn't match/)
    }

    await codeInput.fill(second.code!)
    await page.getByRole("button", { name: "Check code" }).click()
    await expect(page).toHaveURL(/\/dashboard/)

    // The new account can log in from a clean browser.
    const other = await newPage(page.context().browser()!)
    await loginAndWait(other.page, email)
    await other.context.close()
  })

  test("a code typed with spaces or a dash is accepted", async ({ page }, info) => {
    const email = fakeEmail("spaced", info)
    await fillSignup(page, email, fakeUsername(info))
    await expect(page).toHaveURL(/\/verify-email/)
    const { code } = await latestMail(page, email, "code")
    await page.getByLabel("6-number code").fill(`${code!.slice(0, 3)} ${code!.slice(3)}`)
    await page.getByRole("button", { name: "Check code" }).click()
    await expect(page).toHaveURL(/\/dashboard/)
  })
})

test("an unverified account logging in goes to the code page", async ({ page }) => {
  await login(page, SEEDED.unverified.email)
  await expect(page).toHaveURL(/\/verify-email\?email=unverified%40luma\.test/)
  await expect(page.getByRole("heading", { level: 1, name: "Check your email" })).toBeVisible()
  await expect(page.getByText(SEEDED.unverified.email)).toBeVisible()
  await expect(page.getByLabel("6-number code")).toBeVisible()
  // Not verified yet: the dashboard still works but shows the banner with a way back here.
  await page.getByRole("link", { name: "Go to Luma" }).click()
  await expect(page).toHaveURL(/\/dashboard/)
  await expect(page.getByRole("status").filter({ hasText: "Check your email." })).toBeVisible()
  await expect(page.getByRole("link", { name: "Enter code" })).toHaveAttribute("href", /\/verify-email\?email=/)
})

test("forgot password: the reset link sets a new password, the old one stops working", async ({ page, browser }, info) => {
  const { email } = await signUpVerified(page, info)

  // Another browser, not signed in, asks for the link from the login page.
  const phone = await newPage(browser)
  await phone.page.goto("/login")
  await phone.page.getByRole("link", { name: "Forgot password?" }).click()
  await expect(phone.page).toHaveURL(/\/forgot-password/)
  await expect(phone.page.getByRole("heading", { level: 1, name: "Reset your password" })).toBeVisible()
  await expectNoSeriousA11yIssues(phone.page, "forgot-password", info)
  await phone.page.getByLabel("Email").fill(email)
  await phone.page.getByRole("button", { name: "Send reset link" }).click()
  await expect(phone.page.getByText(/we sent a reset link/)).toBeVisible()
  await expect(phone.page.getByRole("button", { name: "Send the link again" })).toBeVisible()

  const { link } = await latestMail(phone.page, email, "reset")
  expect(link).toMatch(/^\/reset-password\?token=/)
  await phone.page.goto(link!)
  await expect(phone.page.getByRole("heading", { level: 1, name: "Make a new password" })).toBeVisible()
  await expectNoSeriousA11yIssues(phone.page, "reset-password", info)
  await phone.page.getByLabel("New password", { exact: true }).fill("brand-new-pass-1")
  await phone.page.getByRole("button", { name: "Save new password" }).click()
  await expect(phone.page).toHaveURL(/\/login\?reset=1/)
  await expect(phone.page.getByText(/Your password is changed/)).toBeVisible()

  // The same link works only once.
  await phone.page.goto(link!)
  await phone.page.getByLabel("New password", { exact: true }).fill("another-pass-22")
  await phone.page.getByRole("button", { name: "Save new password" }).click()
  await expect(phone.page.getByRole("alert")).toContainText("That reset link doesn't work anymore")

  // Old password refused, new one works.
  await login(phone.page, email, PASSWORD)
  await expect(phone.page.getByRole("alert")).toHaveText(/email or password is wrong/i)
  await expect(phone.page).toHaveURL(/\/login/)
  await loginAndWait(phone.page, email, "brand-new-pass-1")

  // The first browser's old session ended: it asks to sign in again.
  await page.reload()
  await expect(page.getByRole("heading", { level: 1, name: "Sign in again" })).toBeVisible()
  await phone.context.close()
})

test("logout from the account menu really signs out", async ({ page }, info) => {
  const { username } = await signUpVerified(page, info)
  const menu = await openAccountMenu(page)
  await expect(menu.getByText(username).first()).toBeVisible()
  await menu.getByRole("button", { name: `Sign out of ${username}` }).click()
  await expect(page).toHaveURL(/\/$|\/login/)
  await expect(page.getByRole("dialog", { name: "Accounts" })).toHaveCount(0)

  // Protected pages now send you to log in, also after a reload.
  await page.goto("/dashboard")
  await expect(page).toHaveURL(/\/login\?redirect=%2Fdashboard/)
  await page.reload()
  await expect(page).toHaveURL(/\/login/)
  await expect(page.getByRole("heading", { level: 1, name: "Log in" })).toBeVisible()
})

test("a session survives a reload and a new tab", async ({ page }, info) => {
  const { username } = await signUpVerified(page, info)
  await page.goto("/settings")
  await page.reload()
  await expect(page).toHaveURL(/\/settings/)
  await expect(page.getByText(username).filter({ visible: true }).first()).toBeVisible()

  const second = await page.context().newPage()
  await second.goto("/dashboard")
  await expect(second).toHaveURL(/\/dashboard/)
  // Signed in already: the login page sends you on.
  await second.goto("/login")
  await expect(second).toHaveURL(/\/dashboard/)
  await second.close()
})

test("an expired session shows Sign in again with the email filled", async ({ page }, info) => {
  const { email, username } = await signUpVerified(page, info)
  const response = await page.request.post(`${API}/__test/expire`, { data: { email } })
  expect(response.ok()).toBe(true)

  await page.reload()
  await expect(page.getByRole("heading", { level: 1, name: "Sign in again" })).toBeVisible()
  await expect(page.getByText(`Your sign-in for ${username} ended`)).toBeVisible()
  const emailField = page.getByLabel("Email")
  await expect(emailField).toHaveValue(email)
  await expect(emailField).toHaveAttribute("readonly", "")
  await expectNoSeriousA11yIssues(page, "sign-in-again", info)

  // A wrong password is refused, the right one brings you back.
  await page.getByLabel("Password", { exact: true }).fill("not-the-password")
  await page.getByRole("button", { name: "Sign in", exact: true }).click()
  await expect(page.getByRole("alert")).toHaveText(/email or password is wrong/i)
  await page.getByLabel("Password", { exact: true }).fill(PASSWORD)
  await page.getByRole("button", { name: "Sign in", exact: true }).click()
  await expect(page).toHaveURL(/\/dashboard/)
})

test.describe("form errors are announced", () => {
  test("login: empty submit is blocked, wrong password marks both fields", async ({ page }, info) => {
    await page.goto("/login")
    await expectNoSeriousA11yIssues(page, "login", info)
    let loginCalls = 0
    page.on("request", (r) => {
      if (r.url() === `${API}/login`) loginCalls += 1
    })
    const emailField = page.getByLabel("Email")
    const passwordField = page.getByLabel("Password", { exact: true })

    await page.getByRole("button", { name: "Log in", exact: true }).click()
    expect(await emailField.evaluate((el: HTMLInputElement) => el.validity.valueMissing)).toBe(true)
    expect(await emailField.evaluate((el: HTMLInputElement) => el.validationMessage)).not.toBe("")
    await expect(emailField).toBeFocused()

    await emailField.fill("not-an-email")
    await passwordField.fill("whatever-pass")
    await page.getByRole("button", { name: "Log in", exact: true }).click()
    expect(await emailField.evaluate((el: HTMLInputElement) => el.validity.typeMismatch)).toBe(true)
    expect(loginCalls).toBe(0)

    await emailField.fill(fakeEmail("nobody", info))
    await page.getByRole("button", { name: "Log in", exact: true }).click()
    const alert = page.getByRole("alert")
    await expect(alert).toHaveText(/email or password is wrong/i)
    await expect(alert).toBeFocused()
    const slotId = await alert.evaluate((el) => el.parentElement!.id)
    for (const field of [emailField, passwordField]) {
      await expect(field).toHaveAttribute("aria-invalid", "true")
      expect((await field.getAttribute("aria-describedby"))!.split(" ")).toContain(slotId)
    }

    // Typing a fix and succeeding clears the error state.
    await emailField.fill(SEEDED.demo.email)
    await passwordField.fill(PASSWORD)
    await page.getByRole("button", { name: "Log in", exact: true }).click()
    await expect(page).toHaveURL(/\/dashboard/)
  })

  test("signup: empty and too-short submits are blocked before any request", async ({ page }, info) => {
    await page.goto("/signup")
    let signupCalls = 0
    page.on("request", (r) => {
      if (r.url() === `${API}/signup`) signupCalls += 1
    })
    const button = page.getByRole("button", { name: "Make account" })
    await button.click()
    await expect(page.getByLabel("Email")).toBeFocused()
    expect(await page.getByLabel("Email").evaluate((el: HTMLInputElement) => el.validity.valueMissing)).toBe(true)

    // The password field explains its rule through aria-describedby.
    const password = page.getByLabel("Password", { exact: true })
    const hintId = (await password.getAttribute("aria-describedby"))!.split(" ")[0]
    await expect(page.locator(`[id="${hintId}"]`)).toHaveText("Use 8 to 128 characters.")

    await page.getByLabel("Email").fill(fakeEmail("short", info))
    await page.getByLabel("Username").fill(fakeUsername(info))
    await password.fill("short")
    await button.click()
    expect(await password.evaluate((el: HTMLInputElement) => el.validity.tooShort)).toBe(true)
    await expect(password).toBeFocused()

    await page.getByLabel("Username").fill("a!")
    await password.fill(PASSWORD)
    await button.click()
    const username = page.getByLabel("Username")
    expect(await username.evaluate((el: HTMLInputElement) => !el.validity.valid)).toBe(true)
    await expect(username).toBeFocused()
    expect(signupCalls).toBe(0)
  })

  test("signup: a server error (username taken) marks the field invalid", async ({ page }, info) => {
    await fillSignup(page, fakeEmail("taken", info), SEEDED.demo.username)
    const alert = page.getByRole("alert")
    await expect(alert).toHaveText("That username is taken. Try another one.")
    await expect(alert).toBeFocused()
    const slotId = await alert.evaluate((el) => el.parentElement!.id)
    const username = page.getByLabel("Username")
    expect((await username.getAttribute("aria-describedby"))!.split(" ")).toContain(slotId)
    await expect(page).toHaveURL(/\/signup/)
    await expect(username).toHaveAttribute("aria-invalid", "true", { timeout: 2_000 })
  })

  test("reset password: too short is blocked, bad link is announced", async ({ page }) => {
    await page.goto("/reset-password?token=made-up-token")
    const field = page.getByLabel("New password", { exact: true })
    await field.fill("short")
    await page.getByRole("button", { name: "Save new password" }).click()
    expect(await field.evaluate((el: HTMLInputElement) => el.validity.tooShort)).toBe(true)

    await field.fill("long-enough-pass")
    await page.getByRole("button", { name: "Save new password" }).click()
    const alert = page.getByRole("alert")
    await expect(alert).toContainText("That reset link doesn't work anymore")
    await expect(field).toHaveAttribute("aria-invalid", "true")
    const slotId = await alert.evaluate((el) => el.parentElement!.id)
    expect((await field.getAttribute("aria-describedby"))!.split(" ")).toContain(slotId)
    await expect(alert.getByRole("link", { name: "Get a new link" })).toHaveAttribute("href", "/forgot-password")

    await page.goto("/reset-password")
    await expect(page.getByRole("heading", { level: 1, name: "This link isn't complete" })).toBeVisible()
  })
})
