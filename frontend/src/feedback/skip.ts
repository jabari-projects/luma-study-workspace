// "Skip this poll" is remembered on the server and, as a backup, on this device.
// "Poll results are in" is remembered on this device once seen or dismissed.
// Every read and write is wrapped: private windows and blocked storage just forget.
import { clearDrafts, resultsSeenKey, skipKey } from "./feedback"

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

export function readSkipped(accountId: string, pollId: string): boolean {
  return read(skipKey(accountId, pollId))
}

/** Not kept on this device when storage is blocked; the server still remembers the skip. */
export function rememberSkip(accountId: string, pollId: string): void {
  remember(skipKey(accountId, pollId))
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
