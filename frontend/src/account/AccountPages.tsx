import { useCallback, useEffect, useId, useRef, useState } from "react"
import type { ChangeEvent, FormEvent, ReactNode } from "react"
import { Link, Navigate, useLocation, useNavigate } from "react-router-dom"

import { toast } from "sonner"

import { useAuth } from "../auth"
import { api, getErrorCode, getErrorMessage, getRetryAfter, getStoredAccessToken, readBook } from "../api"
import { CODE_ERRORS, CODE_LENGTH, cleanCode, useCountdown } from "./codes"
import { MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH, PasswordField } from "./PasswordField"

const PASSWORD_RULE = `Use ${MIN_PASSWORD_LENGTH} to ${MAX_PASSWORD_LENGTH} characters.`
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

type Message = { kind: "error" | "success" | "info"; text: ReactNode; field?: "email" | "username" | "password" }

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
    <div id={id} aria-live="polite" className="message-slot">
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

/* ------------------------------------------------------------------- login */

export function LoginPage() {
  const { login, isAuthenticated, user, activeAccount, accounts, switchAccount, logoutAccount } = useAuth()
  const navigate = useNavigate()
  const location = useLocation()
  const params = new URLSearchParams(location.search)
  // Add mode: signed in and adding another account. Reauth mode: this tab's account needs its password again.
  const adding = params.get("add") === "1" && isAuthenticated
  // "Use a different account" leaves the expired account saved (and keeps its AI chat spot).
  const [skippedReauthFor, setSkippedReauthFor] = useState<string | null>(null)
  const reauth =
    !adding && activeAccount?.status === "expired" && activeAccount.id !== skippedReauthFor ? activeAccount : null
  const [values, setValues] = useState({ email: "", password: "" })
  const [message, setMessage] = useState<Message | null>(
    params.get("reset")
      ? { kind: "success", text: "Your password is changed, and other devices are logged out. Log in with your new password." }
      : null,
  )
  const [submitting, setSubmitting] = useState(false)
  const messageId = useId()
  const otherAccounts = accounts.filter((account) => !account.isActive)

  const update = (event: ChangeEvent<HTMLInputElement>) =>
    setValues((current) => ({ ...current, [event.target.name]: event.target.value }))

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setSubmitting(true)
    setMessage(null)
    try {
      const email = reauth ? reauth.email : values.email.trim()
      const { user: signedIn, alreadyListed } = await login({ email, password: values.password })
      if (adding) {
        toast.success(
          alreadyListed
            ? `You were already signed in as ${signedIn.username}. Switched to it.`
            : `Added ${signedIn.username}. You're using it now.`,
        )
      }
      if (signedIn.email_verified === false) {
        navigate(`/verify-email?email=${encodeURIComponent(signedIn.email)}`, { replace: true })
        return
      }
      navigate(adding ? "/dashboard" : params.get("redirect") || "/dashboard", { replace: true })
    } catch (error: unknown) {
      setMessage({ kind: "error", text: getErrorMessage(error, "We couldn't log you in. Try again.") })
    } finally {
      setSubmitting(false)
    }
  }

  let title = "Log in"
  let intro: ReactNode = params.get("expired")
    ? "Your password was changed, so please log in again."
    : "Welcome back. Log in to keep studying."
  let footer: ReactNode = (
    <p>
      New to Luma? <Link to="/signup">Make an account</Link>
    </p>
  )
  if (adding) {
    title = "Add another account"
    intro = `Sign in with a different email. You'll stay signed in as ${user?.username ?? "your account"}, and you can switch any time.`
    footer = (
      <p>
        <Link to="/dashboard">Cancel</Link> · New to Luma? <Link to="/signup?add=1">Make another account</Link>
      </p>
    )
  } else if (reauth) {
    title = "Sign in again"
    intro = `Your sign-in for ${reauth.username} ended. Enter your password to keep going.`
    footer = (
      <div className="reauth-footer">
        <p>Or use another account</p>
        <div className="account-choices">
          {otherAccounts.map((account) =>
            account.status === "signed_in" ? (
              <button
                key={account.id}
                type="button"
                className="secondary-button wide"
                onClick={() => {
                  switchAccount(account.id)
                  navigate("/dashboard", { replace: true })
                }}
              >
                Use {account.username}
              </button>
            ) : (
              <button
                key={account.id}
                type="button"
                className="secondary-button wide"
                onClick={() => {
                  // Shows this same page for that account. Nothing is removed.
                  switchAccount(account.id)
                  setValues({ email: "", password: "" })
                  setMessage(null)
                }}
              >
                Sign in again as {account.username}
              </button>
            ),
          )}
          <button
            type="button"
            className="secondary-button wide"
            onClick={() => {
              setSkippedReauthFor(reauth.id)
              setValues({ email: "", password: "" })
              setMessage(null)
            }}
          >
            Use a different account
          </button>
        </div>
        <p>
          <button type="button" className="link-button" onClick={() => logoutAccount(reauth.id)}>
            Remove {reauth.username} from this device
          </button>
        </p>
      </div>
    )
  }

  return (
    <AuthShell title={title} intro={intro} footer={footer}>
      <form className="auth-form sheet" method="post" onSubmit={submit} noValidate={false}>
        <FormMessage message={message} id={messageId} />
        <TextField
          label="Email"
          name="email"
          type="email"
          autoComplete="username"
          value={reauth ? reauth.email : values.email}
          onChange={update}
          extraDescribedBy={message?.kind === "error" ? messageId : undefined}
          invalid={message?.kind === "error"}
          inputProps={{ inputMode: "email", autoCapitalize: "none", spellCheck: false, readOnly: Boolean(reauth) }}
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
          {submitting ? "Logging in..." : adding ? "Add account" : reauth ? "Sign in" : "Log in"}
        </button>
      </form>
    </AuthShell>
  )
}

/* ------------------------------------------------------------------ signup */

export function SignupPage() {
  const { signup, isAuthenticated } = useAuth()
  const navigate = useNavigate()
  const location = useLocation()
  const adding = new URLSearchParams(location.search).get("add") === "1" && isAuthenticated
  const [values, setValues] = useState({ email: "", username: "", password: "" })
  const [message, setMessage] = useState<Message | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const messageId = useId()

  const update = (event: ChangeEvent<HTMLInputElement>) =>
    setValues((current) => ({ ...current, [event.target.name]: event.target.value }))

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (values.password.length < MIN_PASSWORD_LENGTH || values.password.length > MAX_PASSWORD_LENGTH) {
      setMessage({ kind: "error", text: PASSWORD_RULE, field: "password" })
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

  // After an error, mark the field it is about (or every field when we can't tell).
  const isError = message?.kind === "error"
  const errorText = isError && typeof message.text === "string" ? message.text.toLowerCase() : ""
  const named = (["email", "username", "password"] as const).filter(
    (field) => message?.field === field || (!message?.field && errorText.includes(field)),
  )
  const isInvalid = (field: "email" | "username" | "password") =>
    isError && (named.length === 0 || named.includes(field))

  return (
    <AuthShell
      title={adding ? "Make another account" : "Make your account"}
      intro="It's free to start. We'll email you a short code to check it's really you."
      footer={
        adding ? (
          <p>
            <Link to="/dashboard">Cancel</Link> · Have an account? <Link to="/login?add=1">Add it</Link>
          </p>
        ) : (
          <p>
            Have an account? <Link to="/login">Log in</Link>
          </p>
        )
      }
    >
      <form className="auth-form sheet" method="post" onSubmit={submit}>
        <FormMessage message={message} id={messageId} />
        <TextField
          label="Email"
          name="email"
          type="email"
          autoComplete="email"
          value={values.email}
          onChange={update}
          extraDescribedBy={message?.kind === "error" ? messageId : undefined}
          invalid={isInvalid("email")}
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
          invalid={isInvalid("username")}
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
          invalid={isInvalid("password")}
        />
        <button className="primary-button wide" type="submit" disabled={submitting}>
          {submitting ? "Making your account..." : "Make account"}
        </button>
      </form>
    </AuthShell>
  )
}

/* ------------------------------------------------------------ verify email */

export function VerifyEmailPage() {
  const { user, isAuthenticated, verifyEmail, refreshProfile, logoutAccount, accounts, switchAccount } = useAuth()
  const navigate = useNavigate()
  const location = useLocation()
  const params = new URLSearchParams(location.search)
  const urlEmail = params.get("email") || ""
  const knownEmail = urlEmail || (isAuthenticated ? user?.email : "") || ""
  const waitParam = params.get("wait")
  const [email, setEmail] = useState(knownEmail)
  // A signup started in this tab wins, even while signed in: it adds the new account.
  const ticket = readSignupTicket(knownEmail || email)
  const signedInPath = isAuthenticated && !ticket
  // Never check a code against the wrong account.
  const mismatch = Boolean(
    signedInPath && user && urlEmail && urlEmail.trim().toLowerCase() !== user.email.trim().toLowerCase(),
  )
  const mismatchAccount = mismatch
    ? accounts.find((account) => account.email.trim().toLowerCase() === urlEmail.trim().toLowerCase())
    : undefined
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
      if (signedInPath) {
        const response = await api.post<{ resend_after_seconds?: number; message?: string }>("/auth/send-verification")
        setSecondsLeft(response.data.resend_after_seconds ?? 60)
        setMessage({ kind: "success", text: "We sent a new code. It can take a few minutes. Check spam too." })
      } else {
        const response = await api.post<{ resend_after_seconds: number }>(
          "/auth/resend-code",
          { email: email.trim(), ticket: ticket ?? undefined },
          { lumaAuth: "none" },
        )
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
  }, [email, setSecondsLeft, signedInPath, ticket])

  // Logged in but not checked yet (older accounts made before codes):
  // nothing was sent on login, so send a code once when this page opens.
  useEffect(() => {
    if (!signedInPath || mismatch || autoSent.current || waitParam || user?.email_verified !== false) {
      return
    }
    autoSent.current = true
    void sendNewCode()
  }, [mismatch, sendNewCode, signedInPath, user?.email_verified, waitParam])

  if (mismatch) {
    return (
      <AuthShell
        title="Switch accounts first"
        intro={
          <>
            This code is for <strong className="auth-email">{urlEmail}</strong>. Switch to that account first.
          </>
        }
      >
        <div className="account-choices">
          {mismatchAccount ? (
            <button
              type="button"
              className="primary-button wide"
              onClick={() => {
                switchAccount(mismatchAccount.id)
                if (mismatchAccount.status === "expired") {
                  navigate("/login", { replace: true })
                }
              }}
            >
              Switch to it
            </button>
          ) : null}
          <Link className={mismatchAccount ? "secondary-button wide" : "primary-button wide"} to="/login?add=1">
            Add that account
          </Link>
          <Link className="ghost-button wide" to="/dashboard">
            Go back to Luma
          </Link>
        </div>
      </AuthShell>
    )
  }

  if (signedInPath && user && user.email_verified === true) {
    return <Navigate to="/dashboard" replace />
  }

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const cleaned = cleanCode(code)
    if (cleaned.length !== CODE_LENGTH) {
      setMessage({ kind: "error", text: "Type all 6 numbers from the email." })
      return
    }
    if (!signedInPath && !ticket) {
      setMessage({
        kind: "error",
        text: "Please finish signing up in the same browser tab where you started. Or start again.",
      })
      return
    }
    setSubmitting(true)
    setMessage(null)
    try {
      await verifyEmail(ticket ? { email: email.trim(), ticket, code: cleaned } : { code: cleaned })
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
        signedInPath ? (
          <p>
            Not now? <Link to="/dashboard">Go to Luma</Link>. AI tools unlock after you enter the code.{" "}
            <button
              type="button"
              className="link-button"
              onClick={() => {
                if (user) {
                  logoutAccount(user.id)
                }
                navigate("/login", { replace: true })
              }}
            >
              Sign out of this account
            </button>
          </p>
        ) : (
          <p>
            Wrong email? <Link to={isAuthenticated ? "/signup?add=1" : "/signup"}>Start again</Link> or{" "}
            <Link to={isAuthenticated ? "/login?add=1" : "/login"}>log in</Link>
          </p>
        )
      }
    >
      <form className="auth-form sheet" method="post" onSubmit={submit}>
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
            disabled={sending || secondsLeft > 0 || (!signedInPath && !email.trim())}
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
      await api.post("/auth/request-reset", { email: email.trim() }, { lumaAuth: "none" })
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
      <form className="auth-form sheet" method="post" onSubmit={submit}>
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
  const { accounts, refreshProfile } = useAuth()
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
      await api.post("/auth/reset", { token, new_password: password }, { lumaAuth: "none" })
      // We don't know which saved account this was for. Check each one: only the
      // account whose password changed stops working and shows "Sign in again".
      const changed: string[] = []
      for (const account of accounts) {
        if (account.status !== "signed_in") {
          continue
        }
        try {
          await refreshProfile(account.id)
        } catch {
          // A 401 marked it expired. Other errors keep it signed in.
        }
        if (readBook().accounts[account.id]?.status === "expired") {
          changed.push(account.username)
        }
      }
      if (getStoredAccessToken()) {
        // Name the account that needs the new password. This tab's account is still signed in.
        toast.success(
          changed.length
            ? `Password changed. Sign in to ${changed.join(" and ")} again with the new password.`
            : "Password changed.",
        )
        navigate("/dashboard", { replace: true })
      } else {
        navigate("/login?reset=1", { replace: true })
      }
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
      <form className="auth-form sheet" method="post" onSubmit={submit}>
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

/* --------------------------------------------------------- after deleting */

export function AccountDeletedPage() {
  const location = useLocation()
  const navigate = useNavigate()
  const { accounts, logoutAccount, switchAccount } = useAuth()
  const state = location.state as { kept?: string[]; deletedId?: string } | null
  const deletedId = state?.deletedId
  const removed = useRef(false)
  useEffect(() => {
    // The deleted account's sign-in is useless now. Only that account is removed.
    // After a reload there is no state, so nothing is removed.
    if (deletedId && !removed.current) {
      removed.current = true
      logoutAccount(deletedId)
    }
  }, [deletedId, logoutAccount])
  const kept = (state?.kept ?? []).filter(Boolean)
  const remaining = accounts.filter((account) => account.id !== deletedId)
  const next =
    remaining.find((account) => account.isActive) ??
    remaining.find((account) => account.status === "signed_in") ??
    remaining[0]
  return (
    <AuthShell
      title="Your account is deleted"
      intro="Your account, notes, cards, summaries, study plans and uploads are gone."
      footer={
        next ? (
          <div className="account-choices">
            <button
              type="button"
              className="primary-button wide"
              onClick={() => {
                switchAccount(next.id)
                navigate("/dashboard", { replace: true })
              }}
            >
              Go back to Luma as {next.username}
            </button>
            <p>
              <Link to="/">Go to the start page</Link>
            </p>
          </div>
        ) : (
          <p>
            <Link to="/">Go to the start page</Link>
          </p>
        )
      }
    >
      {kept.length ? (
        <section className="auth-form sheet" aria-labelledby="kept-heading">
          <h2 id="kept-heading">A few records stay, and here is why</h2>
          <ul>
            {kept.map((line) => (
              <li key={line}>{line}.</li>
            ))}
          </ul>
        </section>
      ) : null}
    </AuthShell>
  )
}
