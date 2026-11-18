// Maintenance breaks in the signed-in app, against the FAKE API (dev/mock-api.mjs):
// - typing during an announcement: the notice shows, focus and text stay;
// - getting ready (draining): a notice that can't be closed, with the work line;
// - the break itself: with everything saved the page is covered (the navigation stays); with
//   words not saved yet the editor stays open with a strong banner and Copy my text. Nothing
//   navigates, and an open editor keeps its text until Luma reopens;
// - the admin page: schedule (Central time preview, daylight saving refused), get ready,
//   "not safe yet" reasons, enter, run checks, reopen;
// - students never see the admin link or page.
// Made-up accounts and text only.
import { expect, test, type Page } from "@playwright/test"

import { SEEDED, expectNoSeriousA11yIssues, loginAndWait } from "./helpers"
import { apiCreate, saveLine, uniqueTitle } from "./work-helpers"
import {
  MAINT_ADMIN,
  centralInput,
  expectNoTechnicalText,
  minutesFromNow,
  nudgeFocusCheck,
  phaseBody,
  resetMaintenance,
  setMaintenance,
  setRunningJobs,
} from "./maintenance-helpers"

test.beforeEach(async ({ page }) => {
  await resetMaintenance(page)
})

test.afterEach(async ({ page }) => {
  await resetMaintenance(page)
})

const notesBox = (page: Page) => page.getByLabel("Your notes")

test("an announcement shows while a student types; focus and text stay", async ({ page }) => {
  await page.clock.install()
  await loginAndWait(page, SEEDED.demo.email)
  await page.goto("/notes/new")
  const box = notesBox(page)
  await box.click()
  await box.pressSequentially("Plants make food ")
  await setMaintenance(page, phaseBody("announced"))
  await nudgeFocusCheck(page)
  const notice = page.getByRole("status").filter({ hasText: "Luma will take a short break on" })
  await expect(notice).toBeVisible()
  await expect(notice).toContainText(/(CST|CDT)\b.*Your saved work is safe\./)
  await expect(box).toBeFocused()
  await page.keyboard.type("from sunlight.")
  await expect(box).toHaveValue("Plants make food from sunlight.")
  await expect(page).toHaveURL(/\/notes\/new$/)
  await expectNoTechnicalText(page)

  // Closing it keeps it closed in this tab.
  await notice.getByRole("button", { name: "Close this notice" }).click()
  await expect(notice).toHaveCount(0)
  await page.reload()
  await expect(page.getByLabel("Your notes")).toBeVisible()
  await expect(page.getByText("Luma will take a short break on")).toHaveCount(0)
})

test("getting ready: a notice that can't be closed, with the work line", async ({ page }, info) => {
  await setMaintenance(page, phaseBody("draining"))
  await loginAndWait(page, SEEDED.demo.email)
  const notice = page.getByRole("status").filter({ hasText: "Luma is getting ready for a short break" })
  await expect(notice).toBeVisible()
  await expect(notice).toContainText("Finish and save your work now.")
  await expect(notice).toContainText("All your work in this tab is saved.")
  await expect(notice.getByRole("button", { name: "Close this notice" })).toHaveCount(0)
  await expectNoSeriousA11yIssues(page, `draining-notice-${info.project.name}`, info)
})

test("the break covers the page but keeps the navigation, and nothing navigates", async ({ page }, info) => {
  await page.clock.install()
  await loginAndWait(page, SEEDED.demo.email)
  // An editor whose words are all saved, so the break covers it (section C.9).
  const note = await apiCreate(page, SEEDED.demo.email, "notes", { title: uniqueTitle("Break cover", info), content: "SYNTH saved.", tags: [] })
  await page.goto(`/notes/${note.id}/edit`)
  await notesBox(page).fill("My saved idea about cells.")
  await page.clock.runFor(2_500) // the autosave wait
  await expect(saveLine(page)).toHaveText(/^Saved at/)

  await setMaintenance(page, phaseBody("active"))
  await nudgeFocusCheck(page)
  const cover = page.getByRole("region", { name: "Luma is taking a short break" })
  await expect(cover).toBeVisible()
  await expect(cover).toContainText("Your saved work is safe.")
  await expect(cover).toContainText("This is a guess, not a promise.")
  await expect(page).toHaveURL(new RegExp(`/notes/${note.id}/edit$`)) // no forced navigation
  await expect(notesBox(page)).toBeHidden()
  const nav = info.project.name === "phone" ? page.getByRole("navigation", { name: "Main navigation" }) : page.getByRole("complementary", { name: "Main navigation" })
  await expect(nav).toBeVisible()
  await expectNoTechnicalText(page)
  await expectNoSeriousA11yIssues(page, `break-cover-${info.project.name}`, info)

  // Luma reopens: the editor comes back with the text still in it (it was never unmounted).
  await setMaintenance(page, { phase: "none", reopened_at: minutesFromNow(0) })
  await nudgeFocusCheck(page)
  await expect(cover).toHaveCount(0)
  await expect(notesBox(page)).toHaveValue("My saved idea about cells.")
  await expect(page.getByRole("status").filter({ hasText: "Luma is back. Thanks for waiting!" })).toBeVisible()
})

test("with words that aren't saved, the break keeps the editor open and offers Copy my text", async ({ page }, info) => {
  await page.clock.install()
  await loginAndWait(page, SEEDED.demo.email)
  await page.goto("/notes/new")
  await notesBox(page).fill("My unsaved idea about cells.")

  await setMaintenance(page, phaseBody("active"))
  await nudgeFocusCheck(page)
  const banner = page.getByRole("alert").filter({ hasText: "Your work isn't saved yet. Keep this tab open. Copy your text to be safe." })
  await expect(banner).toBeVisible()
  await expect(banner).toContainText("This is a guess, not a promise.")
  await expect(banner.getByRole("button", { name: "Copy my text" })).toBeVisible()
  await expect(page.getByRole("region", { name: "Luma is taking a short break" })).toHaveCount(0)
  await expect(page).toHaveURL(/\/notes\/new$/) // no forced navigation
  await expect(notesBox(page)).toHaveValue("My unsaved idea about cells.")
  await expectNoTechnicalText(page)
  await expectNoSeriousA11yIssues(page, `break-unsaved-${info.project.name}`, info)

  await setMaintenance(page, { phase: "none", reopened_at: minutesFromNow(0) })
  await nudgeFocusCheck(page)
  await expect(banner).toHaveCount(0)
  await expect(notesBox(page)).toHaveValue("My unsaved idea about cells.")
  await expect(page.getByRole("status").filter({ hasText: "Luma is back. Thanks for waiting!" })).toBeVisible()
})

test("a student learns about the break from any answer, not by polling", async ({ page }, info) => {
  await loginAndWait(page, SEEDED.demo.email)
  let statusChecks = 0
  page.on("request", (request) => {
    if (request.url().includes("/maintenance/status")) statusChecks += 1
  })
  await page.waitForTimeout(3_000)
  expect(statusChecks, "no checks while nothing happens").toBe(0)
  await setMaintenance(page, phaseBody("announced"))
  // Opening Notes (inside the app, no reload) loads the list; that answer carries the new
  // rev, so the app checks once.
  const nav = info.project.name === "phone" ? page.getByRole("navigation", { name: "Main navigation" }) : page.getByRole("complementary", { name: "Main navigation" })
  await nav.getByRole("link", { name: "Notes", exact: true }).click()
  await expect(page.getByText("Luma will take a short break on")).toBeVisible()
  expect(statusChecks).toBe(1)
})

test("the admin runs a whole break from the admin page", async ({ page }, info) => {
  test.setTimeout(120_000)
  await loginAndWait(page, MAINT_ADMIN.email)
  if (info.project.name !== "phone") {
    await page.getByRole("complementary", { name: "Main navigation" }).getByRole("link", { name: "Maintenance" }).click()
  } else {
    await page.goto("/admin/maintenance")
  }
  await expect(page.getByRole("heading", { level: 1, name: "Maintenance" })).toBeVisible()
  await expect(page.getByText("Best time: Tuesday or Wednesday, 5:00 to 6:00 AM Central.")).toBeVisible()
  await expectNoSeriousA11yIssues(page, `admin-maintenance-${info.project.name}`, info)

  // Daylight saving: a skipped time is refused in the preview and by the server.
  const start = page.getByLabel("Starts (Central time, Chicago)")
  const end = page.getByLabel("Ends about (Central time, Chicago)")
  await start.fill("2030-03-10T02:30")
  await expect(page.getByText("That time is skipped when clocks change. Pick another time.").first()).toBeVisible()
  await end.fill("2030-03-10T04:00")
  await page.getByRole("button", { name: "Schedule the break" }).click()
  await expect(page.getByRole("alert")).toContainText("That time is skipped when clocks change.")

  await start.fill(centralInput(2, "05:00"))
  await expect(page.getByText(/^That is .* 5:00 AM C[SD]T\.$/)).toBeVisible()
  await end.fill(centralInput(2, "06:00"))
  await page.getByLabel("Why").selectOption("database_update")
  await page.getByRole("button", { name: "Schedule the break" }).click()
  await expect(page.getByText("The break is scheduled. Students will see a notice.")).toBeVisible()
  await expect(page.getByRole("region", { name: "The break is announced" })).toBeVisible()

  await page.getByLabel("Minutes students get to finish saving").selectOption("5")
  await page.getByRole("button", { name: "Start getting ready" }).click()
  const ready = page.getByRole("region", { name: "Getting ready" })
  await expect(ready).toBeVisible()

  // Not safe yet: grace time left, a job running, no backup stamp.
  await setRunningJobs(page, 1)
  await page.getByRole("button", { name: "Look again" }).click()
  await page.getByRole("button", { name: "Enter maintenance" }).click()
  const refused = page.getByRole("alert").filter({ hasText: "It isn't safe to start yet." })
  await expect(refused).toBeVisible()
  await expect(refused).toContainText(/Students still have about \d+ minutes? to save\./)
  await expect(refused).toContainText("1 AI or long task is still running.")
  await expect(refused).toContainText("Type the stamp of a backup made in this break")
  await expect(page.getByRole("region", { name: "Getting ready" })).toBeVisible()

  // The grace time ends and the job finishes (fake hooks), then the admin tries again.
  await setRunningJobs(page, 0)
  await setMaintenance(page, { drain_started_at: minutesFromNow(-6), grace_ends_at: minutesFromNow(-1) })
  await page.getByRole("button", { name: "Look again" }).click()
  await expect(ready.getByText("Everything looks ready.")).toHaveCount(0) // still needs the backup stamp
  await page.getByLabel(/Backup stamp \(needed\)/).fill("20301201T103000Z")
  await page.getByLabel("I checked this backup's restore test passed.").check()
  await page.getByRole("button", { name: "Enter maintenance" }).click()
  await expect(page.getByText("Maintenance started. Students see the break page.")).toBeVisible()
  await expect(page.getByRole("region", { name: "In maintenance" })).toBeVisible()
  // The admin's own page is not covered (the admin routes stay open), and the status says so.
  await expect(page.getByRole("heading", { level: 1, name: "Maintenance" })).toBeVisible()

  // A failed check keeps Luma closed.
  await setMaintenance(page, { fail_checks: ["storage"] })
  await page.getByRole("button", { name: "Look again" }).click()
  await page.getByRole("button", { name: "Run checks" }).click()
  await expect(page.getByText("Failed: Picture storage answers")).toBeVisible()
  await expect(page.getByRole("button", { name: "Reopen Luma" })).toBeDisabled()

  await setMaintenance(page, { fail_checks: [] })
  await page.getByRole("button", { name: "Look again" }).click()
  await page.getByRole("button", { name: "Run checks again" }).click()
  await expect(page.getByText("Passed: No records were lost")).toBeVisible()
  await page.getByRole("button", { name: "Reopen Luma" }).click()
  await expect(page.getByText("Luma is open again.")).toBeVisible()
  await expect(page.getByRole("region", { name: "Schedule a break" })).toBeVisible()
  await expect(page.getByRole("region", { name: "What happened" })).toContainText("Luma reopened")
  await expectNoTechnicalText(page)
})

test("students don't see the admin link or page", async ({ page }, info) => {
  await loginAndWait(page, SEEDED.sam.email)
  if (info.project.name !== "phone") {
    await expect(page.getByRole("complementary", { name: "Main navigation" }).getByRole("link", { name: "Maintenance" })).toHaveCount(0)
  }
  await page.goto("/admin/maintenance")
  await expect(page.getByRole("heading", { level: 1, name: "Page not found" })).toBeVisible()
  await expect(page.getByText("Schedule a break")).toHaveCount(0)
})
