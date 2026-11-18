// Central (Chicago) time for maintenance breaks. Pure functions: no network, no storage.
// The server stores UTC and is the judge of every time; these helpers only show times and
// give the admin a live preview while typing.

export const CHICAGO = "America/Chicago"

const centralFormat = new Intl.DateTimeFormat("en-US", {
  timeZone: CHICAGO,
  weekday: "short",
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
  timeZoneName: "short",
})

const wallFormat = new Intl.DateTimeFormat("en-US", {
  timeZone: CHICAGO,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
})

function toDate(value: string | Date | null | undefined): Date | null {
  if (!value) return null
  const date = value instanceof Date ? value : new Date(value)
  return Number.isNaN(date.getTime()) ? null : date
}

/** "Tue, Dec 1, 5:00 AM CST" (CST or CDT, whichever is in effect that day). */
export function formatCentral(value: string | Date | null | undefined): string {
  const date = toDate(value)
  return date ? centralFormat.format(date) : ""
}

/** {day: "Tue, Dec 1", time: "5:00 AM CST"} for sentences like "on Tue, Dec 1 at 5:00 AM CST". */
export function centralParts(value: string | Date | null | undefined): { day: string; time: string } {
  const date = toDate(value)
  if (!date) return { day: "", time: "" }
  const parts = centralFormat.formatToParts(date)
  const pick = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? ""
  return {
    day: `${pick("weekday")}, ${pick("month")} ${pick("day")}`,
    time: `${pick("hour")}:${pick("minute")} ${pick("dayPeriod")} ${pick("timeZoneName")}`,
  }
}

/** "5:00 AM CST" */
export function centralTime(value: string | Date | null | undefined): string {
  return centralParts(value).time
}

/**
 * The same moment in the viewer's own time zone, when that zone shows a different clock
 * time than Chicago: "7:00 AM your time". Empty when it would say the same thing.
 */
export function viewerTimeNote(value: string | Date | null | undefined, viewerZone?: string): string {
  const date = toDate(value)
  if (!date) return ""
  let zone = viewerZone
  try {
    zone = zone ?? Intl.DateTimeFormat().resolvedOptions().timeZone
  } catch {
    return ""
  }
  if (!zone || zone === CHICAGO) return ""
  let local: string
  try {
    local = new Intl.DateTimeFormat("en-US", { timeZone: zone, hour: "numeric", minute: "2-digit" }).format(date)
  } catch {
    return ""
  }
  const central = new Intl.DateTimeFormat("en-US", { timeZone: CHICAGO, hour: "numeric", minute: "2-digit" }).format(date)
  return local === central ? "" : `${local} your time`
}

/** "2:41 PM" in the viewer's own clock (for "Last checked ..."). */
export function shortClock(value: Date | number): string {
  return new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit" }).format(new Date(value))
}

export type CentralChoice =
  | { kind: "ok"; utc: Date }
  | { kind: "skipped" }
  | { kind: "twice" }
  | { kind: "invalid" }

const LOCAL_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/

function wallOf(date: Date): string {
  const parts = wallFormat.formatToParts(date)
  const pick = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? ""
  return `${pick("year")}-${pick("month")}-${pick("day")}T${pick("hour")}:${pick("minute")}`
}

/**
 * A Chicago wall-clock time ("2026-12-01T05:00", what a datetime-local field gives) as a
 * real moment. Chicago is UTC-6 (CST) or UTC-5 (CDT): a time that matches neither is
 * skipped when clocks spring forward; one that matches both happens twice in the fall.
 * The server makes the same check (backend/app/maintenance.py chicago_to_utc).
 */
export function centralChoice(local: string): CentralChoice {
  const m = LOCAL_RE.exec(local)
  if (!m) return { kind: "invalid" }
  const [, y, mo, d, h, mi] = m.map(Number)
  const asUtc = Date.UTC(y, mo - 1, d, h, mi)
  const check = new Date(asUtc)
  if (check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d || h > 23 || mi > 59) return { kind: "invalid" }
  const matches = [5, 6]
    .map((hours) => new Date(asUtc + hours * 3_600_000))
    .filter((candidate) => wallOf(candidate) === local)
  if (matches.length === 0) return { kind: "skipped" }
  if (matches.length > 1) return { kind: "twice" }
  return { kind: "ok", utc: matches[0] }
}

/** Plain words for the admin preview line under a time field. */
export function centralPreview(local: string): string {
  if (!local) return ""
  const choice = centralChoice(local)
  if (choice.kind === "skipped") return "That time is skipped when clocks change. Pick another time."
  if (choice.kind === "twice") return "That time happens twice when clocks change. Pick another time."
  if (choice.kind === "invalid") return "Pick a day and a time."
  return `That is ${formatCentral(choice.utc)}.`
}

/** A UTC time as the value a datetime-local field needs, in Chicago time ("2026-12-01T05:00"). */
export function toCentralInput(value: string | Date | null | undefined): string {
  const date = toDate(value)
  return date ? wallOf(date) : ""
}
