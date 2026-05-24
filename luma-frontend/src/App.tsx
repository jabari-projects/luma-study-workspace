import { useCallback, useEffect, useState } from "react"
import type { CSSProperties, ChangeEvent, FormEvent, ReactNode } from "react"
import {
  Link,
  Navigate,
  NavLink,
  Route,
  Routes,
  useLocation,
  useNavigate,
} from "react-router-dom"

import { useAuth, useProfile } from "./auth"
import { API_BASE_URL, api, checkBackendHealth, getErrorMessage } from "./api"
import type { Profile } from "./api"

type Notice = {
  type: "success" | "error" | "info"
  text: string
}

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
  is_public?: boolean
  published_at?: string | null
  published_by?: string | null
  study_type?: StudyType | null
  [key: string]: unknown
}

type StudyType = "note" | "flashcards" | "summary"

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
    key: "flashcards",
    title: "Flashcards",
    description: "Practice remembering what you learned.",
    dashboardDescription: "Practice remembering things you've learned.",
    endpoint: "/flashcards",
    publicable: true,
    studyType: "flashcards",
    helperText: "Challenge your mind to remember.",
    fields: [
      {
        name: "title",
        label: "Title",
        kind: "text",
        placeholder: "Title",
      },
      {
        name: "front",
        label: "Question",
        kind: "textarea",
        placeholder: "Question",
      },
      {
        name: "back",
        label: "Answer",
        kind: "textarea",
        placeholder: "Answer",
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
    dashboardDescription: "Plan your study time and stay focused.",
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
    ],
  },
  {
    key: "transcripts",
    title: "Transcripts",
    description: "Turn talking or audio into text you can read.",
    dashboardDescription: "Turn talking or audio into text you can read.",
    endpoint: "/transcripts",
    fields: [
      {
        name: "content",
        label: "Transcript",
        kind: "textarea",
        placeholder: "Paste text here...",
      },
    ],
  },
]

const themeColors = [
  { name: "Blue", value: "#3157d5" },
  { name: "Green", value: "#18764a" },
  { name: "Pink", value: "#c02663" },
  { name: "Orange", value: "#c2410c" },
  { name: "Purple", value: "#6d28d9" },
  { name: "Gray", value: "#475467" },
]

type ThemeMode = "light" | "dark"

const workspaceLinks = collectionConfigs.map((config) => ({
  to: `/${config.key}`,
  label: config.title,
}))

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

function getItemTitle(item: CollectionItem): string {
  return displayValue(item.title).trim()
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

function classForNavLink({ isActive }: { isActive: boolean }): string {
  return isActive ? "nav-link active" : "nav-link"
}

function PageHeader({
  eyebrow,
  title,
  description,
  actions,
}: {
  eyebrow?: string
  title: string
  description: string
  actions?: ReactNode
}) {
  return (
    <header className="page-header">
      <div>
        {eyebrow ? <p className="eyebrow">{eyebrow}</p> : null}
        <h1>{title}</h1>
        <p>{description}</p>
      </div>
      {actions ? <div className="page-actions">{actions}</div> : null}
    </header>
  )
}

function NoticeBanner({ notice }: { notice: Notice | null }) {
  if (!notice) {
    return null
  }

  return <div className={`notice ${notice.type}`}>{notice.text}</div>
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
  const { loading, isAuthenticated } = useAuth()
  const location = useLocation()

  if (loading) {
    return <LoadingScreen message="Checking your session..." />
  }

  if (!isAuthenticated) {
    return <Navigate to={`/login?redirect=${encodeURIComponent(location.pathname)}`} replace />
  }

  return <>{children}</>
}

function PublicOnlyRoute({ children }: { children: ReactNode }) {
  const { loading, isAuthenticated } = useAuth()

  if (loading) {
    return <LoadingScreen message="Preparing Luma..." />
  }

  if (isAuthenticated) {
    return <Navigate to="/dashboard" replace />
  }

  return <>{children}</>
}

function AppLayout() {
  const { user, logout } = useAuth()
  const navigate = useNavigate()
  const profile = useProfile()
  const initials = (user?.username ?? user?.email ?? "L").slice(0, 1).toUpperCase()

  const handleLogout = () => {
    logout()
    navigate("/", { replace: true })
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <Link className="brand" to="/dashboard" aria-label="Luma dashboard">
          <img src="/luma-star.png" alt="" />
          <span>Luma</span>
        </Link>
        <nav className="nav-stack" aria-label="Main navigation">
          <NavLink to="/dashboard" className={classForNavLink}>
            Dashboard
          </NavLink>
          <NavLink to="/search" className={classForNavLink}>
            Search
          </NavLink>
          {workspaceLinks.map((link) => (
            <NavLink key={link.to} to={link.to} className={classForNavLink}>
              {link.label}
            </NavLink>
          ))}
          <NavLink to="/image-to-notes" className={classForNavLink}>
            Image to Notes
          </NavLink>
          <NavLink to="/voice-input" className={classForNavLink}>
            Voice Input
          </NavLink>
          <NavLink to="/subscribe" className={classForNavLink}>
            Subscription
          </NavLink>
          <NavLink to="/settings" className={classForNavLink}>
            Settings
          </NavLink>
        </nav>
        <div className="sidebar-footer">
          <div className="identity">
            <span className="avatar">{initials}</span>
            <span>
              <strong>{user?.username ?? "Luma user"}</strong>
              <small>{profile?.subscription_status ?? "free"} plan</small>
            </span>
          </div>
          <button type="button" className="secondary-button" onClick={handleLogout}>
            Logout
          </button>
        </div>
      </aside>
      <main className="content">
        <Routes>
          <Route path="/dashboard" element={<DashboardPage />} />
          <Route path="/search" element={<SearchPage />} />
          {collectionConfigs.map((config) => (
            <Route
              key={config.key}
              path={`/${config.key}`}
              element={<CollectionPage config={config} />}
            />
          ))}
          <Route path="/image-to-notes" element={<ImageToNotesPage />} />
          <Route path="/voice-input" element={<VoiceInputPage />} />
          <Route path="/study-session" element={<Navigate to="/study-sessions" replace />} />
          <Route path="/subscribe" element={<SubscribePage />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="/profile" element={<Navigate to="/settings" replace />} />
          <Route path="*" element={<NotFoundPage />} />
        </Routes>
      </main>
    </div>
  )
}

function RootRoutes() {
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
      <Route path="/forgot-password" element={<ForgotPasswordPage />} />
      <Route path="/reset-password" element={<ResetPasswordPage />} />
      <Route path="/*" element={<ProtectedRoute><AppLayout /></ProtectedRoute>} />
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

function AuthForm({
  mode,
  onSubmit,
}: {
  mode: "login" | "signup"
  onSubmit: (values: { email: string; username: string; password: string }) => Promise<void>
}) {
  const [values, setValues] = useState({ email: "", username: "", password: "" })
  const [notice, setNotice] = useState<Notice | null>(null)
  const [submitting, setSubmitting] = useState(false)

  const updateValue = (event: ChangeEvent<HTMLInputElement>) => {
    setValues((current) => ({
      ...current,
      [event.target.name]: event.target.value,
    }))
  }

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setSubmitting(true)
    setNotice(null)

    try {
      await onSubmit(values)
    } catch (error: unknown) {
      setNotice({ type: "error", text: getErrorMessage(error, "Authentication failed.") })
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <form className="form-panel" onSubmit={handleSubmit}>
      <NoticeBanner notice={notice} />
      <label>
        Email
        <input
          name="email"
          type="email"
          autoComplete="email"
          value={values.email}
          onChange={updateValue}
          required
        />
      </label>
      {mode === "signup" ? (
        <label>
          Username
          <input
            name="username"
            type="text"
            autoComplete="username"
            value={values.username}
            onChange={updateValue}
            minLength={3}
            pattern="[a-zA-Z0-9_]+"
            required
          />
        </label>
      ) : null}
      <label>
        Password
        <input
          name="password"
          type="password"
          autoComplete={mode === "login" ? "current-password" : "new-password"}
          value={values.password}
          onChange={updateValue}
          minLength={6}
          required
        />
      </label>
      <button className="primary-button" type="submit" disabled={submitting}>
        {submitting ? "Working..." : mode === "login" ? "Login" : "Create account"}
      </button>
    </form>
  )
}

function LoginPage() {
  const { login } = useAuth()
  const navigate = useNavigate()
  const location = useLocation()

  const handleLogin = async (values: { email: string; password: string }) => {
    await login(values)
    const searchParams = new URLSearchParams(location.search)
    navigate(searchParams.get("redirect") || "/dashboard", { replace: true })
  }

  return (
    <main className="auth-screen">
      <section>
        <PageHeader
          eyebrow="Welcome back"
          title="Login to Luma"
          description="Log in to get back to your work."
        />
        <AuthForm
          mode="login"
          onSubmit={(values) => handleLogin({ email: values.email, password: values.password })}
        />
        <p className="auth-link">
          Need an account? <Link to="/signup">Create one</Link>
        </p>
        <p className="auth-link">
          Forgot your password? <Link to="/forgot-password">Reset it</Link>
        </p>
      </section>
    </main>
  )
}

function SignupPage() {
  const { signup } = useAuth()
  const navigate = useNavigate()
  const { health, refreshBackendHealth } = useBackendHealth()

  const handleSignup = async (values: { email: string; username: string; password: string }) => {
    const backendConnected = await refreshBackendHealth()
    if (!backendConnected) {
      throw new Error("Luma is not reachable right now. Please try again soon.")
    }

    await signup(values)
    navigate("/dashboard", { replace: true })
  }

  return (
    <main className="auth-screen">
      <section>
        <PageHeader
          eyebrow="New workspace"
          title="Create your account"
          description="Make your Luma account."
        />
        <BackendConnectionBanner health={health} />
        <AuthForm mode="signup" onSubmit={handleSignup} />
        <p className="auth-link">
          Already have an account? <Link to="/login">Login</Link>
        </p>
      </section>
    </main>
  )
}

function ForgotPasswordPage() {
  const [email, setEmail] = useState("")
  const [notice, setNotice] = useState<Notice | null>(null)
  const [submitting, setSubmitting] = useState(false)

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setSubmitting(true)
    setNotice(null)

    try {
      await api.post("/auth/request-reset", { email })
      setNotice({
        type: "success",
        text: "If that account exists, we sent password help.",
      })
    } catch (error: unknown) {
      setNotice({ type: "error", text: getErrorMessage(error) })
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <main className="auth-screen">
      <section>
        <PageHeader
          eyebrow="Password help"
          title="Request reset"
          description="We can help you reset your password."
        />
        <form className="form-panel" onSubmit={submit}>
          <NoticeBanner notice={notice} />
          <label>
            Email
            <input value={email} type="email" onChange={(event) => setEmail(event.target.value)} required />
          </label>
          <button className="primary-button" type="submit" disabled={submitting}>
            {submitting ? "Sending..." : "Send reset request"}
          </button>
        </form>
      </section>
    </main>
  )
}

function ResetPasswordPage() {
  const [token, setToken] = useState("")
  const [password, setPassword] = useState("")
  const [notice, setNotice] = useState<Notice | null>(null)
  const [submitting, setSubmitting] = useState(false)

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setSubmitting(true)
    setNotice(null)

    try {
      await api.post("/auth/reset", { token, new_password: password })
      setNotice({ type: "success", text: "Your password was changed. You can log in now." })
    } catch (error: unknown) {
      setNotice({ type: "error", text: getErrorMessage(error) })
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <main className="auth-screen">
      <section>
        <PageHeader
          eyebrow="Password help"
          title="Set new password"
          description="Pick a new password."
        />
        <form className="form-panel" onSubmit={submit}>
          <NoticeBanner notice={notice} />
          <label>
            Reset token
            <input value={token} onChange={(event) => setToken(event.target.value)} required />
          </label>
          <label>
            New password
            <input
              value={password}
              type="password"
              minLength={6}
              onChange={(event) => setPassword(event.target.value)}
              required
            />
          </label>
          <button className="primary-button" type="submit" disabled={submitting}>
            {submitting ? "Resetting..." : "Reset password"}
          </button>
        </form>
      </section>
    </main>
  )
}

function DashboardPage() {
  const profile = useProfile()
  const { health } = useBackendHealth()
  const [counts, setCounts] = useState<Record<string, number>>({})

  useEffect(() => {
    let active = true

    Promise.all(
      collectionConfigs.map(async (config) => {
        const response = await api.get<CollectionItem[]>(config.endpoint)
        return [config.key, response.data.length] as const
      }),
    )
      .then((entries) => {
        if (active) {
          setCounts(Object.fromEntries(entries))
        }
      })
      .catch(() => {
        if (active) {
          setCounts({})
        }
      })

    return () => {
      active = false
    }
  }, [])

  return (
    <>
      <PageHeader
        eyebrow="Workspace"
        title={`Good to see you${profile?.username ? `, ${profile.username}` : ""}`}
        description="Pick what you want to work on today."
      />
      <BackendConnectionBanner health={health} />
      <section className="metrics-grid">
        {collectionConfigs.map((config) => (
          <Link className="metric-card link-card" key={config.key} to={`/${config.key}`}>
            <strong>{config.title}</strong>
            <span>{counts[config.key] ?? "-"}</span>
            <p>{config.dashboardDescription}</p>
          </Link>
        ))}
      </section>
    </>
  )
}

function CollectionPage({ config }: { config: CollectionConfig }) {
  const profile = useProfile()
  const { user } = useAuth()
  const [items, setItems] = useState<CollectionItem[]>([])
  const [values, setValues] = useState(() => makeEmptyValues(config.fields))
  const [selectedItemId, setSelectedItemId] = useState<string | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editValues, setEditValues] = useState<Record<string, string>>({})
  const [publishModalItem, setPublishModalItem] = useState<CollectionItem | null>(null)
  const [publishing, setPublishing] = useState(false)
  const [notice, setNotice] = useState<Notice | null>(null)
  const [loading, setLoading] = useState(true)
  const selectedItem = items.find((item) => item.id === selectedItemId) ?? null
  const selectedItemIsEditing = Boolean(selectedItem && editingId === selectedItem.id)
  const publisherUsername = profile?.username ?? user?.username ?? "Student"

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
    setSelectedItemId(null)
    setEditingId(null)
    setEditValues({})
    setPublishModalItem(null)
    void loadItems()
  }, [config.fields, loadItems])

  const updateValue = (event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    setValues((current) => ({
      ...current,
      [event.target.name]: event.target.value,
    }))
  }

  const updateEditValue = (event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    setEditValues((current) => ({
      ...current,
      [event.target.name]: event.target.value,
    }))
  }

  const createItem = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setNotice(null)

    try {
      const payload = buildPayload(config.fields, values)

      await api.post(config.endpoint, payload)
      setValues(makeEmptyValues(config.fields))
      setNotice({ type: "success", text: `${config.title.slice(0, -1) || config.title} saved.` })
      await loadItems()
    } catch (error: unknown) {
      setNotice({ type: "error", text: getErrorMessage(error, `Could not save ${config.title}.`) })
    }
  }

  const startEdit = (item: CollectionItem) => {
    setSelectedItemId(item.id)
    setEditingId(item.id)
    setEditValues(
      config.fields.reduce<Record<string, string>>((draft, field) => {
        draft[field.name] = displayValue(item[field.name])
        return draft
      }, {}),
    )
  }

  const saveEdit = async (itemId: string) => {
    setNotice(null)

    try {
      const payload = buildPayload(config.fields, editValues)

      await api.put(`${config.endpoint}/${itemId}`, payload)
      setEditingId(null)
      setEditValues({})
      setNotice({ type: "success", text: "Changes saved." })
      await loadItems()
    } catch (error: unknown) {
      setNotice({ type: "error", text: getErrorMessage(error, "Could not save changes.") })
    }
  }

  const deleteItem = async (itemId: string) => {
    setNotice(null)

    try {
      await api.delete(`${config.endpoint}/${itemId}`)
      if (selectedItemId === itemId) {
        setSelectedItemId(null)
      }
      setNotice({ type: "success", text: "Item deleted." })
      await loadItems()
    } catch (error: unknown) {
      setNotice({ type: "error", text: getErrorMessage(error, "Could not delete item.") })
    }
  }

  const openPublishModal = (item: CollectionItem) => {
    setNotice(null)

    if (!getItemTitle(item)) {
      setNotice({ type: "error", text: "Please give this study set a title before publishing." })
      return
    }

    setPublishModalItem(item)
  }

  const publishItem = async (item: CollectionItem) => {
    if (!config.studyType) {
      return
    }

    setPublishing(true)
    setNotice(null)

    try {
      await api.put(`${config.endpoint}/${item.id}`, {
        is_public: true,
        published_at: new Date().toISOString(),
        published_by: publisherUsername,
        study_type: config.studyType,
      })
      setPublishModalItem(null)
      setNotice({ type: "success", text: "Published." })
      await loadItems()
    } catch (error: unknown) {
      setNotice({ type: "error", text: getErrorMessage(error, "Could not publish this study set.") })
    } finally {
      setPublishing(false)
    }
  }

  const unpublishItem = async (item: CollectionItem) => {
    setPublishing(true)
    setNotice(null)

    try {
      await api.put(`${config.endpoint}/${item.id}`, {
        is_public: false,
        published_at: null,
        published_by: null,
      })
      setNotice({ type: "success", text: "Unpublished." })
      await loadItems()
    } catch (error: unknown) {
      setNotice({ type: "error", text: getErrorMessage(error, "Could not unpublish this study set.") })
    } finally {
      setPublishing(false)
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
            <article
              className={selectedItemId === item.id ? "item-card active" : "item-card"}
              key={item.id}
            >
              {editingId === item.id ? (
                <>
                  {config.fields.map((field) => (
                    <FieldInput
                      key={field.name}
                      field={field}
                      value={editValues[field.name] ?? ""}
                      onChange={updateEditValue}
                    />
                  ))}
                  <div className="button-row">
                    <button type="button" className="primary-button" onClick={() => void saveEdit(item.id)}>
                      Save changes
                    </button>
                    <button
                      type="button"
                      className="secondary-button"
                      onClick={() => {
                        setEditingId(null)
                      }}
                    >
                      Cancel
                    </button>
                  </div>
                </>
              ) : (
                <>
                  <div className="item-fields">
                    {config.fields.map((field) => (
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
                    {item.is_public ? (
                      <div className="published-meta">
                        <small>Published</small>
                        <p>{formatPublishedDate(displayValue(item.published_at))}</p>
                      </div>
                    ) : null}
                  </div>
                  <div className="button-row">
                    <button type="button" className="secondary-button" onClick={() => setSelectedItemId(item.id)}>
                      {selectedItemId === item.id ? "Viewing" : "View"}
                    </button>
                    <button type="button" className="secondary-button" onClick={() => startEdit(item)}>
                      Edit
                    </button>
                    <button type="button" className="danger-button" onClick={() => void deleteItem(item.id)}>
                      Delete
                    </button>
                  </div>
                </>
              )}
            </article>
          ))}
        </section>
      </section>
      {config.publicable && selectedItem && !selectedItemIsEditing ? (
        <button
          type="button"
          className={selectedItem.is_public ? "floating-publish unpublish" : "floating-publish"}
          onClick={() => {
            if (selectedItem.is_public) {
              void unpublishItem(selectedItem)
              return
            }
            openPublishModal(selectedItem)
          }}
          disabled={publishing}
        >
          {selectedItem.is_public ? "Unpublish" : "Publish"}
        </button>
      ) : null}
      {publishModalItem ? (
        <PublishModal
          publishing={publishing}
          onCancel={() => setPublishModalItem(null)}
          onConfirm={() => void publishItem(publishModalItem)}
        />
      ) : null}
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

function PublishModal({
  publishing,
  onCancel,
  onConfirm,
}: {
  publishing: boolean
  onCancel: () => void
  onConfirm: () => void
}) {
  return (
    <div className="modal-backdrop" role="presentation">
      <section className="modal-panel" role="dialog" aria-modal="true" aria-labelledby="publish-title">
        <h2 id="publish-title">Publish this study set?</h2>
        <p>
          Publishing makes this study set visible to other students. Your username will appear as the
          creator. You can unpublish it anytime.
        </p>
        <div className="button-row">
          <button type="button" className="secondary-button" onClick={onCancel} disabled={publishing}>
            Cancel
          </button>
          <button type="button" className="primary-button" onClick={onConfirm} disabled={publishing}>
            {publishing ? "Publishing..." : "Publish"}
          </button>
        </div>
      </section>
    </div>
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
        <button className="primary-button" type="submit" disabled={submitting}>
          {submitting ? "Working..." : "Make notes"}
        </button>
      </form>
      {result ? <OutputBlock title="Generated notes" value={result} /> : null}
    </>
  )
}

function VoiceInputPage() {
  const [audio, setAudio] = useState<File | null>(null)
  const [transcript, setTranscript] = useState("")
  const [notice, setNotice] = useState<Notice | null>(null)
  const [submitting, setSubmitting] = useState(false)

  const transcribe = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!audio) {
      setNotice({ type: "error", text: "Choose an audio file first." })
      return
    }

    setSubmitting(true)
    setNotice(null)
    const formData = new FormData()
    formData.append("audio", audio)

    try {
      const response = await api.post<{ transcript: string }>("/api/transcribe", formData)
      setTranscript(response.data.transcript)
      setNotice({ type: "success", text: "Audio transcribed." })
    } catch (error: unknown) {
      setNotice({ type: "error", text: getErrorMessage(error, "Could not transcribe audio.") })
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <>
      <PageHeader
        eyebrow="Tools"
        title="Voice Input"
        description="Upload audio and turn it into text."
      />
      <form className="form-panel" onSubmit={transcribe}>
        <NoticeBanner notice={notice} />
        <label>
          Audio
          <input
            type="file"
            accept="audio/*"
            onChange={(event) => setAudio(event.target.files?.[0] ?? null)}
          />
        </label>
        <button className="primary-button" type="submit" disabled={submitting}>
          {submitting ? "Working..." : "Turn into text"}
        </button>
      </form>
      {transcript ? <OutputBlock title="Transcript" value={transcript} /> : null}
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
      <div className="tabs" role="tablist" aria-label="Search choices">
        <button
          type="button"
          className={activeTab === "topics" ? "tab-button active" : "tab-button"}
          onClick={() => setActiveTab("topics")}
        >
          Search Topics
        </button>
        <button
          type="button"
          className={activeTab === "users" ? "tab-button active" : "tab-button"}
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
    <form className="form-panel" onSubmit={saveTheme}>
      <h2>Theme</h2>
      <div className={`theme-preview ${themeMode}`} style={previewStyle}>
        <span />
        <strong>{themeMode === "dark" ? "Dark" : "Light"}</strong>
      </div>
      <div className="color-grid" aria-label="Theme colors">
        {themeColors.map((color) => (
          <button
            key={color.value}
            type="button"
            className={themeColor === color.value ? "color-button active" : "color-button"}
            style={{ backgroundColor: color.value }}
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
  const { logout } = useAuth()
  const navigate = useNavigate()
  const [confirmText, setConfirmText] = useState("")

  const deleteAccount = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setNotice(null)

    if (confirmText.trim().toLowerCase() !== "delete") {
      setNotice({ type: "error", text: "Type delete to confirm." })
      return
    }

    try {
      await api.delete("/me/account")
      logout()
      navigate("/", { replace: true })
    } catch (error: unknown) {
      setNotice({ type: "error", text: getErrorMessage(error, "Could not delete account.") })
    }
  }

  return (
    <form className="form-panel danger-zone" onSubmit={deleteAccount}>
      <h2>Delete Account</h2>
      <p>This removes your account and study work.</p>
      <label>
        Type delete
        <input value={confirmText} onChange={(event) => setConfirmText(event.target.value)} />
      </label>
      <button className="danger-button" type="submit">
        Delete account
      </button>
    </form>
  )
}

function SubscribePage() {
  const [notice, setNotice] = useState<Notice | null>(null)
  const [loading, setLoading] = useState(false)

  const startCheckout = async () => {
    setLoading(true)
    setNotice(null)

    try {
      const response = await api.post<{ url: string }>("/api/create-checkout-session")
      window.location.assign(response.data.url)
    } catch (error: unknown) {
      setNotice({ type: "error", text: getErrorMessage(error, "Could not start checkout.") })
    } finally {
      setLoading(false)
    }
  }

  return (
    <>
      <PageHeader
        eyebrow="Premium"
        title="Subscription"
        description="Get extra features and higher limits with Luma Premium."
      />
      <NoticeBanner notice={notice} />
      <section className="form-panel">
        <p>Press the button below to upgrade.</p>
        <button className="primary-button" type="button" onClick={() => void startCheckout()} disabled={loading}>
          {loading ? "Starting..." : "Upgrade"}
        </button>
      </section>
    </>
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
  return <RootRoutes />
}
