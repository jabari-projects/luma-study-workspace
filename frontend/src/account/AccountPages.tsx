import { useCallback, useEffect, useId, useRef, useState } from "react"
import type { ChangeEvent, FormEvent, ReactNode } from "react"
import { Link, Navigate, useLocation, useNavigate } from "react-router-dom"

import { useAuth } from "../auth"
import { api, getErrorCode, getErrorMessage, getRetryAfter } from "../api"

// Matches the backend rule (backend/app/passwords.py MIN/MAX_PASSWORD_LENGTH).
export const MIN_PASSWORD_LENGTH = 8
export const MAX_PASSWORD_LENGTH = 128
const PASSWORD_RULE = `Use ${MIN_PASSWORD_LENGTH} to ${MAX_PASSWORD_LENGTH} characters.`
const CODE_LENGTH = 6
const SIGNUP_TICKET_KEY = "luma.signupTicket"

// The signup ticket stays in this tab's session storage only. It is needed
// together with the emailed code, so a code alone can't finish a signup.
function saveSignupTicket(email: string, ticket: string) {
  try {
    window.sessionStorage.setItem(SIGNUP_TICKET_KEY, JSON.stringify({ email, ticket }))
  } catch {
    // Storage blocked: the code page will explain what to do.
  }
}

function readSignupTicket(email: string): string | null {
  try {
    const saved = JSON.parse(window.sessionStorage.getItem(SIGNUP_TICKET_KEY) || "null") as
      | { email?: string; ticket?: string }
      | null
    if (saved?.ticket && saved.email?.toLowerCase() === email.trim().toLowerCase()) {
      return saved.ticket
    }
  } catch {
    // Ignore unreadable storage.
  }
  return null
}

function clearSignupTicket() {
  try {
    window.sessionStorage.removeItem(SIGNUP_TICKET_KEY)
  } catch {
    // Nothing to clear.
  }
}

type Message = { kind: "error" | "success" | "info"; text: ReactNode }

/* ------------------------------------------------------------------ pieces */

function AuthShell({
  title,
  intro,
  children,
  footer,
}: {
  title: string
  intro?: ReactNode
  children: ReactNode
  footer?: ReactNode
}) {
  const headingRef = useRef<HTMLHeadingElement>(null)
  useEffect(() => {
    headingRef.current?.focus()
  }, [title])

  return (
    <main className="auth-screen">
      <section className="auth-card" aria-labelledby="auth-title">
        <Link to="/" className="auth-brand">
          <img src="/luma-star.png" alt="" width={40} height={40} />
          <span>Luma</span>
        </Link>
        <h1 id="auth-title" ref={headingRef} tabIndex={-1}>
          {title}
        </h1>
        {intro ? <p className="auth-intro">{intro}</p> : null}
        {children}
        {footer ? <div className="auth-footer">{footer}</div> : null}
      </section>
    </main>
  )
}

function FormMessage({ message, id }: { message: Message | null; id: string }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (message?.kind === "error") {
      ref.current?.focus()
    }
  }, [message])

  // The live region stays in the page so screen readers hear each new message.
  return (
    <div id={id} aria-live="polite" className="auth-message-slot">
      {message ? (
        <div
          ref={ref}
          tabIndex={-1}
          className={`notice ${message.kind}`}
          role={message.kind === "error" ? "alert" : undefined}
        >
          {message.text}
        </div>
      ) : null}
    </div>
  )
}

function PasswordField({
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

function TextField({
  label,
  name,
  type = "text",
  value,
  onChange,
  autoComplete,
  hint,
  extraDescribedBy,
  invalid,
  inputProps,
}: {
  label: string
  name: string
  type?: string
  value: string
  onChange: (event: ChangeEvent<HTMLInputElement>) => void
  autoComplete?: string
  hint?: string
  extraDescribedBy?: string
  invalid?: boolean
  inputProps?: Record<string, unknown>
}) {
  const inputId = useId()
  const hintId = useId()
  const describedBy = [hint ? hintId : null, extraDescribedBy].filter(Boolean).join(" ") || undefined
  return (
    <div className="field">
      <label htmlFor={inputId}>{label}</label>
      <input
        id={inputId}
        name={name}
        type={type}
        autoComplete={autoComplete}
        value={value}
        onChange={onChange}
        aria-describedby={describedBy}
        aria-invalid={invalid || undefined}
        required
        {...inputProps}
      />
      {hint ? (
        <p id={hintId} className="field-hint">
          {hint}
        </p>
      ) : null}
    </div>
  )
}

function useCountdown() {
  const [secondsLeft, setSecondsLeft] = useState(0)
  useEffect(() => {
    if (secondsLeft <= 0) {
      return
    }
    const timer = window.setTimeout(() => setSecondsLeft((value) => value - 1), 1000)
    return () => window.clearTimeout(timer)
  }, [secondsLeft])
  return [secondsLeft, setSecondsLeft] as const
}

function cleanCode(raw: string): string {
  return raw.replace(/\D/g, "").slice(0, CODE_LENGTH)
}

/* ------------------------------------------------------------------- login */

export function LoginPage() {
  const { login } = useAuth()
  const navigate = useNavigate()
  const location = useLocation()
  const params = new URLSearchParams(location.search)
  const [values, setValues] = useState({ email: "", password: "" })
  const [message, setMessage] = useState<Message | null>(
    params.get("reset")
      ? { kind: "success", text: "Your password is changed, and other devices are logged out. Log in with your new password." }
      : null,
  )
  const [submitting, setSubmitting] = useState(false)
  const messageId = useId()

  const update = (event: ChangeEvent<HTMLInputElement>) =>
    setValues((current) => ({ ...current, [event.target.name]: event.target.value }))

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setSubmitting(true)
    setMessage(null)
    try {
      const user = await login({ email: values.email.trim(), password: values.password })
      if (user.email_verified === false) {
        navigate(`/verify-email?email=${encodeURIComponent(user.email)}`, { replace: true })
        return
      }
      navigate(params.get("redirect") || "/dashboard", { replace: true })
    } catch (error: unknown) {
      setMessage({ kind: "error", text: getErrorMessage(error, "We couldn't log you in. Try again.") })
    } finally {
      setSubmitting(false)
    }
  }

  const intro = params.get("expired")
    ? "Your password was changed, so please log in again."
    : "Welcome back. Log in to keep studying."

  return (
    <AuthShell
      title="Log in"
      intro={intro}
      footer={
        <p>
          New to Luma? <Link to="/signup">Make an account</Link>
        </p>
      }
    >
      <form className="form-panel auth-form" method="post" onSubmit={submit} noValidate={false}>
        <FormMessage message={message} id={messageId} />
        <TextField
          label="Email"
          name="email"
          type="email"
          autoComplete="username"
          value={values.email}
          onChange={update}
          extraDescribedBy={message?.kind === "error" ? messageId : undefined}
          invalid={message?.kind === "error"}
          inputProps={{ inputMode: "email", autoCapitalize: "none", spellCheck: false }}
        />
        <PasswordField
          label="Password"
          name="password"
          autoComplete="current-password"
          value={values.password}
          onChange={update}
          extraDescribedBy={message?.kind === "error" ? messageId : undefined}
          invalid={message?.kind === "error"}
          labelAction={
            <Link className="field-link" to="/forgot-password">
              Forgot password?
            </Link>
          }
        />
        <button className="primary-button wide" type="submit" disabled={submitting}>
          {submitting ? "Logging in..." : "Log in"}
        </button>
      </form>
    </AuthShell>
  )
}

/* ------------------------------------------------------------------ signup */

export function SignupPage() {
  const { signup } = useAuth()
  const navigate = useNavigate()
  const [values, setValues] = useState({ email: "", username: "", password: "" })
  const [message, setMessage] = useState<Message | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const messageId = useId()

  const update = (event: ChangeEvent<HTMLInputElement>) =>
    setValues((current) => ({ ...current, [event.target.name]: event.target.value }))

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (values.password.length < MIN_PASSWORD_LENGTH || values.password.length > MAX_PASSWORD_LENGTH) {
      setMessage({ kind: "error", text: PASSWORD_RULE })
      return
    }
    setSubmitting(true)
    setMessage(null)
    try {
      const pending = await signup({
        email: values.email.trim(),
        username: values.username.trim(),
        password: values.password,
      })
      saveSignupTicket(pending.email, pending.ticket)
      const query = new URLSearchParams({ email: pending.email, wait: String(pending.resend_after_seconds) })
      navigate(`/verify-email?${query.toString()}`, { replace: true })
    } catch (error: unknown) {
      setMessage({ kind: "error", text: getErrorMessage(error, "We couldn't make your account. Try again.") })
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <AuthShell
      title="Make your account"
      intro="It's free to start. We'll email you a short code to check it's really you."
      footer={
        <p>
          Have an account? <Link to="/login">Log in</Link>
        </p>
      }
    >
      <form className="form-panel auth-form" method="post" onSubmit={submit}>
        <FormMessage message={message} id={messageId} />
        <TextField
          label="Email"
          name="email"
          type="email"
          autoComplete="email"
          value={values.email}
          onChange={update}
          extraDescribedBy={message?.kind === "error" ? messageId : undefined}
          inputProps={{ inputMode: "email", autoCapitalize: "none", spellCheck: false }}
        />
        <TextField
          label="Username"
          name="username"
          autoComplete="username"
          value={values.username}
          onChange={update}
          hint="3 or more letters, numbers, or _ . Other people can see it."
          extraDescribedBy={message?.kind === "error" ? messageId : undefined}
          inputProps={{
            minLength: 3,
            pattern: "[a-zA-Z0-9_]+",
            autoCapitalize: "none",
            spellCheck: false,
          }}
        />
        <PasswordField
          label="Password"
          name="password"
          autoComplete="new-password"
          value={values.password}
          onChange={update}
          hint={PASSWORD_RULE}
          rule
          extraDescribedBy={message?.kind === "error" ? messageId : undefined}
        />
        <button className="primary-button wide" type="submit" disabled={submitting}>
          {submitting ? "Making your account..." : "Make account"}
        </button>
      </form>
    </AuthShell>
  )
}

/* ------------------------------------------------------------ verify email */

const CODE_ERRORS: Record<string, string> = {
  code_incorrect: "That code doesn't match. Check your newest email and try again.",
  code_expired: "That code is too old. Tap \"Send a new code\".",
  code_locked: "Too many tries with that code. Tap \"Send a new code\".",
  rate_limited: "Too many tries. Wait a little, then try again.",
}

export function VerifyEmailPage() {
  const { user, isAuthenticated, verifyEmail, refreshProfile, logout } = useAuth()
  const navigate = useNavigate()
  const location = useLocation()
  const params = new URLSearchParams(location.search)
  const knownEmail = params.get("email") || (isAuthenticated ? user?.email : "") || ""
  const waitParam = params.get("wait")
  const [email, setEmail] = useState(knownEmail)
  const ticket = isAuthenticated ? null : readSignupTicket(knownEmail || email)
  const autoSent = useRef(false)
  const [code, setCode] = useState("")
  const [message, setMessage] = useState<Message | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [sending, setSending] = useState(false)
  const [secondsLeft, setSecondsLeft] = useCountdown()
  const messageId = useId()
  const codeHintId = useId()
  const startedCountdown = useRef(false)

  useEffect(() => {
    if (startedCountdown.current) {
      return
    }
    startedCountdown.current = true
    const wait = Number(waitParam)
    if (Number.isFinite(wait) && wait > 0) {
      setSecondsLeft(Math.min(wait, 600))
    }
  }, [waitParam, setSecondsLeft])

  const sendNewCode = useCallback(async () => {
    setSending(true)
    setMessage(null)
    try {
      if (isAuthenticated) {
        const response = await api.post<{ resend_after_seconds?: number; message?: string }>("/auth/send-verification")
        setSecondsLeft(response.data.resend_after_seconds ?? 60)
        setMessage({ kind: "success", text: "We sent a new code. It can take a few minutes. Check spam too." })
      } else {
        const response = await api.post<{ resend_after_seconds: number }>("/auth/resend-code", {
          email: email.trim(),
          ticket: ticket ?? undefined,
        })
        setSecondsLeft(response.data.resend_after_seconds)
        setMessage({
          kind: "success",
          text: "If that email can get a code, a new one is on its way. It can take a few minutes. Check spam too.",
        })
      }
    } catch (error: unknown) {
      const retry = getRetryAfter(error)
      if (retry) {
        setSecondsLeft(Math.min(retry, 3600))
      }
      setMessage({ kind: "error", text: getErrorMessage(error, "We couldn't send a code. Try again in a minute.") })
    } finally {
      setSending(false)
    }
  }, [email, isAuthenticated, setSecondsLeft, ticket])

  // Logged in but not checked yet (older accounts, or after changing email):
  // nothing was sent on login, so send a code once when this page opens.
  useEffect(() => {
    if (!isAuthenticated || autoSent.current || waitParam || user?.email_verified !== false) {
      return
    }
    autoSent.current = true
    void sendNewCode()
  }, [isAuthenticated, sendNewCode, user?.email_verified, waitParam])

  if (isAuthenticated && user && user.email_verified === true) {
    return <Navigate to="/dashboard" replace />
  }

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const cleaned = cleanCode(code)
    if (cleaned.length !== CODE_LENGTH) {
      setMessage({ kind: "error", text: "Type all 6 numbers from the email." })
      return
    }
    if (!isAuthenticated && !ticket) {
      setMessage({
        kind: "error",
        text: "Please finish signing up in the same browser tab where you started. Or start again.",
      })
      return
    }
    setSubmitting(true)
    setMessage(null)
    try {
      await verifyEmail(isAuthenticated ? { code: cleaned } : { email: email.trim(), ticket: ticket ?? "", code: cleaned })
      clearSignupTicket()
      try {
        await refreshProfile()
      } catch {
        // The new session works even if the profile can't load yet.
      }
      navigate("/dashboard", { replace: true })
    } catch (error: unknown) {
      const errorCode = getErrorCode(error)
      setMessage({
        kind: "error",
        text: (errorCode && CODE_ERRORS[errorCode]) || getErrorMessage(error, "That code didn't work. Try again."),
      })
      if (errorCode === "code_expired" || errorCode === "code_locked") {
        setCode("")
      }
    } finally {
      setSubmitting(false)
    }
  }

  const intro = knownEmail ? (
    <>
      We're sending a 6-number code to <strong className="auth-email">{knownEmail}</strong>. Each code works for 10
      minutes. It can take a few minutes to arrive.
    </>
  ) : (
    "Type your email and the 6-number code we sent you."
  )

  return (
    <AuthShell
      title="Check your email"
      intro={intro}
      footer={
        isAuthenticated ? (
          <p>
            Not now? <Link to="/dashboard">Go to Luma</Link>. AI tools unlock after you enter the code.{" "}
            <button
              type="button"
              className="link-button"
              onClick={() => {
                logout()
                navigate("/login", { replace: true })
              }}
            >
              Log out
            </button>
          </p>
        ) : (
          <p>
            Wrong email? <Link to="/signup">Start again</Link> or <Link to="/login">log in</Link>
          </p>
        )
      }
    >
      <form className="form-panel auth-form" method="post" onSubmit={submit}>
        <FormMessage message={message} id={messageId} />
        {knownEmail ? null : (
          <TextField
            label="Email"
            name="email"
            type="email"
            autoComplete="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            inputProps={{ inputMode: "email", autoCapitalize: "none", spellCheck: false }}
          />
        )}
        <div className="field">
          <label htmlFor="verify-code">6-number code</label>
          <input
            id="verify-code"
            name="code"
            className="code-input"
            type="text"
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="[0-9 \-]*"
            maxLength={12}
            value={code}
            onChange={(event) => setCode(event.target.value.replace(/[^\d\s-]/g, ""))}
            aria-describedby={[codeHintId, message?.kind === "error" ? messageId : null].filter(Boolean).join(" ")}
            aria-invalid={message?.kind === "error" || undefined}
            required
          />
          <p id={codeHintId} className="field-hint">
            You can paste it. Can't find it? Check spam.
          </p>
        </div>
        <button className="primary-button wide" type="submit" disabled={submitting}>
          {submitting ? "Checking..." : "Check code"}
        </button>
        <div className="resend-row">
          <button
            type="button"
            className="secondary-button wide"
            onClick={sendNewCode}
            disabled={sending || secondsLeft > 0 || (!isAuthenticated && !email.trim())}
            aria-describedby="resend-wait"
          >
            {sending ? "Sending..." : "Send a new code"}
          </button>
          <p id="resend-wait" className="field-hint" aria-live="off">
            {secondsLeft > 0 ? `You can ask for a new code in ${secondsLeft} seconds.` : "A new code replaces the old one."}
          </p>
        </div>
      </form>
    </AuthShell>
  )
}

/* -------------------------------------------------------- forgot password */

export function ForgotPasswordPage() {
  const [email, setEmail] = useState("")
  const [message, setMessage] = useState<Message | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [sent, setSent] = useState(false)
  const messageId = useId()

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setSubmitting(true)
    setMessage(null)
    try {
      await api.post("/auth/request-reset", { email: email.trim() })
      setSent(true)
      setMessage({
        kind: "success",
        text: "If there's a Luma account for that email, we sent a reset link. It can take a few minutes. Check spam too. The link works for 30 minutes.",
      })
    } catch (error: unknown) {
      setMessage({ kind: "error", text: getErrorMessage(error, "We couldn't send that. Try again in a minute.") })
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <AuthShell
      title="Reset your password"
      intro="Type your email. We'll send you a link to make a new password."
      footer={
        <p>
          Remembered it? <Link to="/login">Log in</Link>
        </p>
      }
    >
      <form className="form-panel auth-form" method="post" onSubmit={submit}>
        <FormMessage message={message} id={messageId} />
        <TextField
          label="Email"
          name="email"
          type="email"
          autoComplete="email"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          extraDescribedBy={message ? messageId : undefined}
          inputProps={{ inputMode: "email", autoCapitalize: "none", spellCheck: false }}
        />
        <button className="primary-button wide" type="submit" disabled={submitting}>
          {submitting ? "Sending..." : sent ? "Send the link again" : "Send reset link"}
        </button>
      </form>
    </AuthShell>
  )
}

/* --------------------------------------------------------- reset password */

export function ResetPasswordPage() {
  const location = useLocation()
  const navigate = useNavigate()
  const { logout } = useAuth()
  const token = new URLSearchParams(location.search).get("token") ?? ""
  const [password, setPassword] = useState("")
  const [message, setMessage] = useState<Message | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const messageId = useId()

  if (!token) {
    return (
      <AuthShell title="This link isn't complete" intro="Open the newest reset email and tap the button in it.">
        <p className="auth-footer">
          <Link className="primary-button wide" to="/forgot-password">
            Get a new reset link
          </Link>
        </p>
      </AuthShell>
    )
  }

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (password.length < MIN_PASSWORD_LENGTH || password.length > MAX_PASSWORD_LENGTH) {
      setMessage({ kind: "error", text: PASSWORD_RULE })
      return
    }
    setSubmitting(true)
    setMessage(null)
    try {
      await api.post("/auth/reset", { token, new_password: password })
      logout()
      navigate("/login?reset=1", { replace: true })
    } catch (error: unknown) {
      if (getErrorCode(error) === "reset_invalid") {
        setMessage({
          kind: "error",
          text: (
            <>
              That reset link doesn't work anymore. Links work once, for 30 minutes.{" "}
              <Link to="/forgot-password">Get a new link</Link>
            </>
          ),
        })
      } else {
        setMessage({ kind: "error", text: getErrorMessage(error, "We couldn't change your password. Try again.") })
      }
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <AuthShell title="Make a new password" intro="After this, you'll be logged out on your other devices.">
      <form className="form-panel auth-form" method="post" onSubmit={submit}>
        <FormMessage message={message} id={messageId} />
        {/* Hidden username helps password managers save the new password. */}
        <input type="text" name="username" autoComplete="username" hidden readOnly value="" />
        <PasswordField
          label="New password"
          name="new-password"
          autoComplete="new-password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          hint={PASSWORD_RULE}
          rule
          extraDescribedBy={message?.kind === "error" ? messageId : undefined}
          invalid={message?.kind === "error"}
        />
        <button className="primary-button wide" type="submit" disabled={submitting}>
          {submitting ? "Saving..." : "Save new password"}
        </button>
      </form>
    </AuthShell>
  )
}

/* ------------------------------------------------------- unverified banner */

export function VerifyEmailBanner() {
  const { user, isAuthenticated } = useAuth()
  if (!isAuthenticated || !user || user.email_verified !== false) {
    return null
  }
  return (
    <div className="verify-banner" role="status">
      <p>
        <strong>Check your email.</strong> Enter your code to use AI tools.
      </p>
      <Link className="secondary-button small" to={`/verify-email?email=${encodeURIComponent(user.email)}`}>
        Enter code
      </Link>
    </div>
  )
}
