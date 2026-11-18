// Changing the account email takes two steps (security fix 2026-11-17): the new
// email and the current password, then the 6-number code sent to the new email.
// Uses made-up accounts made fresh by signup; FAKE API only.
import { expect, test, type Page, type TestInfo } from "@playwright/test"

import { API, PASSWORD, expectNoSeriousA11yIssues, fakeEmail, latestMail } from "./helpers"

function fakeUsername(label: string, info: TestInfo) {
  return `${label}${Date.now().toString(36)}${info.project.name.slice(0, 2)}${Math.floor(Math.random() * 1000)}`
}

async function signUp(page: Page, email: string, username: string) {
  await page.goto("/signup")
  await page.getByLabel("Email").fill(email)
  await page.getByLabel("Username").fill(username)
  await page.getByLabel("Password", { exact: true }).fill(PASSWORD)
  await page.getByRole("button", { name: /^make account$/i }).click()
  await expect(page).toHaveURL(/\/verify-email/)
  const { code } = await latestMail(page, email, "code")
  await page.getByLabel(/code/i).fill(code!)
  await page.getByRole("button", { name: /check|verify|confirm/i }).click()
  await expect(page).toHaveURL(/\/(dashboard|discover)/)
}

/** Makes another account through the fake API only (the page stays signed in as before). */
async function makeOtherAccount(page: Page, email: string, username: string) {
  const started = await page.request.post(`${API}/signup`, { data: { email, username, password: PASSWORD } })
  expect(started.status()).toBe(202)
  const { ticket } = (await started.json()) as { ticket: string }
  const { code } = await latestMail(page, email, "code")
  const verified = await page.request.post(`${API}/auth/verify-email`, { data: { email, ticket, code } })
  expect(verified.status()).toBe(200)
}

async function outbox(page: Page, email: string) {
  const response = await page.request.get(`${API}/__test/outbox?email=${encodeURIComponent(email)}`)
  return ((await response.json()) as { messages: Array<{ kind: string; code?: string }> }).messages
}

/** Skips the 60 s wait between codes: on the fake server, and on the page's own (fake) clock. */
async function skipCodeWait(page: Page, accountEmail: string) {
  expect((await page.request.post(`${API}/__test/skip-code-wait`, { data: { email: accountEmail } })).status()).toBe(200)
  await page.clock.fastForward(61_000)
}

function accountPanel(page: Page) {
  return page.locator("#account")
}

/** Settings with a fake clock on the page, so the code wait can be skipped. */
async function openSettings(page: Page) {
  await page.clock.install()
  await page.goto("/settings")
}

/** Step 1: new email + password, then Send code. */
async function startChange(page: Page, newEmail: string, password = PASSWORD) {
  const panel = accountPanel(page)
  await panel.getByLabel("Email", { exact: true }).fill(newEmail)
  await panel.getByLabel("Your password").fill(password)
  await panel.getByRole("button", { name: "Send code" }).click()
}

function wrongCodeFor(code: string) {
  return code.slice(0, 5) + String((Number(code[5]) + 1) % 10)
}

const CODE_MISMATCH = "That code doesn't match. Check your newest email and try again."

test("the password box and Send code show only when the email is being changed", async ({ page }, info) => {
  const email = fakeEmail("emailbox", info)
  await signUp(page, email, fakeUsername("eb", info))
  await page.goto("/settings")
  const panel = accountPanel(page)
  const emailField = panel.getByLabel("Email", { exact: true })
  await expect(emailField).toHaveValue(email)
  await expect(panel.getByLabel("Your password")).toHaveCount(0)
  await expect(panel.getByRole("button", { name: "Send code" })).toHaveCount(0)

  await emailField.fill(fakeEmail("emailbox-new", info))
  // The password comes before the button, in the page and in the tab order.
  const passwordField = panel.getByLabel("Your password (to change email)")
  await expect(passwordField).toBeVisible()
  await expect(passwordField).toHaveAttribute("autocomplete", "current-password")
  await expect(panel.getByRole("button", { name: "Show password" })).toBeVisible()
  const sendCode = panel.getByRole("button", { name: "Send code" })
  const passwordBox = await passwordField.boundingBox()
  const buttonBox = await sendCode.boundingBox()
  expect(passwordBox!.y).toBeLessThan(buttonBox!.y)
  await emailField.focus()
  await page.keyboard.press("Tab")
  await expect(passwordField).toBeFocused()

  // Send code with no password: friendly words, not the browser's bubble.
  await sendCode.click()
  await expect(page.getByText("Type your password first.")).toBeVisible()
  await expect(passwordField).toBeFocused()
  await expect(passwordField).toHaveAttribute("aria-invalid", "true")
  await passwordField.fill("x")
  await expect(passwordField).not.toHaveAttribute("aria-invalid", "true")
  await expectNoSeriousA11yIssues(page, "settings email change", info)
})

test("a wrong password stops at step 1; the right one sends a code, a new code needs no password, and the code changes the email", async ({
  page,
}, info) => {
  const email = fakeEmail("emailchg", info)
  const next = fakeEmail("emailchg-new", info)
  await signUp(page, email, fakeUsername("ec", info))
  await openSettings(page)
  const panel = accountPanel(page)
  const messageSlot = await page.locator("#settings-email-message").elementHandle()
  await expect(panel.getByLabel("Email", { exact: true })).toHaveAttribute(
    "aria-describedby",
    /settings-email-message/,
  )

  await startChange(page, next, "not-my-password")
  await expect(page.getByText("That password is wrong. Try again.")).toBeVisible()
  await expect(panel.getByLabel("Your password")).toBeFocused()
  await expect(panel.getByLabel("6-number code")).toHaveCount(0)
  expect(await outbox(page, next)).toEqual([])

  const started = page.waitForResponse((r) => r.url() === `${API}/me/email` && r.request().method() === "PUT")
  await panel.getByLabel("Your password").fill(PASSWORD)
  await panel.getByRole("button", { name: "Send code" }).click()
  expect((await started).status()).toBe(202)

  // Step 2, in place, with focus on the code box.
  await expect(panel.getByRole("heading", { name: "Check your new email" })).toBeVisible()
  await expect(panel.getByText(`We sent a 6-number code to ${next}. Type it here.`)).toBeVisible()
  await expect(panel.getByText(/It works for 10 minutes\./)).toBeVisible()
  const codeField = panel.getByLabel("6-number code")
  await expect(codeField).toBeFocused()
  await expect(codeField).toHaveAttribute("inputmode", "numeric")
  await expect(codeField).toHaveAttribute("autocomplete", "one-time-code")
  // "Send a new code" waits out the cooldown.
  const sendNewCode = panel.getByRole("button", { name: "Send a new code" })
  await expect(sendNewCode).toBeDisabled()
  await expect(panel.getByText(/You can ask for a new code in \d+ seconds\./)).toBeVisible()
  await expectNoSeriousA11yIssues(page, "settings email code step", info)

  // Nothing changed yet: the old address has no notice.
  expect((await outbox(page, email)).some((m) => m.kind === "email_changed")).toBe(false)

  // After the wait, a new code goes to the same new email, without the password again.
  const codesBefore = (await outbox(page, next)).length
  await skipCodeWait(page, email)
  await expect(sendNewCode).toBeEnabled()
  const resent = page.waitForResponse((r) => r.url() === `${API}/me/email/resend`)
  await sendNewCode.click()
  const resentResponse = await resent
  expect(resentResponse.status()).toBe(202)
  expect(resentResponse.request().postDataJSON()).toEqual({ new_email: next })
  await expect(page.getByText("We sent a new code. It can take a few minutes. Check spam too.")).toBeVisible()
  await expect(codeField).toBeFocused()
  await expect.poll(async () => (await outbox(page, next)).length).toBe(codesBefore + 1)

  const { code } = await latestMail(page, next, "code")
  await codeField.fill(wrongCodeFor(code!))
  await panel.getByRole("button", { name: "Change my email" }).click()
  await expect(page.getByText(CODE_MISMATCH)).toBeVisible()
  await expect(codeField).toHaveAttribute("aria-invalid", "true")

  await codeField.fill(code!)
  await panel.getByRole("button", { name: "Change my email" }).click()
  await expect(page.getByText("Your email is changed.")).toBeVisible()
  // The message slot stayed on the page through both steps, so it is read out.
  expect(await messageSlot!.evaluate((slot) => slot.isConnected && slot.textContent)).toContain(
    "Your email is changed.",
  )
  await expect(panel.getByLabel("Email", { exact: true })).toHaveValue(next)
  await expect(panel.getByLabel("Email", { exact: true })).toBeFocused()
  await expect(page.locator("#accounts").getByText(next)).toBeVisible()

  // The old address was told, and only the new email logs in now.
  await latestMail(page, email, "email_changed")
  expect((await page.request.post(`${API}/login`, { data: { email: next, password: PASSWORD } })).status()).toBe(200)
  expect((await page.request.post(`${API}/login`, { data: { email, password: PASSWORD } })).status()).toBe(401)

  // Still changed after a reload.
  await page.reload()
  await expect(accountPanel(page).getByLabel("Email", { exact: true })).toHaveValue(next)
})

test("an email that already has an account looks the same at step 1, and after Cancel the fixed email gets a code", async ({
  page,
}, info) => {
  const email = fakeEmail("emailtaken", info)
  const taken = fakeEmail("emailtaken-other", info)
  const free = fakeEmail("emailtaken-free", info)
  await makeOtherAccount(page, taken, fakeUsername("ot", info))
  const takenMailCount = (await outbox(page, taken)).length
  await signUp(page, email, fakeUsername("et", info))
  await openSettings(page)
  const panel = accountPanel(page)

  const takenAnswer = page.waitForResponse((r) => r.url() === `${API}/me/email` && r.request().method() === "PUT")
  await startChange(page, taken)
  const takenResponse = await takenAnswer
  await expect(panel.getByText(`We sent a 6-number code to ${taken}. Type it here.`)).toBeVisible()
  // No message at all, so nothing hints that the address is in use.
  await expect(page.locator(".settings-main .notice")).toHaveCount(0)
  // No code went to the other account's inbox.
  expect(await outbox(page, taken)).toHaveLength(takenMailCount)

  // A made-up code just doesn't match, and the email stays the same.
  await panel.getByLabel("6-number code").fill("123456")
  await panel.getByRole("button", { name: "Change my email" }).click()
  await expect(page.getByText(CODE_MISMATCH)).toBeVisible()

  // Cancel goes back to step 1 with the old email.
  await panel.getByRole("button", { name: "Cancel" }).click()
  await expect(panel.getByLabel("Email", { exact: true })).toHaveValue(email)
  await expect(panel.getByLabel("Email", { exact: true })).toBeFocused()

  // Fixing the email right away: Send code waits for the timer instead of sending nothing.
  await panel.getByLabel("Email", { exact: true }).fill(free)
  await panel.getByLabel("Your password").fill(PASSWORD)
  const sendCode = panel.getByRole("button", { name: "Send code" })
  await expect(sendCode).toBeDisabled()
  await expect(panel.getByText(/You can ask for a new code in \d+ seconds\./)).toBeVisible()

  // After the wait, the fixed email gets exactly the same answer, and a real code.
  await skipCodeWait(page, email)
  await expect(sendCode).toBeEnabled()
  const freeAnswer = page.waitForResponse((r) => r.url() === `${API}/me/email` && r.request().method() === "PUT")
  await sendCode.click()
  const freeResponse = await freeAnswer
  expect(takenResponse.status()).toBe(202)
  expect(freeResponse.status()).toBe(202)
  expect(await freeResponse.json()).toEqual(await takenResponse.json())
  await expect(panel.getByText(`We sent a 6-number code to ${free}. Type it here.`)).toBeVisible()
  const { code } = await latestMail(page, free, "code")
  await panel.getByLabel("6-number code").fill(code!)
  await panel.getByRole("button", { name: "Change my email" }).click()
  await expect(page.getByText("Your email is changed.")).toBeVisible()
  await expect(panel.getByLabel("Email", { exact: true })).toHaveValue(free)
})

test("if someone takes the new email before the code is typed, it says so kindly", async ({ page }, info) => {
  const email = fakeEmail("emailrace", info)
  const next = fakeEmail("emailrace-new", info)
  await signUp(page, email, fakeUsername("er", info))
  await page.goto("/settings")
  const panel = accountPanel(page)

  await startChange(page, next)
  await expect(panel.getByRole("heading", { name: "Check your new email" })).toBeVisible()
  const { code } = await latestMail(page, next, "code")
  await makeOtherAccount(page, next, fakeUsername("fa", info))

  await panel.getByLabel("6-number code").fill(code!)
  await panel.getByRole("button", { name: "Change my email" }).click()
  await expect(page.getByText("That email already has a Luma account. Try a different email.")).toBeVisible()
  // Back at step 1, with the email box marked and tied to the message; the email did not change.
  await expect(panel.getByLabel("6-number code")).toHaveCount(0)
  const emailField = panel.getByLabel("Email", { exact: true })
  await expect(emailField).toBeFocused()
  await expect(emailField).toHaveAttribute("aria-invalid", "true")
  await expect(page.locator("#settings-email-message")).toContainText("That email already has a Luma account.")
  expect((await page.request.post(`${API}/login`, { data: { email, password: PASSWORD } })).status()).toBe(200)
})

test("too many wrong passwords says how long to wait, and the delete form says it too", async ({ page }, info) => {
  const email = fakeEmail("emailwait", info)
  await signUp(page, email, fakeUsername("ew", info))
  await page.goto("/settings")
  const panel = accountPanel(page)

  for (let i = 0; i < 5; i += 1) {
    await startChange(page, fakeEmail("emailwait-new", info), "not-my-password")
    await expect(page.getByText("That password is wrong. Try again.")).toBeVisible()
  }
  await panel.getByRole("button", { name: "Send code" }).click()
  await expect(page.getByText("Too many tries. Try again in 15 minutes.")).toBeVisible()
  await expect(panel.getByRole("button", { name: "Send code" })).toBeDisabled()
  await expect(panel.getByText(/You can try again in 1[45] minutes\./)).toBeVisible()
  await expect(panel.getByLabel("Your password")).toBeFocused()

  // The limit is shared with deleting the account, and that form says so.
  const remove = page.locator("form.danger-zone")
  await remove.getByLabel("Type delete to confirm").fill("delete")
  await remove.getByLabel("Your password").fill(PASSWORD)
  await remove.getByRole("button", { name: "Delete my account" }).click()
  await expect(
    remove.getByText("Too many tries. Try again in 15 minutes. This also pauses changing your email."),
  ).toBeVisible()
  await expect(remove.getByRole("button", { name: "Delete my account" })).toBeDisabled()
  expect((await page.request.post(`${API}/login`, { data: { email, password: PASSWORD } })).status()).toBe(200)
})

test("pressing Enter without changing the email just says so", async ({ page }, info) => {
  const email = fakeEmail("emailsame", info)
  await signUp(page, email, fakeUsername("es", info))
  await page.goto("/settings")
  let emailCalls = 0
  page.on("request", (r) => {
    if (r.url().startsWith(`${API}/me/email`)) emailCalls += 1
  })
  await accountPanel(page).getByLabel("Email", { exact: true }).press("Enter")
  await expect(page.getByText("That's already your email.")).toBeVisible()
  expect(emailCalls).toBe(0)
})
