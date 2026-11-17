import { useEffect, useId, useRef } from "react"
import type { ReactNode } from "react"

const FOCUSABLE = 'button:not([disabled]), a[href], input:not([disabled]), [tabindex]:not([tabindex="-1"])'

/**
 * "Are you sure?" box for things that can't be undone, like deleting a note.
 * Focus starts on the safe choice. Escape or a tap outside means "no".
 * Tab stays inside, and focus goes back to where it was when the box closes.
 */
export function ConfirmDialog({
  title,
  body,
  confirmLabel,
  cancelLabel,
  busyLabel,
  busy = false,
  onConfirm,
  onCancel,
  returnFocus,
}: {
  title: ReactNode
  body: ReactNode
  confirmLabel: string
  cancelLabel: string
  busyLabel?: string
  busy?: boolean
  onConfirm: () => void
  onCancel: () => void
  /** Where focus goes when the box closes. Defaults to whatever had focus when it opened. */
  returnFocus?: () => HTMLElement | null | undefined
}) {
  const titleId = useId()
  const bodyId = useId()
  const panelRef = useRef<HTMLElement>(null)
  const cancelRef = useRef<HTMLButtonElement>(null)
  const busyRef = useRef(busy)
  const cancelHandler = useRef(onCancel)
  const returnFocusRef = useRef(returnFocus)

  useEffect(() => {
    busyRef.current = busy
    cancelHandler.current = onCancel
    returnFocusRef.current = returnFocus
  })

  // While busy both buttons are off, so hold focus on the box itself instead of the page behind it.
  useEffect(() => {
    const panel = panelRef.current
    if (busy && panel && (!panel.contains(document.activeElement) || document.activeElement?.matches(":disabled"))) {
      panel.focus()
    }
  }, [busy])

  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null
    cancelRef.current?.focus()
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault()
        if (!busyRef.current) cancelHandler.current()
        return
      }
      if (event.key !== "Tab") return
      const panel = panelRef.current
      if (!panel) return
      const items = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE))
      if (!items.length) {
        event.preventDefault()
        panel.focus()
        return
      }
      const first = items[0]
      const last = items[items.length - 1]
      const active = document.activeElement
      if (!panel.contains(active) || (event.shiftKey && active === first) || (!event.shiftKey && active === last)) {
        event.preventDefault()
        ;(event.shiftKey ? last : first).focus()
      }
    }
    window.addEventListener("keydown", onKey)
    return () => {
      window.removeEventListener("keydown", onKey)
      // Put focus back on the button that opened the box, if it is still on the page.
      const target = returnFocusRef.current?.() ?? opener
      if (target?.isConnected) target.focus()
    }
  }, [])

  return (
    <div className="modal-backdrop" role="presentation" onClick={() => !busy && onCancel()}>
      <section
        ref={panelRef}
        className="modal-panel confirm-panel"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={bodyId}
        aria-busy={busy || undefined}
        tabIndex={-1}
        onClick={(event) => event.stopPropagation()}
      >
        <h2 id={titleId}>{title}</h2>
        <p id={bodyId}>{body}</p>
        <div className="button-row confirm-actions">
          <button type="button" className="danger-button" onClick={onConfirm} disabled={busy}>
            {busy && busyLabel ? busyLabel : confirmLabel}
          </button>
          <button ref={cancelRef} type="button" className="secondary-button" onClick={onCancel} disabled={busy}>
            {cancelLabel}
          </button>
        </div>
      </section>
    </div>
  )
}
