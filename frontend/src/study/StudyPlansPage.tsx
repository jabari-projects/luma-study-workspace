import { useEffect, useRef, useState } from "react"
import type { FormEvent } from "react"
import { Link } from "react-router-dom"
import { toast } from "sonner"
import { ArrowLeft, CalendarBlank, Trash } from "@phosphor-icons/react"

import { api, getErrorMessage, getTabAccountId } from "../api"
import { ConfirmDialog } from "../ui/ConfirmDialog"
import { NoticeBanner } from "../ui/common"
import type { Notice } from "../ui/common"
import { Scribble } from "../ui/Scribble"
import { DraftOffer } from "../work/DraftOffer"
import { newCreateKey, useEditSession } from "../work/useAutosave"
import { useExplicitWork } from "../work/useExplicitWork"
import { STUDY_HUB, STUDY_PLANS, planMinutesText, secondsFromMinutes } from "./hub"

/** A study plan as the server sends it. Time is kept in seconds; the page shows minutes. */
type StudyPlan = {
  id: string
  name?: string | null
  subject?: string | null
  notes?: string | null
  duration_seconds?: number | null
  created_at?: string
  updated_at?: string | null
}

const emptyForm = { name: "", subject: "", minutes: "", notes: "" }
type PlanForm = typeof emptyForm & { createKey?: string }

function isPlanForm(value: unknown): value is PlanForm {
  const v = value as Partial<PlanForm> | null
  return Boolean(v && ["name", "subject", "minutes", "notes"].every((key) => typeof v[key as keyof PlanForm] === "string"))
}

const hasWords = (form: PlanForm) => Boolean(form.name.trim() || form.subject.trim() || form.minutes.trim() || form.notes.trim())

const planName = (plan: StudyPlan) => plan.name?.trim() || "Untitled plan"

/** /study-sessions: write down what to study and for how long. It does not start a review. */
export function StudyPlansPage() {
  const [plans, setPlans] = useState<StudyPlan[]>([])
  const [loading, setLoading] = useState(true)
  // This tab's account when the page opened. The plan is saved into it.
  const [accountId] = useState(() => getTabAccountId())
  // One Idempotency-Key per new plan: a retry after a lost answer can't make two plans.
  const [form, setForm] = useState<PlanForm>(() => ({ ...emptyForm, createKey: newCreateKey() }))
  const [notice, setNotice] = useState<Notice | null>(null)
  const [saving, setSaving] = useState(false)
  const [deleting, setDeleting] = useState<StudyPlan | null>(null)
  const [removing, setRemoving] = useState(false)
  const listRef = useRef<HTMLElement>(null)
  const deleteButtons = useRef(new Map<string, HTMLButtonElement>())
  const { headers: sessionHeaders } = useEditSession()
  const work = useExplicitWork<PlanForm>({
    label: "Your study plan",
    accountId,
    kind: "plan",
    data: hasWords(form) ? form : null,
    saving,
    textOf: (value) => [value.name, value.subject, value.minutes ? `${value.minutes} minutes` : "", value.notes].filter(Boolean).join("\n"),
    accept: isPlanForm,
    onDiscard: () => setForm({ ...emptyForm, createKey: newCreateKey() }),
  })

  useEffect(() => {
    let active = true
    api
      .get<StudyPlan[]>(STUDY_PLANS)
      .then((response) => {
        if (active) setPlans(Array.isArray(response.data) ? response.data.filter((plan) => plan && typeof plan.id === "string") : [])
      })
      .catch((error: unknown) => {
        if (active) setNotice({ type: "error", text: getErrorMessage(error, "We couldn't load your study plans. Try again in a moment.") })
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => {
      active = false
    }
  }, [])

  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setNotice(null)
    if (!form.name.trim()) {
      setNotice({ type: "error", text: "Give your plan a name." })
      return
    }
    // Save into the account that showed this page, even if the tab switches meanwhile.
    const createKey = form.createKey ?? newCreateKey()
    setSaving(true)
    try {
      const response = await api.post<StudyPlan>(
        STUDY_PLANS,
        {
          name: form.name.trim(),
          subject: form.subject.trim(),
          notes: form.notes.trim(),
          duration_seconds: secondsFromMinutes(form.minutes),
        },
        { lumaAccountId: accountId ?? undefined, timeout: 30_000, headers: { ...sessionHeaders(), "Idempotency-Key": createKey } },
      )
      if ((getTabAccountId() ?? null) !== accountId) return
      setForm({ ...emptyForm, createKey: newCreateKey() })
      setPlans((current) => [response.data, ...current.filter((plan) => plan.id !== response.data.id)])
      toast.success(`Saved “${planName(response.data)}”.`)
    } catch (error: unknown) {
      setNotice({ type: "error", text: getErrorMessage(error, "We couldn't save this plan. Try again in a moment.") })
    } finally {
      setSaving(false)
    }
  }

  const confirmDelete = async () => {
    if (!deleting) return
    const target = deleting
    setRemoving(true)
    try {
      await api.delete(`${STUDY_PLANS}/${target.id}`, { lumaAccountId: accountId ?? undefined })
      setPlans((current) => current.filter((plan) => plan.id !== target.id))
      toast.success(`Deleted “${planName(target)}”.`)
    } catch (error: unknown) {
      setNotice({ type: "error", text: getErrorMessage(error, "We couldn't delete that. It is still here.") })
    } finally {
      setRemoving(false)
      setDeleting(null)
    }
  }

  return (
    <div className="study-plans">
      <header className="page-head">
        <div>
          <h1>
            Study <Scribble type="underline">plans</Scribble>
          </h1>
          <p className="lede">Write down what you want to study and for how long.</p>
        </div>
        <div className="page-head-actions">
          <Link className="ghost-button" to={STUDY_HUB}>
            <ArrowLeft weight="bold" aria-hidden="true" /> Back to Study
          </Link>
        </div>
      </header>

      <NoticeBanner notice={notice} />

      <div className="plans-layout">
        <section className="plan-list" aria-labelledby="plan-list-title" ref={listRef} tabIndex={-1}>
          <div className="section-head">
            <h2 id="plan-list-title">Your plans</h2>
          </div>
          {loading ? (
            <p className="hub-empty" role="status">
              <span className="spinner small-spinner" aria-hidden="true" /> Loading your plans...
            </p>
          ) : plans.length === 0 ? (
            <p className="hub-empty" role="status">
              No study plans yet.
            </p>
          ) : (
            <ul className="row-list">
              {plans.map((plan) => {
                const minutes = planMinutesText(plan.duration_seconds)
                const detail = [plan.subject?.trim(), minutes].filter(Boolean).join(" · ")
                return (
                  <li key={plan.id} className="row plan-row">
                    <span className="row-icon" aria-hidden="true">
                      <CalendarBlank weight="duotone" />
                    </span>
                    <span className="row-main">
                      <strong className="plan-name">{planName(plan)}</strong>
                      {detail ? <small>{detail}</small> : null}
                      {plan.notes?.trim() ? <span className="row-preview">{plan.notes.trim()}</span> : null}
                    </span>
                    <button
                      ref={(element) => {
                        if (element) deleteButtons.current.set(plan.id, element)
                        else deleteButtons.current.delete(plan.id)
                      }}
                      type="button"
                      className="icon-button"
                      aria-label={`Delete ${planName(plan)}`}
                      onClick={() => setDeleting(plan)}
                    >
                      <Trash aria-hidden="true" />
                    </button>
                  </li>
                )
              })}
            </ul>
          )}
        </section>
        <form className="plan-form" onSubmit={save} noValidate aria-labelledby="plan-form-title">
          <h2 id="plan-form-title">New plan</h2>
          {work.offer ? (
            <DraftOffer
              onUse={() => {
                const restored = work.takeOffer()
                if (restored) setForm({ ...restored, createKey: restored.createKey ?? newCreateKey() })
              }}
              onThrowAway={work.dropOffer}
            />
          ) : null}
          <label>
            Name
            <input
              value={form.name}
              onChange={(event) => setForm((current) => ({ ...current, name: event.target.value }))}
              placeholder="Like: Chapter 3 review"
              maxLength={200}
              required
            />
          </label>
          <div className="plan-form-pair">
            <label>
              Subject (optional)
              <input
                value={form.subject}
                onChange={(event) => setForm((current) => ({ ...current, subject: event.target.value }))}
                placeholder="Like: Biology"
                maxLength={200}
              />
            </label>
            <label>
              Minutes
              <input
                type="number"
                inputMode="numeric"
                min={0}
                step={1}
                value={form.minutes}
                onChange={(event) => setForm((current) => ({ ...current, minutes: event.target.value }))}
                placeholder="Like: 25"
              />
            </label>
          </div>
          <label>
            Notes (optional)
            <textarea
              value={form.notes}
              onChange={(event) => setForm((current) => ({ ...current, notes: event.target.value }))}
              placeholder="What do you want to study?"
              rows={3}
            />
          </label>
          <div className="button-row">
            <button type="submit" className="primary-button" disabled={saving}>
              {saving ? "Saving..." : "Save plan"}
            </button>
          </div>
          {work.draftProblem ? <p className="field-hint">{work.draftProblem}</p> : null}
        </form>

      </div>

      {deleting ? (
        <ConfirmDialog
          title={`Delete “${planName(deleting)}”?`}
          body="You can't get it back."
          confirmLabel="Delete"
          busyLabel="Deleting..."
          cancelLabel="Keep it"
          busy={removing}
          onConfirm={() => void confirmDelete()}
          onCancel={() => setDeleting(null)}
          returnFocus={() => deleteButtons.current.get(deleting.id) ?? listRef.current}
        />
      ) : null}
    </div>
  )
}
