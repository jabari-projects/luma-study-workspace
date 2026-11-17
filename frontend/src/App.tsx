import { useCallback, useEffect, useLayoutEffect, useState } from "react"
import type { CSSProperties, FormEvent, ReactNode } from "react"
import { Toaster, toast } from "sonner"
import {
  Link,
  Navigate,
  Route,
  Routes,
  useLocation,
  useNavigate,
} from "react-router-dom"

import { useAuth, useProfile } from "./auth"
import { API_BASE_URL, api, checkBackendHealth, getErrorMessage } from "./api"
import type { Profile } from "./api"
import { NoticeBanner, PageHeader } from "./ui/common"
import type { Notice, StudyType } from "./ui/common"
import { MobileTabBar, MobileTopBar, SideNav } from "./ui/Nav"
import { AccountsPanel, SignedOutElsewhere } from "./ui/AccountMenu"
import { isBusyPath } from "./ui/accountActions"
import { DEFAULT_ACCENT, themeColors } from "./ui/themeColors"
import { applyTheme, clearTheme, normalizeMode, readThemeCache, resolveMode, useResolvedTheme } from "./ui/theme"
import type { ThemeMode } from "./ui/theme"
import { ACCOUNT_LIMIT_MESSAGE } from "./accounts"
import { DeckEditorPage, DeckPage, DecksPage, StudyPage } from "./study/FlashcardPages"
import { QuizPage } from "./study/QuizPage"
import { StudyPlansPage } from "./study/StudyPlansPage"
import { STUDY_PLANS, STUDY_REDIRECTS } from "./study/hub"
import { NotePage } from "./notes/NotePage"
import { NotesHub } from "./notes/NotesHub"
import { NoteEditorPage } from "./notes/NoteEditorPage"
import { NOTE_REDIRECTS, SUMMARIES_TAB, redirectTarget } from "./notes/paths"
import { ImagePage } from "./capture/ImagePage"
import { TodayPage } from "./study/TodayPage"
import { AudioToNotesPage } from "./capture/AudioPage"
import {
  ForgotPasswordPage,
  LoginPage,
  AccountDeletedPage,
  ResetPasswordPage,
  SignupPage,
  VerifyEmailBanner,
  VerifyEmailPage,
} from "./account/AccountPages"
import { AdminReportsPage, ReportButton } from "./account/Reporting"
import { ImportPage } from "./capture/ImportPage"

type PublicStudyItem = {
  id: string
  study_type: StudyType
  title: string
  preview: string
  tags: string[]
  user_id: string
  username: string
  display_name?: string | null
  published_at?: string | null
  published_by?: string | null
  created_at: string
}

type PublicUser = {
  id: string
  username: string
  display_name?: string | null
  avatar_url?: string | null
  public_count: number
  items: PublicStudyItem[]
}

type HealthState = {
  status: "checking" | "online" | "offline"
  detail: string | null
}

const initialHealthState: HealthState = {
  status: "checking",
  detail: "Checking Luma...",
}

function useBackendHealth() {
  const [health, setHealth] = useState<HealthState>(initialHealthState)

  const refreshBackendHealth = useCallback(async () => {
    setHealth(initialHealthState)

    try {
      await checkBackendHealth()
      setHealth({ status: "online", detail: null })
      return true
    } catch (error: unknown) {
      setHealth({ status: "offline", detail: getErrorMessage(error) })
      return false
    }
  }, [])

  useEffect(() => {
    let active = true

    async function checkHealth() {
      try {
        await checkBackendHealth()
        if (active) {
          setHealth({ status: "online", detail: null })
        }
      } catch (error: unknown) {
        if (active) {
          setHealth({ status: "offline", detail: getErrorMessage(error) })
        }
      }
    }

    void checkHealth()

    return () => {
      active = false
    }
  }, [])

  return { health, refreshBackendHealth }
}

function labelForStudyType(studyType: StudyType): string {
  if (studyType === "note") {
    return "Note"
  }

  if (studyType === "flashcards") {
    return "Flashcards"
  }

  return "Summary"
}

function formatPublishedDate(value?: string | null): string {
  if (!value) {
    return "Not published yet"
  }

  const date = new Date(value)
  if (Number.isNaN(date.getTime())) {
    return value
  }

  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  })
}

function groupPublicItems(items: PublicStudyItem[]): Record<StudyType, PublicStudyItem[]> {
  return items.reduce<Record<StudyType, PublicStudyItem[]>>(
    (groups, item) => {
      groups[item.study_type].push(item)
      return groups
    },
    { note: [], flashcards: [], summary: [] },
  )
}


function LoadingScreen({ message }: { message: string }) {
  return (
    <main className="center-screen">
      <section className="status-panel">
        <span className="spinner" />
        <p>{message}</p>
      </section>
    </main>
  )
}

function BackendConnectionBanner({ health }: { health: HealthState }) {
  if (health.status === "online") {
    return null
  }

  return (
    <div className="backend-banner" role="status" aria-live="polite">
      <span className={`health-dot ${health.status}`} />
      <strong>{health.status === "checking" ? "Checking Luma" : "Luma is having trouble connecting"}</strong>
      <p>{health.detail ?? "We are checking the connection."}</p>
      <small>{API_BASE_URL}</small>
    </div>
  )
}

function ProtectedRoute({ children }: { children: ReactNode }) {
  const { loading, isAuthenticated, signedOutElsewhere } = useAuth()
  const location = useLocation()

  if (loading) {
    return <LoadingScreen message="Checking your session..." />
  }

  if (signedOutElsewhere) {
    return <SignedOutElsewhere />
  }

  if (!isAuthenticated) {
    return <Navigate to={`/login?redirect=${encodeURIComponent(location.pathname)}`} replace />
  }

  return <>{children}</>
}

function PublicOnlyRoute({ children }: { children: ReactNode }) {
  const { loading, isAuthenticated, canAddAccount } = useAuth()
  const location = useLocation()
  const adding = new URLSearchParams(location.search).get("add") === "1"
  // Room is checked when the page opens. A sign-in that just filled the last spot
  // must not bounce back with a "device is full" error.
  const [roomWhenOpened] = useState(canAddAccount)

  if (loading) {
    return <LoadingScreen message="Preparing Luma..." />
  }

  if (isAuthenticated) {
    // "Add another account" opens the login and signup pages while signed in.
    if (adding && roomWhenOpened) {
      return <>{children}</>
    }
    if (adding) {
      return <AccountLimitRedirect />
    }
    return <Navigate to="/dashboard" replace />
  }

  return <>{children}</>
}

function AccountLimitRedirect() {
  useEffect(() => {
    toast.error(ACCOUNT_LIMIT_MESSAGE, { id: "account-limit" })
  }, [])
  return <Navigate to="/settings#accounts" replace />
}

/** Sends an old address to its new place, keeping its ?query and #hash. */
function KeepQueryRedirect({ to }: { to: string }) {
  const { search, hash } = useLocation()
  return <Navigate to={redirectTarget(to, search, hash)} replace />
}

function AppLayout() {
  const { user, activeAccountId, profileLoading } = useAuth()
  const profile = useProfile()
  const initials = (user?.username ?? user?.email ?? "L").slice(0, 1).toUpperCase()
  const { pathname } = useLocation()
  const { resolved, accent } = useResolvedTheme({
    accountId: activeAccountId,
    // undefined until the profile is loaded: the theme saved on this device is used until then.
    profileMode: profile ? (profile.theme_mode ?? null) : undefined,
    profileAccent: profile?.theme_color,
    profileVersion: profile,
    busy: isBusyPath(pathname),
    pathname,
  })

  // Apply the theme to the whole page so the background, sheets and modals match.
  // Other accent shades are mixed from --accent in styles.css for light and dark mode.
  // A layout effect, so a new account's theme is in place before the first paint.
  useLayoutEffect(() => {
    const root = document.documentElement
    applyTheme(root, resolved, accent)
    return () => clearTheme(root)
  }, [resolved, accent])

  // Signed-in pages are a student's own space: ask search engines not to list them.
  // The landing and sign-in pages stay without this tag.
  useEffect(() => {
    const meta = document.createElement("meta")
    meta.name = "robots"
    meta.content = "noindex"
    document.head.appendChild(meta)
    return () => meta.remove()
  }, [])

  // Just logged in on a device with no saved theme: wait for the profile (and its theme)
  // instead of drawing the dashboard in Light first. A failed load ends the wait too.
  const [themeUnknown] = useState(() => {
    if (!profileLoading || profile || !activeAccountId) return false
    try {
      return !readThemeCache(window.localStorage, activeAccountId)
    } catch {
      return true
    }
  })
  if (themeUnknown && profileLoading && !profile) {
    return <LoadingScreen message="Opening Luma..." />
  }

  return (
    <div className="app-shell">
      <SideNav
        username={user?.username ?? "Luma student"}
        plan={profile?.subscription_status ?? "free"}
        initials={initials}
      />
      <MobileTopBar initials={initials} />
      <main className="content">
        <VerifyEmailBanner />
        <Routes>
          <Route path="/dashboard" element={<TodayPage />} />
          <Route path="/search" element={<SearchPage />} />
          <Route path="/flashcards" element={<DecksPage />} />
          <Route path="/flashcards/new" element={<DeckEditorPage />} />
          <Route path="/flashcards/:itemId" element={<DeckPage />} />
          <Route path="/flashcards/:itemId/edit" element={<DeckEditorPage />} />
          <Route path="/flashcards/:itemId/study" element={<StudyPage />} />
          <Route path="/quizzes" element={<QuizPage />} />
          <Route path={STUDY_PLANS} element={<StudyPlansPage />} />
          <Route path="/notes" element={<NotesHub />} />
          <Route path="/notes/new" element={<NoteEditorPage />} />
          <Route path="/notes/import" element={<ImportPage />} />
          <Route path="/notes/voice" element={<AudioToNotesPage />} />
          <Route path="/notes/image" element={<ImagePage />} />
          <Route
            path="/notes/:itemId"
            element={<NotePage endpoint="/notes" studyType="note" backTo="/notes" kindLabel="Note" />}
          />
          <Route path="/notes/:itemId/edit" element={<NoteEditorPage kind="note" />} />
          <Route
            path="/summaries/:itemId"
            element={<NotePage endpoint="/summaries" studyType="summary" backTo={SUMMARIES_TAB} kindLabel="Summary" />}
          />
          <Route path="/summaries/:itemId/edit" element={<NoteEditorPage kind="summary" />} />
          {/* Old addresses keep working, with their ?query (like /import?from=link). */}
          {[...NOTE_REDIRECTS, ...STUDY_REDIRECTS].map(([from, to]) => (
            <Route key={from} path={from} element={<KeepQueryRedirect to={to} />} />
          ))}
          <Route path="/ai-tutor" element={<Navigate to="/dashboard" replace />} />
          <Route path="/transcripts" element={<Navigate to="/dashboard" replace />} />
          <Route path="/quiz" element={<Navigate to="/quizzes" replace />} />
          <Route path="/subscribe" element={<Navigate to="/dashboard" replace />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="/admin/reports" element={<AdminReportsPage />} />
          <Route path="/profile" element={<Navigate to="/settings" replace />} />
          <Route path="*" element={<NotFoundPage />} />
        </Routes>
      </main>
      <MobileTabBar />
    </div>
  )
}

function RootRoutes() {
  const { activeAccountId, isAuthenticated, loading } = useAuth()

  // public/theme-boot.js may paint a saved theme before the app knows the account can't be
  // used (for example its sign-in ended). Pages outside the signed-in app stay light.
  useLayoutEffect(() => {
    if (!loading && !isAuthenticated) clearTheme(document.documentElement)
  }, [loading, isAuthenticated])

  return (
    <Routes>
      <Route path="/" element={<LandingPage />} />
      <Route
        path="/login"
        element={
          <PublicOnlyRoute>
            <LoginPage />
          </PublicOnlyRoute>
        }
      />
      <Route
        path="/signup"
        element={
          <PublicOnlyRoute>
            <SignupPage />
          </PublicOnlyRoute>
        }
      />
      <Route path="/verify-email" element={<VerifyEmailPage />} />
      <Route path="/account-deleted" element={<AccountDeletedPage />} />
      <Route path="/forgot-password" element={<ForgotPasswordPage />} />
      <Route path="/reset-password" element={<ResetPasswordPage />} />
      {/* Keyed by account: switching starts the app fresh, so no page shows one account's data under another. */}
      <Route path="/*" element={<ProtectedRoute><AppLayout key={activeAccountId ?? "none"} /></ProtectedRoute>} />
    </Routes>
  )
}

function LandingPage() {
  const { isAuthenticated } = useAuth()
  const { health } = useBackendHealth()

  if (isAuthenticated) {
    return <Navigate to="/dashboard" replace />
  }

  return (
    <main className="landing">
      <section className="hero">
        <div className="hero-copy">
          <img className="hero-mark" src="/luma-star.png" alt="" />
          <p className="eyebrow">Study workspace</p>
          <h1>Luma</h1>
          <p>Keep your notes, cards, study time, and lessons in one easy place.</p>
          <div className="hero-actions">
            <Link className="primary-button" to="/login">
              Login
            </Link>
            <Link className="secondary-button" to="/signup">
              Create account
            </Link>
          </div>
        </div>
        <BackendConnectionBanner health={health} />
      </section>
    </main>
  )
}

function SearchPage() {
  const [activeTab, setActiveTab] = useState<"topics" | "users">("topics")
  const [query, setQuery] = useState("")
  const [topics, setTopics] = useState<PublicStudyItem[]>([])
  const [users, setUsers] = useState<PublicUser[]>([])
  const [notice, setNotice] = useState<Notice | null>(null)
  const [loading, setLoading] = useState(false)
  const groupedTopics = groupPublicItems(topics)
  const studyGroups: Array<{ type: StudyType; title: string }> = [
    { type: "note", title: "Notes" },
    { type: "flashcards", title: "Flashcards" },
    { type: "summary", title: "Summaries" },
  ]

  const searchPublicTopics = useCallback(async (searchQuery: string) => {
    setLoading(true)
    setNotice(null)

    try {
      const response = await api.get<PublicStudyItem[]>("/public/topics", {
        params: { query: searchQuery },
      })
      setTopics(response.data)
    } catch (error: unknown) {
      setNotice({ type: "error", text: getErrorMessage(error, "Could not search study materials.") })
    } finally {
      setLoading(false)
    }
  }, [])

  const searchPublicUsers = useCallback(async (searchQuery: string) => {
    setLoading(true)
    setNotice(null)

    try {
      const response = await api.get<PublicUser[]>("/public/users", {
        params: { query: searchQuery },
      })
      setUsers(response.data)
    } catch (error: unknown) {
      setNotice({ type: "error", text: getErrorMessage(error, "Could not search users.") })
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void searchPublicTopics("")
  }, [searchPublicTopics])

  const submitSearch = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()

    if (activeTab === "topics") {
      await searchPublicTopics(query)
      return
    }

    await searchPublicUsers(query)
  }

  const browseTopics = async () => {
    setActiveTab("topics")
    setQuery("")
    await searchPublicTopics("")
  }

  return (
    <>
      <PageHeader
        eyebrow="Search"
        title="Search"
        description="Find study sets from other students."
      />
      {/* A simple switch of what to search, so plain toggle buttons (aria-pressed), not tabs. */}
      <div className="tabs" role="group" aria-label="Search choices">
        <button
          type="button"
          className="tab"
          aria-pressed={activeTab === "topics"}
          onClick={() => setActiveTab("topics")}
        >
          Search Topics
        </button>
        <button
          type="button"
          className="tab"
          aria-pressed={activeTab === "users"}
          onClick={() => setActiveTab("users")}
        >
          Search Users
        </button>
      </div>
      <form className="form-panel" onSubmit={submitSearch}>
        <NoticeBanner notice={notice} />
        <label>
          Search
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={activeTab === "topics" ? "Try math, history, or science" : "Search a username"}
          />
        </label>
        <div className="button-row">
          <button className="primary-button" type="submit">
            Search
          </button>
          <button className="secondary-button" type="button" onClick={() => void browseTopics()}>
            Browse study materials
          </button>
        </div>
      </form>
      {activeTab === "topics" ? (
        <section className="public-results" aria-live="polite">
          {loading ? <p className="muted">Loading...</p> : null}
          {!loading && topics.length === 0 ? (
            <p className="muted">No public study sets found.</p>
          ) : null}
          {studyGroups.map((group) =>
            groupedTopics[group.type].length ? (
              <section className="public-section" key={group.type}>
                <h2>{group.title}</h2>
                <div className="public-grid">
                  {groupedTopics[group.type].map((item) => (
                    <PublicStudyCard item={item} key={`${item.study_type}-${item.id}`} />
                  ))}
                </div>
              </section>
            ) : null,
          )}
        </section>
      ) : (
        <section className="list-panel" aria-live="polite">
          {loading ? <p className="muted">Loading...</p> : null}
          {!loading && users.length === 0 ? (
            <p className="muted">No public study sets found for that user.</p>
          ) : null}
          {users.map((user) => (
            <article className="item-card public-user-section" key={user.id}>
              <div className="user-card">
                <span className="avatar">{(user.display_name || user.username).slice(0, 1).toUpperCase()}</span>
                <div>
                  <strong>{user.display_name || user.username}</strong>
                  <small>@{user.username}</small>
                  <p>{user.public_count} public study set{user.public_count === 1 ? "" : "s"}</p>
                </div>
              </div>
              <div className="public-grid compact">
                {user.items.map((item) => (
                  <PublicStudyCard item={item} key={`${item.study_type}-${item.id}`} />
                ))}
              </div>
            </article>
          ))}
        </section>
      )}
    </>
  )
}

function PublicStudyCard({ item }: { item: PublicStudyItem }) {
  return (
    <article className="public-card">
      <div className="card-topline">
        <span>{labelForStudyType(item.study_type)}</span>
        <small>@{item.published_by || item.username}</small>
      </div>
      <h2>{item.title}</h2>
      <dl className="public-details">
        <div>
          <dt>Study type</dt>
          <dd>{labelForStudyType(item.study_type)}</dd>
        </div>
        <div>
          <dt>Published date</dt>
          <dd>{formatPublishedDate(item.published_at)}</dd>
        </div>
        <div>
          <dt>Published by</dt>
          <dd>@{item.published_by || item.username}</dd>
        </div>
      </dl>
      <p>{item.preview || "No text yet."}</p>
      {item.tags.length ? (
        <div className="tag-row">
          {item.tags.map((tag) => (
            <span key={tag}>{tag}</span>
          ))}
        </div>
      ) : null}
      <ReportButton itemType={item.study_type} itemId={item.id} title={item.title} />
    </article>
  )
}

function SettingsPage() {
  const profile = useProfile()
  const { user } = useAuth()
  const [notice, setNotice] = useState<Notice | null>(null)
  const settingsKey = profile?.id ?? user?.id ?? "empty"

  return (
    <>
      <PageHeader
        eyebrow="Account"
        title="Settings"
        description="Manage your account and settings."
      />
      <NoticeBanner notice={notice} />
      <section className="settings-grid">
        <UsernameSettingsForm key={`username-${settingsKey}`} profile={profile} setNotice={setNotice} />
        <EmailSettingsForm key={`email-${settingsKey}`} profile={profile} setNotice={setNotice} />
        <ThemeSettingsForm key={`theme-${settingsKey}`} profile={profile} setNotice={setNotice} />
        <AccountHelpPanel profile={profile} setNotice={setNotice} />
        <AccountsPanel id="accounts" />
        {profile?.is_admin ? (
          <section className="form-panel">
            <h2>Reports</h2>
            <p>Check public study sets that students reported.</p>
            <Link className="secondary-button" to="/admin/reports">
              Open the review queue
            </Link>
          </section>
        ) : null}
        <DeleteAccountPanel setNotice={setNotice} />
      </section>
    </>
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
    <form className="form-panel" onSubmit={saveUsername}>
      <h2>Username</h2>
      <label>
        Username
        <input value={username} onChange={(event) => setUsername(event.target.value)} minLength={3} required />
      </label>
      <button className="primary-button" type="submit">
        Save username
      </button>
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
    <form className="form-panel" onSubmit={saveEmail}>
      <h2>Change Email</h2>
      <label>
        Email
        <input type="email" value={email} onChange={(event) => setEmail(event.target.value)} required />
      </label>
      <button className="primary-button" type="submit">
        Save email
      </button>
    </form>
  )
}

const THEME_MODE_CHOICES: Array<{ value: ThemeMode; name: string; help: string }> = [
  { value: "light", name: "Light", help: "Cream paper all day." },
  { value: "dark", name: "Dark", help: "Easy on your eyes at night." },
  { value: "auto", name: "Automatic", help: "Light in the day, dark from 7 pm to 7 am." },
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
    <form className="form-panel theme-panel" onSubmit={saveTheme}>
      <h2 id="theme-settings-title">Theme</h2>
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
      <button className="primary-button" type="submit">
        Save theme
      </button>
    </form>
  )
}

function AccountHelpPanel({
  profile,
  setNotice,
}: {
  profile: Profile | null
  setNotice: (notice: Notice | null) => void
}) {
  const { user } = useAuth()
  const email = profile?.email ?? user?.email ?? ""

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
    <section className="form-panel">
      <h2>Account Help</h2>
      <button className="secondary-button" type="button" onClick={() => void resetPassword()} disabled={!email}>
        Reset password
      </button>
      <button className="secondary-button" type="button" onClick={() => void sendVerification()}>
        Send verification email
      </button>
    </section>
  )
}

function DeleteAccountPanel({
  setNotice,
}: {
  setNotice: (notice: Notice | null) => void
}) {
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
    <form className="form-panel danger-zone" onSubmit={deleteAccount}>
      <h2>Delete account</h2>
      <p>
        This deletes your account and everything in it: notes, flashcards, summaries, study plans, your
        picture and theme images. It can't be undone.
      </p>
      <details>
        <summary>What stays after you delete?</summary>
        <ul>
          <li>If you paid for Premium, payment records stay with Stripe because tax law requires them.</li>
          <li>Copies already sent to our AI helpers follow their own deletion rules.</li>
          <li>Database backups age out on our hosting provider's schedule.</li>
          <li>
            A scrambled code made from your email (not the email itself) stays for a few days, so the free AI
            limit can't be reset by making a new account.
          </li>
          <li>Reports you sent about public content stay for safety review, without your name.</li>
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
      <button className="danger-button" type="submit" disabled={deleting}>
        {deleting ? "Deleting..." : "Delete my account"}
      </button>
    </form>
  )
}

function NotFoundPage() {
  return (
    <section className="status-panel">
      <h1>Page not found</h1>
      <p>We could not find that page.</p>
      <Link className="primary-button" to="/dashboard">
        Back to dashboard
      </Link>
    </section>
  )
}

export default function App() {
  return (
    <>
      <RootRoutes />
      {/* Outside the app layout so messages survive switching accounts. */}
      <Toaster position="top-center" richColors closeButton />
    </>
  )
}
