// /admin/maintenance: plan and run a short maintenance break (admins only).
// The page loads when it opens, when the window gets focus again and after each action.
// There is no timer: nothing here changes by itself. The server checks the admin, the
// order of the steps and every time again.
import { useCallback, useEffect, useState } from "react"
import type { FormEvent, ReactNode } from "react"
import { AxiosError } from "axios"
import { Link } from "react-router-dom"

import { useAuth, useProfile } from "../auth"
import { getErrorMessage } from "../api"
import { NoticeBanner, PageHeader } from "../ui/common"
import type { Notice } from "../ui/common"
import { adminAction, loadAdminView } from "./maintenance-api"
import type { AdminAction, AdminView, SafetyReason } from "./maintenance-api"
import { checkMaintenanceNow } from "./observe"
import type { MaintenanceReason } from "./store"
import { centralPreview, formatCentral, toCentralInput } from "./time"
import { ACTION_WORDS, CHECK_LABELS, PHASE_WORDS, REASON_LABELS, safetyWords } from "./words"
import "./maintenance.css"

type Reason = Exclude<MaintenanceReason, "">
const REASONS = Object.keys(REASON_LABELS) as Reason[]
const GRACE_CHOICES = [5, 10, 15, 20, 30]
const STAMP_RE = /^[0-9]{8}T[0-9]{6}Z$/

type TimeFields = { start: string; end: string }

function TimeFieldsEditor({ value, onChange, idPrefix }: { value: TimeFields; onChange: (next: TimeFields) => void; idPrefix: string }) {
  return (
    <>
      <div className="field">
        <label htmlFor={`${idPrefix}-start`}>Starts (Central time, Chicago)</label>
        <input
          id={`${idPrefix}-start`}
          type="datetime-local"
          value={value.start}
          onChange={(event) => onChange({ ...value, start: event.target.value })}
          aria-describedby={`${idPrefix}-start-preview`}
          required
        />
        <p id={`${idPrefix}-start-preview`} className="field-hint" aria-live="polite">
          {centralPreview(value.start)}
        </p>
      </div>
      <div className="field">
        <label htmlFor={`${idPrefix}-end`}>Ends about (Central time, Chicago)</label>
        <input
          id={`${idPrefix}-end`}
          type="datetime-local"
          value={value.end}
          onChange={(event) => onChange({ ...value, end: event.target.value })}
          aria-describedby={`${idPrefix}-end-preview`}
          required
        />
        <p id={`${idPrefix}-end-preview`} className="field-hint" aria-live="polite">
          {centralPreview(value.end)}
        </p>
      </div>
    </>
  )
}

function Block({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="ruled-block maint-admin-block" aria-label={title}>
      <h2>{title}</h2>
      {children}
    </section>
  )
}

function NotFound() {
  return (
    <>
      <PageHeader title="Page not found" description="We could not find that page." />
      <Link className="primary-button" to="/dashboard">
        Back to Home
      </Link>
    </>
  )
}

export function AdminMaintenancePage() {
  const profile = useProfile()
  const { profileLoading } = useAuth()
  if (!profile) {
    return profileLoading ? <p className="muted">Loading...</p> : <NotFound />
  }
  if (!profile.is_admin) return <NotFound />
  return <AdminMaintenance />
}

function AdminMaintenance() {
  const [view, setView] = useState<AdminView | null>(null)
  const [notice, setNotice] = useState<Notice | null>(null)
  const [busy, setBusy] = useState<AdminAction | null>(null)
  const [forbidden, setForbidden] = useState(false)
  const [notSafe, setNotSafe] = useState<SafetyReason[] | null>(null)
  const [times, setTimes] = useState<TimeFields>({ start: "", end: "" })
  const [reason, setReason] = useState<Reason>("website_update")
  const [note, setNote] = useState("")
  const [editing, setEditing] = useState(false)
  const [postponing, setPostponing] = useState(false)
  const [grace, setGrace] = useState(10)
  const [stamp, setStamp] = useState("")
  const [stampChecked, setStampChecked] = useState(false)
  const [dropReason, setDropReason] = useState("")

  const load = useCallback(async () => {
    try {
      setView(await loadAdminView())
    } catch (error: unknown) {
      if (error instanceof AxiosError && error.response?.status === 403) setForbidden(true)
      else setNotice({ type: "error", text: getErrorMessage(error, "We couldn't load the break settings.") })
    }
  }, [])

  // Load on open and when the admin comes back to this window. No timer.
  useEffect(() => {
    void load()
    const onFocus = () => void load()
    window.addEventListener("focus", onFocus)
    return () => window.removeEventListener("focus", onFocus)
  }, [load])

  const act = async (action: AdminAction, body: Record<string, unknown>, done: string) => {
    if (!view) return
    setBusy(action)
    setNotice(null)
    setNotSafe(null)
    try {
      const next = await adminAction(action, { expected_rev: view.state.rev, ...body })
      setView(next)
      setNotice({ type: "success", text: done })
      setEditing(false)
      setPostponing(false)
      void checkMaintenanceNow() // so this tab's own notice updates too
    } catch (error: unknown) {
      const data = error instanceof AxiosError ? (error.response?.data as { error_code?: string; reasons?: SafetyReason[] } | undefined) : undefined
      if (data?.error_code === "maintenance_not_safe" && data.reasons) {
        setNotSafe(data.reasons)
        void load()
      } else {
        setNotice({ type: "error", text: getErrorMessage(error, "That didn't work. Try again.") })
        if (data?.error_code === "maintenance_changed") void load()
      }
    } finally {
      setBusy(null)
    }
  }

  if (forbidden) return <NotFound />

  const state = view?.state
  const phase = state?.phase ?? "none"

  const startEdit = () => {
    if (!state) return
    setTimes({ start: toCentralInput(state.start_at), end: toCentralInput(state.estimated_end_at) })
    setReason((state.reason || "website_update") as Reason)
    setNote(state.note)
    setEditing(true)
  }

  const submitSchedule = (event: FormEvent) => {
    event.preventDefault()
    void act(
      "schedule",
      { start_local: times.start, estimated_end_local: times.end, reason, note: note.trim() },
      phase === "none" ? "The break is scheduled. Students will see a notice." : "The break is changed.",
    )
  }

  const submitPostpone = (event: FormEvent) => {
    event.preventDefault()
    void act("postpone", { start_local: times.start, estimated_end_local: times.end }, "The break is moved. Students can work again.")
  }

  const scheduleForm = (
    <form className="maint-admin-form" onSubmit={submitSchedule}>
      <TimeFieldsEditor value={times} onChange={setTimes} idPrefix="maint-schedule" />
      <div className="field">
        <label htmlFor="maint-reason">Why</label>
        <select id="maint-reason" value={reason} onChange={(event) => setReason(event.target.value as Reason)}>
          {REASONS.map((value) => (
            <option key={value} value={value}>
              {REASON_LABELS[value]}
            </option>
          ))}
        </select>
      </div>
      <div className="field">
        <label htmlFor="maint-note">Note for students (optional)</label>
        <input id="maint-note" value={note} maxLength={200} onChange={(event) => setNote(event.target.value)} />
        <p className="field-hint">Students see this on the status page. Keep it short and kind.</p>
      </div>
      <p className="field-hint">
        Best time: Tuesday or Wednesday, 5:00 to 6:00 AM Central. Tell students at least 2 days ahead. Skip the
        Sundays when clocks change.
      </p>
      <div className="button-row">
        <button type="submit" className="primary-button" disabled={busy !== null}>
          {phase === "none" ? "Schedule the break" : "Save changes"}
        </button>
        {phase !== "none" ? (
          <button type="button" className="ghost-button" onClick={() => setEditing(false)}>
            Keep it as it is
          </button>
        ) : null}
      </div>
    </form>
  )

  const postponeForm = (
    <form className="maint-admin-form" onSubmit={submitPostpone}>
      <TimeFieldsEditor value={times} onChange={setTimes} idPrefix="maint-postpone" />
      <div className="button-row">
        <button type="submit" className="primary-button" disabled={busy !== null}>
          Move the break
        </button>
        <button type="button" className="ghost-button" onClick={() => setPostponing(false)}>
          Keep it as it is
        </button>
      </div>
    </form>
  )

  const cancelButton = (
    <button type="button" className="ghost-button" disabled={busy !== null} onClick={() => void act("cancel", {}, "The break is cancelled.")}>
      Cancel the break
    </button>
  )

  const checks = state?.checks?.results ?? []
  const allPassed = checks.length > 0 && checks.every((check) => check.passed)
  const inFlight = view?.instances.reduce((sum, item) => sum + item.in_flight, 0) ?? 0

  return (
    <>
      <PageHeader
        title="Maintenance"
        description="Plan a short break. Students see a notice first. Nothing starts by itself."
      />
      <NoticeBanner notice={notice} />
      {view === null ? <p className="muted">Loading...</p> : null}

      {view && state ? (
        <div className="maint-admin">
          <Block title="Right now">
            <dl className="maint-facts">
              <div>
                <dt>Step</dt>
                <dd>{PHASE_WORDS[phase] ?? phase}</dd>
              </div>
              {state.start_at ? (
                <div>
                  <dt>Starts</dt>
                  <dd>{formatCentral(state.start_at)}</dd>
                </div>
              ) : null}
              {state.estimated_end_at ? (
                <div>
                  <dt>Ends about</dt>
                  <dd>{formatCentral(state.estimated_end_at)} (a guess)</dd>
                </div>
              ) : null}
              {state.reason ? (
                <div>
                  <dt>Why</dt>
                  <dd>{REASON_LABELS[state.reason as Reason] ?? state.reason}</dd>
                </div>
              ) : null}
              {state.grace_ends_at && phase === "draining" ? (
                <div>
                  <dt>Saving time ends</dt>
                  <dd>{formatCentral(state.grace_ends_at)}</dd>
                </div>
              ) : null}
              {state.backup_ref ? (
                <div>
                  <dt>Backup</dt>
                  <dd>{state.backup_ref}</dd>
                </div>
              ) : null}
            </dl>
            {view.partial ? <p className="notice error">Some counts couldn't be loaded. Look again in a moment.</p> : null}
            <button type="button" className="link-button" onClick={() => void load()}>
              Look again
            </button>
          </Block>

          {phase === "none" ? <Block title="Schedule a break">{scheduleForm}</Block> : null}

          {phase === "announced" ? (
            <Block title="The break is announced">
              {editing ? (
                scheduleForm
              ) : postponing ? (
                postponeForm
              ) : (
                <>
                  <div className="field">
                    <label htmlFor="maint-grace">Minutes students get to finish saving</label>
                    <select id="maint-grace" value={grace} onChange={(event) => setGrace(Number(event.target.value))}>
                      {GRACE_CHOICES.map((minutes) => (
                        <option key={minutes} value={minutes}>
                          {minutes} minutes
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="button-row">
                    <button
                      type="button"
                      className="primary-button"
                      disabled={busy !== null}
                      onClick={() => void act("drain", { grace_minutes: grace }, "Getting ready. New work is paused.")}
                    >
                      Start getting ready
                    </button>
                    <button type="button" className="secondary-button" onClick={startEdit}>
                      Change
                    </button>
                    {cancelButton}
                  </div>
                </>
              )}
            </Block>
          ) : null}

          {phase === "draining" ? (
            <Block title="Getting ready">
              <ul className="maint-counts">
                <li>
                  <strong>{view.jobs.running}</strong> AI or long {view.jobs.running === 1 ? "task" : "tasks"} running
                  {view.jobs.stale ? ` (${view.jobs.stale} old ${view.jobs.stale === 1 ? "one" : "ones"} left by a stopped server, not counted)` : ""}
                </li>
                <li>
                  <strong>{inFlight}</strong> {inFlight === 1 ? "request" : "requests"} being answered on {view.instances.length}{" "}
                  {view.instances.length === 1 ? "server" : "servers"}
                </li>
              </ul>
              {view.safety && view.safety.length ? (
                <ul className="maint-reasons" aria-label="Not ready yet">
                  {view.safety.map((item) => (
                    <li key={item.code}>{safetyWords(item)}</li>
                  ))}
                </ul>
              ) : (
                <p>Everything looks ready.</p>
              )}
              {postponing ? (
                postponeForm
              ) : (
                <>
                  <div className="field">
                    <label htmlFor="maint-stamp">
                      Backup stamp {state.reason === "database_update" ? "(needed)" : "(optional)"}, like 20261201T103000Z
                    </label>
                    <input
                      id="maint-stamp"
                      value={stamp}
                      inputMode="text"
                      autoComplete="off"
                      spellCheck={false}
                      onChange={(event) => setStamp(event.target.value.trim())}
                      aria-invalid={stamp !== "" && !STAMP_RE.test(stamp)}
                    />
                  </div>
                  <label className="maint-check">
                    <input type="checkbox" checked={stampChecked} onChange={(event) => setStampChecked(event.target.checked)} />
                    <span>I checked this backup's restore test passed.</span>
                  </label>
                  <div className="button-row">
                    <button
                      type="button"
                      className="primary-button"
                      disabled={busy !== null}
                      onClick={() =>
                        void act(
                          "activate",
                          stamp ? { backup_ref: stamp, backup_checked: stampChecked } : { backup_checked: stampChecked },
                          "Maintenance started. Students see the break page.",
                        )
                      }
                    >
                      Enter maintenance
                    </button>
                    <button
                      type="button"
                      className="secondary-button"
                      onClick={() => {
                        setTimes({ start: "", end: "" })
                        setPostponing(true)
                      }}
                    >
                      Postpone
                    </button>
                    {cancelButton}
                  </div>
                </>
              )}
              {notSafe ? (
                <div className="notice error maint-not-safe" role="alert">
                  <p>
                    <strong>It isn't safe to start yet.</strong>
                  </p>
                  <ul>
                    {notSafe.map((item) => (
                      <li key={item.code}>{safetyWords(item)}</li>
                    ))}
                  </ul>
                  <p>Try again in a little while, or postpone the break.</p>
                </div>
              ) : null}
            </Block>
          ) : null}

          {phase === "active" || phase === "checking" ? (
            <Block title={phase === "active" ? "In maintenance" : "Checks"}>
              {phase === "checking" ? (
                <ul className="maint-check-list">
                  {checks.map((check) => (
                    <li key={check.name} className={check.passed ? "passed" : "failed"}>
                      <strong>{check.passed ? "Passed" : "Failed"}:</strong> {CHECK_LABELS[check.name] ?? check.name}
                    </li>
                  ))}
                </ul>
              ) : (
                <p>Do the work, then run the checks. Luma reopens only when every check passes.</p>
              )}
              {state.reason === "other" ? (
                <div className="field">
                  <label htmlFor="maint-drop">If some records were removed on purpose, say why (optional)</label>
                  <input id="maint-drop" value={dropReason} maxLength={200} onChange={(event) => setDropReason(event.target.value)} />
                </div>
              ) : null}
              <div className="button-row">
                <button
                  type="button"
                  className={phase === "active" ? "primary-button" : "secondary-button"}
                  disabled={busy !== null}
                  onClick={() =>
                    void act("checks", dropReason.trim() ? { counts_drop_reason: dropReason.trim() } : {}, "Checks are done.")
                  }
                >
                  {phase === "active" ? "Run checks" : "Run checks again"}
                </button>
                {phase === "checking" ? (
                  <button
                    type="button"
                    className="primary-button"
                    disabled={busy !== null || !allPassed}
                    onClick={() => void act("reopen", {}, "Luma is open again.")}
                  >
                    Reopen Luma
                  </button>
                ) : null}
              </div>
              {phase === "checking" && !allPassed ? (
                <p className="field-hint">Luma stays closed until every check passes. Fix the problem, then run the checks again.</p>
              ) : null}
            </Block>
          ) : null}

          <Block title="What happened">
            {view.log.length === 0 ? (
              <p className="muted">Nothing yet.</p>
            ) : (
              <ol className="maint-log">
                {view.log.map((row, index) => (
                  <li key={`${row.at}-${index}`}>
                    <span>{ACTION_WORDS[row.action] ?? row.action}</span>
                    {row.from_phase && row.to_phase && row.from_phase !== row.to_phase ? (
                      <span className="muted">
                        {" "}
                        ({PHASE_WORDS[row.from_phase] ?? row.from_phase} to {PHASE_WORDS[row.to_phase] ?? row.to_phase})
                      </span>
                    ) : null}
                    <time className="muted" dateTime={row.at ?? undefined}>
                      {" "}
                      {formatCentral(row.at)}
                    </time>
                  </li>
                ))}
              </ol>
            )}
          </Block>
        </div>
      ) : null}
    </>
  )
}
