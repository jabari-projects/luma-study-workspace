import { useCallback } from "react"
import type { CSSProperties } from "react"
import { useNavigate } from "react-router-dom"
import { toast } from "sonner"

import { ACCOUNT_LIMIT_MESSAGE } from "../accounts"
import { useAuth } from "../auth"
import { LEAVE_ANYWAY_STATE, markSigningOut, requestLeave } from "../work/leave"
import { useHasUnsavedWork } from "../work/useAutosave"

// Pages where the automatic theme (Light by day, Dark from 7 pm) waits for the next page
// instead of flipping colors in the middle of studying or writing. This is only about colors:
// whether work is unsaved is asked of the editors themselves (work/unsaved.ts).
// The old note addresses (/import, /voice-input, /image-to-notes) stay listed.
const BUSY_PATHS = [
  /^\/notes\/(new|import|voice|image)\/?$/,
  /^\/(notes|summaries)\/[^/]+\/edit\/?$/,
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

/** Added to "Sign out of all accounts?" while work in this tab isn't saved. */
export const UNSAVED_WORK_WARNING = "Signing out throws away work that isn't saved."

/** True on pages where the automatic theme waits for the next page (see BUSY_PATHS). */
export function isBusyPath(pathname: string): boolean {
  return BUSY_PATHS.some((pattern) => pattern.test(pathname))
}

/**
 * Switch, sign out and add, with the same messages everywhere. With unsaved work in this tab
 * each one asks first ("Stay and save" / "... anyway"), so nothing is lost by surprise.
 */
export function useAccountActions() {
  const { accounts, activeAccountId, canAddAccount, switchAccount, logoutAccount, logoutAll } = useAuth()
  const navigate = useNavigate()
  const busy = useHasUnsavedWork()

  const switchTo = useCallback(
    async (id: string): Promise<boolean> => {
      const target = accounts.find((account) => account.id === id)
      if (!target || id === activeAccountId) {
        return false
      }
      if (!(await requestLeave("switch"))) {
        return false
      }
      switchAccount(id)
      navigate("/dashboard", { replace: true, state: LEAVE_ANYWAY_STATE })
      if (target.status === "signed_in") {
        toast.success(`Now using ${target.username}.`)
      }
      return true
    },
    [accounts, activeAccountId, navigate, switchAccount],
  )

  const signOut = useCallback(
    async (id: string): Promise<boolean> => {
      const leaving = accounts.find((account) => account.id === id)
      if (!leaving) {
        return false
      }
      const wasActive = id === activeAccountId
      if (wasActive && !(await requestLeave("signOut"))) {
        return false
      }
      if (wasActive) markSigningOut(true)
      const { nextId } = logoutAccount(id)
      if (!wasActive) {
        toast.success(
          leaving.status === "expired" ? `Removed ${leaving.username} from this device.` : `Signed out of ${leaving.username}.`,
        )
        return true
      }
      const next = accounts.find((account) => account.id === nextId)
      const moved = next
        ? navigate("/dashboard", { replace: true, state: LEAVE_ANYWAY_STATE })
        : navigate("/", { replace: true, state: LEAVE_ANYWAY_STATE })
      void Promise.resolve(moved).finally(() => markSigningOut(false))
      if (next) toast.success(`Signed out of ${leaving.username}. You're now using ${next.username}.`)
      return true
    },
    [accounts, activeAccountId, logoutAccount, navigate],
  )

  // The account menu asks first, and adds the unsaved-work warning when work isn't saved (busy).
  const signOutAll = useCallback(() => {
    markSigningOut(true)
    logoutAll()
    void Promise.resolve(navigate("/", { replace: true, state: LEAVE_ANYWAY_STATE })).finally(() => markSigningOut(false))
  }, [logoutAll, navigate])

  const addAccount = useCallback(async (): Promise<boolean> => {
    if (!canAddAccount) {
      toast.error(ACCOUNT_LIMIT_MESSAGE, { id: "account-limit" })
      return false
    }
    if (!(await requestLeave("add"))) {
      return false
    }
    navigate("/login?add=1", { state: LEAVE_ANYWAY_STATE })
    return true
  }, [canAddAccount, navigate])

  return { switchTo, signOut, signOutAll, addAccount, busy }
}
