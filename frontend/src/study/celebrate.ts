import confetti from "canvas-confetti"

import { activityKey } from "../accounts"

function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches
}

let starShape: confetti.Shape | null = null

function getStarShape(): confetti.Shape {
  if (!starShape) {
    starShape = confetti.shapeFromPath({
      path: "M12 0 L14.9 8.6 L24 9.2 L17 15 L19.4 24 L12 19 L4.6 24 L7 15 L0 9.2 L9.1 8.6 Z",
    })
  }
  return starShape
}

/** One celebratory burst of stars in the student's color. Used once, at the end of a session. */
export function celebrate() {
  if (prefersReducedMotion()) {
    return
  }
  // --accent always has a value: styles.css gives :root the default and the theme sets the student's pick.
  const accent = getComputedStyle(document.documentElement).getPropertyValue("--accent").trim()
  const colors = [accent, "#ffd166", "#ffffff", "#ff8fab"]
  const base = { spread: 70, startVelocity: 38, ticks: 140, gravity: 0.9, scalar: 1.1, colors, shapes: [getStarShape()] }
  void confetti({ ...base, particleCount: 40, origin: { x: 0.2, y: 0.7 }, angle: 60 })
  void confetti({ ...base, particleCount: 40, origin: { x: 0.8, y: 0.7 }, angle: 120 })
}

function dayKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`
}

// Study activity is kept per account, so two students on one device don't share a week.
function readActivity(userId: string): Record<string, number> {
  try {
    const raw = window.localStorage.getItem(activityKey(userId))
    return raw ? (JSON.parse(raw) as Record<string, number>) : {}
  } catch {
    return {}
  }
}

/** Remember that the student studied today (kept on this device). */
export function recordStudy(userId: string | null | undefined, cardsReviewed: number) {
  if (!userId) {
    return
  }
  try {
    const activity = readActivity(userId)
    const key = dayKey(new Date())
    activity[key] = (activity[key] ?? 0) + cardsReviewed
    window.localStorage.setItem(activityKey(userId), JSON.stringify(activity))
  } catch {
    // Storage can be blocked; studying still works.
  }
}

/** Monday-first list of this week's days and how many cards were reviewed on each. */
export function weekActivity(userId: string | null | undefined, now = new Date()) {
  const activity = userId ? readActivity(userId) : {}
  const monday = new Date(now)
  monday.setHours(0, 0, 0, 0)
  monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7))
  return Array.from({ length: 7 }, (_, index) => {
    const day = new Date(monday)
    day.setDate(monday.getDate() + index)
    const key = dayKey(day)
    return {
      key,
      label: day.toLocaleDateString(undefined, { weekday: "narrow" }),
      count: activity[key] ?? 0,
      isToday: key === dayKey(now),
      isFuture: day.getTime() > now.getTime(),
    }
  })
}
