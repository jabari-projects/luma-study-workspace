// /status: a public page (no sign-in) that says whether Luma is open or on a short break.
// It never shows technical text: no addresses, ports, status numbers or error messages.
import { useCallback, useEffect, useState } from "react"
import { Link } from "react-router-dom"
import { ArrowClockwise } from "@phosphor-icons/react"

import { checkMaintenanceNow, useMaintenance } from "./observe"
import { STATUS_BACKOFF_MS, breakIsOn, nextBackoff } from "./store"
import { shortClock } from "./time"
import {
  CANT_REACH,
  SAVED_WORK_SAFE,
  announcedText,
  estimateText,
  reasonWords,
  startText,
  statusHeadline,
} from "./words"
import "./maintenance.css"

export function StatusPage() {
  const { status, checkedAt, failed, checking } = useMaintenance()
  const [step, setStep] = useState(0)
  const on = breakIsOn(status)
  const stopped = on && step >= STATUS_BACKOFF_MS.length

  const checkAgain = useCallback(() => {
    setStep(0)
    void checkMaintenanceNow()
  }, [])

  // Read the status when the page opens.
  useEffect(() => {
    void checkMaintenanceNow()
  }, [])

  // While a break is on, check again after 30 s, 1 min, 2 min and 4 min, then stop and
  // show "Check again". This bounded backoff is the one allowed exception to the owner's
  // no-polling rule: it ends by itself, it waits while the tab is hidden, and it starts over
  // only when the student comes back to the tab or presses Check again.
  useEffect(() => {
    if (!on) return
    const wait = nextBackoff(step)
    if (wait === null) return
    const id = window.setTimeout(() => {
      if (document.visibilityState === "hidden") return // paused; starts over on visibilitychange
      void checkMaintenanceNow()
      setStep((current) => current + 1)
    }, wait)
    return () => window.clearTimeout(id)
  }, [on, step, checkedAt])

  // Coming back to the tab starts the checks over.
  useEffect(() => {
    const onBack = () => {
      if (document.visibilityState === "hidden") return
      checkAgain()
    }
    window.addEventListener("focus", onBack)
    document.addEventListener("visibilitychange", onBack)
    return () => {
      window.removeEventListener("focus", onBack)
      document.removeEventListener("visibilitychange", onBack)
    }
  }, [checkAgain])

  const why = status ? reasonWords(status.reason) : ""

  return (
    <main className="maint-status-screen">
      <section className="maint-status sheet" aria-labelledby="maint-status-title">
        <Link className="maint-status-brand" to="/" aria-label="Luma home">
          <img src="/luma-star.png" alt="" />
          <span>Luma</span>
        </Link>
        <h1 id="maint-status-title">{status ? statusHeadline(status) : "Luma status"}</h1>

        {status === null && !failed ? <p className="muted">Checking Luma...</p> : null}

        {status?.phase === "none" ? <p>Everything is open. {SAVED_WORK_SAFE}</p> : null}

        {status?.phase === "announced" ? (
          <>
            <p>{announcedText(status)}</p>
            {why ? <p>{why}</p> : null}
            <p>{estimateText(status)}</p>
          </>
        ) : null}

        {status && on ? (
          <>
            {why ? <p>{why}</p> : null}
            {status.start_at ? <p>{startText(status)}</p> : null}
            <p>{estimateText(status)}</p>
            <p>
              <strong>{SAVED_WORK_SAFE}</strong>
            </p>
          </>
        ) : null}

        {status?.note ? <p className="maint-status-note">{status.note}</p> : null}

        {failed ? (
          <p className="notice error" role="alert">
            {CANT_REACH}
          </p>
        ) : null}

        <div className="maint-status-foot">
          <p className="muted" aria-live="polite">
            {checking ? "Checking..." : checkedAt ? `Last checked ${shortClock(checkedAt)}` : ""}
          </p>
          <button type="button" className={stopped ? "primary-button" : "secondary-button"} onClick={checkAgain} disabled={checking}>
            <ArrowClockwise weight="bold" aria-hidden="true" /> Check again
          </button>
        </div>
        <Link className="link-button maint-status-home" to="/">
          Go to Luma
        </Link>
      </section>
    </main>
  )
}
