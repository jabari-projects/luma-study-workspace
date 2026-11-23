// Study area: the Study hub (/flashcards) with its ready strip, decks and quiz picker,
// deck editor, deck page, the review intro and flashcard session, quizzes from one or
// more decks (/quizzes?deck=a,b), Study plans in minutes, and the Home next step + week strip.
// Runs against the FAKE API only. Seeded decks are only read, never changed;
// anything that changes data uses a brand-new made-up account.
import AxeBuilder from "@axe-core/playwright"
import { expect, test, type Locator, type Page, type TestInfo } from "@playwright/test"

import { PASSWORD, SEEDED, fakeEmail, latestMail, loginAndWait, setThemeMode, answerSharePrompt } from "./helpers"

type Card = { front: string; back: string }

const CARDS: Card[] = [
  { front: "Capital of France", back: "Paris" },
  { front: "Two times eight", back: "Sixteen" },
  { front: "Color of clear daytime sky", back: "Blue" },
]

async function signUpFresh(page: Page, info: TestInfo) {
  const email = fakeEmail("study", info)
  const username = `s${Date.now().toString(36)}${info.project.name.slice(0, 2)}${Math.floor(Math.random() * 1000)}`
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
  return { email, username }
}

const field = (page: Page, name: string) => page.getByRole("textbox", { name, exact: true })

/** Makes a deck through the real editor and returns its id (from the URL). */
async function createDeck(page: Page, title: string, cards: Card[], tags = "") {
  await page.goto("/flashcards/new")
  await expect(page.getByRole("heading", { level: 1, name: "Make a deck" })).toBeVisible()
  await field(page, "Title").fill(title)
  if (tags) await field(page, "Tags").fill(tags)
  // The editor starts with two empty rows.
  for (let i = 2; i < cards.length; i += 1) await page.getByRole("button", { name: "Add card" }).click()
  for (const [i, card] of cards.entries()) {
    await field(page, `Question ${i + 1}`).fill(card.front)
    await field(page, `Answer ${i + 1}`).fill(card.back)
  }
  await expect(page.getByText(`${cards.length} cards ready`)).toBeVisible()
  // The first save makes the deck and keeps the editor open (it saves by itself from now on).
  await page.getByRole("button", { name: "Save deck" }).click()
  await expect(page).toHaveURL(/\/flashcards\/[^/]+\/edit$/)
  await expect(page.getByText(/^Saved at /)).toBeVisible()
  // A new item: "Share with the crowd?" asks right after its first save. Not now keeps it private.
  await answerSharePrompt(page)
  // Save deck again opens the deck.
  await page.getByRole("button", { name: "Save deck" }).click()
  await expect(page).toHaveURL(/\/flashcards\/[^/]+$/)
  await expect(page.getByRole("heading", { level: 1, name: title })).toBeVisible()
  return page.url().split("/").pop()!
}

/** The thing at the center of this element is the element itself, so a tap lands on it. */
async function expectNotCovered(target: Locator) {
  await expect(target).toBeInViewport({ ratio: 1 })
  const onTop = await target.evaluate((el) => {
    const box = el.getBoundingClientRect()
    const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2)
    return hit === el || el.contains(hit)
  })
  expect(onTop).toBe(true)
}

/** The two boxes on screen do not touch, e.g. a floating button and the row it could hide. */
async function expectApart(a: Locator, b: Locator) {
  const [boxA, boxB] = [await a.boundingBox(), await b.boundingBox()]
  expect(boxA).not.toBeNull()
  expect(boxB).not.toBeNull()
  const overlap =
    boxA!.x < boxB!.x + boxB!.width && boxB!.x < boxA!.x + boxA!.width && boxA!.y < boxB!.y + boxB!.height && boxB!.y < boxA!.y + boxA!.height
  expect(overlap, JSON.stringify({ boxA, boxB })).toBe(false)
}

/** A deck on the Study hub shelf. */
const deckTile = (page: Page, title: string) => page.locator("li.deck-tile").filter({ hasText: title })

/** The ready strip at the top of the Study hub. */
const readyStrip = (page: Page) => page.getByRole("region", { name: "Cards to review" })

/** The intro before the first card: check what it says, then Start. */
async function startReview(page: Page) {
  await expect(page.getByRole("heading", { level: 1, name: /^Ready to (review|practice)$/ })).toBeVisible()
  await page.getByRole("button", { name: "Start", exact: true }).click()
  await expect(page.locator(".study-stage")).toBeVisible()
}

/** A number in the deck page's stat row, e.g. deckStat(page, "ready now"). */
function deckStat(page: Page, label: string) {
  return page.locator(".deck-hero-info .stat-row > div").filter({ has: page.getByText(label, { exact: true }) }).locator("strong")
}

/** Home's slim week strip: seven stars and "N of 4 days this week". */
function weekPanel(page: Page) {
  return page.locator("section.week-strip")
}

/** The flashcard in the study room, showing its question / its answer. */
const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
const questionCard = (page: Page, card: Card) =>
  page.getByRole("button", { name: new RegExp(`Question: ?${escapeRegExp(card.front)} ?Tap to flip$`) })
const answerCard = (page: Page, card: Card) =>
  page.getByRole("button", { name: new RegExp(`^Answer ?: ?${escapeRegExp(card.back)} ?\\. Tap to see the question\\.$`) })

/** Waits until the previous quiz question has animated out, then returns the prompt. */
async function currentPrompt(page: Page) {
  await expect(page.locator(".quiz-question")).toHaveCount(1)
  await expect(page.locator(".feedback-bar")).toHaveCount(0)
  return (await page.locator(".quiz-prompt").innerText()).trim()
}

const AXE_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]

/** Serious/critical axe problems, as "rule target" strings. */
async function seriousAxe(page: Page, opts: { exclude?: string[]; include?: string; rules?: string[] } = {}) {
  let builder = new AxeBuilder({ page }).withTags(AXE_TAGS)
  if (opts.include) builder = builder.include(opts.include)
  for (const sel of opts.exclude ?? []) builder = builder.exclude(sel)
  if (opts.rules) builder = builder.withRules(opts.rules)
  const results = await builder.analyze()
  return results.violations
    .filter((v) => v.impact === "serious" || v.impact === "critical")
    .flatMap((v) => v.nodes.map((n) => `${v.id} ${n.target.join(" ")}`))
}

test.describe("Study hub (seeded accounts, read only)", () => {
  test("lists the account's decks with ready counts, review and quiz links", async ({ page }) => {
    await loginAndWait(page, SEEDED.demo.email)
    await page.goto("/flashcards")
    await expect(page.getByRole("heading", { level: 1, name: "Study" })).toBeVisible()
    // The hand-written note stays on the Study page.
    await expect(page.locator(".hand-note")).toHaveText("Challenge your mind to remember.")

    const solar = deckTile(page, "Solar System")
    const spanish = deckTile(page, "Spanish Basics")
    await expect(solar).toBeVisible()
    await expect(spanish).toBeVisible()
    // Solar: 3 new + 1 overdue = 4 ready (Saturn is due in 9 days). Spanish: 4 new.
    await expect(solar.getByText("5 cards · 4 ready")).toBeVisible()
    await expect(spanish.getByText("4 cards · 4 ready")).toBeVisible()
    await expect(solar.getByText("#science")).toBeVisible()
    // "% known" replaces "% Lumen". Saturn is the one card known well: 1 of 5.
    await expect(solar.getByText("20% known")).toBeVisible()
    await expect(solar).not.toContainText("Lumen")
    // A shared deck says "Shared"; a private one says nothing.
    await expect(spanish.getByText("Shared", { exact: true })).toBeVisible()
    await expect(solar.getByText("Shared", { exact: true })).toHaveCount(0)

    await expect(solar.getByRole("link", { name: "Review 4" })).toHaveAttribute("href", "/flashcards/d1/study")
    await expect(spanish.getByRole("link", { name: "Review 4" })).toHaveAttribute("href", "/flashcards/d2/study")
    await expect(spanish.getByRole("link", { name: "Quiz yourself" })).toHaveAttribute("href", "/quizzes?deck=d2")

    // The ready strip counts every deck (4 + 4) and opens the deck with the most ready.
    const strip = readyStrip(page)
    const line = strip.getByText("8 cards are ready across your decks. About 2 minutes.")
    await expect(line).toBeVisible()
    expect(await line.textContent()).toContain("2\u00a0minutes")
    await expect(strip).toContainText("Flip each card. Tell Luma how well you knew it. Luma picks when you see it again.")
    // It says which deck it starts with, since only that deck opens.
    await expect(strip.getByText("Starts with Solar System (4).")).toBeVisible()
    const reviewLink = strip.getByRole("link", { name: "Review cards" })
    await expect(reviewLink).toHaveAttribute("href", "/flashcards/d1/study")
    await expect(reviewLink).toHaveAccessibleDescription("Starts with Solar System (4).")

    // Other students' decks never show up here.
    await expect(page.locator("li.deck-tile")).toHaveCount(2)

    // Open a deck from the shelf.
    await solar.getByRole("link", { name: "Solar System" }).click()
    await expect(page).toHaveURL(/\/flashcards\/d1$/)
    await expect(page.getByRole("heading", { level: 1, name: "Solar System" })).toBeVisible()
    await expect(deckStat(page, "cards")).toHaveText("5")
    await expect(deckStat(page, "ready now")).toHaveText("4")
    await expect(deckStat(page, "known")).toHaveText("20%")
    await expect(page.locator(".card-list .card-q", { hasText: "Which planet is closest to the Sun?" })).toBeVisible()
    await expect(page.getByRole("link", { name: "Review 4 cards" })).toHaveAttribute("href", "/flashcards/d1/study")
    const quiz = page.getByRole("link", { name: "Quiz yourself" })
    await expect(quiz).toHaveAttribute("href", "/quizzes?deck=d1")
    // The page says where quiz questions come from.
    await expect(quiz).toHaveAccessibleDescription("Questions come from the 5 cards in this deck.")
    await expect(page.getByText("Questions come from the 5 cards in this deck.")).toBeVisible()
    await expect(page.getByRole("link", { name: "Edit" })).toBeVisible()
  })

  test("a different seeded account sees only its own decks", async ({ page }) => {
    await loginAndWait(page, SEEDED.sam.email)
    await page.goto("/flashcards")
    await expect(page.getByRole("heading", { level: 1, name: "Study" })).toBeVisible()
    await expect(page.getByRole("heading", { name: "Make a deck first" })).toBeVisible()
    await expect(page.getByText("Your quizzes use your cards.", { exact: false })).toBeVisible()
    await expect(page.getByRole("link", { name: "Make a deck" })).toHaveAttribute("href", "/flashcards/new")
    await expect(page.getByText("Solar System")).toHaveCount(0)
    // No ready strip and no quiz picker without decks.
    await expect(readyStrip(page)).toHaveCount(0)
    await expect(page.getByRole("button", { name: "Start quiz" })).toHaveCount(0)
  })

  test("a deck id from another account shows a not-found message", async ({ page }) => {
    await loginAndWait(page, SEEDED.sam.email)
    await page.goto("/flashcards/d1")
    await expect(page.getByRole("heading", { level: 1, name: "Deck not found" })).toBeVisible()
    await expect(page.getByRole("link", { name: "Back to Study" })).toHaveAttribute("href", "/flashcards")
  })

  test("/study opens the Study hub", async ({ page }) => {
    await loginAndWait(page, SEEDED.demo.email)
    await page.goto("/study")
    await expect(page).toHaveURL(/\/flashcards$/)
    await expect(page.getByRole("heading", { level: 1, name: "Study" })).toBeVisible()
  })

  test("one stamped button, no sideways scroll", async ({ page }) => {
    await loginAndWait(page, SEEDED.demo.email)
    await page.goto("/flashcards")
    await expect(readyStrip(page).getByRole("link", { name: "Review cards" })).toBeVisible()
    // Only the main action wears the hard 3px stamp shadow.
    const stamped = await page.evaluate(
      () => [...document.querySelectorAll("main *")].filter((el) => getComputedStyle(el).boxShadow.includes("3px 3px 0px")).length,
    )
    expect(stamped).toBeLessThanOrEqual(1)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  })
})

test.describe("quiz yourself from one or more decks (seeded, read only)", () => {
  test("hub chips open the quiz with both decks picked", async ({ page }) => {
    await loginAndWait(page, SEEDED.demo.email)
    await page.goto("/flashcards")
    const picker = page.getByRole("region", { name: "Quiz yourself" })
    await expect(picker).toContainText("Luma makes quiz questions from your flashcards. Pick one deck or more.")
    await expect(picker).toContainText("A quiz doesn't change when your cards come back.")
    const chips = picker.getByRole("group", { name: "Decks for your quiz" })
    const solar = chips.getByRole("button", { name: /Solar System/ })
    const spanish = chips.getByRole("button", { name: /Spanish Basics/ })
    // The first deck starts picked.
    await expect(solar).toHaveAttribute("aria-pressed", "true")
    await expect(spanish).toHaveAttribute("aria-pressed", "false")
    await spanish.click()
    await expect(spanish).toHaveAttribute("aria-pressed", "true")
    await expect(picker).toContainText("9 cards from 2 decks.")

    await picker.getByRole("button", { name: "Start quiz" }).click()
    await expect(page).toHaveURL(/\/quizzes\?deck=d1,d2$/)
    await expect(page.getByRole("heading", { level: 1, name: "Quiz yourself" })).toBeVisible()
    await expect(page.getByText("Answer questions made from your flashcards.")).toBeVisible()
    await expect(page.getByRole("button", { name: /Solar System/ })).toHaveAttribute("aria-pressed", "true")
    await expect(page.getByRole("button", { name: /Spanish Basics/ })).toHaveAttribute("aria-pressed", "true")
    await expect(page.getByText("9 cards picked — the quiz will have 9 questions.")).toBeVisible()
  })

  test("unpicking every deck says so and turns Start quiz off", async ({ page }) => {
    await loginAndWait(page, SEEDED.demo.email)
    // On the hub.
    await page.goto("/flashcards")
    const picker = page.getByRole("region", { name: "Quiz yourself" })
    await picker.getByRole("button", { name: /Solar System/ }).click()
    await expect(picker.getByRole("button", { name: /Solar System/ })).toHaveAttribute("aria-pressed", "false")
    await expect(picker.getByText("Pick at least one deck.")).toBeVisible()
    await expect(picker.getByRole("button", { name: "Start quiz" })).toBeDisabled()

    // On the quiz page.
    await page.goto("/quizzes?deck=d1,d2")
    for (const name of [/Solar System/, /Spanish Basics/]) await page.getByRole("button", { name }).click()
    await expect(page.getByText("Pick at least one deck.")).toBeVisible()
    await expect(page.getByText("Ready when you are")).toHaveCount(0)
    await expect(page.getByRole("button", { name: "Start quiz" })).toBeDisabled()
    await page.getByRole("button", { name: /Spanish Basics/ }).click()
    await expect(page.getByText("Ready when you are")).toBeVisible()
    await expect(page.getByRole("button", { name: "Start quiz" })).toBeEnabled()
  })

  test("a link to one deck and a link with an unknown deck still work", async ({ page }) => {
    await loginAndWait(page, SEEDED.demo.email)
    await page.goto("/quizzes?deck=d2,nope")
    await expect(page.getByRole("button", { name: /Spanish Basics/ })).toHaveAttribute("aria-pressed", "true")
    await expect(page.getByRole("button", { name: /Solar System/ })).toHaveAttribute("aria-pressed", "false")
  })
})

test.describe("make a deck (fresh account)", () => {
  test("empty shelf, editor checks, save, open, edit and delete", async ({ page }, info) => {
    await signUpFresh(page, info)

    // Empty states on Home, Study and Quiz yourself.
    await expect(page.getByRole("heading", { name: "Make your first flashcard deck" })).toBeVisible()
    await page.goto("/flashcards")
    await expect(page.getByRole("heading", { name: "Make a deck first" })).toBeVisible()
    await page.goto("/quizzes")
    await expect(page.getByRole("heading", { name: "Make a deck first" })).toBeVisible()

    await page.goto("/flashcards")
    await page.getByRole("link", { name: "New deck" }).click()
    await expect(page).toHaveURL(/\/flashcards\/new$/)

    // Checks before saving: the box above the cards says what is missing, and focus goes there.
    const problems = page.locator(".card-problems")
    await page.getByRole("button", { name: "Save deck" }).click()
    await expect(problems).toContainText("Add at least one card with a question and an answer.")
    await expect(problems).toContainText("Give your deck a title.")
    await expect(field(page, "Title")).toBeFocused()
    await field(page, "Title").fill("Made Up Facts")
    await expect(problems).not.toContainText("Give your deck a title.")
    await page.getByRole("button", { name: "Save deck" }).click()
    await expect(field(page, "Question 1")).toBeFocused()
    await field(page, "Question 1").fill("Half a card")
    await page.getByRole("button", { name: "Save deck" }).click()
    await expect(problems).toContainText("2 cards aren't filled in.")
    await expect(field(page, "Answer 1")).toBeFocused()
    await expect(page).toHaveURL(/\/flashcards\/new$/)

    // Fill it properly: two typed cards, one removed row, plus a pasted list.
    await field(page, "Answer 1").fill("Whole answer")
    await field(page, "Question 2").fill("Two plus two")
    await field(page, "Answer 2").fill("Four")
    await page.getByRole("button", { name: "Add card" }).click()
    await expect(field(page, "Question 3")).toBeVisible()
    await page.getByRole("button", { name: "Remove card 3" }).click()
    await expect(field(page, "Question 3")).toHaveCount(0)

    const make = page.getByRole("button", { name: "Make cards from my notes", exact: true })
    await make.click()
    await expect(make).toHaveAttribute("aria-expanded", "true")
    await page.getByRole("textbox", { name: "Your notes" }).fill("Capital of Spain - Madrid\nnot a card line\nThree squared - Nine")
    await page.getByRole("button", { name: "Find cards for free" }).click()
    await page.getByRole("button", { name: "Add 2 cards" }).click()
    await expect(page.getByText("Added 2 cards.")).toBeVisible()
    await expect(page.getByText("4 cards ready")).toBeVisible()
    await field(page, "Tags").fill("#trivia, math")

    // The first save makes the deck; the editor stays open and says it is saved.
    await page.getByRole("button", { name: "Save deck" }).click()
    await expect(page).toHaveURL(/\/flashcards\/[^/]+\/edit$/)
    await expect(page.getByRole("heading", { level: 1, name: "Edit your deck" })).toBeVisible()
    await expect(page.getByText(/^Saved at /)).toBeVisible()
    // A new item: "Share with the crowd?" asks right after its first save. Not now keeps it private.
    await answerSharePrompt(page)
    await page.getByRole("button", { name: "Save deck" }).click()
    await expect(page).toHaveURL(/\/flashcards\/[^/]+$/)
    await expect(page.getByRole("heading", { level: 1, name: "Made Up Facts" })).toBeVisible()
    await expect(deckStat(page, "cards")).toHaveText("4")
    await expect(deckStat(page, "ready now")).toHaveText("4")
    await expect(deckStat(page, "known")).toHaveText("0%")
    for (const text of ["Whole answer", "Four", "Madrid", "Nine"]) {
      await expect(page.locator(".card-list .card-a", { hasText: text })).toBeVisible()
    }
    await expect(page.getByRole("link", { name: "Review 4 cards" })).toBeVisible()

    // Shelf shows the new deck with tags and a review button.
    await page.getByRole("link", { name: "Back to Study", exact: true }).click()
    await expect(page).toHaveURL(/\/flashcards$/)
    const deckCard = deckTile(page, "Made Up Facts")
    await expect(deckCard.getByText("4 cards · 4 ready")).toBeVisible()
    await expect(deckCard.getByText("#trivia")).toBeVisible()
    await expect(deckCard.getByText("#math")).toBeVisible()
    await expect(deckCard.getByRole("link", { name: "Review 4" })).toBeVisible()
    await expect(readyStrip(page).getByText("4 cards are ready. About 1 minute.")).toBeVisible()
    await expect(readyStrip(page).getByText(/^Starts with/)).toHaveCount(0)

    // Edit: rename and keep the cards.
    await deckCard.getByRole("link", { name: "Made Up Facts" }).click()
    await page.getByRole("link", { name: "Edit" }).click()
    await expect(page.getByRole("heading", { level: 1, name: "Edit your deck" })).toBeVisible()
    await expect(field(page, "Title")).toHaveValue("Made Up Facts")
    await expect(field(page, "Tags")).toHaveValue("trivia, math")
    await expect(field(page, "Question 4")).toHaveValue("Three squared")
    await field(page, "Title").fill("Made Up Facts v2")
    await page.getByRole("button", { name: "Save deck" }).click()
    await expect(page.getByRole("heading", { level: 1, name: "Made Up Facts v2" })).toBeVisible()
    await expect(deckStat(page, "cards")).toHaveText("4")

    // Survives a reload (saved on the server, not just in memory).
    await page.reload()
    await expect(page.getByRole("heading", { level: 1, name: "Made Up Facts v2" })).toBeVisible()

    // Delete asks first, "Keep it" keeps it, "Yes, delete" removes it.
    await page.getByRole("button", { name: "Delete deck" }).click()
    await page.getByRole("button", { name: "Keep it" }).click()
    await expect(page.getByRole("heading", { level: 1, name: "Made Up Facts v2" })).toBeVisible()
    await page.getByRole("button", { name: "Delete deck" }).click()
    // Scrolled to the very bottom, nothing floats over "Yes, delete" (the tab bar; Share now sits in the header).
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight))
    await expectNotCovered(page.getByRole("button", { name: "Yes, delete" }))
    await expectNotCovered(page.getByRole("button", { name: "Keep it" }))
    await expectApart(page.locator(".quiet-zone .button-row"), page.locator("header.page-head").getByRole("button", { name: "Share", exact: true }))
    await page.getByRole("button", { name: "Yes, delete" }).click()
    await expect(page).toHaveURL(/\/flashcards$/)
    await expect(page.getByRole("heading", { name: "Make a deck first" })).toBeVisible()
  })
})

test.describe("study, quiz and Today (fresh account)", () => {
  test("study session grades cards; deck, shelf and Today update; quiz from the deck counts too", async ({ page }, info) => {
    await signUpFresh(page, info)
    const deckId = await createDeck(page, "Practice Deck", CARDS)

    // Home before studying: the new deck is the next step; the week is empty.
    await page.goto("/dashboard")
    const nextStep = page.getByRole("region", { name: "Review 3 cards in “Practice Deck”" })
    await expect(nextStep.getByRole("heading", { level: 2, name: "Review 3 cards in “Practice Deck”" })).toBeVisible()
    await expect(nextStep.getByText("Up next")).toBeVisible()
    // One deck, 3 cards at about 12 seconds each: rounds up to 1 minute.
    const readyLine = nextStep.getByText("3 cards are ready. About 1 minute.")
    await expect(readyLine).toBeVisible()
    // "1 minute" never breaks across two lines.
    expect(await readyLine.textContent()).toContain("1\u00a0minute")
    await expect(weekPanel(page)).toHaveAccessibleName("This week")
    await expect(weekPanel(page)).toContainText("0 of 4 days this week")
    await expect(weekPanel(page)).not.toContainText("Goal reached")
    await expect(weekPanel(page).locator("li")).toHaveCount(7)
    await expect(weekPanel(page).locator("li.lit")).toHaveCount(0)
    await expect(weekPanel(page).locator("li.today")).toContainText("no study yet")
    await expect(page.getByRole("link", { name: "Start now" })).toHaveAttribute("href", `/flashcards/${deckId}/study`)

    // The intro comes first: what this review has, about how long, and how it works.
    await page.getByRole("link", { name: "Start now" }).click()
    await expect(page).toHaveURL(new RegExp(`/flashcards/${deckId}/study$`))
    const intro = page.getByRole("region", { name: "Ready to review" })
    await expect(intro.getByRole("heading", { level: 1, name: "Ready to review" })).toBeVisible()
    await expect(intro).toContainText("3 cards are new. About 1 minute.")
    await expect(intro).toContainText("Look at the front. Think of the answer. Flip it. Then tap how well you knew it.")
    await expect(page.locator(".study-stage")).toHaveCount(0)
    // Focus starts on the heading, so the count, the time and the steps are read in order.
    await expect(intro.getByRole("heading", { level: 1, name: "Ready to review" })).toBeFocused()
    await intro.getByRole("button", { name: "Start", exact: true }).click()

    // Study session. New cards come in the order they were made.
    await expect(page.getByText("3 left")).toBeVisible()

    // Card 1: flip with "Show answer", then "Forgot" so it comes back later.
    await expect(questionCard(page, CARDS[0])).toHaveAttribute("aria-pressed", "false")
    await page.getByRole("button", { name: "Show answer" }).click()
    await expect(answerCard(page, CARDS[0])).toHaveAttribute("aria-pressed", "true")
    await expect(page.getByRole("button", { name: /^Got it/ })).toBeVisible()
    await page.getByRole("button", { name: "More choices" }).click()
    await expect(page.getByRole("button", { name: /^Tough/ })).toBeVisible()
    await expect(page.getByRole("button", { name: /^Easy/ })).toBeVisible()
    await page.getByRole("button", { name: /^Forgot/ }).click()

    // Card 2: tap the card itself to flip, then "Got it".
    await expect(questionCard(page, CARDS[1])).toHaveAttribute("aria-pressed", "false")
    await expect(page.getByText("3 left")).toBeVisible() // the missed card went back into the queue
    await questionCard(page, CARDS[1]).click()
    await expect(answerCard(page, CARDS[1])).toHaveAttribute("aria-pressed", "true")
    await page.getByRole("button", { name: /^Got it/ }).click()

    // Card 3: keyboard only. Space flips, 3 = Got it.
    await expect(questionCard(page, CARDS[2])).toBeVisible()
    await expect(page.getByText("2 left")).toBeVisible()
    await page.locator(".study-stage").focus()
    await page.keyboard.press("Space")
    await expect(answerCard(page, CARDS[2])).toHaveAttribute("aria-pressed", "true")
    await page.keyboard.press("3")

    // The missed card comes back; know it this time.
    await expect(questionCard(page, CARDS[0])).toBeVisible()
    await expect(page.getByText("1 left")).toBeVisible()
    await page.getByRole("button", { name: "Show answer" }).click()
    await page.getByRole("button", { name: /^Got it/ }).click()

    // Recap.
    await expect(page.getByRole("heading", { level: 1, name: "Review done" })).toBeVisible()
    await expect(page.getByText("Nice work!")).toBeVisible()
    await expect(page.getByText("Session done")).toHaveCount(0)
    const recapStat = (label: string) =>
      page.locator(".session-recap .stat-row > div").filter({ has: page.getByText(label, { exact: true }) }).locator("strong")
    await expect(recapStat("cards studied")).toHaveText("3")
    await expect(recapStat("to practice")).toHaveText("1")
    await expect(page.getByRole("heading", { name: "Cards to keep practicing" })).toBeVisible()
    await expect(page.locator(".session-recap .card-q")).toHaveText([CARDS[0].front])
    await expect(page.getByText(/^Next review:/)).toBeVisible()
    await expect(page.getByRole("link", { name: "Quiz yourself" })).toHaveAttribute("href", `/quizzes?deck=${deckId}`)

    // Progress is saved: the deck page after a reload has nothing due now.
    await page.getByRole("link", { name: "Back to deck" }).click()
    await expect(page).toHaveURL(new RegExp(`/flashcards/${deckId}$`))
    await page.reload()
    await expect(deckStat(page, "ready now")).toHaveText("0")
    const practice = page.getByRole("link", { name: "Practice anyway" })
    await expect(practice).toBeVisible()
    // Practising early is not free: it says the answers still count.
    const practiceNote = "These cards aren't due yet. Your answers still change when they come back."
    await expect(page.getByText(practiceNote)).toBeVisible()
    await expect(practice).toHaveAccessibleDescription(practiceNote)

    await page.goto("/flashcards")
    const shelfCard = deckTile(page, "Practice Deck")
    await expect(shelfCard.getByRole("link", { name: "Practice", exact: true })).toBeVisible()
    await expect(readyStrip(page)).toContainText("Nothing to review right now.")
    await expect(readyStrip(page).getByRole("link", { name: "Quiz yourself" })).toHaveAttribute("href", `/quizzes?deck=${deckId}`)
    await expect(readyStrip(page).getByRole("link", { name: "Review cards" })).toHaveCount(0)

    // Home after studying: caught up, today's star is lit with 4 reviews.
    await page.goto("/dashboard")
    await expect(page.getByRole("heading", { level: 2, name: "You're all caught up!" })).toBeVisible()
    await expect(weekPanel(page)).toContainText("1 of 4 days this week")
    await expect(weekPanel(page).locator("li.lit")).toHaveCount(1)
    await expect(weekPanel(page).locator("li.today")).toHaveClass(/lit/)
    await expect(weekPanel(page).locator("li.today")).toContainText("studied 4 cards")
    await expect(page.getByRole("link", { name: "Quiz yourself" })).toHaveAttribute("href", `/quizzes?deck=${deckId}`)

    // Quiz from the deck: "Pick the answer" only, 3 questions (deck has 3 cards).
    await page.getByRole("link", { name: "Quiz yourself" }).click()
    await expect(page).toHaveURL(new RegExp(`/quizzes\\?deck=${deckId}$`))
    await expect(page.getByRole("heading", { level: 1, name: "Quiz yourself" })).toBeVisible()
    await expect(page.getByRole("button", { name: /Practice Deck/ })).toHaveAttribute("aria-pressed", "true")
    await page.getByRole("button", { name: "True or false" }).click()
    await page.getByRole("button", { name: "Type the answer" }).click()
    await expect(page.getByRole("button", { name: "True or false" })).toHaveAttribute("aria-pressed", "false")
    await expect(page.getByRole("button", { name: "Pick the answer" })).toHaveAttribute("aria-pressed", "true")
    await page.getByRole("button", { name: "5", exact: true }).click()
    await expect(page.getByText("3 cards picked — the quiz will have 3 questions.")).toBeVisible()
    await page.getByRole("button", { name: "Start quiz" }).click()

    const answerFor = new Map(CARDS.map((c) => [c.front, c.back]))
    for (let i = 1; i <= 3; i += 1) {
      await expect(page.locator(".study-count")).toHaveText(`${i}/3`)
      const prompt = await currentPrompt(page)
      const answer = answerFor.get(prompt)
      expect(answer, `known answer for "${prompt}"`).toBeTruthy()
      if (i === 1) {
        // Get the first one wrong on purpose.
        const wrong = CARDS.map((c) => c.back).find((b) => b !== answer)!
        await page.getByRole("button", { name: wrong, exact: true }).click()
        await expect(page.getByRole("status").filter({ hasText: "Not quite" })).toBeVisible()
        await expect(page.getByRole("status").filter({ hasText: "Not quite" })).toContainText(`Answer: ${answer}`)
      } else {
        await page.getByRole("button", { name: answer!, exact: true }).click()
        await expect(page.getByRole("status").filter({ hasText: /Yes!|Nailed it!|Correct!|You got it!/ })).toBeVisible()
      }
      await page.getByRole("button", { name: i === 3 ? "See results" : "Next", exact: true }).click()
    }
    await expect(page.getByText("Quiz done")).toBeVisible()
    await expect(page.locator(".score-ring")).toContainText("67%")
    await expect(page.locator(".score-ring")).toContainText("2 of 3")
    await expect(page.getByRole("heading", { level: 2, name: "Study these again" })).toBeVisible()

    // Retry missed: one question, answer it right.
    await page.getByRole("button", { name: "Retry missed" }).click()
    await expect(page.locator(".study-count")).toHaveText("1/1")
    const retryPrompt = await currentPrompt(page)
    await page.getByRole("button", { name: answerFor.get(retryPrompt)!, exact: true }).click()
    await page.getByRole("button", { name: "See results" }).click()
    await expect(page.locator(".score-ring")).toContainText("100%")
    await expect(page.getByText("You got every one right!")).toBeVisible()

    // Home counts the quiz answers too: 4 reviews + 3 + 1 = 8, still one day.
    await page.goto("/dashboard")
    await expect(weekPanel(page).locator("li.today")).toContainText("studied 8 cards")
    await expect(weekPanel(page)).toContainText("1 of 4 days this week")
  })

  test("the review intro can be turned off for this account", async ({ page }, info) => {
    await signUpFresh(page, info)
    const deckId = await createDeck(page, "Intro Deck", CARDS)
    await page.goto(`/flashcards/${deckId}/study`)
    await expect(page.getByRole("heading", { level: 1, name: "Ready to review" })).toBeVisible()
    // "Back to deck" leaves without starting.
    await page.getByRole("link", { name: "Back to deck" }).click()
    await expect(page).toHaveURL(new RegExp(`/flashcards/${deckId}$`))

    await page.goto(`/flashcards/${deckId}/study`)
    await page.getByRole("checkbox", { name: "Don't show this again" }).check()
    await page.getByRole("button", { name: "Start", exact: true }).click()
    await expect(questionCard(page, CARDS[0])).toBeVisible()

    // After a reload the first card shows right away.
    await page.reload()
    await expect(questionCard(page, CARDS[0])).toBeVisible()
    await expect(page.getByRole("heading", { name: "Ready to review" })).toHaveCount(0)
  })

  test("Study plans are in minutes: 25 minutes saves as 1500 seconds", async ({ page }, info) => {
    await signUpFresh(page, info)
    await page.goto("/flashcards")
    await page.getByRole("main").getByRole("link", { name: "Study plans", exact: true }).click()
    await expect(page).toHaveURL(/\/study-sessions$/)
    await expect(page.getByRole("heading", { level: 1, name: "Study plans" })).toBeVisible()
    await expect(page.getByText("No study plans yet.")).toBeVisible()
    await expect(page.getByLabel("Minutes")).toBeVisible()
    await expect(page.getByText(/seconds/i)).toHaveCount(0)
    await expect(page.getByText(/study session/i)).toHaveCount(0)

    // A name is needed.
    await page.getByRole("button", { name: "Save plan" }).click()
    await expect(page.getByText("Give your plan a name.")).toBeVisible()

    await page.getByLabel("Name").fill("Chapter 3 review")
    await page.getByLabel("Subject (optional)").fill("Biology")
    await page.getByLabel("Minutes").fill("25")
    const sent = page.waitForRequest((request) => request.method() === "POST" && new URL(request.url()).pathname === "/study-sessions")
    await page.getByRole("button", { name: "Save plan" }).click()
    const body = (await sent).postDataJSON() as Record<string, unknown>
    expect(body.duration_seconds).toBe(1500)
    expect(body.name).toBe("Chapter 3 review")
    expect(body.subject).toBe("Biology")

    const row = page.locator("li.plan-row").filter({ hasText: "Chapter 3 review" })
    await expect(row).toContainText("Biology · 25 min")
    // Saved on the server: still there after a reload.
    await page.reload()
    await expect(row).toContainText("Biology · 25 min")

    // Delete asks first.
    await row.getByRole("button", { name: "Delete Chapter 3 review" }).click()
    const dialog = page.getByRole("alertdialog", { name: "Delete “Chapter 3 review”?" })
    await expect(dialog).toContainText("You can't get it back.")
    await dialog.getByRole("button", { name: "Keep it" }).click()
    await expect(row).toBeVisible()
    await row.getByRole("button", { name: "Delete Chapter 3 review" }).click()
    await page.getByRole("alertdialog").getByRole("button", { name: "Delete", exact: true }).click()
    await expect(row).toHaveCount(0)
    await expect(page.getByText("No study plans yet.")).toBeVisible()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  })

  test("Up next counts every deck, and the time matches that count", async ({ page }, info) => {
    await signUpFresh(page, info)
    await createDeck(page, "Small Deck", CARDS)
    await createDeck(page, "Bigger Deck", [...CARDS, { front: "Number of legs on a spider", back: "Eight" }])

    await page.goto("/dashboard")
    // The button studies the deck with the most cards ready...
    const nextStep = page.getByRole("region", { name: "Review 4 cards in “Bigger Deck”" })
    await expect(nextStep.getByRole("heading", { level: 2 })).toBeVisible()
    // ...and the line counts all 7. 7 cards at about 12 seconds each is 84 seconds, so 2 minutes
    // (the top deck alone would be 1 minute).
    const readyLine = nextStep.getByText("7 cards are ready across your decks. About 2 minutes.")
    await expect(readyLine).toBeVisible()
    expect(await readyLine.textContent()).toContain("2\u00a0minutes")
  })

  test("quiz link preselects that deck; typed answers forgive small typos", async ({ page }) => {
    await loginAndWait(page, SEEDED.demo.email)
    await page.goto("/quizzes?deck=d2")
    await expect(page.getByRole("button", { name: /Spanish Basics/ })).toHaveAttribute("aria-pressed", "true")
    await expect(page.getByRole("button", { name: /Solar System/ })).toHaveAttribute("aria-pressed", "false")
    await expect(page.getByText("4 cards picked — the quiz will have 4 questions.")).toBeVisible()

    // Turning every type off disables Start.
    for (const kind of ["Pick the answer", "True or false", "Type the answer"]) await page.getByRole("button", { name: kind }).click()
    await expect(page.getByText("Pick at least one question type")).toBeVisible()
    await expect(page.getByRole("button", { name: "Start quiz" })).toBeDisabled()
    await page.getByRole("button", { name: "Type the answer" }).click()
    await page.getByRole("button", { name: "Start quiz" }).click()

    const answers: Record<string, string> = { Hello: "Hola", "Thank you": "Gracias", Cat: "Gato", Water: "Agua" }
    for (let i = 1; i <= 4; i += 1) {
      await expect(page.locator(".study-count")).toHaveText(`${i}/4`)
      const prompt = await currentPrompt(page)
      // "Gracias" is 7 letters, so one missing letter is allowed. Case does not matter.
      await page.getByLabel("Your answer").fill(prompt === "Thank you" ? "gracas" : answers[prompt].toUpperCase())
      await page.getByRole("button", { name: "Check" }).click()
      await expect(page.getByRole("status").filter({ hasText: `Answer: ${answers[prompt]}` })).toBeVisible()
      await page.getByRole("status").getByRole("button", { name: i === 4 ? "See results" : "Next", exact: true }).click()
    }
    await expect(page.locator(".score-ring")).toContainText("100%")
    await expect(page.getByRole("heading", { level: 1, name: "Superstar!" })).toBeVisible()

    // Unknown deck id falls back to the first deck.
    await page.goto("/quizzes?deck=nope")
    await expect(page.getByRole("button", { name: /Solar System/ })).toHaveAttribute("aria-pressed", "true")
    await expect(page.getByRole("button", { name: /Spanish Basics/ })).toHaveAttribute("aria-pressed", "false")
  })

  test("typed-answer quiz keeps the cursor in the answer box for every question", async ({ page }) => {
    await loginAndWait(page, SEEDED.demo.email)
    await page.goto("/quizzes?deck=d2")
    await page.getByRole("button", { name: "Pick the answer" }).click()
    await page.getByRole("button", { name: "True or false" }).click()
    await page.getByRole("button", { name: "Start quiz" }).click()
    const input = page.getByLabel("Your answer")
    await expect(input).toBeFocused()
    await page.keyboard.type("zzz")
    await page.keyboard.press("Enter")
    await expect(page.getByRole("status").filter({ hasText: "Not quite" })).toBeVisible()
    await page.getByRole("status").getByRole("button", { name: "Next", exact: true }).click()
    await expect(page.locator(".study-count")).toHaveText("2/4")
    await expect(input).toBeEnabled()
    await expect(input).toBeFocused({ timeout: 3000 })
  })
})

test.describe("accessibility of study pages", () => {
  // These parts are left out here and checked one by one in the tests below.
  const KNOWN = [".identity", ".flip-card", ".grade-button.good > small", ".quiz-room .progress-track"]

  test("decks, deck, editor, study, quiz and Today have no other serious axe problems", async ({ page }, info) => {
    await signUpFresh(page, info)
    const deckId = await createDeck(page, "Axe Deck", CARDS)
    const found: string[] = []
    const scan = async (label: string) => {
      for (const v of await seriousAxe(page, { exclude: KNOWN })) found.push(`${label}: ${v}`)
    }
    await scan("deck-page")
    await page.goto("/flashcards")
    await expect(page.locator("li.deck-tile")).toHaveCount(1)
    await scan("decks")
    await page.goto("/flashcards/new")
    await expect(field(page, "Question 1")).toBeVisible()
    await scan("editor")
    await page.goto(`/flashcards/${deckId}/study`)
    await expect(page.getByRole("heading", { level: 1, name: "Ready to review" })).toBeVisible()
    await scan("study-intro")
    await startReview(page)
    await expect(page.getByRole("button", { name: "Show answer" })).toBeVisible()
    await scan("study-front")
    await page.getByRole("button", { name: "Show answer" }).click()
    await expect(page.getByRole("button", { name: /^Got it/ })).toBeVisible()
    await scan("study-back")
    await page.goto(`/quizzes?deck=${deckId}`)
    await expect(page.getByRole("button", { name: "Start quiz" })).toBeVisible()
    await scan("quiz-setup")
    await page.getByRole("button", { name: "Start quiz" }).click()
    await expect(page.locator(".quiz-prompt")).toBeVisible()
    await scan("quiz-question")
    await page.goto("/dashboard")
    await expect(page.getByRole("heading", { name: /Review 3 cards/ })).toBeVisible()
    await scan("today")
    expect(found).toEqual([])
  })

  test("study flashcard's spoken name includes its visible text", async ({ page }, info) => {
    await signUpFresh(page, info)
    const deckId = await createDeck(page, "Name Deck", CARDS)
    await page.goto(`/flashcards/${deckId}/study`)
    await startReview(page)
    await expect(questionCard(page, CARDS[0])).toBeVisible()
    expect(await seriousAxe(page, { include: ".study-stage", rules: ["label-content-name-mismatch"] })).toEqual([])
  })

  test("Got it interval text has enough contrast", async ({ page }, info) => {
    await signUpFresh(page, info)
    const deckId = await createDeck(page, "Contrast Deck", CARDS)
    await page.goto(`/flashcards/${deckId}/study`)
    await startReview(page)
    await page.getByRole("button", { name: "Show answer" }).click()
    await expect(page.getByRole("button", { name: /^Got it/ })).toBeVisible()
    expect(await seriousAxe(page, { include: ".grade-dock", rules: ["color-contrast"] })).toEqual([])
  })

  test("quiz progress bar has an accessible name", async ({ page }) => {
    await loginAndWait(page, SEEDED.demo.email)
    await page.goto("/quizzes?deck=d2")
    await page.getByRole("button", { name: "Start quiz" }).click()
    await expect(page.locator(".quiz-prompt")).toBeVisible()
    expect(await seriousAxe(page, { include: ".quiz-room", rules: ["aria-progressbar-name"] })).toEqual([])
  })

  test("desktop sidebar account button's spoken name includes its visible text", async ({ page }) => {
    await loginAndWait(page, SEEDED.demo.email)
    await page.goto("/flashcards")
    await expect(page.getByRole("heading", { level: 1, name: "Study" })).toBeVisible()
    expect(await seriousAxe(page, { rules: ["label-content-name-mismatch"] })).toEqual([])
  })

  // The hub, a deck, the review intro, a running quiz and Study plans, in light and dark.
  for (const theme of ["light", "dark"] as const) {
    test(`Study pages have no serious axe problems (${theme})`, async ({ page }) => {
      try {
        await setThemeMode(page, SEEDED.demo.email, theme)
        await loginAndWait(page, SEEDED.demo.email)
        await expect(page.locator("html")).toHaveAttribute("data-theme", theme)
        const found: string[] = []
        const scan = async (label: string) => {
          await page.waitForTimeout(600) // entrance animations
          for (const v of await seriousAxe(page, { exclude: KNOWN })) found.push(`${label}: ${v}`)
        }
        await page.goto("/flashcards")
        await expect(readyStrip(page)).toBeVisible()
        await scan("hub")
        await page.goto("/flashcards/d1")
        await expect(page.getByRole("heading", { level: 1, name: "Solar System" })).toBeVisible()
        await scan("deck")
        await page.goto("/flashcards/d1/study")
        await expect(page.getByRole("heading", { level: 1, name: "Ready to review" })).toBeVisible()
        await scan("intro")
        await page.goto("/quizzes?deck=d1,d2")
        await page.getByRole("button", { name: "Start quiz" }).click()
        await expect(page.locator(".quiz-prompt")).toBeVisible()
        await scan("quiz-running")
        await page.goto("/study-sessions")
        await expect(page.getByRole("heading", { level: 1, name: "Study plans" })).toBeVisible()
        await expect(page.locator(".spinner")).toHaveCount(0)
        await scan("study-plans")
        expect(found).toEqual([])
      } finally {
        await setThemeMode(page, SEEDED.demo.email, "light")
      }
    })
  }
})
