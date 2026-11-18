// Light, Dark and Automatic theme.
//
// Rules:
// - The mode is saved per account on the server (profiles.theme_mode): "light", "dark" or "auto".
//   null or anything else means Light, so students who never picked keep what they have today.
// - Automatic is Light from 07:00 to 18:59 and Dark from 19:00 to 06:59, by the device clock.
// - Each account's choice is also kept on this device (localStorage "luma.theme:<id>"), so
//   public/theme-boot.js can paint the right theme before the app loads. That file repeats
//   the rules below in plain JavaScript; src/ui/theme.test.ts runs the same cases on both.
//
// The pure helpers at the top have no window, so `node --test` can run them.
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react"

import { DEFAULT_ACCENT, textOnAccent } from "./themeColors.ts"

export type ThemeMode = "light" | "dark" | "auto"
export type ResolvedTheme = "light" | "dark"

/** Automatic turns light at 7 am... */
export const AUTO_LIGHT_START = 7
/** ...and dark at 7 pm. */
export const AUTO_DARK_START = 19
export const THEME_CACHE_PREFIX = "luma.theme:"
export const themeCacheKey = (accountId: string) => `${THEME_CACHE_PREFIX}${accountId}`
/** The browser bar color for each theme (the page's --paper). */
export const THEME_BAR_COLOR: Record<ResolvedTheme, string> = { light: "#fbf6ec", dark: "#15140f" }
/** The longest wait between clock checks, so a sleeping laptop catches up soon after it wakes. */
export const MAX_CHECK_WAIT_MS = 60 * 60 * 1000
const SWITCH_FADE_MS = 300

export type ThemeCache = { mode: ThemeMode; accent: string | null; onAccent: string | null }

const HEX_COLOR = /^#[0-9a-f]{6}$/i

/** The saved mode as one of the three choices. Unknown or empty means Light. */
export function normalizeMode(value: unknown): ThemeMode {
  return value === "dark" || value === "auto" ? value : "light"
}

/** What the page shows for a mode at this time. */
export function resolveMode(mode: unknown, date: Date = new Date()): ResolvedTheme {
  const picked = normalizeMode(mode)
  if (picked !== "auto") return picked
  const hour = date.getHours()
  return hour >= AUTO_LIGHT_START && hour < AUTO_DARK_START ? "light" : "dark"
}

/** Milliseconds until Automatic next changes (the next 7:00 or 19:00 on the device clock). */
export function msUntilNextSwitch(date: Date): number {
  const next = new Date(date.getTime())
  const hour = date.getHours()
  if (hour < AUTO_LIGHT_START) {
    next.setHours(AUTO_LIGHT_START, 0, 0, 0)
  } else if (hour < AUTO_DARK_START) {
    next.setHours(AUTO_DARK_START, 0, 0, 0)
  } else {
    next.setDate(next.getDate() + 1)
    next.setHours(AUTO_LIGHT_START, 0, 0, 0)
  }
  return next.getTime() - date.getTime()
}

/** Puts the theme on the page: data-theme, the accent colors and the browser bar color. */
export function applyTheme(root: HTMLElement, resolved: ResolvedTheme, accent: string, onAccent = textOnAccent(accent)): void {
  root.dataset.theme = resolved
  root.style.setProperty("--accent", accent)
  root.style.setProperty("--on-accent", onAccent)
  root.ownerDocument.querySelector('meta[name="theme-color"]')?.setAttribute("content", THEME_BAR_COLOR[resolved])
}

/** Back to the plain light page (signed out). */
export function clearTheme(root: HTMLElement): void {
  delete root.dataset.theme
  root.style.removeProperty("--accent")
  root.style.removeProperty("--on-accent")
  root.ownerDocument.querySelector('meta[name="theme-color"]')?.setAttribute("content", THEME_BAR_COLOR.light)
}

/** Reads an account's saved theme on this device. Anything broken reads as nothing. */
export function readThemeCache(storage: Storage | null, accountId: string): ThemeCache | null {
  try {
    const raw = storage?.getItem(themeCacheKey(accountId))
    if (!raw) return null
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null
    const value = parsed as Record<string, unknown>
    if (value.mode !== "light" && value.mode !== "dark" && value.mode !== "auto") return null
    const color = (found: unknown) => (typeof found === "string" && HEX_COLOR.test(found) ? found : null)
    return { mode: value.mode, accent: color(value.accent), onAccent: color(value.onAccent) }
  } catch {
    return null
  }
}

/** Saves an account's theme on this device. False when the browser won't save it. */
export function writeThemeCache(storage: Storage | null, accountId: string, cache: ThemeCache): boolean {
  try {
    if (!storage) return false
    storage.setItem(themeCacheKey(accountId), JSON.stringify(cache))
    return true
  } catch {
    return false
  }
}

function deviceStorage(): Storage | null {
  try {
    return window.localStorage
  } catch {
    return null
  }
}

function prefersReducedMotion(): boolean {
  try {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches
  } catch {
    return false
  }
}

/** Fades the colors for a moment when Automatic switches by itself. */
function fadeThemeSwitch(): void {
  if (prefersReducedMotion()) return
  const root = document.documentElement
  root.classList.add("theme-switching")
  window.setTimeout(() => root.classList.remove("theme-switching"), SWITCH_FADE_MS)
}

type CacheState = { accountId: string | null; cache: ThemeCache | null }

/**
 * The theme the signed-in app shows.
 * - Uses the profile's mode once it is loaded, and this device's saved copy until then.
 * - Automatic checks the clock at the next 7:00 or 19:00 (at least once an hour), and when
 *   the tab comes back into view or gets focus.
 * - While a busy page is open (studying, a quiz, making notes), a clock switch waits until
 *   the next page change or until the tab is hidden, so colors don't jump mid-task.
 * - Keeps this device's copy up to date, and follows other tabs of the same account.
 */
export function useResolvedTheme({
  accountId,
  profileMode,
  profileAccent,
  profileVersion,
  busy,
  pathname,
}: {
  accountId: string | null
  /** undefined while the profile is not loaded yet. */
  profileMode: string | null | undefined
  profileAccent: string | null | undefined
  /** Changes whenever this tab gets a new copy of the profile (the profile object itself). */
  profileVersion?: unknown
  busy: boolean
  pathname: string
}): { mode: ThemeMode; resolved: ResolvedTheme; accent: string } {
  const [cacheState, setCacheState] = useState<CacheState>(() => ({
    accountId,
    cache: accountId ? readThemeCache(deviceStorage(), accountId) : null,
  }))
  if (cacheState.accountId !== accountId) {
    setCacheState({ accountId, cache: accountId ? readThemeCache(deviceStorage(), accountId) : null })
  }
  const cache = cacheState.accountId === accountId ? cacheState.cache : null

  // A theme another tab of this account just saved. It wins over this tab's (older) profile
  // copy until this tab's profile changes again.
  const [fromOtherTab, setFromOtherTab] = useState<ThemeCache | null>(null)
  const [seenProfile, setSeenProfile] = useState<{ accountId: string | null; version: unknown }>({
    accountId,
    version: profileVersion,
  })
  if (seenProfile.accountId !== accountId || seenProfile.version !== profileVersion) {
    setSeenProfile({ accountId, version: profileVersion })
    if (fromOtherTab) setFromOtherTab(null)
  }

  const profileLoaded = profileMode !== undefined
  const mode: ThemeMode =
    fromOtherTab?.mode ?? (profileLoaded ? normalizeMode(profileMode) : (cache?.mode ?? "light"))
  const accent =
    fromOtherTab?.accent ??
    (profileLoaded ? profileAccent || DEFAULT_ACCENT : (cache?.accent ?? DEFAULT_ACCENT))

  // What Automatic means by the clock right now, and what it shows (held while busy).
  const [clockTheme, setClockTheme] = useState<ResolvedTheme>(() => resolveMode("auto", new Date()))
  const [shownClockTheme, setShownClockTheme] = useState<ResolvedTheme>(clockTheme)
  const [seenPath, setSeenPath] = useState(pathname)
  if (seenPath !== pathname) {
    // A page change is a calm moment: catch up with the clock.
    setSeenPath(pathname)
    if (shownClockTheme !== clockTheme) setShownClockTheme(clockTheme)
  }

  const modeRef = useRef(mode)
  const busyRef = useRef(busy)
  const shownRef = useRef(shownClockTheme)
  useLayoutEffect(() => {
    modeRef.current = mode
    busyRef.current = busy
    shownRef.current = shownClockTheme
  }, [mode, busy, shownClockTheme])

  useEffect(() => {
    let timer = 0
    const check = () => {
      const next = resolveMode("auto", new Date())
      setClockTheme(next)
      const auto = modeRef.current === "auto"
      if (auto && busyRef.current && document.visibilityState === "visible") {
        // Wait for a page change or for the tab to be hidden.
      } else {
        if (auto && shownRef.current !== next) fadeThemeSwitch()
        shownRef.current = next
        setShownClockTheme(next)
      }
      schedule()
    }
    const schedule = () => {
      window.clearTimeout(timer)
      const wait = Math.min(Math.max(msUntilNextSwitch(new Date()), 1000), MAX_CHECK_WAIT_MS)
      timer = window.setTimeout(check, wait)
    }
    schedule()
    document.addEventListener("visibilitychange", check)
    window.addEventListener("focus", check)
    return () => {
      window.clearTimeout(timer)
      document.removeEventListener("visibilitychange", check)
      window.removeEventListener("focus", check)
    }
  }, [])

  // Another tab of this account saved a new theme.
  useEffect(() => {
    if (!accountId) return
    const key = themeCacheKey(accountId)
    const onStorage = (event: StorageEvent) => {
      if (event.key !== key && event.key !== null) return
      const next = readThemeCache(deviceStorage(), accountId)
      setCacheState({ accountId, cache: next })
      // Removed (signed out elsewhere) changes nothing here; the sign-out itself is handled by auth.
      if (next) setFromOtherTab(next)
    }
    window.addEventListener("storage", onStorage)
    return () => window.removeEventListener("storage", onStorage)
  }, [accountId])

  // Keep this device's copy in step with the profile, for the next page load.
  useEffect(() => {
    if (!accountId || !profileLoaded) return
    writeThemeCache(deviceStorage(), accountId, { mode, accent, onAccent: textOnAccent(accent) })
  }, [accountId, profileLoaded, mode, accent])

  return { mode, resolved: mode === "auto" ? shownClockTheme : mode, accent }
}

function subscribeToDocumentColors(onChange: () => void): () => void {
  const observer = new MutationObserver(onChange)
  // data-theme says light or dark; the style attribute carries --accent, the student's color.
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "style"] })
  return () => observer.disconnect()
}

/**
 * The theme and the student's color on <html> right now, as one string ("dark #16a34a"),
 * kept up to date. It changes when either changes, so a drawing can redraw in the new color.
 */
export function useDocumentColors(): string {
  return useSyncExternalStore(
    subscribeToDocumentColors,
    () => {
      const root = document.documentElement
      return `${root.dataset.theme === "dark" ? "dark" : "light"} ${root.style.getPropertyValue("--accent").trim()}`
    },
    () => "light",
  )
}
