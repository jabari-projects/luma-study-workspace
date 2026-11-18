// Every sentence students and the admin see about a break, in one place.
// Plain words, sentence case, about a 3rd-grade reading level. Never a host name, port,
// status number or error text from the network.
import type { MaintenanceReason, MaintenanceStatus } from "./store.ts"
import type { UnsavedSummary } from "../work/unsaved.ts"
import { centralParts, centralTime, formatCentral, viewerTimeNote } from "./time.ts"

export const CANT_REACH = "We can't reach Luma right now. Try again in a minute."
export const SAVED_WORK_SAFE = "Your saved work is safe."

export const REASON_WORDS: Record<Exclude<MaintenanceReason, "">, string> = {
  database_update: "We're making the place where your work is kept better.",
  website_update: "We're updating the website.",
  backup_check: "We're checking the safety copy of your work.",
  other: "We're doing some upkeep.",
}

/** Admin pick list labels for the reason. */
export const REASON_LABELS: Record<Exclude<MaintenanceReason, "">, string> = {
  database_update: "Database update (needs a fresh backup)",
  website_update: "Website update",
  backup_check: "Backup check",
  other: "Something else",
}

export function reasonWords(reason: MaintenanceReason): string {
  return reason ? REASON_WORDS[reason] : ""
}

function withViewerTime(value: string | null): string {
  const note = viewerTimeNote(value)
  return note ? ` (${note})` : ""
}

/** "Luma will take a short break on Tue, Dec 1 at 5:00 AM CST. Your saved work is safe." */
export function announcedText(status: MaintenanceStatus): string {
  const { day, time } = centralParts(status.start_at)
  if (!day) return `Luma will take a short break soon. ${SAVED_WORK_SAFE}`
  return `Luma will take a short break on ${day} at ${time}${withViewerTime(status.start_at)}. ${SAVED_WORK_SAFE}`
}

export const DRAINING_TEXT = "Luma is getting ready for a short break. Finish and save your work now."
export const ACTIVE_TITLE = "Luma is taking a short break"
export const UNSAVED_DURING_BREAK =
  "Your work isn't saved yet. Keep this tab open. Copy your text to be safe."
export const BACK_TEXT = "Luma is back. Thanks for waiting!"

/** "We hope to be back around 6:00 AM CST. This is a guess, not a promise." */
export function estimateText(status: MaintenanceStatus): string {
  const time = centralTime(status.estimated_end_at)
  if (!time) return "We don't know yet when Luma will be back. Check again soon."
  return `We hope to be back around ${time}${withViewerTime(status.estimated_end_at)}. This is a guess, not a promise.`
}

/** The draining work line, from this tab's unsaved-work counts. */
export function workLine(summary: UnsavedSummary): string {
  const notSaved = summary.unsaved + summary.failed
  if (notSaved > 0) {
    return notSaved === 1
      ? "1 thing isn't saved yet. Open it and tap Save."
      : `${notSaved} things aren't saved yet. Open them and tap Save.`
  }
  if (summary.saving > 0) return "Saving your work..."
  return "All your work in this tab is saved."
}

/** One line for the status page heading. */
export function statusHeadline(status: MaintenanceStatus | null): string {
  if (!status) return "Luma status"
  switch (status.phase) {
    case "none":
      return status.recently_reopened ? BACK_TEXT : "Luma is working"
    case "announced":
      return "A short break is coming"
    case "draining":
      return "Luma is getting ready for a short break"
    default:
      return ACTIVE_TITLE
  }
}

export function startText(status: MaintenanceStatus): string {
  return status.start_at ? `Starts ${formatCentral(status.start_at)}${withViewerTime(status.start_at)}` : ""
}

/** Admin words for each reason the server gives when it isn't safe to start yet. */
export function safetyWords(reason: { code: string; seconds_left?: number; count?: number }): string {
  const n = reason.count ?? 0
  switch (reason.code) {
    case "grace_not_over": {
      const minutes = Math.max(1, Math.ceil((reason.seconds_left ?? 0) / 60))
      return `Students still have about ${minutes} ${minutes === 1 ? "minute" : "minutes"} to save.`
    }
    case "jobs_running":
      return `${n} AI or long ${n === 1 ? "task is" : "tasks are"} still running.`
    case "requests_in_flight":
      return `${n} ${n === 1 ? "request is" : "requests are"} still being answered.`
    case "instance_silent":
      return `${n} ${n === 1 ? "server" : "servers"} stopped reporting while busy. Wait up to 10 minutes.`
    case "backup_missing":
      return "Type the stamp of a backup made in this break, and tick the box after its restore test passed."
    case "database_unreachable":
      return "We couldn't count the records. Try again."
    default:
      return "Something isn't ready yet. Try again."
  }
}

export const CHECK_LABELS: Record<string, string> = {
  database: "The database answers",
  schema: "Every needed table and column is there",
  records_kept: "No records were lost",
  log_write: "The break log can be written",
  storage: "Picture storage answers",
  code_version: "Code version noted",
}

export const ACTION_WORDS: Record<string, string> = {
  schedule: "Break scheduled",
  change: "Break changed",
  postpone: "Break moved",
  cancel: "Break cancelled",
  drain: "Getting ready started",
  activate: "Maintenance started",
  activate_refused: "Not safe to start yet",
  checks: "Checks run",
  log_check: "Log check",
  reopen: "Luma reopened",
}

export const PHASE_WORDS: Record<string, string> = {
  none: "Open",
  announced: "Break announced",
  draining: "Getting ready",
  active: "In maintenance",
  checking: "Checking",
}
