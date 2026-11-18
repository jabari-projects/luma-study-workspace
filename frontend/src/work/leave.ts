// "You have work that isn't saved yet." before switching, signing out or adding an account,
// and the bridge from a "Sign in" button to the sign-in-again box.
import { hasUnsavedWork } from "./unsaved"

export type LeaveAction = "switch" | "signOut" | "add"

export const LEAVE_TITLE = "You have work that isn't saved yet."
export const LEAVE_COPY: Record<LeaveAction, { body: string; go: string }> = {
  switch: { body: "Stay here so Luma can save it, or switch anyway.", go: "Switch anyway" },
  signOut: { body: "Signing out throws away work that isn't saved.", go: "Sign out anyway" },
  add: { body: "Stay here so Luma can save it, or add an account anyway.", go: "Add anyway" },
}
export const STAY_AND_SAVE = "Stay and save"

/** Navigation state that tells the leave guard the student already chose to go. */
export const LEAVE_ANYWAY_STATE = { lumaLeaveAnyway: true } as const

export function isLeaveAnyway(state: unknown): boolean {
  return Boolean(state && typeof state === "object" && (state as Record<string, unknown>).lumaLeaveAnyway === true)
}

type LeaveRequest = { action: LeaveAction; resolve: (go: boolean) => void }

let current: LeaveRequest | null = null
const listeners = new Set<() => void>()
const emit = () => listeners.forEach((listener) => listener())

/** Resolves true right away when nothing is unsaved; otherwise asks first (UnsavedWorkGuard shows the box). */
export function requestLeave(action: LeaveAction): Promise<boolean> {
  if (!hasUnsavedWork()) return Promise.resolve(true)
  current?.resolve(false)
  return new Promise<boolean>((resolve) => {
    current = { action, resolve }
    emit()
  })
}

export function getLeaveRequest(): LeaveRequest | null {
  return current
}

export function subscribeLeave(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function answerLeave(go: boolean): void {
  const request = current
  current = null
  emit()
  request?.resolve(go)
}

// Signing out ends the session first and then goes to the home page. The router's move is a
// moment later, so in between the signed-in pages show nothing instead of sending the student
// to the login page.
let signingOut = false

export function markSigningOut(on: boolean): void {
  signingOut = on
}

export function isSigningOut(): boolean {
  return signingOut
}

/** Fired on window by a "Sign in" button: detail { accountId }. ProtectedRoute opens the box. */
export const SIGN_IN_AGAIN_EVENT = "luma:sign-in-again"

export function askToSignInAgain(accountId: string | null): void {
  window.dispatchEvent(new CustomEvent(SIGN_IN_AGAIN_EVENT, { detail: { accountId } }))
}
