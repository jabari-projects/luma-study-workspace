import { useEffect, useId, useRef, useState } from "react"
import type { FormEvent } from "react"

import { getErrorMessage } from "../api"
import { useAuth } from "../auth"
import { PasswordField } from "../account/PasswordField"
import "./work.css"
import { copyUnsavedText, discardWork, resumeWork } from "./unsaved"

/**
 * The page stays open with the student's words when the sign-in ended (401) or the account
 * was signed out in another tab. The email is fixed to that account: only its password works.
 */
export function SignInAgainDialog({
  account,
  reason,
}: {
  account: { id: string; email: string; username: string }
  reason: "expired" | "elsewhere"
}) {
  const { signInAgain } = useAuth()
  const titleId = useId()
  const bodyId = useId()
  const emailId = useId()
  const [password, setPassword] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState<string | null>(null)
  const [confirmThrow, setConfirmThrow] = useState(false)
  const passwordRef = useRef<HTMLInputElement>(null)
  const panelRef = useRef<HTMLElement>(null)

  useEffect(() => {
    passwordRef.current?.focus()
    // Keep Tab inside the box: the page behind it waits for this choice.
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Tab") return
      const panel = panelRef.current
      if (!panel) return
      const items = Array.from(panel.querySelectorAll<HTMLElement>("button:not([disabled]), input:not([disabled])"))
      if (items.length === 0) return
      const first = items[0]
      const last = items[items.length - 1]
      const active = document.activeElement
      if (!panel.contains(active) || (event.shiftKey && active === first) || (!event.shiftKey && active === last)) {
        event.preventDefault()
        ;(event.shiftKey ? last : first).focus()
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [])

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!password) {
      setError("Type your password.")
      passwordRef.current?.focus()
      return
    }
    setBusy(true)
    setError(null)
    try {
      await signInAgain(account.id, account.email, password)
      // The saves that waited for this sign-in try once more.
      resumeWork(account.id)
    } catch (err: unknown) {
      setError(getErrorMessage(err, "That didn't work. Check your password and try again."))
      setBusy(false)
    }
  }

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(copyUnsavedText())
      setCopied("Copied. You can paste it anywhere.")
    } catch {
      setCopied("We couldn't copy it. Select the words on the page and copy them.")
    }
  }

  return (
    <div className="modal-backdrop work-signin-backdrop" role="presentation">
      <section
        ref={panelRef}
        className="modal-panel work-signin"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={bodyId}
      >
        <h2 id={titleId}>{reason === "elsewhere" ? "You signed out in another tab" : "Sign in again to save"}</h2>
        <p id={bodyId}>
          {reason === "elsewhere"
            ? "You signed out in another tab. Sign in again to save this, or copy your text."
            : "Your sign-in ended. Your work is still here. Type your password to keep saving."}
        </p>
        <form className="work-signin-form" onSubmit={submit} noValidate>
          <div className="field">
            <label htmlFor={emailId}>Email</label>
            <input id={emailId} type="email" value={account.email} readOnly autoComplete="username" />
          </div>
          <PasswordField
            label="Password"
            name="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            autoComplete="current-password"
            invalid={Boolean(error)}
            inputRef={passwordRef}
          />
          {error ? (
            <p className="notice error" role="alert">
              {error}
            </p>
          ) : null}
          <div className="button-row">
            <button type="submit" className="primary-button" disabled={busy}>
              {busy ? "Signing in..." : "Sign in"}
            </button>
            <button type="button" className="secondary-button" onClick={() => void copy()} disabled={busy}>
              Copy my text
            </button>
            {confirmThrow ? null : (
              <button type="button" className="ghost-button" onClick={() => setConfirmThrow(true)} disabled={busy}>
                Throw it away
              </button>
            )}
          </div>
          {copied ? (
            <p className="field-hint" role="status">
              {copied}
            </p>
          ) : null}
          {confirmThrow ? (
            <div className="work-throw-confirm" role="group" aria-label="Throw your work away?">
              <p>Throw away the work that isn't saved? This can't be undone.</p>
              <div className="button-row">
                <button type="button" className="secondary-button small" onClick={() => setConfirmThrow(false)}>
                  Keep it
                </button>
                <button type="button" className="danger-button small" onClick={() => discardWork(account.id)}>
                  Throw it away
                </button>
              </div>
            </div>
          ) : null}
        </form>
      </section>
    </div>
  )
}
