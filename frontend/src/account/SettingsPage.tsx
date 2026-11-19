import { Fragment, useEffect, useRef, useState } from "react"
import type { CSSProperties, FormEvent, ReactNode } from "react"
import { useLocation, useNavigate } from "react-router-dom"

import { useAuth, useProfile } from "../auth"
import { api, getErrorCode, getErrorMessage, getRetryAfter } from "../api"
import type { Profile } from "../api"
import { MAX_ACCOUNTS } from "../accounts"
import { AI_CHAT_UI_ENABLED } from "../config"
import { AccountList } from "../ui/AccountMenu"
import { NoticeBanner } from "../ui/common"
import type { Notice } from "../ui/common"
import { Scribble } from "../ui/Scribble"
import { DEFAULT_ACCENT, themeColors } from "../ui/themeColors"
import { normalizeMode, resolveMode } from "../ui/theme"
import type { ThemeMode } from "../ui/theme"
import { CODE_ERRORS, CODE_LENGTH, cleanCode, useCountdown, waitWords } from "./codes"
import { PasswordField } from "./PasswordField"

/**
 * Settings holds only things about you and this device: your account, how Luma looks,
 * the accounts signed in here, and deleting your account (last, in red).
 * Switching accounts and signing out also live in the avatar menu; a deck's or note's
 * own options (sharing, delete) stay on that deck or note.
 */
const SETTINGS_SECTIONS = [
  { id: "account", label: "Account" },
  { id: "appearance", label: "Appearance" },
  { id: "accounts", label: "Accounts on this device" },
  { id: "delete-account", label: "Delete account" },
] as const

type SectionId = (typeof SETTINGS_SECTIONS)[number]["id"]

/** One settings group: its name and a short help line on the left (wide screens), the controls on the right. */
function SettingsSection({
  id,
  title,
  help,
  danger = false,
  children,
}: {
  id: SectionId
  title: string
  help: ReactNode
  danger?: boolean
  children: ReactNode
}) {
  const { hash } = useLocation()
  const ref = useRef<HTMLElement>(null)

  // Opened as /settings#accounts (for example when the device already has 3 accounts): show that part.
  useEffect(() => {
    if (hash === `#${id}`) {
      ref.current?.scrollIntoView({ block: "start" })
    }
  }, [hash, id])

  return (
    <section
      ref={ref}
      id={id}
      className={danger ? "settings-section danger" : "settings-section"}
      aria-labelledby={`${id}-title`}
    >
      <div className="settings-label">
        <h2 id={`${id}-title`}>{title}</h2>
        <p>{help}</p>
      </div>
      <div className="settings-body">{children}</div>
    </section>
  )
}

export function SettingsPage() {
  const profile = useProfile()
  const { user } = useAuth()
  const [notice, setNotice] = useState<Notice | null>(null)
  const settingsKey = profile?.id ?? user?.id ?? "empty"

  return (
    <div className="settings-page">
      <header className="page-head">
        <div>
          <h1>
            <Scribble type="underline">Settings</Scribble>
          </h1>
          <p className="lede">Your account, how Luma looks, and who is signed in on this device.</p>
        </div>
      </header>

      <nav className="settings-index" aria-label="Settings sections">
        <ul>
          {SETTINGS_SECTIONS.map((section) => (
            <li key={section.id}>
              <a href={`#${section.id}`}>{section.label}</a>
            </li>
          ))}
        </ul>
      </nav>

      <div className="settings-main">
        <NoticeBanner notice={notice} />

        <SettingsSection id="account" title="Account" help="Your name and how you sign in.">
          <UsernameSettingsForm key={`username-${settingsKey}`} profile={profile} setNotice={setNotice} />
          <EmailSettingsForm key={`email-${settingsKey}`} profile={profile} setNotice={setNotice} />
          <SignInHelp profile={profile} setNotice={setNotice} />
        </SettingsSection>

        <SettingsSection id="appearance" title="Appearance" help="Light or dark, and your color.">
          <ThemeSettingsForm key={`theme-${settingsKey}`} profile={profile} setNotice={setNotice} />
        </SettingsSection>

        <SettingsSection
          id="accounts"
          title="Accounts on this device"
          help={`Stay signed in to up to ${MAX_ACCOUNTS} accounts here and switch any time.`}
        >
          {AI_CHAT_UI_ENABLED ? (
            <p className="field-hint">
              The AI chat works for one account per device: the first one signed in. If that account signs out, the next
              one gets it.
            </p>
          ) : null}
          <AccountList variant="panel" />
        </SettingsSection>

        <SettingsSection id="delete-account" title="Delete account" help="This can't be undone." danger>
          <DeleteAccountForm setNotice={setNotice} />
        </SettingsSection>
      </div>
    </div>
  )
}

function UsernameSettingsForm({
  profile,
  setNotice,
}: {
  profile: Profile | null
  setNotice: (notice: Notice | null) => void
}) {
  const { refreshProfile, user, activeAccountId } = useAuth()
  const [username, setUsername] = useState(profile?.username ?? user?.username ?? "")
  const [saving, setSaving] = useState(false)
  // Saved into the account that showed this page, even if the tab switches meanwhile.
  const [accountId] = useState(activeAccountId)

  const saveUsername = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (saving) return
    setNotice(null)
    setSaving(true)
    try {
      await api.put("/me/username", { new_username: username.trim() }, { lumaAccountId: accountId ?? undefined })
      await refreshProfile(accountId ?? undefined)
      setNotice({ type: "success", text: "Username saved." })
    } catch (error: unknown) {
      setNotice({ type: "error", text: getErrorMessage(error, "Could not save username.") })
    } finally {
      setSaving(false)
    }
  }

  return (
    <form className="settings-row" onSubmit={saveUsername}>
      <div className="field">
        <label htmlFor="settings-username">Username</label>
        <div className="input-row">
          <input
            id="settings-username"
            value={username}
            onChange={(event) => setUsername(event.target.value)}
            minLength={3}
            required
            aria-describedby="settings-username-hint"
          />
          <button className="secondary-button" type="submit" disabled={saving}>
            {saving ? "Saving..." : "Save username"}
          </button>
        </div>
        <p id="settings-username-hint" className="field-hint">
          Shown on anything you share.
        </p>
      </div>
    </form>
  )
}

/** A message right next to the form it is about, read out when it changes. */
function FormNotice({ id, notice }: { id: string; notice: Notice | null }) {
  return (
    <div id={id} className="message-slot" aria-live="polite">
      <NoticeBanner notice={notice} />
    </div>
  )
}

/** Friendly words for each error code the email change can get back. */
const EMAIL_CHANGE_ERRORS: Record<string, string> = {
  ...CODE_ERRORS,
  wrong_password: "That password is wrong. Try again.",
  password_needed: "Your account has no password yet. Tap Reset password below to make one, then try again.",
  same_email: "That's already your email.",
  admin_email_locked: "The admin email can't be changed here.",
  email_taken: "That email already has a Luma account. Try a different email.",
  email_change_failed: "That didn't work, and that code is used up. Type your password and tap Send code to get a new one.",
  no_pending_change: "That code is used up. Type your password and tap Send code to start again.",
  resend_cooldown: "You just got a code. Wait for the timer, then ask again.",
}

/** These answers mean the code is used up or gone, so the student starts again at step 1. */
const START_AGAIN = new Set(["email_taken", "email_change_failed", "no_pending_change"])

type EmailChangeStart = { resend_after_seconds: number; code_expires_in_seconds: number }

/** "Too many tries" with the real wait in it, so the student knows what to do next. */
function tooManyTries(retryAfter: number | null | undefined): string {
  return retryAfter ? `Too many tries. Try again ${waitWords(retryAfter)}.` : CODE_ERRORS.rate_limited
}

/**
 * Changing your email takes two steps: the new email and your password, then
 * the 6-number code sent to the new email. Nothing changes until the code is right.
 * One message slot stays on screen through both steps, so screen readers hear every message.
 */
function EmailSettingsForm({
  profile,
  setNotice,
}: {
  profile: Profile | null
  setNotice: (notice: Notice | null) => void
}) {
  const { setProfile, user } = useAuth()
  const currentEmail = profile?.email ?? user?.email ?? ""
  const [email, setEmail] = useState(currentEmail)
  // Only needed to start a change; cleared once the code is sent.
  const [password, setPassword] = useState("")
  // Step 2: where the code went, and how long it works.
  const [pendingEmail, setPendingEmail] = useState<string | null>(null)
  const [codeMinutes, setCodeMinutes] = useState<number | null>(null)
  const [code, setCode] = useState("")
  const [badField, setBadField] = useState<"email" | "password" | "code" | null>(null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<Notice | null>(null)
  // Until a new code may be sent (the server's resend_after_seconds or its cooldown).
  const [resendLeft, startResendWait] = useCountdown()
  // After "too many tries": how long, and which button waits.
  const [blockedLeft, startBlockedWait] = useCountdown()
  const [blockedAction, setBlockedAction] = useState<"send" | "confirm">("send")
  const emailRef = useRef<HTMLInputElement>(null)
  const passwordRef = useRef<HTMLInputElement>(null)
  const codeRef = useRef<HTMLInputElement>(null)
  const focusNext = useRef<"email" | "password" | "code" | null>(null)
  const changing = email.trim().toLowerCase() !== currentEmail.trim().toLowerCase()
  const sendBlocked = blockedAction === "send" && blockedLeft > 0
  const confirmBlocked = blockedAction === "confirm" && blockedLeft > 0
  const sendWait = sendBlocked
    ? `You can try again ${waitWords(blockedLeft)}.`
    : resendLeft > 0
      ? `You can ask for a new code in ${resendLeft} seconds.`
      : null

  // Move focus after the step on screen changes.
  useEffect(() => {
    if (focusNext.current === "code") {
      codeRef.current?.focus()
    } else if (focusNext.current === "password") {
      passwordRef.current?.focus()
    } else if (focusNext.current === "email") {
      emailRef.current?.focus()
    }
    focusNext.current = null
  }, [pendingEmail])

  // Messages show next to this form; the page banner could be off screen on a phone.
  const say = (next: Notice | null) => {
    setNotice(null)
    setMessage(next)
  }

  /** Shows the friendly words for an error and starts any wait it asks for. */
  const showError = (error: unknown, fallback: string, action: "send" | "confirm") => {
    const errorCode = getErrorCode(error)
    const retry = getRetryAfter(error)
    if (errorCode === "resend_cooldown" && retry) {
      startResendWait(retry)
    }
    if (errorCode === "rate_limited") {
      if (retry) {
        setBlockedAction(action)
        startBlockedWait(retry)
      }
      say({ type: "error", text: tooManyTries(retry) })
      return errorCode
    }
    say({ type: "error", text: (errorCode && EMAIL_CHANGE_ERRORS[errorCode]) || getErrorMessage(error, fallback) })
    return errorCode
  }

  const codeSent = (sent: EmailChangeStart) => {
    startResendWait(sent.resend_after_seconds)
    const lasts = sent.code_expires_in_seconds
    setCodeMinutes(Number.isFinite(lasts) && lasts > 0 ? Math.max(1, Math.round(lasts / 60)) : null)
    setCode("")
  }

  /** Back to step 1. The new email stays typed, so only the password is needed again. */
  const backToStart = (focus: "email" | "password") => {
    setPendingEmail(null)
    setCode("")
    focusNext.current = focus
  }

  // The answer is the same whether or not the new email already has an account.
  const startChange = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    say(null)
    setBadField(null)
    if (!changing) {
      setEmail(currentEmail)
      say({ type: "success", text: "That's already your email." })
      return
    }
    if (!emailRef.current?.validity.valid) {
      setBadField("email")
      say({ type: "error", text: "Type a full email, like name@example.com." })
      emailRef.current?.focus()
      return
    }
    if (!password) {
      setBadField("password")
      say({ type: "error", text: "Type your password first." })
      passwordRef.current?.focus()
      return
    }

    const newEmail = email.trim()
    setBusy(true)
    try {
      const response = await api.put<EmailChangeStart>("/me/email", {
        new_email: newEmail,
        current_password: password,
      })
      codeSent(response.data)
      setPassword("")
      focusNext.current = "code"
      setPendingEmail(newEmail)
    } catch (error: unknown) {
      const errorCode = showError(error, "We couldn't send a code. Try again.", "send")
      if (errorCode === "same_email") {
        setBadField("email")
        emailRef.current?.focus()
      } else {
        if (errorCode === "wrong_password") {
          setBadField("password")
        }
        passwordRef.current?.focus()
      }
    } finally {
      setBusy(false)
    }
  }

  // No password again: the server only sends it to the email this change started with.
  const sendNewCode = async () => {
    if (!pendingEmail) {
      return
    }
    say(null)
    setBadField(null)
    setBusy(true)
    try {
      const response = await api.post<EmailChangeStart>("/me/email/resend", { new_email: pendingEmail })
      codeSent(response.data)
      say({ type: "success", text: "We sent a new code. It can take a few minutes. Check spam too." })
      codeRef.current?.focus()
    } catch (error: unknown) {
      const errorCode = showError(error, "We couldn't send a code. Try again.", "send")
      if (errorCode && START_AGAIN.has(errorCode)) {
        backToStart("password")
      } else {
        codeRef.current?.focus()
      }
    } finally {
      setBusy(false)
    }
  }

  const cancel = () => {
    say(null)
    setBadField(null)
    setEmail(currentEmail)
    setPassword("")
    backToStart("email")
  }

  const confirmChange = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!pendingEmail) {
      return
    }
    say(null)
    setBadField(null)
    const cleaned = cleanCode(code)
    if (cleaned.length !== CODE_LENGTH) {
      setBadField("code")
      say({ type: "error", text: "Type all 6 numbers from the email." })
      codeRef.current?.focus()
      return
    }
    setBusy(true)
    try {
      const response = await api.post<Profile>("/me/email/confirm", { new_email: pendingEmail, code: cleaned })
      setProfile(response.data)
      setEmail(response.data.email)
      backToStart("email")
      say({ type: "success", text: "Your email is changed." })
    } catch (error: unknown) {
      const errorCode = showError(error, "That code didn't work. Try again.", "confirm")
      if (errorCode === "email_taken") {
        setBadField("email")
        backToStart("email")
      } else if (errorCode && START_AGAIN.has(errorCode)) {
        backToStart("password")
      } else {
        if (errorCode !== "rate_limited") {
          setBadField("code")
        }
        if (errorCode === "code_expired" || errorCode === "code_locked") {
          setCode("")
        }
        codeRef.current?.focus()
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <form
      className="settings-row"
      noValidate
      onSubmit={pendingEmail ? confirmChange : startChange}
      aria-labelledby={pendingEmail ? "settings-email-code-title" : undefined}
    >
      {pendingEmail ? (
        <div key="code-step" className="field">
          <h3 id="settings-email-code-title">Check your new email</h3>
          <p id="settings-email-code-sent" className="field-hint">
            We sent a 6-number code to <strong className="auth-email">{pendingEmail}</strong>. Type it here.
          </p>
          <label htmlFor="settings-email-code">6-number code</label>
          <input
            ref={codeRef}
            id="settings-email-code"
            name="code"
            className="code-input"
            type="text"
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="[0-9 \-]*"
            maxLength={12}
            value={code}
            onChange={(event) => {
              setCode(event.target.value.replace(/[^\d\s-]/g, ""))
              if (badField === "code") {
                setBadField(null)
              }
            }}
            aria-describedby="settings-email-code-sent settings-email-code-hint settings-email-message"
            aria-invalid={badField === "code" || undefined}
            required
          />
          <p id="settings-email-code-hint" className="field-hint">
            {codeMinutes ? `It works for ${codeMinutes} ${codeMinutes === 1 ? "minute" : "minutes"}. ` : ""}
            Can't find it? Check spam. Your email stays the same until you tap Change my email.
          </p>
          <p id="settings-email-resend-wait" className="field-hint">
            {sendWait ?? "A new code replaces the old one."}
          </p>
          {confirmBlocked ? (
            <p id="settings-email-confirm-wait" className="field-hint">
              You can try a code again {waitWords(blockedLeft)}.
            </p>
          ) : null}
        </div>
      ) : (
        <Fragment key="start-step">
          <div className="field">
            <label htmlFor="settings-email">Email</label>
            <input
              ref={emailRef}
              id="settings-email"
              type="email"
              value={email}
              onChange={(event) => {
                setEmail(event.target.value)
                if (badField === "email") {
                  setBadField(null)
                }
              }}
              required
              aria-describedby="settings-email-hint settings-email-message"
              aria-invalid={badField === "email" || undefined}
            />
            <p id="settings-email-hint" className="field-hint">
              Codes and password help go here.
            </p>
          </div>
          {changing ? (
            <PasswordField
              label="Your password (to change email)"
              name="current_password"
              autoComplete="current-password"
              value={password}
              onChange={(event) => {
                setPassword(event.target.value)
                if (badField === "password") {
                  setBadField(null)
                }
              }}
              hint="To keep your account safe, type your password. Then we send a code to your new email."
              extraDescribedBy="settings-email-message"
              invalid={badField === "password"}
              inputRef={passwordRef}
            />
          ) : null}
          {changing && sendWait ? (
            <p id="settings-email-send-wait" className="field-hint">
              {sendWait}
            </p>
          ) : null}
        </Fragment>
      )}
      <FormNotice id="settings-email-message" notice={message} />
      {pendingEmail ? (
        <div key="code-buttons" className="button-row">
          <button
            className="primary-button"
            type="submit"
            disabled={busy || confirmBlocked}
            aria-describedby={confirmBlocked ? "settings-email-confirm-wait" : undefined}
          >
            Change my email
          </button>
          <button
            className="secondary-button"
            type="button"
            onClick={() => void sendNewCode()}
            disabled={busy || sendWait !== null}
            aria-describedby="settings-email-resend-wait"
          >
            Send a new code
          </button>
          <button className="ghost-button" type="button" onClick={cancel} disabled={busy}>
            Cancel
          </button>
        </div>
      ) : changing ? (
        <div key="start-buttons" className="button-row">
          <button
            className="secondary-button"
            type="submit"
            disabled={busy || sendWait !== null}
            aria-describedby={sendWait ? "settings-email-send-wait" : undefined}
          >
            Send code
          </button>
        </div>
      ) : null}
    </form>
  )
}

/** Password help, and a new code while the email is not checked yet (hidden once it is). */
function SignInHelp({
  profile,
  setNotice,
}: {
  profile: Profile | null
  setNotice: (notice: Notice | null) => void
}) {
  const { user } = useAuth()
  const email = profile?.email ?? user?.email ?? ""
  const needsCheck = user?.email_verified === false

  const resetPassword = async () => {
    setNotice(null)

    try {
      await api.post("/auth/request-reset", { email })
      setNotice({ type: "success", text: "Password help sent." })
    } catch (error: unknown) {
      setNotice({ type: "error", text: getErrorMessage(error, "Could not send password help.") })
    }
  }

  const sendVerification = async () => {
    setNotice(null)

    try {
      await api.post("/auth/send-verification")
      setNotice({ type: "success", text: "Verification email sent." })
    } catch (error: unknown) {
      setNotice({ type: "error", text: getErrorMessage(error, "Could not send verification email.") })
    }
  }

  return (
    <div className="settings-row" role="group" aria-labelledby="sign-in-help-title">
      <div>
        <h3 id="sign-in-help-title">Password and sign-in</h3>
        <p className="field-hint">We email you a link to make a new password.</p>
      </div>
      <div className="button-row">
        <button className="secondary-button" type="button" onClick={() => void resetPassword()} disabled={!email}>
          Reset password
        </button>
        {needsCheck ? (
          <button className="ghost-button" type="button" onClick={() => void sendVerification()}>
            Send verification email
          </button>
        ) : null}
      </div>
    </div>
  )
}

const THEME_MODE_CHOICES: Array<{ value: ThemeMode; name: string; help: string }> = [
  { value: "light", name: "Light", help: "Cream paper all day." },
  { value: "dark", name: "Dark", help: "Easy on your eyes at night." },
  // \u00a0 keeps "7 pm" and "7 am" on one line.
  { value: "auto", name: "Automatic", help: "Light in the day, dark from 7\u00a0pm to 7\u00a0am." },
]

/** A tiny page drawn in that theme's own colors (data-theme scopes the color tokens). */
function ThemeModePreview({ mode, accent }: { mode: ThemeMode; accent: string }) {
  const style = { "--theme-choice": accent } as CSSProperties
  if (mode === "auto") {
    return (
      <span className="mode-preview split" aria-hidden="true" style={style}>
        <span className="mode-preview-half" data-theme="light">
          <span className="mode-preview-dot" />
          <span className="mode-preview-line" />
        </span>
        <span className="mode-preview-half" data-theme="dark">
          <span className="mode-preview-dot" />
          <span className="mode-preview-line" />
        </span>
      </span>
    )
  }
  return (
    <span className="mode-preview" data-theme={mode} aria-hidden="true" style={style}>
      <span className="mode-preview-dot" />
      <span className="mode-preview-line" />
      <span className="mode-preview-line" />
    </span>
  )
}

function ThemeSettingsForm({
  profile,
  setNotice,
}: {
  profile: Profile | null
  setNotice: (notice: Notice | null) => void
}) {
  const { setProfile, activeAccountId } = useAuth()
  const [themeColor, setThemeColor] = useState(profile?.theme_color ?? DEFAULT_ACCENT)
  const [themeMode, setThemeMode] = useState<ThemeMode>(normalizeMode(profile?.theme_mode))
  const [saving, setSaving] = useState(false)
  // Saved into the account that showed this page, even if the tab switches meanwhile.
  const [accountId] = useState(activeAccountId)
  const previewStyle = { "--theme-choice": themeColor } as CSSProperties

  const saveTheme = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (saving) return
    setNotice(null)
    setSaving(true)
    try {
      const response = await api.put<Profile>(
        "/me/profile",
        {
          theme_color: themeColor,
          theme_mode: themeMode,
        },
        { lumaAccountId: accountId ?? undefined },
      )
      setProfile(response.data)
      setNotice({ type: "success", text: "Theme saved." })
    } catch (error: unknown) {
      setNotice({ type: "error", text: getErrorMessage(error, "Could not save theme.") })
    } finally {
      setSaving(false)
    }
  }

  return (
    <form className="theme-form" onSubmit={saveTheme}>
      <h3 id="theme-settings-title">Theme</h3>
      <fieldset className="mode-toggle" role="radiogroup" aria-labelledby="theme-settings-title">
        {THEME_MODE_CHOICES.map((choice) => (
          <label key={choice.value} className={themeMode === choice.value ? "mode-option active" : "mode-option"}>
            <input
              type="radio"
              name="theme-mode"
              value={choice.value}
              checked={themeMode === choice.value}
              onChange={() => setThemeMode(choice.value)}
              aria-labelledby={`theme-mode-${choice.value}`}
              aria-describedby={`theme-mode-${choice.value}-help`}
            />
            <ThemeModePreview mode={choice.value} accent={themeColor} />
            <span className="mode-name" id={`theme-mode-${choice.value}`}>
              {choice.name}
            </span>
            <span className="mode-help" id={`theme-mode-${choice.value}-help`}>
              {choice.help}
            </span>
          </label>
        ))}
      </fieldset>
      {themeMode === "auto" ? (
        <p className="mode-now" role="status">
          Right now: {resolveMode("auto")}.
        </p>
      ) : null}
      <h3 id="theme-color-title">Color</h3>
      <div className="color-preview-bar" style={previewStyle}>
        <span />
        <strong>{themeColors.find((color) => color.value === themeColor)?.name ?? "Color"}</strong>
      </div>
      <div className="color-grid" aria-label="Theme colors">
        {themeColors.map((color) => (
          <button
            key={color.value}
            type="button"
            className={themeColor === color.value ? "color-button active" : "color-button"}
            style={{ "--swatch-color": color.value } as CSSProperties}
            aria-label={color.name}
            aria-pressed={themeColor === color.value}
            onClick={() => setThemeColor(color.value)}
          />
        ))}
      </div>
      <div>
        <button className="primary-button" type="submit" disabled={saving}>
          {saving ? "Saving..." : "Save theme"}
        </button>
      </div>
    </form>
  )
}

const DELETE_ERRORS: Record<string, string> = {
  wrong_password: "That password is wrong. Your account is not deleted.",
  password_needed: "Your account has no password yet. Tap Reset password above to make one, then try again.",
}

function DeleteAccountForm({ setNotice }: { setNotice: (notice: Notice | null) => void }) {
  const navigate = useNavigate()
  const { activeAccountId } = useAuth()
  const [confirmText, setConfirmText] = useState("")
  const [password, setPassword] = useState("")
  const [badField, setBadField] = useState<"confirm" | "password" | null>(null)
  const [deleting, setDeleting] = useState(false)
  // After too many password tries (the same limit as changing your email).
  const [blockedLeft, startBlockedWait] = useCountdown()
  const confirmRef = useRef<HTMLInputElement>(null)
  const passwordRef = useRef<HTMLInputElement>(null)
  const [message, setMessage] = useState<Notice | null>(null)
  const say = (next: Notice | null) => {
    setNotice(null)
    setMessage(next)
  }

  const deleteAccount = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    say(null)

    setBadField(null)
    if (confirmText.trim().toLowerCase() !== "delete") {
      setBadField("confirm")
      say({ type: "error", text: "Type delete to confirm." })
      confirmRef.current?.focus()
      return
    }
    if (!password) {
      setBadField("password")
      say({ type: "error", text: "Type your password to delete your account." })
      passwordRef.current?.focus()
      return
    }

    // Pin the account now, so a switch in another tab can't change which one is deleted.
    const deletedId = activeAccountId
    if (!deletedId) {
      return
    }
    setDeleting(true)
    try {
      const response = await api.delete<{ message?: string; retained?: string[] }>("/me/account", {
        lumaAccountId: deletedId,
        data: { current_password: password },
      })
      // Show the result on a public page first, then forget the (now useless) session.
      // The result page logs out once it's showing (logging out here would
      // bounce this protected page to /login first).
      navigate("/account-deleted", { replace: true, state: { kept: response.data.retained ?? [], deletedId } })
    } catch (error: unknown) {
      const errorCode = getErrorCode(error)
      if (errorCode === "rate_limited") {
        const retry = getRetryAfter(error)
        if (retry) {
          startBlockedWait(retry)
        }
        say({ type: "error", text: `${tooManyTries(retry)} This also pauses changing your email.` })
      } else {
        say({
          type: "error",
          text: (errorCode && DELETE_ERRORS[errorCode]) || getErrorMessage(error, "Could not delete account."),
        })
      }
      if (errorCode === "wrong_password") {
        setBadField("password")
      }
      if (errorCode === "wrong_password" || errorCode === "rate_limited") {
        passwordRef.current?.focus()
      }
    } finally {
      setDeleting(false)
    }
  }

  return (
    <form className="danger-zone" noValidate onSubmit={deleteAccount} aria-labelledby="delete-account-title">
      <p>
        This deletes your account and everything in it: notes, flashcards, summaries, study plans, your picture and
        theme images. It can't be undone.
      </p>
      <details>
        <summary>What stays after you delete?</summary>
        <ul>
          <li>If you paid for Premium, payment records stay with Stripe because tax law requires them.</li>
          <li>Copies already sent to our AI helpers follow their own deletion rules.</li>
          <li>Database backups age out on our hosting provider's schedule.</li>
          <li>
            A scrambled code made from your email (not the email itself) stays for a few days, so the free AI limit
            can't be reset by making a new account.
          </li>
          <li>Reports you sent about shared content stay for safety review, without your name.</li>
          <li>Your answers to monthly feedback polls stay in the totals, without your name. Your poll comments are deleted.</li>
        </ul>
      </details>
      <div className="field">
        <label htmlFor="delete-account-confirm">Type delete to confirm</label>
        <input
          ref={confirmRef}
          id="delete-account-confirm"
          value={confirmText}
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          onChange={(event) => {
            setConfirmText(event.target.value)
            if (badField === "confirm") {
              setBadField(null)
            }
          }}
          aria-describedby="delete-account-message"
          aria-invalid={badField === "confirm" || undefined}
        />
      </div>
      <PasswordField
        label="Your password (to delete your account)"
        name="current_password"
        autoComplete="current-password"
        value={password}
        onChange={(event) => {
          setPassword(event.target.value)
          if (badField === "password") {
            setBadField(null)
          }
        }}
        extraDescribedBy="delete-account-message"
        invalid={badField === "password"}
        inputRef={passwordRef}
      />
      <FormNotice id="delete-account-message" notice={message} />
      {blockedLeft > 0 ? (
        <p id="delete-account-wait" className="field-hint">
          You can try again {waitWords(blockedLeft)}.
        </p>
      ) : null}
      <div>
        <button
          className="danger-button"
          type="submit"
          disabled={deleting || blockedLeft > 0}
          aria-describedby={blockedLeft > 0 ? "delete-account-wait" : undefined}
        >
          {deleting ? "Deleting..." : "Delete my account"}
        </button>
      </div>
    </form>
  )
}
