import { useCallback, useEffect, useState } from "react"
import type { CSSProperties, ChangeEvent, FormEvent, ReactNode } from "react"
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
import { useAccountActions } from "./ui/accountActions"
import { ACCOUNT_LIMIT_MESSAGE } from "./accounts"
import { DeckEditorPage, DeckPage, DecksPage, StudyPage } from "./study/FlashcardPages"
import { QuizPage } from "./study/QuizPage"
import { NotePage } from "./notes/NotePage"
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

type FieldKind = "text" | "textarea" | "tags" | "number"

type FieldConfig = {
  name: string
  label: string
  kind: FieldKind
  placeholder: string
}

type CollectionConfig = {
  key: string
  title: string
  description: string
  dashboardDescription: string
  endpoint: string
  fields: FieldConfig[]
  publicable?: boolean
  studyType?: StudyType
  helperText?: string
}

type CollectionItem = {
  id: string
  created_at?: string
  updated_at?: string | null
  is_public?: boolean
  published_at?: string | null
  published_by?: string | null
  study_type?: StudyType | null
  [key: string]: unknown
}

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

const collectionConfigs: CollectionConfig[] = [
  {
    key: "notes",
    title: "Notes",
    description: "Write your notes here.",
    dashboardDescription: "Write down what you're learning so you don't forget.",
    helperText: "Tip: write a question, then ::, then the answer. Luma can turn those lines into flashcards.",
    endpoint: "/notes",
    publicable: true,
    studyType: "note",
    fields: [
      {
        name: "title",
        label: "Title",
        kind: "text",
        placeholder: "Title",
      },
      {
        name: "content",
        label: "Content",
        kind: "textarea",
        placeholder: "Write your notes...",
      },
      {
        name: "tags",
        label: "Tags",
        kind: "tags",
        placeholder: "Add tags (optional)",
      },
    ],
  },
  {
    key: "study-sessions",
    title: "Study Sessions",
    description: "Plan your study time.",
    dashboardDescription: "Plan your study time.",
    endpoint: "/study-sessions",
    fields: [
      {
        name: "name",
        label: "Name",
        kind: "text",
        placeholder: "Study name",
      },
      {
        name: "subject",
        label: "Subject",
        kind: "text",
        placeholder: "Subject",
      },
      {
        name: "notes",
        label: "Notes",
        kind: "textarea",
        placeholder: "What do you want to study?",
      },
      {
        name: "duration_seconds",
        label: "Time in seconds",
        kind: "number",
        placeholder: "How long?",
      },
    ],
  },
  {
    key: "summaries",
    title: "Summaries",
    description: "Write a short version of your lesson.",
    dashboardDescription: "Save short versions of your lessons.",
    endpoint: "/summaries",
    publicable: true,
    studyType: "summary",
    fields: [
      {
        name: "title",
        label: "Title",
        kind: "text",
        placeholder: "Title",
      },
      {
        name: "content",
        label: "Summary",
        kind: "textarea",
        placeholder: "Write a short version...",
      },
      {
        name: "tags",
        label: "Tags",
        kind: "tags",
        placeholder: "Add tags (optional)",
      },
    ],
  },
]

const themeColors = [
  { name: "Red", value: "#dc2626" },
  { name: "Yellow", value: "#ca8a04" },
  { name: "Teal", value: "#0f766e" },
  { name: "Pink", value: "#db2777" },
  { name: "Gold", value: "#b7791f" },
  { name: "Cyan", value: "#0891b2" },
  { name: "Purple", value: "#7c3aed" },
  { name: "Orange", value: "#ea580c" },
  { name: "Green", value: "#16a34a" },
  { name: "Blue", value: "#3157d5" },
]

const DEFAULT_ACCENT = "#0f766e"

/** WCAG relative luminance of a #rrggbb color (null when it can't be read). */
function luminance(hex: string): number | null {
  const match = /^#?([0-9a-f]{6})$/i.exec(hex.trim())
  if (!match) return null
  const channels = [0, 2, 4].map((at) => {
    const value = parseInt(match[1].slice(at, at + 2), 16) / 255
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2]
}

const ON_ACCENT_LIGHT = "#ffffff"
const ON_ACCENT_DARK = "#1b1626"

/** Text color for buttons filled with the accent: white when it is easy to read, dark otherwise. */
function textOnAccent(accent: string): string {
  const background = luminance(accent)
  if (background === null) return ON_ACCENT_LIGHT
  const withWhite = 1.05 / (background + 0.05)
  if (withWhite >= 4.5) return ON_ACCENT_LIGHT
  const dark = luminance(ON_ACCENT_DARK) ?? 0
  const withDark = (background + 0.05) / (dark + 0.05)
  return withDark > withWhite ? ON_ACCENT_DARK : ON_ACCENT_LIGHT
}

type ThemeMode = "light" | "dark"

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

function makeEmptyValues(fields: FieldConfig[]): Record<string, string> {
  return fields.reduce<Record<string, string>>((accumulator, field) => {
    accumulator[field.name] = field.kind === "number" ? "0" : ""
    return accumulator
  }, {})
}

function normalizeTags(value: string): string[] {
  return value
    .split(",")
    .map((tag) => tag.trim())
    .filter(Boolean)
}

function buildPayload(
  fields: FieldConfig[],
  values: Record<string, string>,
): Record<string, string | number | string[] | boolean> {
  return fields.reduce<Record<string, string | number | string[] | boolean>>((payload, field) => {
    const rawValue = values[field.name] ?? ""

    if (field.kind === "tags") {
      payload[field.name] = normalizeTags(rawValue)
      return payload
    }

    if (field.kind === "number") {
      payload[field.name] = Number.parseInt(rawValue, 10) || 0
      return payload
    }

    payload[field.name] = rawValue.trim()
    return payload
  }, {})
}

function displayValue(value: unknown): string {
  if (Array.isArray(value)) {
    return value.join(", ")
  }

  if (typeof value === "number") {
    return String(value)
  }

  if (typeof value === "string") {
    return value
  }

  return ""
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

function AppLayout() {
  const { user, activeAccountId } = useAuth()
  const { signOut } = useAccountActions()
  const navigate = useNavigate()
  const profile = useProfile()
  const initials = (user?.username ?? user?.email ?? "L").slice(0, 1).toUpperCase()
  const themeMode = profile?.theme_mode === "dark" ? "dark" : "light"
  const accent = profile?.theme_color || DEFAULT_ACCENT

  // Apply the theme to the whole page so the background, sheets and modals match.
  // Other accent shades are mixed from --accent in styles.css for light and dark mode.
  useEffect(() => {
    const root = document.documentElement
    root.dataset.theme = themeMode
    root.style.setProperty("--accent", accent)
    // Keep text on accent-filled buttons readable for every theme color (4.5:1 or more).
    root.style.setProperty("--on-accent", textOnAccent(accent))
    return () => {
      delete root.dataset.theme
      root.style.removeProperty("--accent")
      root.style.removeProperty("--on-accent")
    }
  }, [themeMode, accent])

  // Signed-in pages are a student's own space: ask search engines not to list them.
  // The landing and sign-in pages stay without this tag.
  useEffect(() => {
    const meta = document.createElement("meta")
    meta.name = "robots"
    meta.content = "noindex"
    document.head.appendChild(meta)
    return () => meta.remove()
  }, [])

  const handleLogout = () => {
    if (activeAccountId) {
      signOut(activeAccountId)
    } else {
      navigate("/", { replace: true })
    }
  }

  return (
    <div className={`app-shell theme-${themeMode}`}>
      <SideNav
        username={user?.username ?? "Luma student"}
        plan={profile?.subscription_status ?? "free"}
        initials={initials}
        onLogout={handleLogout}
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
          {collectionConfigs.map((config) => (
            <Route key={config.key} path={`/${config.key}`} element={<CollectionPage config={config} />} />
          ))}
          <Route
            path="/notes/:itemId"
            element={<NotePage endpoint="/notes" studyType="note" backTo="/notes" kindLabel="Note" />}
          />
          <Route
            path="/summaries/:itemId"
            element={<NotePage endpoint="/summaries" studyType="summary" backTo="/summaries" kindLabel="Summary" />}
          />
          <Route path="/image-to-notes" element={<ImageToNotesPage />} />
          <Route path="/voice-input" element={<AudioToNotesPage />} />
          <Route path="/import" element={<ImportPage />} />
          <Route path="/audio-to-notes" element={<Navigate to="/voice-input" replace />} />
          <Route path="/ai-tutor" element={<Navigate to="/dashboard" replace />} />
          <Route path="/transcripts" element={<Navigate to="/dashboard" replace />} />
          <Route path="/study-session" element={<Navigate to="/study-sessions" replace />} />
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
  const { activeAccountId } = useAuth()
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

function CollectionPage({ config }: { config: CollectionConfig }) {
  const navigate = useNavigate()
  const [items, setItems] = useState<CollectionItem[]>([])
  const [values, setValues] = useState(() => makeEmptyValues(config.fields))
  const [notice, setNotice] = useState<Notice | null>(null)
  const [loading, setLoading] = useState(true)

  const loadItems = useCallback(async () => {
    setLoading(true)
    setNotice(null)

    try {
      const response = await api.get<CollectionItem[]>(config.endpoint)
      setItems(response.data)
    } catch (error: unknown) {
      setNotice({ type: "error", text: getErrorMessage(error, `Could not load ${config.title}.`) })
    } finally {
      setLoading(false)
    }
  }, [config.endpoint, config.title])

  useEffect(() => {
    setValues(makeEmptyValues(config.fields))
    void loadItems()
  }, [config.fields, loadItems])

  const updateValue = (event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    setValues((current) => ({
      ...current,
      [event.target.name]: event.target.value,
    }))
  }

  const createItem = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setNotice(null)

    try {
      const response = await api.post<CollectionItem>(config.endpoint, buildPayload(config.fields, values))
      setValues(makeEmptyValues(config.fields))

      if (config.publicable && response.data.id) {
        navigate(`/${config.key}/${response.data.id}`)
        return
      }

      setNotice({ type: "success", text: `${config.title.slice(0, -1) || config.title} saved.` })
      await loadItems()
    } catch (error: unknown) {
      setNotice({ type: "error", text: getErrorMessage(error, `Could not save ${config.title}.`) })
    }
  }

  const deleteItem = async (itemId: string) => {
    setNotice(null)

    try {
      await api.delete(`${config.endpoint}/${itemId}`)
      setNotice({ type: "success", text: "Item deleted." })
      await loadItems()
    } catch (error: unknown) {
      setNotice({ type: "error", text: getErrorMessage(error, "Could not delete item.") })
    }
  }

  return (
    <>
      <PageHeader eyebrow="Study data" title={config.title} description={config.description} />
      <NoticeBanner notice={notice} />
      <section className="split-layout">
        <form className="form-panel" onSubmit={createItem}>
          <h2>Create</h2>
          {config.helperText ? <p className="muted">{config.helperText}</p> : null}
          {config.fields.map((field) => (
            <FieldInput
              key={field.name}
              field={field}
              value={values[field.name] ?? ""}
              onChange={updateValue}
            />
          ))}
          <button type="submit" className="primary-button">
            Save
          </button>
        </form>
        <section className="list-panel" aria-live="polite">
          {loading ? <p className="muted">Loading...</p> : null}
          {!loading && items.length === 0 ? <p className="muted">No items yet.</p> : null}
          {items.map((item) => (
            <article className="item-card" key={item.id}>
              <div className="item-fields">
                {config.fields.slice(0, 2).map((field) => (
                  <div key={field.name}>
                    <small>{field.label}</small>
                    <p>{displayValue(item[field.name]) || "-"}</p>
                  </div>
                ))}
                {config.publicable ? (
                  <span className={`visibility-pill ${item.is_public ? "public" : "private"}`}>
                    {item.is_public ? "Public" : "Private"}
                  </span>
                ) : null}
              </div>
              <div className="button-row">
                {config.publicable ? (
                  <Link className="secondary-button" to={`/${config.key}/${item.id}`}>
                    View
                  </Link>
                ) : null}
                <button type="button" className="danger-button" onClick={() => void deleteItem(item.id)}>
                  Delete
                </button>
              </div>
            </article>
          ))}
        </section>
      </section>
    </>
  )
}

function FieldInput({
  field,
  value,
  onChange,
}: {
  field: FieldConfig
  value: string
  onChange: (event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => void
}) {
  return (
    <label>
      {field.label}
      {field.kind === "textarea" ? (
        <textarea
          name={field.name}
          value={value}
          onChange={onChange}
          placeholder={field.placeholder}
          required
        />
      ) : (
        <input
          name={field.name}
          type={field.kind === "number" ? "number" : "text"}
          value={value}
          onChange={onChange}
          placeholder={field.placeholder}
          required={field.name !== "tags" && field.name !== "subject" && field.name !== "notes"}
          min={field.kind === "number" ? 0 : undefined}
        />
      )}
    </label>
  )
}

function ImageToNotesPage() {
  const [fileName, setFileName] = useState("")
  const [imageData, setImageData] = useState<string | null>(null)
  const [result, setResult] = useState("")
  const [notice, setNotice] = useState<Notice | null>(null)
  const [submitting, setSubmitting] = useState(false)

  const readImage = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    setResult("")
    setNotice(null)
    setFileName(file?.name ?? "")

    if (!file) {
      setImageData(null)
      return
    }

    const reader = new FileReader()
    reader.onload = () => {
      setImageData(typeof reader.result === "string" ? reader.result : null)
    }
    reader.readAsDataURL(file)
  }

  const generateNotes = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!imageData) {
      setNotice({ type: "error", text: "Choose an image first." })
      return
    }

    setSubmitting(true)
    setNotice(null)

    try {
      const response = await api.post<{ notes: string }>("/api/generate-notes", { image: imageData })
      setResult(response.data.notes)
      setNotice({ type: "success", text: "Notes generated." })
    } catch (error: unknown) {
      setNotice({ type: "error", text: getErrorMessage(error, "Could not generate notes.") })
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <>
      <PageHeader
        eyebrow="Tools"
        title="Image to Notes"
        description="Upload a picture and turn it into notes."
      />
      <form className="form-panel" onSubmit={generateNotes}>
        <NoticeBanner notice={notice} />
        <label>
          Image
          <input type="file" accept="image/png,image/jpeg,image/webp" onChange={readImage} />
        </label>
        {fileName ? <p className="muted">Selected: {fileName}</p> : null}
        <p className="muted small-text">To make notes, Luma sends your picture to OpenAI. Luma does not save the picture.</p>
        <button className="primary-button" type="submit" disabled={submitting}>
          {submitting ? "Working..." : "Make notes"}
        </button>
      </form>
      {result ? <OutputBlock title="Generated notes" value={result} /> : null}
    </>
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
          className={activeTab === "topics" ? "tab-button active" : "tab-button"}
          aria-pressed={activeTab === "topics"}
          onClick={() => setActiveTab("topics")}
        >
          Search Topics
        </button>
        <button
          type="button"
          className={activeTab === "users" ? "tab-button active" : "tab-button"}
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

function ThemeSettingsForm({
  profile,
  setNotice,
}: {
  profile: Profile | null
  setNotice: (notice: Notice | null) => void
}) {
  const { setProfile } = useAuth()
  const [themeColor, setThemeColor] = useState(profile?.theme_color ?? themeColors[0].value)
  const [themeMode, setThemeMode] = useState<ThemeMode>(profile?.theme_mode === "dark" ? "dark" : "light")
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
      <h2>Theme</h2>
      <div className={`theme-preview ${themeMode}`} style={previewStyle}>
        <span />
        <strong>{themeMode === "dark" ? "Dark" : "Light"}</strong>
      </div>
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
      <div className="mode-toggle" aria-label="Light or dark mode">
        <button
          type="button"
          className={themeMode === "light" ? "active" : ""}
          onClick={() => setThemeMode("light")}
        >
          Light
        </button>
        <button
          type="button"
          className={themeMode === "dark" ? "active" : ""}
          onClick={() => setThemeMode("dark")}
        >
          Dark
        </button>
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

function OutputBlock({ title, value }: { title: string; value: string }) {
  return (
    <section className="output-block">
      <h2>{title}</h2>
      <pre>{value}</pre>
    </section>
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
