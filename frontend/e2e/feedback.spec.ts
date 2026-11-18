// Monthly feedback poll, student side, against the FAKE API (dev/mock-api.mjs + dev/mock-feedback.mjs).
// Made-up data and accounts only; nothing leaves localhost. Each test picks a poll scenario
// and puts the fake server back to "no poll" and the real clock afterwards.
import { expect, test, type Page } from "@playwright/test"

import { API, PASSWORD, SEEDED, expectNoSeriousA11yIssues, latestMail, login, loginAndWait, makeAccount, setThemeMode } from "./helpers"

const TITLE = "If it ain't broke why fix it?!"
const QUESTION_1 = "Add a dark mode for the flashcard review screen"
const QUESTION_2 = "Show a timer while you take a quiz"
const NO_RESULTS = "Not enough students answered this poll to show results. Thanks to everyone who did!"

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

async function counts(page: Page, pollId: string) {
  const response = await page.request.get(`${API}/__test/feedback/counts`)
  return ((await response.json()) as Record<string, { responses: number; answers: number }>)[pollId]
}

async function tokenFor(page: Page, email: string) {
  const response = await page.request.post(`${API}/login`, { data: { email, password: PASSWORD } })
  return ((await response.json()) as { access_token: string }).access_token
}

/** Waits for the poll form (the first question is drawn). */
async function openPollPage(page: Page) {
  await page.goto("/feedback")
  await expect(page.getByRole("heading", { level: 1, name: TITLE })).toBeVisible()
  await expect(page.getByRole("group", { name: `1. ${QUESTION_1}` })).toBeVisible()
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

test.describe("Home note", () => {
  test("a small note under the study step, never a pop-up; Skip hides it for this poll and is not a vote", async ({ page }, info) => {
    const [poll] = await scenario(page, "open")
    const student = await makeAccount(page, info, "fbhome")
    await loginAndWait(page, student.email)
    const note = page.getByRole("complementary", { name: TITLE })
    await expect(note).toBeVisible()
    // The fake poll uses the real window: the last Sunday of the month at noon, Central time.
    await expect(note).toContainText(/Our monthly poll is open until Sunday, \w+ \d+ at 12:00 PM Central time/)
    await expect(note).toContainText("You can skip it.")
    // Not a dialog, not a live region, and focus never moves to it.
    await expect(page.getByRole("dialog")).toHaveCount(0)
    await expect(note).not.toHaveAttribute("aria-live", /.+/)
    expect(await note.evaluate((el) => el.contains(document.activeElement))).toBe(false)
    // The study step stays first, the note comes right after it.
    const order = await page.locator(".home-main > *").evaluateAll((els) => els.map((el) => el.className))
    expect(order[0]).toContain("next-step")
    expect(order[1]).toContain("feedback-note")
    // No stamp shadow on the note (Home keeps only the next-step card and its button stamped).
    const stamped = await note.evaluate((el) =>
      [el, ...Array.from(el.querySelectorAll("*"))].filter((x) => getComputedStyle(x).boxShadow.includes("3px 3px 0px")).length,
    )
    expect(stamped).toBe(0)
    await expect(note.getByRole("link", { name: "Answer the poll" })).toHaveAttribute("href", "/feedback")
    await settle(page)
    await expectNoSeriousA11yIssues(page, "home-feedback-note", info)

    // Skip with the keyboard: a short "okay" line takes focus (never <body>), and OK closes the note.
    await note.getByRole("button", { name: "Skip this poll" }).focus()
    await page.keyboard.press("Enter")
    const okay = note.getByRole("status")
    await expect(okay).toHaveText("Okay, we won't ask about this poll again.")
    await expect(okay).toBeFocused()
    expect(await page.evaluate(() => document.activeElement?.tagName)).not.toBe("BODY")
    await note.getByRole("button", { name: "OK" }).click()
    await expect(note).toHaveCount(0)
    await page.reload()
    await expect(page.locator(".next-step")).toBeVisible()
    await page.waitForLoadState("networkidle")
    await expect(page.getByRole("complementary", { name: TITLE })).toHaveCount(0)
    expect(await counts(page, poll.id)).toEqual({ responses: 0, answers: 0 })

    // The poll page remembers the skip but still lets them answer.
    await page.goto("/feedback")
    await expect(page.getByRole("heading", { level: 2, name: "You skipped this poll. That's okay!" })).toBeVisible()
    await page.getByRole("button", { name: "Answer it anyway" }).click()
    await expect(page.getByRole("group", { name: `1. ${QUESTION_1}` })).toBeVisible()
  })

  test("a Skip the server didn't save says so, keeps the note, and works on a second try", async ({ page }) => {
    await scenario(page, "open")
    await loginAndWait(page, SEEDED.sam.email)
    const note = page.getByRole("complementary", { name: TITLE })
    await page.route(`${API}/feedback/polls/*/skip`, (route) => route.fulfill({ status: 503, body: "{}" }))
    await note.getByRole("button", { name: "Skip this poll" }).click()
    await expect(note.getByRole("alert")).toHaveText("We couldn't skip the poll just now. Try again.")
    await expect(note.getByRole("button", { name: "Skip this poll" })).toBeVisible()
    await page.unroute(`${API}/feedback/polls/*/skip`)
    await note.getByRole("button", { name: "Skip this poll" }).click()
    await expect(note.getByRole("status")).toHaveText("Okay, we won't ask about this poll again.")
    await page.reload()
    await expect(page.locator(".next-step")).toBeVisible()
    await page.waitForLoadState("networkidle")
    await expect(page.getByRole("complementary", { name: TITLE })).toHaveCount(0)
  })

  test("no note and no error when the poll can't load", async ({ page }) => {
    await scenario(page, "open")
    await page.route(`${API}/feedback/current`, (route) => route.fulfill({ status: 500, body: "{}" }))
    await loginAndWait(page, SEEDED.demo.email)
    await expect(page.getByRole("heading", { level: 2, name: /^Review \d+ cards? in/ })).toBeVisible()
    await page.waitForLoadState("networkidle")
    await expect(page.locator(".feedback-note")).toHaveCount(0)
    await expect(page.getByRole("alert")).toHaveCount(0)
  })
})

test.describe("answering the poll", () => {
  test("pick, check and send: nothing pre-selected, review step, one vote even on a double click", async ({ page }, info) => {
    const [poll] = await scenario(page, "open")
    const hosts = new Set<string>()
    page.on("request", (request) => hosts.add(new URL(request.url()).hostname))
    await loginAndWait(page, SEEDED.demo.email)
    await openPollPage(page)

    await expect(page.getByText(/^Help us make Luma better! Answer a few quick questions about what should change\./)).toBeVisible()
    await expect(page.getByText("Admins can't see who wrote your answers.")).toBeVisible()
    await expect(page.getByText(/anonymous/i)).toHaveCount(0)
    await expect(page.getByRole("group")).toHaveCount(10)
    await expect(page.getByRole("radio", { checked: true })).toHaveCount(0)
    await settle(page)
    await expectNoSeriousA11yIssues(page, "feedback-open", info)

    // Every answer target is at least 44px tall; on a phone the pair stacks.
    const q1 = page.getByRole("group", { name: `1. ${QUESTION_1}` })
    const yes = q1.getByRole("radio", { name: "Yes, I want this change" })
    const no = q1.getByRole("radio", { name: "No, keep it as it is" })
    const yesBox = await page.locator(".feedback-choice").first().boundingBox()
    const noBox = await page.locator(".feedback-choice").nth(1).boundingBox()
    expect(yesBox!.height).toBeGreaterThanOrEqual(44)
    if (info.project.name === "phone") expect(noBox!.y).toBeGreaterThan(yesBox!.y)
    else expect(noBox!.y).toBe(yesBox!.y)

    // Keyboard: pick Yes, arrow to No, then clear it and pick Yes again.
    await yes.focus()
    await page.keyboard.press("Space")
    await expect(yes).toBeChecked()
    await page.keyboard.press("ArrowRight")
    await expect(no).toBeChecked()
    await q1.getByRole("button", { name: /Clear answer/ }).click()
    await expect(q1.getByRole("radio", { checked: true })).toHaveCount(0)
    await yes.check()
    await page.getByRole("group", { name: `2. ${QUESTION_2}` }).getByRole("radio", { name: "No, keep it as it is" }).check()

    // The comment: label, hint and counter are tied to the box; too long blocks Review.
    const comment = page.getByRole("textbox", { name: /Anything else you'd like us to add or change\?/ })
    await expect(comment).toHaveAccessibleDescription(/Please don't include passwords or private information\. 500 characters left/)
    await comment.fill("x".repeat(501))
    await expect(comment).toHaveAttribute("aria-invalid", "true")
    // One message only: the counter turns red and says how much to cut.
    await expect(page.locator(".feedback-count.over")).toHaveText("Please cut 1 character.")
    await expect(comment).toHaveAccessibleDescription(/Please cut 1 character\./)
    await expect(page.locator(".feedback-error")).toHaveCount(0)
    await page.getByRole("button", { name: "Review my answers" }).click()
    await expect(comment).toBeFocused()
    await expect(page.getByRole("alert")).toHaveCount(0)
    await expect(page.getByRole("heading", { name: "Check your answers" })).toHaveCount(0)
    await comment.fill("More colors for decks please 😀")
    await expect(page.getByText("470 characters left")).toBeVisible()

    // Review: every question shows the answer or "Left blank", and focus lands on the heading.
    await page.getByRole("button", { name: "Review my answers" }).click()
    const reviewHeading = page.getByRole("heading", { level: 2, name: "Check your answers" })
    await expect(reviewHeading).toBeFocused()
    const rows = page.locator(".feedback-summary > li")
    await expect(rows).toHaveCount(10)
    await expect(rows.nth(0)).toContainText("Yes, I want this change")
    await expect(rows.nth(1)).toContainText("No, keep it as it is")
    await expect(rows.nth(2)).toContainText("Left blank")
    await expect(page.getByText("More colors for decks please 😀")).toBeVisible()
    await expect(page.getByText("You can't change your answers after you send them.")).toBeVisible()
    await settle(page)
    await expectNoSeriousA11yIssues(page, "feedback-review", info)

    // Change my answers keeps everything.
    await page.getByRole("button", { name: "Change my answers" }).click()
    await expect(yes).toBeChecked()
    await expect(comment).toHaveValue("More colors for decks please 😀")
    await page.getByRole("button", { name: "Review my answers" }).click()

    // A double click sends once.
    await page.getByRole("button", { name: "Send my answers" }).dblclick()
    const done = page.getByRole("status").filter({ hasText: "Thanks! We got your answers." })
    await expect(done).toBeVisible()
    await expect(page.getByRole("heading", { level: 2, name: "Thanks! We got your answers." })).toBeFocused()
    await expect(done).toContainText(/Results come out Sunday, \w+ \d+ at 12:00 PM Central time\./)
    expect(await counts(page, poll.id)).toEqual({ responses: 1, answers: 2 })
    await settle(page)
    await expectNoSeriousA11yIssues(page, "feedback-sent", info)

    // A reload shows the answers already sent, read only.
    await page.reload()
    await expect(page.getByRole("heading", { level: 2, name: "We already have your answers for this poll. Thanks!" })).toBeVisible()
    await expect(page.getByRole("radio")).toHaveCount(0)
    await expect(page.locator(".feedback-summary > li").nth(0)).toContainText("Yes, I want this change")
    await settle(page)
    await expectNoSeriousA11yIssues(page, "feedback-already-sent", info)

    // Sending again from the API is acknowledged, never counted twice.
    const token = await tokenFor(page, SEEDED.demo.email)
    const again = await page.request.post(`${API}/feedback/polls/${poll.id}/responses`, {
      headers: { authorization: `Bearer ${token}` },
      data: { answers: [], comment: "Another try" },
    })
    expect(again.status()).toBe(200)
    expect(((await again.json()) as { status: string }).status).toBe("already_received")
    expect(await counts(page, poll.id)).toEqual({ responses: 1, answers: 2 })

    // Home now says thanks instead of asking.
    await page.goto("/dashboard")
    await expect(page.getByRole("complementary", { name: TITLE })).toContainText("Thanks! We got your answers.")
    expect([...hosts].every((host) => host === "localhost" || host === "127.0.0.1"), [...hosts].join(", ")).toBe(true)
  })

  test("an empty ballot asks to answer something or skip, and the message goes once they answer", async ({ page }) => {
    await scenario(page, "open")
    await loginAndWait(page, SEEDED.demo.email)
    await openPollPage(page)
    await page.getByRole("button", { name: "Review my answers" }).click()
    await expect(page.getByRole("alert")).toHaveText("Answer at least one question, or skip the poll.")
    await expect(page.getByRole("heading", { name: "Check your answers" })).toHaveCount(0)
    await page.getByRole("group", { name: `1. ${QUESTION_1}` }).getByRole("radio", { name: "No, keep it as it is" }).check()
    await expect(page.getByText("Answer at least one question, or skip the poll.")).toHaveCount(0)
  })

  test("one Skip skips the whole poll and is not a vote", async ({ page }, info) => {
    const [poll] = await scenario(page, "open")
    await loginAndWait(page, SEEDED.demo.email)
    await openPollPage(page)
    await page.getByRole("group", { name: `1. ${QUESTION_1}` }).getByRole("radio", { name: "Yes, I want this change" }).check()
    await page.getByRole("button", { name: "Skip this poll" }).click()
    await expect(page.getByRole("heading", { level: 2, name: "You skipped this poll. That's okay!" })).toBeFocused()
    expect(await counts(page, poll.id)).toEqual({ responses: 0, answers: 0 })
    await settle(page)
    await expectNoSeriousA11yIssues(page, "feedback-skipped", info)
  })

  test("a failed send keeps the answers, and trying again counts once", async ({ page }) => {
    const [poll] = await scenario(page, "open")
    await loginAndWait(page, SEEDED.demo.email)
    await openPollPage(page)
    await page.getByRole("group", { name: `1. ${QUESTION_1}` }).getByRole("radio", { name: "No, keep it as it is" }).check()
    await page.getByRole("button", { name: "Review my answers" }).click()
    let aborted = false
    await page.route(`${API}/feedback/polls/*/responses`, async (route) => {
      if (!aborted) {
        aborted = true
        await route.abort()
      } else {
        await route.continue()
      }
    })
    await page.getByRole("button", { name: "Send my answers" }).click()
    await expect(page.getByRole("alert")).toHaveText("We couldn't send your answers. They're still here. Try again.")
    await expect(page.locator(".feedback-summary > li").nth(0)).toContainText("No, keep it as it is")
    await page.getByRole("button", { name: "Send my answers" }).click()
    await expect(page.getByRole("heading", { level: 2, name: "Thanks! We got your answers." })).toBeVisible()
    expect(await counts(page, poll.id)).toEqual({ responses: 1, answers: 1 })
  })

  test("a second tab for the same student sees the answers as already sent", async ({ page, browser }) => {
    const [poll] = await scenario(page, "open")
    await loginAndWait(page, SEEDED.demo.email)
    await openPollPage(page)
    const other = await browser.newContext()
    const second = await other.newPage()
    await loginAndWait(second, SEEDED.demo.email)
    await openPollPage(second)
    for (const p of [page, second]) {
      await p.getByRole("group", { name: `1. ${QUESTION_1}` }).getByRole("radio", { name: "Yes, I want this change" }).check()
      await p.getByRole("button", { name: "Review my answers" }).click()
    }
    await page.getByRole("button", { name: "Send my answers" }).click()
    await expect(page.getByRole("heading", { level: 2, name: "Thanks! We got your answers." })).toBeVisible()
    // The other tab's send is acknowledged as already received, not counted.
    await second.getByRole("button", { name: "Send my answers" }).click()
    await expect(second.getByRole("heading", { level: 2, name: "Thanks! We got your answers." })).toBeVisible()
    await second.reload()
    await expect(second.getByRole("heading", { level: 2, name: "We already have your answers for this poll. Thanks!" })).toBeVisible()
    expect(await counts(page, poll.id)).toEqual({ responses: 1, answers: 1 })
    await other.close()
  })

  test("an unverified account sees how to verify, and no form", async ({ page }, info) => {
    const [poll] = await scenario(page, "open")
    // Not verified yet: sign-in lands on the code page; the rest of Luma still opens.
    await login(page, SEEDED.unverified.email)
    await expect(page).toHaveURL(/\/verify-email/)
    await page.goto("/feedback")
    await expect(page.getByRole("heading", { level: 1, name: TITLE })).toBeVisible()
    await expect(page.locator(".feedback-verify")).toContainText("Verify your email to answer the poll.")
    await expect(page.locator(".feedback-verify").getByRole("link", { name: "Enter code" })).toHaveAttribute("href", /^\/verify-email/)
    await expect(page.getByRole("radio")).toHaveCount(0)
    const token = await tokenFor(page, SEEDED.unverified.email)
    const direct = await page.request.post(`${API}/feedback/polls/${poll.id}/responses`, {
      headers: { authorization: `Bearer ${token}` },
      data: { answers: [], comment: "Hello" },
    })
    expect(direct.status()).toBe(403)
    expect(((await direct.json()) as { error_code: string }).error_code).toBe("email_unverified")
    expect(await counts(page, poll.id)).toEqual({ responses: 0, answers: 0 })
    await settle(page)
    await expectNoSeriousA11yIssues(page, "feedback-unverified", info)

    // They can still skip it in one tap, so Home stops asking.
    await page.getByRole("button", { name: "Skip this poll" }).click()
    await expect(page.getByRole("heading", { level: 2, name: "You skipped this poll. That's okay!" })).toBeFocused()
    await expect(page.getByRole("button", { name: "Answer it anyway" })).toHaveCount(0)
    expect(await counts(page, poll.id)).toEqual({ responses: 0, answers: 0 })
    await page.goto("/dashboard")
    await page.waitForLoadState("networkidle")
    await expect(page.getByRole("complementary", { name: TITLE })).toHaveCount(0)
  })

  test("with no poll open, it says when polls open", async ({ page }, info) => {
    await loginAndWait(page, SEEDED.demo.email)
    await page.goto("/feedback")
    await expect(page.getByRole("heading", { level: 2, name: "There's no poll open right now." })).toBeVisible()
    await expect(page.getByText("A new poll opens on the last Sunday of each month at noon Central time.")).toBeVisible()
    await expect(page.getByRole("link", { name: "Past results" })).toHaveAttribute("href", "/feedback/results")
    await settle(page)
    await expectNoSeriousA11yIssues(page, "feedback-none", info)
  })

  test("a deleted account's answers stay counted, and a new account with the same email can't vote again", async ({ page }, info) => {
    const [poll] = await scenario(page, "open")
    const student = await makeAccount(page, info, "fbdel")
    const headers = { authorization: `Bearer ${student.token}` }
    const current = await page.request.get(`${API}/feedback/current`, { headers })
    const { poll: open } = (await current.json()) as { poll: { questions: { id: string }[] } }
    const first = await page.request.post(`${API}/feedback/polls/${poll.id}/responses`, {
      headers,
      data: { answers: [{ question_id: open.questions[0].id, choice: "yes" }], comment: "Made-up comment that should be deleted" },
    })
    expect(first.status()).toBe(201)

    const deleted = await page.request.delete(`${API}/me/account`, { headers, data: { current_password: PASSWORD } })
    expect(deleted.status()).toBe(200)
    const { retained } = (await deleted.json()) as { retained: string[] }
    expect(retained).toContain("Your answers to monthly feedback polls stay in the totals, without your name. Your poll comments are deleted.")
    expect(await counts(page, poll.id)).toEqual({ responses: 1, answers: 1 })

    // Same email, new account.
    const signup = await page.request.post(`${API}/signup`, { data: { email: student.email, username: `${student.username}x`, password: PASSWORD } })
    const { ticket } = (await signup.json()) as { ticket: string }
    const { code } = await latestMail(page, student.email, "code")
    const verified = await page.request.post(`${API}/auth/verify-email`, { data: { ticket, email: student.email, code } })
    const { access_token } = (await verified.json()) as { access_token: string }
    const again = await page.request.post(`${API}/feedback/polls/${poll.id}/responses`, {
      headers: { authorization: `Bearer ${access_token}` },
      data: { answers: [{ question_id: open.questions[0].id, choice: "no" }], comment: null },
    })
    expect(again.status()).toBe(200)
    expect(await counts(page, poll.id)).toEqual({ responses: 1, answers: 1 })

    await loginAndWait(page, student.email)
    await page.goto("/feedback")
    await expect(page.getByRole("heading", { level: 2, name: "We already have your answers for this poll. Thanks!" })).toBeVisible()
  })
})

test.describe("the deadline", () => {
  test("one second before close the form is open; at close a send is refused and results appear", async ({ page }) => {
    const [poll] = await scenario(page, "open")
    const closes = new Date(poll.closes_at).getTime()
    await setClock(page, new Date(closes - 1000).toISOString())
    await loginAndWait(page, SEEDED.demo.email)
    await openPollPage(page)
    // Results stay private until the deadline.
    const token = await tokenFor(page, SEEDED.demo.email)
    const early = await page.request.get(`${API}/feedback/results/${poll.id}`, { headers: { authorization: `Bearer ${token}` } })
    expect(early.status()).toBe(409)
    expect(JSON.stringify(await early.json())).not.toMatch(/yes_pct|"yes"|participants/)
    await page.goto(`/feedback/results/${poll.id}`)
    await expect(page.getByText(/^Results come out Sunday, \w+ \d+ at 12:00 PM/)).toBeVisible()

    await openPollPage(page)
    await page.getByRole("group", { name: `1. ${QUESTION_1}` }).getByRole("radio", { name: "Yes, I want this change" }).check()
    await page.getByRole("button", { name: "Review my answers" }).click()
    await setClock(page, new Date(closes).toISOString())
    await page.getByRole("button", { name: "Send my answers" }).click()
    // Either the send is refused at the deadline, or the page noticed the close by itself first.
    await expect(page.getByRole("heading", { level: 2, name: /^This poll closed/ })).toBeVisible()
    expect(await counts(page, poll.id)).toEqual({ responses: 0, answers: 0 })

    await page.getByRole("link", { name: "See the results" }).click()
    await expect(page.getByRole("link", { name: /poll$/ })).toHaveCount(1)
    await page.getByRole("link", { name: /poll$/ }).click()
    await expect(page.getByRole("heading", { level: 2, name: "What students said" })).toBeVisible()
    // Nobody answered: one friendly line instead of a page of empty rows.
    await expect(page.getByText(NO_RESULTS)).toBeVisible()
    await expect(page.locator(".feedback-result")).toHaveCount(0)
  })
})

test.describe("results for students", () => {
  test("the Home results note can be dismissed, and goes away once the results are seen", async ({ page, browser }) => {
    const [poll] = await scenario(page, "closed")
    await loginAndWait(page, SEEDED.demo.email)
    const note = page.getByRole("complementary", { name: TITLE })
    await expect(note).toContainText("Poll results are in.")
    await note.getByRole("button", { name: "Got it" }).click()
    await expect(note).toHaveCount(0)
    await page.reload()
    await expect(page.locator(".next-step")).toBeVisible()
    await page.waitForLoadState("networkidle")
    await expect(page.getByRole("complementary", { name: TITLE })).toHaveCount(0)

    // Another student who opens the results page also stops seeing it.
    const otherContext = await browser.newContext()
    const other = await otherContext.newPage()
    await loginAndWait(other, SEEDED.sam.email)
    await expect(other.getByRole("complementary", { name: TITLE })).toContainText("Poll results are in.")
    await other.goto(`/feedback/results/${poll.id}`)
    await expect(other.getByRole("heading", { level: 2, name: "What students said" })).toBeVisible()
    await other.goto("/dashboard")
    await expect(other.locator(".next-step")).toBeVisible()
    await other.waitForLoadState("networkidle")
    await expect(other.getByRole("complementary", { name: TITLE })).toHaveCount(0)
    await otherContext.close()
  })

  test("percentages only, sorted by Yes, with no names, counts or comments", async ({ page }, info) => {
    const [poll] = await scenario(page, "closed")
    await loginAndWait(page, SEEDED.demo.email)
    await page.goto(`/feedback/results/${poll.id}`)
    await expect(page.getByRole("heading", { level: 1, name: TITLE })).toBeVisible()
    const rows = page.locator(".feedback-result")
    await expect(rows).toHaveCount(10)
    // 5 of 6 said yes (83%) comes first. Questions fewer than 5 students answered show no
    // percentages and go last, in question order.
    await expect(rows.nth(0)).toContainText("Make the Home page show your next quiz")
    await expect(rows.nth(0)).toContainText("Yes 83% · No 17%")
    await expect(rows.nth(2)).toContainText(QUESTION_2)
    await expect(rows.nth(2)).toContainText("Yes 50% · No 50%")
    await expect(rows.nth(8)).toContainText(QUESTION_1)
    await expect(rows.nth(8)).toContainText("Not enough answers yet")
    await expect(rows.nth(8).locator(".poll-bar")).toHaveCount(0)
    await expect(rows.nth(9)).toContainText("Let you pick a color for each deck")
    await expect(rows.nth(9)).toContainText("Not enough answers yet")
    await expect(page.getByText("We're reviewing your feedback.")).toBeVisible()

    const text = await page.locator("main").innerText()
    expect(text).not.toMatch(/SENTINEL-COMMENT-7|answered|skipped|No votes yet|seed-|@|password|—|75%/i)
    expect(text).not.toMatch(/\(\d+\)/)
    await expect(page.locator(".feedback-result img")).toHaveCount(0)

    const token = await tokenFor(page, SEEDED.demo.email)
    const body = await (await page.request.get(`${API}/feedback/results/${poll.id}`, { headers: { authorization: `Bearer ${token}` } })).text()
    expect(body).not.toMatch(/SENTINEL|seed-|"user_id"|response|participants|"yes":|"no":|answered|"email"|"username"|@/)
    await settle(page)
    await expectNoSeriousA11yIssues(page, "feedback-results", info)

    await page.goto("/feedback/results")
    await expect(page.getByRole("heading", { level: 1, name: /Past poll results/ })).toBeVisible()
    await expect(page.locator(".feedback-archive li")).toHaveCount(1)
    await settle(page)
    await expectNoSeriousA11yIssues(page, "feedback-archive", info)
  })

  test("results pages pass axe in the dark theme too", async ({ page }, info) => {
    const [poll] = await scenario(page, "closed")
    try {
      await setThemeMode(page, SEEDED.demo.email, "dark")
      await loginAndWait(page, SEEDED.demo.email)
      await expect(page.locator("html")).toHaveAttribute("data-theme", "dark")
      await page.goto(`/feedback/results/${poll.id}`)
      await expect(page.locator(".feedback-result")).toHaveCount(10)
      await settle(page)
      await expectNoSeriousA11yIssues(page, "feedback-results-dark", info)
      await scenario(page, "open")
      await openPollPage(page)
      await page.getByRole("group", { name: `1. ${QUESTION_1}` }).getByRole("radio", { name: "Yes, I want this change" }).check()
      await settle(page)
      await expectNoSeriousA11yIssues(page, "feedback-open-dark", info)
    } finally {
      await setThemeMode(page, SEEDED.demo.email, "light")
    }
  })

  test("the archive keeps the newest 24 polls; older ones drop off for students", async ({ page }) => {
    const polls = await scenario(page, "archive")
    expect(polls.length).toBeGreaterThan(24)
    await loginAndWait(page, SEEDED.demo.email)
    await page.goto("/feedback/results")
    await expect(page.locator(".feedback-archive li")).toHaveCount(24)
    const oldest = [...polls].sort((a, b) => a.closes_at.localeCompare(b.closes_at))[0]
    await page.goto(`/feedback/results/${oldest.id}`)
    await expect(page.getByText("We couldn't find those results. Older polls drop off after 2 years.")).toBeVisible()
  })
})
