// "Poll results are in" is remembered on this device once seen or dismissed.
// ("Skip this poll" is remembered by the server only: see /feedback/current `skipped`.)
// Every read and write is wrapped: private windows and blocked storage just forget.
import { clearDrafts, resultsSeenKey } from "./feedback"

function read(key: string): boolean {
  try {
    return window.localStorage.getItem(key) === "1"
  } catch {
    return false
  }
}

function remember(key: string): void {
  try {
    window.localStorage.setItem(key, "1")
  } catch {
    // Not kept on this device.
  }
}

export function readResultsSeen(accountId: string, pollId: string): boolean {
  return read(resultsSeenKey(accountId, pollId))
}

export function rememberResultsSeen(accountId: string, pollId: string): void {
  remember(resultsSeenKey(accountId, pollId))
}

/** Unsent poll answers and comments leave this tab on sign-out or account switch. */
export function clearFeedbackDrafts(): void {
  try {
    clearDrafts(window.sessionStorage)
  } catch {
    // Storage blocked: nothing was saved.
  }
}
