// The maintenance notice inside the signed-in app (under the top bar, above each page).
// It never navigates, reloads or signs anyone out: an open editor stays open in every phase.
import { useState, useSyncExternalStore } from "react"
import { Link, useLocation } from "react-router-dom"
import { toast } from "sonner"
import { Info, WarningCircle, X } from "@phosphor-icons/react"

import { useMaintenance } from "./observe"
import {
  ACTIVE_TITLE,
  BACK_TEXT,
  DRAINING_TEXT,
  SAVED_WORK_SAFE,
  UNSAVED_DURING_BREAK,
  announcedText,
  estimateText,
  reasonWords,
  workLine,
} from "./words"
import { copyUnsavedText, getUnsavedSummary, hasUnsavedWork, subscribeUnsaved } from "../work/unsaved"
import "./maintenance.css"

const CLOSED_PREFIX = "luma.maintenanceNoticeClosed:"

function readClosed(key: string): boolean {
  try {
    return window.sessionStorage.getItem(key) === "1"
  } catch {
    return false
  }
}

function writeClosed(key: string): void {
  try {
    window.sessionStorage.setItem(key, "1")
  } catch {
    // Blocked storage: the notice just closes for this page view.
  }
}

/** A notice the student can close for this tab (kept per break in sessionStorage). */
function ClosableNotice({ storageKey, text, tone }: { storageKey: string; text: string; tone: "info" | "good" }) {
  const [closed, setClosed] = useState(() => readClosed(storageKey))
  if (closed) return null
  return (
    <div className={`maint-notice ${tone}`} role="status">
      <Info weight="duotone" aria-hidden="true" className="maint-notice-icon" />
      <p>{text}</p>
      <button
        type="button"
        className="maint-close"
        aria-label="Close this notice"
        onClick={() => {
          writeClosed(storageKey)
          setClosed(true)
        }}
      >
        <X weight="bold" aria-hidden="true" />
      </button>
    </div>
  )
}

async function copyText() {
  const text = copyUnsavedText()
  if (!text) {
    toast.info("There's no text to copy in this tab.")
    return
  }
  try {
    await navigator.clipboard.writeText(text)
    toast.success("Copied your text. Paste it somewhere safe.")
  } catch {
    toast.error("We couldn't copy. Select your text and copy it yourself.")
  }
}

export function MaintenanceNotice() {
  const { status } = useMaintenance()
  // Strings and booleans, so React compares them by value.
  const line = useSyncExternalStore(subscribeUnsaved, () => workLine(getUnsavedSummary()))
  const unsaved = useSyncExternalStore(subscribeUnsaved, hasUnsavedWork)
  const { pathname } = useLocation()

  if (!status) return null

  if (status.phase === "none") {
    if (!status.recently_reopened) return null
    return <ClosableNotice key={`back-${status.rev}`} storageKey={`${CLOSED_PREFIX}back-${status.rev}`} text={BACK_TEXT} tone="good" />
  }

  if (status.phase === "announced") {
    return <ClosableNotice key={`soon-${status.rev}`} storageKey={`${CLOSED_PREFIX}${status.rev}`} text={announcedText(status)} tone="info" />
  }

  if (status.phase === "draining") {
    return (
      <div className="maint-notice warn" role="status">
        <WarningCircle weight="duotone" aria-hidden="true" className="maint-notice-icon" />
        <div>
          <p>
            <strong>{DRAINING_TEXT}</strong>
          </p>
          <p className="maint-work-line">{line}</p>
        </div>
      </div>
    )
  }

  // active or checking
  if (pathname === "/admin/maintenance") {
    // The admin runs the break from this page, so it is never covered.
    return (
      <div className="maint-notice warn" role="status">
        <WarningCircle weight="duotone" aria-hidden="true" className="maint-notice-icon" />
        <p>Luma is in maintenance. Students see the break page.</p>
      </div>
    )
  }

  if (unsaved) {
    return (
      <div className="maint-notice strong" role="alert">
        <WarningCircle weight="fill" aria-hidden="true" className="maint-notice-icon" />
        <div>
          <p>
            <strong>{UNSAVED_DURING_BREAK}</strong>
          </p>
          <p className="maint-work-line">{estimateText(status)}</p>
        </div>
        <button type="button" className="secondary-button small" onClick={() => void copyText()}>
          Copy my text
        </button>
      </div>
    )
  }

  const why = reasonWords(status.reason)
  return (
    <section className="maint-cover" aria-labelledby="maint-cover-title">
      <img className="maint-cover-mark" src="/luma-star.png" alt="" />
      <h1 id="maint-cover-title">{ACTIVE_TITLE}</h1>
      {why ? <p className="maint-cover-why">{why}</p> : null}
      <p>{estimateText(status)}</p>
      <p>
        <strong>{SAVED_WORK_SAFE}</strong>
      </p>
      <Link className="secondary-button" to="/status">
        See Luma's status
      </Link>
    </section>
  )
}
