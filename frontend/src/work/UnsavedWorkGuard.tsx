import { useEffect, useRef, useState, useSyncExternalStore } from "react"
import { useBlocker } from "react-router-dom"

import { ConfirmDialog } from "../ui/ConfirmDialog"
import "./work.css"
import { LEAVE_COPY, LEAVE_TITLE, STAY_AND_SAVE, answerLeave, getLeaveRequest, isLeaveAnyway, subscribeLeave } from "./leave"
import { flushAllWork, hasUnsavedWork } from "./unsaved"
import { useHasUnsavedWork } from "./useAutosave"

/**
 * Keeps unsaved work from being lost by leaving:
 * - a browser "Leave site?" warning, only while something isn't saved (closing the tab is
 *   never treated as a save);
 * - an in-app link first saves, shows "Saving your work...", then goes on by itself; if the
 *   save fails it asks "Stay here / Leave anyway";
 * - the "You have work that isn't saved yet." box for switching, signing out or adding an account.
 */
export function UnsavedWorkGuard() {
  const unsaved = useHasUnsavedWork()
  const leave = useSyncExternalStore(subscribeLeave, getLeaveRequest, () => null)
  const [phase, setPhase] = useState<"idle" | "saving" | "failed">("idle")

  useEffect(() => {
    if (!unsaved) return
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault()
      // Older browsers need a value here to show their own warning.
      event.returnValue = ""
    }
    window.addEventListener("beforeunload", warn)
    return () => window.removeEventListener("beforeunload", warn)
  }, [unsaved])

  const blocker = useBlocker(({ currentLocation, nextLocation }) => {
    if (isLeaveAnyway(nextLocation.state)) return false
    if (currentLocation.pathname === nextLocation.pathname && currentLocation.search === nextLocation.search) return false
    return hasUnsavedWork()
  })

  const blockerRef = useRef(blocker)
  useEffect(() => {
    blockerRef.current = blocker
  })

  useEffect(() => {
    if (blocker.state !== "blocked") return
    let active = true
    // Save first; go on by itself when the server confirmed it.
    Promise.resolve()
      .then(() => {
        if (active) setPhase("saving")
        return flushAllWork()
      })
      .then((saved) => {
        if (!active) return
        if (saved) {
          setPhase("idle")
          blockerRef.current.proceed?.()
        } else {
          setPhase("failed")
        }
      })
    return () => {
      active = false
    }
  }, [blocker.state])

  return (
    <>
      {blocker.state === "blocked" && phase === "saving" ? (
        <div className="modal-backdrop" role="presentation">
          <section className="modal-panel work-saving-panel" role="alertdialog" aria-modal="true" aria-label="Saving your work" tabIndex={-1}>
            <span className="spinner" aria-hidden="true" />
            <p role="status">Saving your work...</p>
          </section>
        </div>
      ) : null}
      {blocker.state === "blocked" && phase === "failed" ? (
        <ConfirmDialog
          title="Your work isn't saved."
          body="If you leave now, the changes that aren't saved stay only in this tab."
          confirmLabel="Leave anyway"
          cancelLabel="Stay here"
          onConfirm={() => {
            setPhase("idle")
            blocker.proceed?.()
          }}
          onCancel={() => {
            setPhase("idle")
            blocker.reset?.()
          }}
        />
      ) : null}
      {leave ? (
        <ConfirmDialog
          title={LEAVE_TITLE}
          body={LEAVE_COPY[leave.action].body}
          confirmLabel={LEAVE_COPY[leave.action].go}
          cancelLabel={STAY_AND_SAVE}
          onConfirm={() => answerLeave(true)}
          onCancel={() => {
            answerLeave(false)
            void flushAllWork()
          }}
        />
      ) : null}
    </>
  )
}
