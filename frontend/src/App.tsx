import { useEffect, useLayoutEffect, useState } from "react"
import type { ReactNode } from "react"
import { Toaster, toast } from "sonner"
import {
  Link,
  Navigate,
  Route,
  Routes,
  useLocation,
} from "react-router-dom"

import { useAuth, useProfile } from "./auth"
import { MobileTabBar, MobileTopBar, SideNav } from "./ui/Nav"
import { SignedOutElsewhere } from "./ui/AccountMenu"
import { Scribble } from "./ui/Scribble"
import { NotePreview } from "./ui/NotePreview"
import { isBusyPath } from "./ui/accountActions"
import { applyTheme, clearTheme, readThemeCache, useResolvedTheme } from "./ui/theme"
import { ACCOUNT_LIMIT_MESSAGE } from "./accounts"
import { SignInAgainHost, UnsavedWorkGuard, isSigningOut, useHasUnsavedWork } from "./work"
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
import { AdminReportsPage } from "./account/Reporting"
import { SettingsPage } from "./account/SettingsPage"
import { DiscoverPage } from "./discover/DiscoverPage"
import { DISCOVER, DISCOVER_REDIRECTS } from "./discover/discover"
import { ImportPage } from "./capture/ImportPage"
import { MaintenanceNotice } from "./maintenance/MaintenanceNotice"
import { StatusPage } from "./maintenance/StatusPage"
import { AdminMaintenancePage } from "./maintenance/AdminMaintenancePage"
import { FeedbackPage } from "./feedback/FeedbackPage"
import { FeedbackArchivePage, FeedbackResultsPage } from "./feedback/FeedbackResultsPage"
import { AdminFeedbackPage, AdminPollPage } from "./feedback/AdminFeedbackPage"

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

function ProtectedRoute({ children }: { children: ReactNode }) {
  const { loading, isAuthenticated, signedOutElsewhere } = useAuth()
  const location = useLocation()
  // Unsaved work is never dropped by a redirect or a sign-out in another tab: the page stays
  // open and asks to sign in again (SignInAgainHost). With nothing unsaved, nothing changes.
  const holdingWork = useHasUnsavedWork()

  if (loading) {
    return <LoadingScreen message="Checking your session..." />
  }

  if (signedOutElsewhere && !holdingWork) {
    return <SignedOutElsewhere />
  }

  if (!isAuthenticated && !signedOutElsewhere && !holdingWork) {
    // Signing out goes to the home page next; don't send the student to the login page first.
    if (isSigningOut()) return null
    return <Navigate to={`/login?redirect=${encodeURIComponent(location.pathname)}`} replace />
  }

  return (
    <>
      <UnsavedWorkGuard />
      {children}
      <SignInAgainHost />
    </>
  )
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
        <MaintenanceNotice />
        <Routes>
          <Route path="/dashboard" element={<TodayPage />} />
          <Route path={DISCOVER} element={<DiscoverPage />} />
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
          {[...NOTE_REDIRECTS, ...STUDY_REDIRECTS, ...DISCOVER_REDIRECTS].map(([from, to]) => (
            <Route key={from} path={from} element={<KeepQueryRedirect to={to} />} />
          ))}
          <Route path="/ai-tutor" element={<Navigate to="/dashboard" replace />} />
          <Route path="/transcripts" element={<Navigate to="/dashboard" replace />} />
          <Route path="/quiz" element={<Navigate to="/quizzes" replace />} />
          <Route path="/subscribe" element={<Navigate to="/dashboard" replace />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="/admin/reports" element={<AdminReportsPage />} />
          <Route path="/admin/maintenance" element={<AdminMaintenancePage />} />
          <Route path="/feedback" element={<FeedbackPage />} />
          <Route path="/feedback/results" element={<FeedbackArchivePage />} />
          <Route path="/feedback/results/:pollId" element={<FeedbackResultsPage />} />
          <Route path="/admin/feedback" element={<AdminFeedbackPage />} />
          <Route path="/admin/feedback/:pollId" element={<AdminPollPage />} />
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
      <Route path="/status" element={<StatusPage />} />
      {/* Keyed by account: switching starts the app fresh, so no page shows one account's data under another. */}
      <Route path="/*" element={<ProtectedRoute><AppLayout key={activeAccountId ?? "none"} /></ProtectedRoute>} />
    </Routes>
  )
}

function LandingPage() {
  const { isAuthenticated } = useAuth()

  if (isAuthenticated) {
    return <Navigate to="/dashboard" replace />
  }

  // A page from a notebook: the brand and the two ways in on one side,
  // a note turning into a flashcard (what Luma does) on the other.
  return (
    <main className="landing">
      <div className="landing-inner">
        <section className="landing-copy" aria-labelledby="landing-title">
          <img className="landing-star" src="/luma-star.png" alt="" width={88} height={88} />
          <h1 id="landing-title">Luma</h1>
          <p className="landing-lede">
            Keep your notes in one easy place. Luma turns them into flashcards and quizzes.
          </p>
          <div className="landing-actions">
            <Link className="primary-button" to="/login">
              Log in
            </Link>
            <Link className="secondary-button" to="/signup">
              Make an account
            </Link>
          </div>
          <p className="landing-free hand-note">It's free to start!</p>
        </section>
        <NotePreview className="landing-preview" />
      </div>
    </main>
  )
}

function NotFoundPage() {
  return (
    <>
      <header className="page-head">
        <div>
          <h1>
            Page not <Scribble type="underline">found</Scribble>
          </h1>
          <p className="lede">We could not find that page.</p>
        </div>
      </header>
      <Link className="primary-button" to="/dashboard">
        Back to Home
      </Link>
    </>
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
