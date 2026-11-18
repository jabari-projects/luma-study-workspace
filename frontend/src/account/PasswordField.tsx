import { useId, useState } from "react"
import type { ChangeEvent, ReactNode, Ref } from "react"

// Matches the backend rule (backend/app/passwords.py MIN/MAX_PASSWORD_LENGTH).
export const MIN_PASSWORD_LENGTH = 8
export const MAX_PASSWORD_LENGTH = 128

/** A password box with a Show/Hide button: signup, login, new password and Settings. */
export function PasswordField({
  label,
  name,
  value,
  onChange,
  autoComplete,
  hint,
  extraDescribedBy,
  invalid,
  rule,
  labelAction,
  inputRef,
}: {
  label: string
  name: string
  value: string
  onChange: (event: ChangeEvent<HTMLInputElement>) => void
  autoComplete: "current-password" | "new-password"
  hint?: string
  extraDescribedBy?: string
  invalid?: boolean
  rule?: boolean
  labelAction?: ReactNode
  inputRef?: Ref<HTMLInputElement>
}) {
  const [visible, setVisible] = useState(false)
  const inputId = useId()
  const hintId = useId()
  const describedBy = [hint ? hintId : null, extraDescribedBy].filter(Boolean).join(" ") || undefined

  return (
    <div className="field">
      <div className="field-label-row">
        <label htmlFor={inputId}>{label}</label>
        {labelAction}
      </div>
      <div className="password-field">
        <input
          ref={inputRef}
          id={inputId}
          name={name}
          type={visible ? "text" : "password"}
          autoComplete={autoComplete}
          value={value}
          onChange={onChange}
          minLength={rule ? MIN_PASSWORD_LENGTH : undefined}
          maxLength={MAX_PASSWORD_LENGTH}
          aria-describedby={describedBy}
          aria-invalid={invalid || undefined}
          autoCapitalize="none"
          spellCheck={false}
          required
        />
        <button
          type="button"
          className="password-toggle"
          aria-pressed={visible}
          aria-controls={inputId}
          onClick={() => setVisible((current) => !current)}
        >
          {visible ? "Hide" : "Show"}
          <span className="sr-only"> password</span>
        </button>
      </div>
      {hint ? (
        <p id={hintId} className="field-hint">
          {hint}
        </p>
      ) : null}
    </div>
  )
}
