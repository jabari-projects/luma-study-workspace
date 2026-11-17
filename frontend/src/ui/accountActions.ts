import { useCallback } from "react"
import type { CSSProperties } from "react"
import { useLocation, useNavigate } from "react-router-dom"
import { toast } from "sonner"

import { ACCOUNT_LIMIT_MESSAGE } from "../accounts"
import { useAuth } from "../auth"

// Pages where switching or signing out would throw away work in progress.
const BUSY_PATHS = [
  /^\/import(\/|$)/,
  /^\/voice-input(\/|$)/,
  /^\/image-to-notes(\/|$)/,
  /^\/flashcards\/new$/,
  /^\/flashcards\/[^/]+\/(study|edit)$/,
  /^\/quizzes(\/|$)/,
]

/** Where the account menu opens, next to the account button in the sidebar. */
export function accountMenuPosition(anchor: HTMLElement): CSSProperties {
  const rect = anchor.getBoundingClientRect()
  if (window.innerWidth >= 1100) {
    // Desktop: open upward from the sidebar footer.
    return { left: rect.left, bottom: window.innerHeight - rect.top + 10, width: Math.max(rect.width, 300) }
  }
  // Icon rail: open to the right of the rail, not over it.
  const railRight = anchor.closest("aside")?.getBoundingClientRect().right ?? rect.right
  return { left: railRight + 10, bottom: Math.max(12, window.innerHeight - rect.bottom) }
}

export type LeaveAction = "switch" | "signOut" | "add"

const LEAVE_QUESTIONS: Record<LeaveAction, string> = {
  switch: "Switch accounts now?",
  signOut: "Sign out now?",
  add: "Add another account now?",
}

export const UNSAVED_WORK_WARNING = "Your work on this page is not saved yet."

/** The words for the "are you sure?" box. Short and plain on purpose. */
export function leaveMessage(action: LeaveAction): string {
  return `${LEAVE_QUESTIONS[action]} ${UNSAVED_WORK_WARNING} Notes being made now still count for this account.`
}

/** True when leaving this page could lose work. */
export function isBusyPath(pathname: string): boolean {
  return BUSY_PATHS.some((pattern) => pattern.test(pathname))
}

/** Asks first when leaving this page could lose work. True means go ahead. */
export function confirmLeaveIfBusy(pathname: string, action: LeaveAction): boolean {
  if (!isBusyPath(pathname)) {
    return true
  }
  return window.confirm(leaveMessage(action))
}

/** Switch, sign out and add, with the same messages everywhere. */
export function useAccountActions() {
  const { accounts, activeAccountId, canAddAccount, switchAccount, logoutAccount, logoutAll } = useAuth()
  const navigate = useNavigate()
  const { pathname } = useLocation()

  const switchTo = useCallback(
    (id: string): boolean => {
      const target = accounts.find((account) => account.id === id)
      if (!target || id === activeAccountId) {
        return false
      }
      if (!confirmLeaveIfBusy(pathname, "switch")) {
        return false
      }
      switchAccount(id)
      navigate("/dashboard", { replace: true })
      if (target.status === "signed_in") {
        toast.success(`Now using ${target.username}.`)
      }
      return true
    },
    [accounts, activeAccountId, navigate, pathname, switchAccount],
  )

  const signOut = useCallback(
    (id: string): boolean => {
      const leaving = accounts.find((account) => account.id === id)
      if (!leaving) {
        return false
      }
      const wasActive = id === activeAccountId
      if (wasActive && !confirmLeaveIfBusy(pathname, "signOut")) {
        return false
      }
      const { nextId } = logoutAccount(id)
      if (!wasActive) {
        toast.success(
          leaving.status === "expired" ? `Removed ${leaving.username} from this device.` : `Signed out of ${leaving.username}.`,
        )
        return true
      }
      const next = accounts.find((account) => account.id === nextId)
      if (next) {
        navigate("/dashboard", { replace: true })
        toast.success(`Signed out of ${leaving.username}. You're now using ${next.username}.`)
      } else {
        navigate("/", { replace: true })
      }
      return true
    },
    [accounts, activeAccountId, logoutAccount, navigate, pathname],
  )

  // The account menu asks first, and adds the unsaved-work warning on busy pages (busy).
  const signOutAll = useCallback(() => {
    logoutAll()
    navigate("/", { replace: true })
  }, [logoutAll, navigate])

  const addAccount = useCallback((): boolean => {
    if (!canAddAccount) {
      toast.error(ACCOUNT_LIMIT_MESSAGE, { id: "account-limit" })
      return false
    }
    if (!confirmLeaveIfBusy(pathname, "add")) {
      return false
    }
    navigate("/login?add=1")
    return true
  }, [canAddAccount, navigate, pathname])

  return { switchTo, signOut, signOutAll, addAccount, busy: isBusyPath(pathname) }
}
