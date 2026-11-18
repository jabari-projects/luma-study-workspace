import { useEffect, useRef, useState } from "react"
import type { CSSProperties, FormEvent, ReactNode } from "react"
import { useLocation, useNavigate } from "react-router-dom"

import { useAuth, useProfile } from "../auth"
import { api, getErrorMessage } from "../api"
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
  const { refreshProfile, user } = useAuth()
  const [username, setUsername] = useState(profile?.username ?? user?.username ?? "")

  const saveUsername = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setNotice(null)

    try {
      await api.put("/me/username", { new_username: username.trim() })
      await refreshProfile()
      setNotice({ type: "success", text: "Username saved." })
    } catch (error: unknown) {
      setNotice({ type: "error", text: getErrorMessage(error, "Could not save username.") })
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
          <button className="secondary-button" type="submit">
            Save username
          </button>
        </div>
        <p id="settings-username-hint" className="field-hint">
          Shown on anything you share.
        </p>
      </div>
    </form>
  )
}

function EmailSettingsForm({
  profile,
  setNotice,
}: {
  profile: Profile | null
  setNotice: (notice: Notice | null) => void
}) {
  const { setProfile, user } = useAuth()
  const [email, setEmail] = useState(profile?.email ?? user?.email ?? "")

  const saveEmail = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setNotice(null)

    try {
      const response = await api.put<Profile>("/me/email", { new_email: email.trim() })
      setProfile(response.data)
      setNotice({ type: "success", text: "Email saved. Check your email when you can." })
    } catch (error: unknown) {
      setNotice({ type: "error", text: getErrorMessage(error, "Could not save email.") })
    }
  }

  return (
    <form className="settings-row" onSubmit={saveEmail}>
      <div className="field">
        <label htmlFor="settings-email">Email</label>
        <div className="input-row">
          <input
            id="settings-email"
            type="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            required
            aria-describedby="settings-email-hint"
          />
          <button className="secondary-button" type="submit">
            Save email
          </button>
        </div>
        <p id="settings-email-hint" className="field-hint">
          Codes and password help go here.
        </p>
      </div>
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
  const { setProfile } = useAuth()
  const [themeColor, setThemeColor] = useState(profile?.theme_color ?? DEFAULT_ACCENT)
  const [themeMode, setThemeMode] = useState<ThemeMode>(normalizeMode(profile?.theme_mode))
  const previewStyle = { "--theme-choice": themeColor } as CSSProperties

  const saveTheme = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setNotice(null)

    try {
      const response = await api.put<Profile>("/me/profile", {
        theme_color: themeColor,
        theme_mode: themeMode,
      })
      setProfile(response.data)
      setNotice({ type: "success", text: "Theme saved." })
    } catch (error: unknown) {
      setNotice({ type: "error", text: getErrorMessage(error, "Could not save theme.") })
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
        <button className="primary-button" type="submit">
          Save theme
        </button>
      </div>
    </form>
  )
}

function DeleteAccountForm({ setNotice }: { setNotice: (notice: Notice | null) => void }) {
  const navigate = useNavigate()
  const { activeAccountId } = useAuth()
  const [confirmText, setConfirmText] = useState("")
  const [deleting, setDeleting] = useState(false)

  const deleteAccount = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setNotice(null)

    if (confirmText.trim().toLowerCase() !== "delete") {
      setNotice({ type: "error", text: "Type delete to confirm." })
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
      })
      // Show the result on a public page first, then forget the (now useless) session.
      // The result page logs out once it's showing (logging out here would
      // bounce this protected page to /login first).
      navigate("/account-deleted", { replace: true, state: { kept: response.data.retained ?? [], deletedId } })
    } catch (error: unknown) {
      setNotice({ type: "error", text: getErrorMessage(error, "Could not delete account.") })
    } finally {
      setDeleting(false)
    }
  }

  return (
    <form className="danger-zone" onSubmit={deleteAccount} aria-labelledby="delete-account-title">
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
        </ul>
      </details>
      <label>
        Type delete to confirm
        <input
          value={confirmText}
          autoComplete="off"
          autoCapitalize="none"
          onChange={(event) => setConfirmText(event.target.value)}
        />
      </label>
      <div>
        <button className="danger-button" type="submit" disabled={deleting}>
          {deleting ? "Deleting..." : "Delete my account"}
        </button>
      </div>
    </form>
  )
}
