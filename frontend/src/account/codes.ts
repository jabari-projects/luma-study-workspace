import { useCallback, useEffect, useState } from "react"

/** Emailed codes: shared by the code page and the email change in Settings. */
export const CODE_LENGTH = 6

export const CODE_ERRORS: Record<string, string> = {
  code_incorrect: "That code doesn't match. Check your newest email and try again.",
  code_expired: "That code is too old. Tap \"Send a new code\".",
  code_locked: "Too many tries with that code. Tap \"Send a new code\".",
  rate_limited: "Too many tries. Wait a little, then try again.",
}

export function cleanCode(raw: string): string {
  return raw.replace(/\D/g, "").slice(0, CODE_LENGTH)
}

/** How long to wait, in plain words: "in 40 seconds", "in 15 minutes", "in 3 hours" or "tomorrow". */
export function waitWords(seconds: number): string {
  if (seconds < 60) {
    const whole = Math.max(1, Math.ceil(seconds))
    return `in ${whole} ${whole === 1 ? "second" : "seconds"}`
  }
  if (seconds < 90 * 60) {
    const minutes = Math.ceil(seconds / 60)
    return `in ${minutes} ${minutes === 1 ? "minute" : "minutes"}`
  }
  if (seconds < 20 * 60 * 60) {
    return `in ${Math.ceil(seconds / 3600)} hours`
  }
  return "tomorrow"
}

/**
 * Seconds left on a wait, such as until "Send a new code" works again. It counts
 * down to a fixed end time (so a slow background tab can't stretch it), then stops.
 * Anything that isn't a positive number of seconds means no wait.
 */
export function useCountdown() {
  const [endsAt, setEndsAt] = useState(0)
  const [now, setNow] = useState(0)
  const secondsLeft = Math.max(0, Math.ceil((endsAt - now) / 1000))

  useEffect(() => {
    if (secondsLeft <= 0) {
      return
    }
    // Wake up when the shown number of seconds changes.
    const timer = window.setTimeout(() => setNow(Date.now()), (endsAt - now) % 1000 || 1000)
    return () => window.clearTimeout(timer)
  }, [endsAt, now, secondsLeft])

  const start = useCallback((seconds: number) => {
    const startedAt = Date.now()
    setNow(startedAt)
    setEndsAt(Number.isFinite(seconds) && seconds > 0 ? startedAt + seconds * 1000 : startedAt)
  }, [])

  return [secondsLeft, start] as const
}
