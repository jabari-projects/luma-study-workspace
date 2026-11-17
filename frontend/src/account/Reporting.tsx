import { useEffect, useId, useRef, useState } from "react"
import type { FormEvent } from "react"
import { Flag } from "@phosphor-icons/react"

import { api, getErrorMessage } from "../api"
import { NoticeBanner, PageHeader } from "../ui/common"
import type { Notice, StudyType } from "../ui/common"
import { Scribble } from "../ui/Scribble"

const REASONS: { value: string; label: string }[] = [
  { value: "bullying", label: "Mean or bullying" },
  { value: "unsafe", label: "Unsafe or scary" },
  { value: "private_info", label: "Shares private info" },
  { value: "spam", label: "Spam or ads" },
  { value: "copyright", label: "Copied from someone else" },
  { value: "wrong_info", label: "Wrong on purpose" },
  { value: "other", label: "Something else" },
]

/** A small "Report" control for a shared study set. */
export function ReportButton({ itemType, itemId, title }: { itemType: StudyType; itemId: string; title: string }) {
  const [open, setOpen] = useState(false)
  const [reason, setReason] = useState("")
  const [details, setDetails] = useState("")
  const [notice, setNotice] = useState<Notice | null>(null)
  const [sending, setSending] = useState(false)
  const [sent, setSent] = useState(false)
  const panelId = useId()
  const firstFieldRef = useRef<HTMLSelectElement>(null)
  const toggleRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (open) {
      firstFieldRef.current?.focus()
    }
  }, [open])

  const close = () => {
    setOpen(false)
    setNotice(null)
    toggleRef.current?.focus()
  }

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!reason) {
      setNotice({ type: "error", text: "Pick a reason first." })
      return
    }
    setSending(true)
    setNotice(null)
    try {
      await api.post("/public/reports", { item_type: itemType, item_id: itemId, reason, details: details.trim() || null })
      setSent(true)
      setNotice({ type: "success", text: "Thanks. A Luma helper will look at this." })
    } catch (error: unknown) {
      setNotice({ type: "error", text: getErrorMessage(error, "We couldn't send that report. Try again.") })
    } finally {
      setSending(false)
    }
  }

  return (
    <div className="report-control">
      <button
        ref={toggleRef}
        type="button"
        className="ghost-button small report-toggle"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => (open ? close() : setOpen(true))}
      >
        <Flag size={18} aria-hidden="true" />
        {sent ? "Reported" : "Report"}
        <span className="sr-only"> {title}</span>
      </button>
      {open ? (
        <form
          id={panelId}
          className="report-panel"
          onSubmit={submit}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.stopPropagation()
              close()
            }
          }}
        >
          <NoticeBanner notice={notice} />
          {sent ? (
            <button type="button" className="secondary-button small" onClick={close}>
              Close
            </button>
          ) : (
            <>
              <label>
                What's wrong?
                <select ref={firstFieldRef} value={reason} onChange={(event) => setReason(event.target.value)} required>
                  <option value="">Pick a reason</option>
                  {REASONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                More details (optional)
                <textarea
                  value={details}
                  maxLength={500}
                  onChange={(event) => setDetails(event.target.value)}
                  placeholder="Tell us what you saw. Don't add your own private info."
                />
              </label>
              <p className="field-hint">The person who made this won't see your name.</p>
              <div className="button-row">
                <button className="primary-button small" type="submit" disabled={sending}>
                  {sending ? "Sending..." : "Send report"}
                </button>
                <button className="ghost-button small" type="button" onClick={close}>
                  Cancel
                </button>
              </div>
            </>
          )}
        </form>
      ) : null}
    </div>
  )
}

type Report = {
  id: string
  item_type: string
  item_id: string
  item_title?: string | null
  reason: string
  details?: string | null
  status: string
  created_at?: string | null
  reviewed_at?: string | null
  reviewer_note?: string | null
}

const STATUS_FILTERS = ["open", "reviewing", "resolved", "dismissed", "all"] as const

const STATUS_LABELS: Record<string, string> = {
  open: "Open",
  reviewing: "Reviewing",
  resolved: "Resolved",
  dismissed: "Dismissed",
  all: "All",
}

const ITEM_LABELS: Record<string, string> = {
  flashcards: "Flashcards",
  note: "Note",
  summary: "Summary",
}

/** A friendly, sentence-case name for a raw value from the API (never throws on an empty one). */
function labelFrom(table: Record<string, string>, value: string | null | undefined, fallback: string): string {
  if (!value) return fallback
  return table[value] ?? value.charAt(0).toUpperCase() + value.slice(1).replace(/_/g, " ")
}

/** Review queue for Luma helpers (users with the admin role). */
export function AdminReportsPage() {
  const [status, setStatus] = useState<(typeof STATUS_FILTERS)[number]>("open")
  const [reports, setReports] = useState<Report[] | null>(null)
  const [notice, setNotice] = useState<Notice | null>(null)
  const [forbidden, setForbidden] = useState(false)

  const [reloadKey, setReloadKey] = useState(0)

  useEffect(() => {
    let active = true
    api
      .get<Report[]>("/admin/reports", { params: { status } })
      .then((response) => {
        if (active) setReports(response.data)
      })
      .catch((error: unknown) => {
        if (!active) return
        const code = (error as { response?: { status?: number } })?.response?.status
        if (code === 403) {
          setForbidden(true)
        } else {
          setNotice({ type: "error", text: getErrorMessage(error, "We couldn't load reports.") })
        }
      })
    return () => {
      active = false
    }
  }, [status, reloadKey])

  const update = async (report: Report, next: string) => {
    try {
      await api.patch(`/admin/reports/${report.id}`, { status: next })
      setNotice({ type: "success", text: `Marked as ${next}.` })
      setReloadKey((key) => key + 1)
    } catch (error: unknown) {
      setNotice({ type: "error", text: getErrorMessage(error, "We couldn't update that report.") })
    }
  }

  if (forbidden) {
    return (
      <>
        <PageHeader title="Reports" description="Only Luma helpers can see this page." />
      </>
    )
  }

  return (
    <>
      <PageHeader
        title={<Scribble type="underline">Reports</Scribble>}
        description="Check shared study sets that students reported. To stop sharing one, use Stop sharing on the item itself."
      />
      <NoticeBanner notice={notice} />
      <div className="choice-chips" role="group" aria-label="Show reports">
        {STATUS_FILTERS.map((option) => (
          <button
            key={option}
            type="button"
            className="chip"
            aria-pressed={option === status}
            onClick={() => setStatus(option)}
          >
            {labelFrom(STATUS_LABELS, option, option)}
          </button>
        ))}
      </div>
      {reports === null ? (
        <p className="muted">Loading reports...</p>
      ) : reports.length === 0 ? (
        <p className="muted">Nothing here. Nice!</p>
      ) : (
        <ul className="report-list">
          {reports.map((report) => (
            <li key={report.id} className="report-row">
              <div className="report-main">
                <p className="report-kind">
                  {labelFrom(ITEM_LABELS, report.item_type, "Study set")}
                  {report.created_at ? ` · ${new Date(report.created_at).toLocaleString()}` : ""}
                </p>
                <h2>{report.item_title || "Untitled study set"}</h2>
                <p className="report-reason">
                  <strong>{REASONS.find((r) => r.value === report.reason)?.label ?? report.reason}</strong>
                </p>
                {report.details ? <p className="report-details">{report.details}</p> : null}
              </div>
              <span className={`status-chip ${report.status ?? ""}`}>{labelFrom(STATUS_LABELS, report.status, "Open")}</span>
              <div className="button-row report-actions">
                {report.status !== "reviewing" ? (
                  <button type="button" className="secondary-button small" onClick={() => void update(report, "reviewing")}>
                    Mark reviewing
                  </button>
                ) : null}
                <button type="button" className="secondary-button small" onClick={() => void update(report, "resolved")}>
                  Resolved
                </button>
                <button type="button" className="ghost-button small" onClick={() => void update(report, "dismissed")}>
                  Dismiss
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </>
  )
}
