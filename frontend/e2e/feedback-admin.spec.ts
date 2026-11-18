// Monthly feedback poll, admin side, against the FAKE API (dev/mock-api.mjs + dev/mock-feedback.mjs).
// demo is the fake admin; sam is a student. Made-up data only. Each test resets the fake
// poll scenario and clock afterwards.
import { expect, test, type Locator, type Page } from "@playwright/test"

import { API, PASSWORD, SEEDED, expectNoSeriousA11yIssues, loginAndWait } from "./helpers"

type ScenarioPoll = { id: string; status: string; opens_at: string; closes_at: string }

async function scenario(page: Page, name: string): Promise<ScenarioPoll[]> {
  const response = await page.request.post(`${API}/__test/feedback`, { data: { scenario: name } })
  expect(response.ok()).toBe(true)
  return ((await response.json()) as { polls: ScenarioPoll[] }).polls
}

async function setClock(page: Page, iso: string | null) {
  const response = await page.request.post(`${API}/__test/clock`, { data: { now: iso } })
  expect(response.ok()).toBe(true)
}

async function tokenFor(page: Page, email: string) {
  const response = await page.request.post(`${API}/login`, { data: { email, password: PASSWORD } })
  return ((await response.json()) as { access_token: string }).access_token
}

async function openAccountMenu(page: Page, project: string): Promise<Locator> {
  if (project === "phone") {
    await page.getByRole("button", { name: "Accounts and settings" }).click()
  } else {
    await page.getByRole("button", { name: /^Accounts/ }).click()
  }
  const menu = page.getByRole("dialog", { name: "Accounts" })
  await expect(menu).toBeVisible()
  return menu
}

async function settle(page: Page) {
  await page.waitForLoadState("networkidle")
  await expect(page.locator("[aria-busy='true']")).toHaveCount(0)
  await page.waitForTimeout(500)
}

test.afterEach(async ({ page }) => {
  await setClock(page, null)
  await scenario(page, "none")
})

test("only admins get the Student feedback page, and only from the account menu", async ({ page, browser }, info) => {
  await scenario(page, "none")
  // A student: no link, the page refuses them, and so does the API.
  await loginAndWait(page, SEEDED.sam.email)
  const samMenu = await openAccountMenu(page, info.project.name)
  await expect(samMenu.getByRole("button", { name: /add another account/i })).toBeVisible()
  await expect(samMenu.getByRole("link", { name: "Student feedback" })).toHaveCount(0)
  await page.keyboard.press("Escape")
  await page.goto("/admin/feedback")
  await expect(page.getByRole("heading", { level: 1, name: "Student feedback" })).toBeVisible()
  await expect(page.getByText("Only Luma helpers can see this page.")).toBeVisible()
  const samToken = await tokenFor(page, SEEDED.sam.email)
  for (const path of ["/admin/feedback/polls", "/admin/feedback/polls/made-up/totals", "/admin/feedback/polls/made-up/comments"]) {
    const refused = await page.request.get(`${API}${path}`, { headers: { authorization: `Bearer ${samToken}` } })
    expect(refused.status(), path).toBe(403)
  }
  expect((await page.request.get(`${API}/admin/feedback/polls`)).status()).toBe(401)

  // The admin: not in Settings, but in the account menu.
  const adminContext = await browser.newContext()
  const admin = await adminContext.newPage()
  await loginAndWait(admin, SEEDED.demo.email)
  await admin.goto("/settings")
  await expect(admin.getByRole("heading", { level: 1, name: "Settings" })).toBeVisible()
  await expect(admin.getByRole("link", { name: "Student feedback" })).toHaveCount(0)
  const menu = await openAccountMenu(admin, info.project.name)
  await menu.getByRole("link", { name: "Student feedback" }).click()
  await expect(admin).toHaveURL(/\/admin\/feedback$/)
  await expect(admin.getByRole("heading", { level: 1, name: "Student feedback" })).toBeVisible()
  await adminContext.close()
})

test("draft, dates, questions, approve, lock at open, live totals, then a published update students can see", async ({ page, browser }, info) => {
  test.setTimeout(150_000)
  await setClock(page, "2026-11-17T15:00:00Z")
  await scenario(page, "none")
  await loginAndWait(page, SEEDED.demo.email)
  await page.goto("/admin/feedback")

  // Loading the list makes this month's and next month's drafts. Neither opens by itself.
  const rows = page.locator(".report-row")
  await expect(rows).toHaveCount(2)
  await expect(rows.nth(0)).toContainText("December 2026 poll")
  await expect(rows.nth(1)).toContainText("November 2026 poll")
  await expect(rows.nth(1).locator(".status-chip")).toHaveText("Draft")
  // November 2026 has five Sundays: the poll opens on the last one, the 29th.
  await expect(rows.nth(1)).toContainText("Opens Sunday, November 29 at 12:00 PM Central time")
  // The poll name comes first; a draft that opens soon says what it still needs.
  await expect(rows.nth(1).locator(".report-main > *").first()).toHaveText("November 2026 poll")
  await expect(rows.nth(1)).toContainText("Needs questions and approval")
  await expect(rows.nth(0)).not.toContainText("Needs")
  await settle(page)
  await expectNoSeriousA11yIssues(page, "admin-feedback-list", info)
  await page.getByRole("link", { name: "November 2026 poll" }).click()
  await expect(page.getByRole("heading", { level: 1, name: "November 2026 poll" })).toBeVisible()

  // Dates in Central time; a time that happens twice is refused, and the defaults come back.
  const opens = page.getByLabel("Opens (Central time)")
  const closes = page.getByLabel("Closes (Central time)")
  await expect(opens).toHaveValue("2026-11-29T12:00")
  await expect(closes).toHaveValue("2026-12-06T12:00")
  await opens.fill("2026-11-01T01:30")
  await page.getByRole("button", { name: "Save dates" }).click()
  await expect(page.getByRole("alert")).toContainText("because of daylight saving")
  await page.getByRole("button", { name: "Use default dates" }).click()
  await expect(opens).toHaveValue("2026-11-29T12:00")

  // Questions: a two-in-one warning, add, reorder, save.
  const q1 = page.getByLabel("Question 1", { exact: true })
  await q1.fill("Add dark mode and bigger buttons")
  await expect(page.getByText("Is this two changes in one? Split it.")).toBeVisible()
  await q1.fill("Add a dark mode for reviews")
  await expect(page.getByText("Is this two changes in one? Split it.")).toHaveCount(0)
  await page.getByRole("button", { name: "Add a question" }).click()
  await page.getByLabel("Question 2", { exact: true }).fill("Show a timer on quizzes")
  await page.getByRole("button", { name: "Move up question 2" }).click()
  await expect(page.getByLabel("Question 1", { exact: true })).toHaveValue("Show a timer on quizzes")
  const approveButton = page.getByRole("button", { name: "Approve and schedule" })
  await page.getByRole("checkbox", { name: "Each question asks about one change" }).check()
  await page.getByRole("checkbox", { name: /Yes always means/ }).check()
  await expect(page.getByText("Save your questions first.")).toBeVisible()
  await expect(approveButton).toBeDisabled()
  await page.getByRole("button", { name: "Save questions" }).click()
  await expect(page.getByText("Questions saved.")).toBeVisible()
  await settle(page)
  await expectNoSeriousA11yIssues(page, "admin-feedback-draft", info)

  // Approve: a confirm box; Escape closes it and focus comes back.
  await expect(approveButton).toBeEnabled()
  await approveButton.click()
  const dialog = page.getByRole("alertdialog", { name: "Approve this poll?" })
  await expect(dialog).toContainText("Students will see this on Sunday, November 29 at 12:00 PM Central time.")
  await page.keyboard.press("Escape")
  await expect(dialog).toHaveCount(0)
  await expect(approveButton).toBeFocused()
  await approveButton.click()
  await dialog.getByRole("button", { name: "Approve and schedule" }).click()
  await expect(page.locator(".page-head .status-chip")).toHaveText("Scheduled")
  await expect(page.getByText("Move it back to draft to edit questions.")).toBeVisible()
  await expect(page.getByLabel("Question 1", { exact: true })).toHaveCount(0)

  // Noon on the last Sunday: the poll is open and a student answers.
  await setClock(page, "2026-11-29T18:00:00Z")
  const studentContext = await browser.newContext()
  const student = await studentContext.newPage()
  await loginAndWait(student, SEEDED.sam.email)
  await student.goto("/feedback")
  await student.getByRole("group", { name: "1. Show a timer on quizzes" }).getByRole("radio", { name: "Yes, I want this change" }).check()
  await student.getByRole("button", { name: "Review my answers" }).click()
  await student.getByRole("button", { name: "Send my answers" }).click()
  await expect(student.getByRole("heading", { level: 2, name: "Thanks! We got your answers." })).toBeVisible()

  // The wording and dates are locked now. While voting is open, admins see only how many
  // answered: no per-question counts and no comments, so nobody can match a student to answers.
  await page.reload()
  await expect(page.locator(".page-head .status-chip")).toHaveText("Open")
  await expect(page.getByText("Voting has started, so the wording is locked.")).toBeVisible()
  await expect(page.getByLabel("Opens (Central time)")).toBeDisabled()
  const totals = page.getByRole("region", { name: "Live totals" })
  await expect(totals).toContainText("1 student answered so far")
  await expect(totals).toContainText("Totals and comments show up after the poll closes, so no one can tell who wrote what.")
  await expect(totals.locator(".feedback-result")).toHaveCount(0)
  await expect(totals).toContainText(/Updated \d+:\d\d (AM|PM) Central time/)
  await expect(page.getByRole("heading", { level: 2, name: "Comments" })).toHaveCount(0)
  const token = await tokenFor(page, SEEDED.demo.email)
  const pollId = page.url().split("/").pop()
  const locked = await page.request.put(`${API}/admin/feedback/polls/${pollId}/questions`, {
    headers: { authorization: `Bearer ${token}` },
    data: { questions: [{ label: "Sneaky new wording" }] },
  })
  expect(locked.status()).toBe(409)
  await settle(page)
  await expectNoSeriousA11yIssues(page, "admin-feedback-open", info)

  // Closed: the admin writes an update and publishes it.
  await setClock(page, "2026-12-06T18:00:00Z")
  await page.reload()
  await expect(page.locator(".page-head .status-chip")).toHaveText("Closed")
  const final = page.getByRole("region", { name: "Final totals" })
  await expect(final.locator(".feedback-result").first()).toContainText("Yes 100% (1) · No 0% (0) · 1 answered · 0 left blank")
  await expect(final.locator(".feedback-result").nth(1)).toContainText("No votes yet")
  await expect(final.getByRole("button", { name: "Refresh" })).toHaveCount(0)
  await expect(final).toContainText(/Updated \d+:\d\d (AM|PM) Central time/)
  const add = page.getByRole("form", { name: "Add an update" })
  await add.getByLabel("What change").fill("Quiz timer")
  await add.getByLabel("Status").selectOption("planned")
  await add.getByLabel("Note for students (optional)").fill("We'll add it in January.")
  await add.getByRole("checkbox", { name: "Published" }).check()
  await add.getByRole("button", { name: "Add update" }).click()
  await expect(page.getByText("Update added.")).toBeVisible()

  // The student sees the update, never counts. One vote is too few to show percentages.
  await student.goto("/feedback/results")
  await student.getByRole("link", { name: "November 2026 poll" }).click()
  await expect(student.getByText("Not enough students answered this poll to show results. Thanks to everyone who did!")).toBeVisible()
  await expect(student.getByText(/100%/)).toHaveCount(0)
  const doing = student.getByRole("region", { name: "What we're doing" })
  await expect(doing.locator(".status-chip")).toHaveText("Planned")
  await expect(doing).toContainText("Quiz timer")
  await expect(doing).toContainText("We'll add it in January.")
  await expect(student.getByText(/\d+ answered|\(1\)/)).toHaveCount(0)
  await studentContext.close()
})

test("comments: urgent first, text only (never who wrote it), merge and split themes", async ({ page }, info) => {
  const [poll] = await scenario(page, "closed")
  let dialogs = 0
  page.on("dialog", (d) => {
    dialogs += 1
    void d.dismiss()
  })
  await loginAndWait(page, SEEDED.demo.email)
  await page.goto(`/admin/feedback/${poll.id}`)
  await expect(page.getByRole("heading", { level: 2, name: "Comments" })).toBeVisible()

  const totals = page.getByRole("region", { name: "Final totals" })
  await expect(totals).toContainText("6 students answered")
  await expect(totals.locator(".feedback-result").filter({ hasText: "Add a dark mode for the flashcard review screen" })).toContainText(
    "Yes 75% (3) · No 25% (1) · 4 answered · 2 left blank",
  )
  await expect(totals.locator(".feedback-result").last()).toContainText("No votes yet")

  // Urgent problems come first, whatever the theme sizes.
  const urgent = page.getByRole("region", { name: "Needs attention: security, accessibility or privacy" })
  await expect(urgent).toContainText("Someone got my password and my account got hacked")
  await expect(urgent).toContainText("Security")
  const order = await page.locator("#comments").locator("xpath=..").locator("h3").allInnerTexts()
  expect(order[0]).toMatch(/^Needs attention/)
  // A flagged comment shows once: not again under Other comments, and not in its count.
  const other = page.getByRole("region", { name: /^Other comments/ })
  await expect(other).not.toContainText("my account got hacked")
  const otherCount = Number((await other.getByRole("heading").innerText()).match(/\((\d+)\)/)?.[1])
  await expect(other.locator(".feedback-comment-list > li")).toHaveCount(otherCount)
  // Disclosure toggles show a chevron so admins can tell they open.
  const chevron = await page.locator(".feedback-flag-menu summary").first().evaluate((el) => getComputedStyle(el, "::after").content)
  expect(chevron).not.toBe("none")

  // A comment with HTML in it is shown as plain text and never runs.
  await expect(page.getByText('<img src=x onerror="window.__pwned=1"><script>window.__pwned=2</script>')).toBeVisible()
  expect(await page.evaluate(() => (window as unknown as { __pwned?: number }).__pwned)).toBeUndefined()
  await expect(page.locator(".feedback-comment-list img, .feedback-comment-list script")).toHaveCount(0)
  expect(dialogs).toBe(0)

  // Never who wrote it.
  const text = await page.locator("main").innerText()
  expect(text).not.toMatch(/seed-|@luma\.test|@seed\.test|jabari|\bsam\b|\blee\b/)

  // Themes count different students; merge two, then split one back out.
  const themes = page.locator(".feedback-theme")
  await expect(themes).toHaveCount(2)
  await expect(themes.nth(0).locator(".feedback-theme-summary")).toHaveText("Dark mode · 2 students")
  await expect(themes.nth(1).locator(".feedback-theme-summary")).toHaveText("Speed load · 2 students")
  await page.getByRole("checkbox", { name: "Pick Dark mode to merge" }).check()
  await page.getByRole("checkbox", { name: "Pick Speed load to merge" }).check()
  await page.getByLabel("Merge picked themes into").selectOption({ label: "Dark mode" })
  await page.getByRole("button", { name: "Merge", exact: true }).click()
  await expect(page.getByText("Themes merged.")).toBeVisible()
  await expect(themes).toHaveCount(1)
  await expect(themes.nth(0).locator(".feedback-theme-summary")).toHaveText("Dark mode · 4 students")

  await themes.nth(0).locator(".feedback-theme-summary").click()
  const picks = themes.nth(0).getByRole("checkbox", { name: /^Pick comment / })
  await expect(picks).toHaveCount(4)
  await picks.nth(0).check()
  await picks.nth(1).check()
  await themes.nth(0).getByLabel("New theme name").fill("Quiz speed")
  await themes.nth(0).getByRole("button", { name: "Move to new theme" }).click()
  await expect(page.getByText("Moved to a new theme.")).toBeVisible()
  await expect(themes).toHaveCount(2)
  await expect(page.locator(".feedback-theme-summary")).toHaveText(["Dark mode · 2 students", "Quiz speed · 2 students"])

  // Regroup keeps the admin's own themes.
  await page.getByRole("button", { name: "Regroup" }).click()
  await expect(page.getByText("Comments regrouped.")).toBeVisible()
  await expect(page.locator(".feedback-theme-summary").filter({ hasText: "Quiz speed" })).toHaveCount(1)

  await themes.nth(0).locator(".feedback-theme-summary").click()
  await settle(page)
  await expectNoSeriousA11yIssues(page, "admin-feedback-comments", info)

  // Clearing a flag takes it out of Needs attention.
  await urgent.getByRole("button", { name: /^Clear flag/ }).click()
  await expect(page.getByText("Flag cleared.")).toBeVisible()
  await expect(urgent).toContainText("Nothing flagged.")
})
