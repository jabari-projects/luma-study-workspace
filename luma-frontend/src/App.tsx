import { useCallback, useEffect, useState } from "react"
import type { ChangeEvent, FormEvent, ReactNode } from "react"
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
  endpoint: string
  fields: FieldConfig[]
}

type CollectionItem = {
  id: string
  created_at?: string
  [key: string]: unknown
}

type HealthState = {
  status: "checking" | "online" | "offline"
  detail: string | null
}

const collectionConfigs: CollectionConfig[] = [
  {
    key: "notes",
    title: "Notes",
    description: "Capture structured study notes and keep them searchable.",
    endpoint: "/notes",
    fields: [
      {
        name: "title",
        label: "Title",
        kind: "text",
        placeholder: "Photosynthesis review",
      },
      {
        name: "content",
        label: "Content",
        kind: "textarea",
        placeholder: "Main ideas, examples, and questions",
      },
      {
        name: "tags",
        label: "Tags",
        kind: "tags",
        placeholder: "biology, exam",
      },
    ],
  },
  {
    key: "flashcards",
    title: "Flashcards",
    description: "Build memory prompts for quick review sessions.",
    endpoint: "/flashcards",
    fields: [
      {
        name: "front",
        label: "Front",
        kind: "textarea",
        placeholder: "What is active recall?",
      },
      {
        name: "back",
        label: "Back",
        kind: "textarea",
        placeholder: "Retrieving information without looking at notes",
      },
      {
        name: "tags",
        label: "Tags",
        kind: "tags",
        placeholder: "study, recall",
      },
    ],
  },
  {
    key: "study-sessions",
    title: "Study Sessions",
    description: "Plan and track focused blocks of learning.",
    endpoint: "/study-sessions",
    fields: [
      {
        name: "name",
        label: "Name",
        kind: "text",
        placeholder: "Chemistry practice block",
      },
      {
        name: "subject",
        label: "Subject",
        kind: "text",
        placeholder: "Chemistry",
      },
      {
        name: "notes",
        label: "Notes",
        kind: "textarea",
        placeholder: "Focus on stoichiometry problems",
      },
      {
        name: "duration_seconds",
        label: "Duration seconds",
        kind: "number",
        placeholder: "1800",
      },
    ],
  },
  {
    key: "summaries",
    title: "Summaries",
    description: "Store compact summaries for later review.",
    endpoint: "/summaries",
    fields: [
      {
        name: "content",
        label: "Summary",
        kind: "textarea",
        placeholder: "Condense the lesson into the most important ideas",
      },
    ],
  },
  {
    key: "transcripts",
    title: "Transcripts",
    description: "Keep lecture or voice transcripts attached to your workspace.",
    endpoint: "/transcripts",
    fields: [
      {
        name: "content",
        label: "Transcript",
        kind: "textarea",
        placeholder: "Paste or save transcript text",
      },
    ],
  },
]

const workspaceLinks = collectionConfigs.map((config) => ({
  to: `/${config.key}`,
  label: config.title,
}))

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
): Record<string, string | number | string[]> {
  return fields.reduce<Record<string, string | number | string[]>>((payload, field) => {
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
      <strong>{health.status === "checking" ? "Checking backend" : "Backend unavailable"}</strong>
      <p>{health.detail ?? "Waiting for the backend health check to finish."}</p>
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
            Subscribe
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
  const [health, setHealth] = useState<HealthState>({
    status: "checking",
    detail: "Checking backend...",
  })

  useEffect(() => {
    let active = true

    checkBackendHealth()
      .then(() => {
        if (active) {
          setHealth({ status: "online", detail: null })
        }
      })
      .catch((error: unknown) => {
        if (active) {
          setHealth({ status: "offline", detail: getErrorMessage(error) })
        }
      })

    return () => {
      active = false
    }
  }, [])

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
          <p>
            Notes, flashcards, transcripts, sessions, and AI study tools running against
            the configured backend.
          </p>
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
          description="Use your Luma backend account to open the workspace."
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

  const handleSignup = async (values: { email: string; username: string; password: string }) => {
    await signup(values)
    navigate("/dashboard", { replace: true })
  }

  return (
    <main className="auth-screen">
      <section>
        <PageHeader
          eyebrow="New workspace"
          title="Create your account"
          description="Signup uses the backend custom JWT flow and creates a Luma profile."
        />
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
        text: "If that account exists, the backend accepted the reset request.",
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
          description="Ask the backend to issue a password reset token."
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
      setNotice({ type: "success", text: "Password reset accepted. You can login now." })
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
          description="Paste the reset token from the backend email flow."
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
  const [health, setHealth] = useState<HealthState>({
    status: "checking",
    detail: "Checking backend...",
  })
  const [counts, setCounts] = useState<Record<string, number>>({})

  useEffect(() => {
    let active = true

    checkBackendHealth()
      .then(() => active && setHealth({ status: "online", detail: null }))
      .catch((error: unknown) => active && setHealth({ status: "offline", detail: getErrorMessage(error) }))

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
        title={`Good to see you${profile?.display_name ? `, ${profile.display_name}` : ""}`}
        description="Your Luma backend, study collections, and AI tools are wired into one workspace."
      />
      <BackendConnectionBanner health={health} />
      <section className="metrics-grid">
        {collectionConfigs.map((config) => (
          <Link className="metric-card link-card" key={config.key} to={`/${config.key}`}>
            <strong>{config.title}</strong>
            <span>{counts[config.key] ?? "-"}</span>
            <p>{config.description}</p>
          </Link>
        ))}
      </section>
    </>
  )
}

function CollectionPage({ config }: { config: CollectionConfig }) {
  const [items, setItems] = useState<CollectionItem[]>([])
  const [values, setValues] = useState(() => makeEmptyValues(config.fields))
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editValues, setEditValues] = useState<Record<string, string>>({})
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
    setEditingId(null)
    setEditValues({})
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
      await api.post(config.endpoint, buildPayload(config.fields, values))
      setValues(makeEmptyValues(config.fields))
      setNotice({ type: "success", text: `${config.title.slice(0, -1) || config.title} saved.` })
      await loadItems()
    } catch (error: unknown) {
      setNotice({ type: "error", text: getErrorMessage(error, `Could not save ${config.title}.`) })
    }
  }

  const startEdit = (item: CollectionItem) => {
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
      await api.put(`${config.endpoint}/${itemId}`, buildPayload(config.fields, editValues))
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
                    <button type="button" className="secondary-button" onClick={() => setEditingId(null)}>
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
                  </div>
                  <div className="button-row">
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
        eyebrow="AI"
        title="Image to Notes"
        description="Send an image data URL to the backend note generation endpoint."
      />
      <form className="form-panel" onSubmit={generateNotes}>
        <NoticeBanner notice={notice} />
        <label>
          Image
          <input type="file" accept="image/png,image/jpeg,image/webp" onChange={readImage} />
        </label>
        {fileName ? <p className="muted">Selected: {fileName}</p> : null}
        <button className="primary-button" type="submit" disabled={submitting}>
          {submitting ? "Generating..." : "Generate notes"}
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
        eyebrow="AI"
        title="Voice Input"
        description="Upload audio and let the backend transcription route produce text."
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
          {submitting ? "Transcribing..." : "Transcribe"}
        </button>
      </form>
      {transcript ? <OutputBlock title="Transcript" value={transcript} /> : null}
    </>
  )
}

function SearchPage() {
  const [query, setQuery] = useState("")
  const [users, setUsers] = useState<Array<{ id: string; username: string; display_name?: string | null }>>([])
  const [semanticResult, setSemanticResult] = useState("")
  const [notice, setNotice] = useState<Notice | null>(null)

  const searchUsers = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setNotice(null)

    try {
      const response = await api.get<Array<{ id: string; username: string; display_name?: string | null }>>(
        "/users/search",
        { params: { query } },
      )
      setUsers(response.data)
    } catch (error: unknown) {
      setNotice({ type: "error", text: getErrorMessage(error, "Could not search users.") })
    }
  }

  const semanticSearch = async () => {
    setNotice(null)
    setSemanticResult("")

    try {
      const response = await api.post<{ keywords: string[]; embedding?: number[] | null }>("/api/semantic-search", {
        query,
      })
      setSemanticResult(
        `Keywords: ${response.data.keywords.join(", ")}\nEmbedding dimensions: ${
          response.data.embedding?.length ?? 0
        }`,
      )
    } catch (error: unknown) {
      setNotice({ type: "error", text: getErrorMessage(error, "Could not run semantic search.") })
    }
  }

  return (
    <>
      <PageHeader
        eyebrow="Search"
        title="Workspace Search"
        description="Search profiles and run the premium semantic search endpoint when configured."
      />
      <form className="form-panel" onSubmit={searchUsers}>
        <NoticeBanner notice={notice} />
        <label>
          Query
          <input value={query} onChange={(event) => setQuery(event.target.value)} required minLength={1} />
        </label>
        <div className="button-row">
          <button className="primary-button" type="submit">
            Search users
          </button>
          <button className="secondary-button" type="button" onClick={() => void semanticSearch()}>
            Semantic search
          </button>
        </div>
      </form>
      <section className="list-panel">
        {users.length === 0 ? <p className="muted">No user results yet.</p> : null}
        {users.map((user) => (
          <article className="item-card" key={user.id}>
            <strong>{user.display_name || user.username}</strong>
            <small>@{user.username}</small>
          </article>
        ))}
      </section>
      {semanticResult ? <OutputBlock title="Semantic result" value={semanticResult} /> : null}
    </>
  )
}

function SettingsPage() {
  const profile = useProfile()
  const [notice, setNotice] = useState<Notice | null>(null)

  return (
    <>
      <PageHeader
        eyebrow="Account"
        title="Settings"
        description="Manage profile fields that are stored through the backend profile API."
      />
      <NoticeBanner notice={notice} />
      <section className="split-layout">
        <ProfileSettingsForm key={`profile-${profile?.id ?? "empty"}`} profile={profile} setNotice={setNotice} />
        <IdentitySettingsForm key={`identity-${profile?.username ?? "empty"}`} profile={profile} setNotice={setNotice} />
      </section>
    </>
  )
}

function ProfileSettingsForm({
  profile,
  setNotice,
}: {
  profile: Profile | null
  setNotice: (notice: Notice | null) => void
}) {
  const { setProfile } = useAuth()
  const [profileValues, setProfileValues] = useState({
    display_name: profile?.display_name ?? "",
    timezone: profile?.timezone ?? "",
    theme_mode: profile?.theme_mode ?? "",
    phone_number: profile?.phone_number ?? "",
    birthday: profile?.birthday ?? "",
  })

  const updateProfileValue = (event: ChangeEvent<HTMLInputElement>) => {
    setProfileValues((current) => ({
      ...current,
      [event.target.name]: event.target.value,
    }))
  }

  const saveProfile = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setNotice(null)

    try {
      const payload = Object.fromEntries(
        Object.entries(profileValues).map(([key, value]) => [key, value.trim() || null]),
      )
      const response = await api.put<Profile>("/me/profile", payload)
      setProfile(response.data)
      setNotice({ type: "success", text: "Profile saved." })
    } catch (error: unknown) {
      setNotice({ type: "error", text: getErrorMessage(error, "Could not save profile.") })
    }
  }

  return (
    <form className="form-panel" onSubmit={saveProfile}>
      <h2>Profile</h2>
      <label>
        Display name
        <input name="display_name" value={profileValues.display_name} onChange={updateProfileValue} />
      </label>
      <label>
        Timezone
        <input name="timezone" value={profileValues.timezone} onChange={updateProfileValue} />
      </label>
      <label>
        Theme mode
        <input name="theme_mode" value={profileValues.theme_mode} onChange={updateProfileValue} />
      </label>
      <label>
        Phone
        <input name="phone_number" value={profileValues.phone_number} onChange={updateProfileValue} />
      </label>
      <label>
        Birthday
        <input name="birthday" type="date" value={profileValues.birthday} onChange={updateProfileValue} />
      </label>
      <button className="primary-button" type="submit">
        Save profile
      </button>
    </form>
  )
}

function IdentitySettingsForm({
  profile,
  setNotice,
}: {
  profile: Profile | null
  setNotice: (notice: Notice | null) => void
}) {
  const { refreshProfile } = useAuth()
  const [username, setUsername] = useState(profile?.username ?? "")

  const saveUsername = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setNotice(null)

    try {
      await api.put("/me/username", { new_username: username })
      await refreshProfile()
      setNotice({ type: "success", text: "Username updated." })
    } catch (error: unknown) {
      setNotice({ type: "error", text: getErrorMessage(error, "Could not update username.") })
    }
  }

  const sendVerification = async () => {
    setNotice(null)

    try {
      await api.post("/auth/send-verification")
      setNotice({ type: "success", text: "Verification request sent." })
    } catch (error: unknown) {
      setNotice({ type: "error", text: getErrorMessage(error, "Could not send verification email.") })
    }
  }

  return (
    <form className="form-panel" onSubmit={saveUsername}>
      <h2>Identity</h2>
      <label>
        Username
        <input value={username} onChange={(event) => setUsername(event.target.value)} minLength={3} required />
      </label>
      <button className="primary-button" type="submit">
        Save username
      </button>
      <button className="secondary-button" type="button" onClick={() => void sendVerification()}>
        Send verification email
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
        description="Start Stripe Checkout through the backend when Stripe env vars are configured."
      />
      <NoticeBanner notice={notice} />
      <section className="form-panel">
        <p>
          Premium unlocks higher AI limits and premium study tools. The backend will return a
          checkout URL when Stripe is configured.
        </p>
        <button className="primary-button" type="button" onClick={() => void startCheckout()} disabled={loading}>
          {loading ? "Starting..." : "Start checkout"}
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
      <p>The route does not exist in this Luma app.</p>
      <Link className="primary-button" to="/dashboard">
        Back to dashboard
      </Link>
    </section>
  )
}

export default function App() {
  return <RootRoutes />
}
