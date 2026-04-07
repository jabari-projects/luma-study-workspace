import type { ReactNode } from "react";
import { Navigate, Route, Routes, useLocation } from "react-router-dom";
import { Suspense, lazy, memo, useEffect } from "react";
import type { AuthUser } from "./api/api";
import DevFlowBadge from "./components/DevFlowBadge";
import Navbar from "./components/Navbar";
import RequireAdmin from "./components/RequireAdmin";
import ThemeToggle from "./components/ThemeToggle";
import { useAuth } from "./context/AuthContext";
import { isDevFlowTestingEnabled } from "./context/DevFlowTestingContext";
import { trackPageView } from "./lib/analytics";

const ChatUI = lazy(() => import("./features/chatbot/ChatUI"));
const Flashcards = lazy(() => import("./features/study/Flashcards"));
const ImageToNotes = lazy(() => import("./features/study/ImageToNotes"));
const StudySession = lazy(() => import("./features/study/StudySession"));
const VoiceInput = lazy(() => import("./features/study/VoiceInput"));
const AdminPersonasPage = lazy(() => import("./pages/AdminPersonas"));
const DashboardPage = lazy(() => import("./pages/DashboardPage"));
const DevFlowTestPage = lazy(() => import("./pages/DevFlowTestPage"));
const LandingPage = lazy(() => import("./pages/LandingPage"));
const LoginPage = lazy(() => import("./pages/LoginPage"));
const ForgotPasswordPage = lazy(() => import("./pages/ForgotPasswordPage"));
const NotFoundPage = lazy(() => import("./pages/NotFoundPage"));
const OnboardingPage = lazy(() => import("./pages/OnboardingPage"));
const ProfileSettingsPage = lazy(() => import("./pages/ProfileSettingsPage"));
const ProPage = lazy(() => import("./pages/ProPage"));
const ResetPasswordPage = lazy(() => import("./pages/ResetPasswordPage"));
const SearchPage = lazy(() => import("./pages/SearchPage"));
const SignupPage = lazy(() => import("./pages/SignupPage"));
const SubscribePage = lazy(() => import("./pages/Subscribe"));
const VerifyEmailPage = lazy(() => import("./pages/VerifyEmailPage"));

const FullScreenStatus = memo(function FullScreenStatus({
  message,
}: {
  message: string;
}) {
  return (
    <div
      style={{
        minHeight: "100vh",
        display: "grid",
        placeItems: "center",
        padding: 16,
      }}
    >
      <div
        style={{
          width: "100%",
          maxWidth: 420,
          padding: 16,
          borderRadius: 16,
          background: "var(--card)",
          boxShadow: "var(--shadow)",
          border: "1px solid var(--border)",
          textAlign: "center",
        }}
      >
        <div
          style={{
            width: 56,
            height: 56,
            margin: "0 auto 12px",
            borderRadius: "50%",
            border: "4px solid var(--surface-tint-soft)",
            borderTopColor: "var(--luma-accent)",
            animation: "luma-spin 0.9s linear infinite",
          }}
        />
        <p
          style={{
            margin: 0,
            fontSize: 16,
            color: "var(--luma-text-muted)",
          }}
        >
          {message}
        </p>
      </div>
    </div>
  );
});

function ProtectedRoute({ children }: { children: ReactNode }) {
  const { loading, isAuthenticated } = useAuth();
  const location = useLocation();

  if (loading) {
    return <FullScreenStatus message="Loading your workspace..." />;
  }

  if (!isAuthenticated) {
    const redirectTarget = `${location.pathname}${location.search}${location.hash}`;
    return (
      <Navigate
        to={`/login?redirect=${encodeURIComponent(redirectTarget)}`}
        replace
      />
    );
  }

  return <>{children}</>;
}

function requiresOnboarding(user: AuthUser | null) {
  return Boolean(
    user &&
      (user.display_name == null || user.theme_mode == null),
  );
}

function OnboardingRoute({ children }: { children: ReactNode }) {
  const { loading, isAuthenticated, user } = useAuth();
  const location = useLocation();

  if (loading) {
    return <FullScreenStatus message="Preparing your setup..." />;
  }

  if (!isAuthenticated) {
    const redirectTarget = `${location.pathname}${location.search}${location.hash}`;
    return (
      <Navigate
        to={`/login?redirect=${encodeURIComponent(redirectTarget)}`}
        replace
      />
    );
  }

  if (!requiresOnboarding(user)) {
    return <Navigate to="/dashboard" replace />;
  }

  return <>{children}</>;
}

function PublicOnlyRoute({ children }: { children: ReactNode }) {
  const { loading, isAuthenticated, user } = useAuth();

  if (loading) {
    return <FullScreenStatus message="Checking your session..." />;
  }

  if (isAuthenticated) {
    return (
      <Navigate
        to={requiresOnboarding(user) ? "/onboarding" : "/dashboard"}
        replace
      />
    );
  }

  return <>{children}</>;
}

export default function App() {
  const { loading, isAuthenticated, user } = useAuth();
  const location = useLocation();
  const devFlowTestingEnabled = isDevFlowTestingEnabled();
  const isAuthPage =
    location.pathname === "/login" ||
    location.pathname === "/signup" ||
    location.pathname === "/forgot-password" ||
    location.pathname === "/reset-password";
  const isOnboardingPage = location.pathname === "/onboarding";
  const isDevFlowPage = location.pathname === "/dev/test-flows";
  const isProPage = location.pathname === "/pro";
  const onboardingRequired = requiresOnboarding(user);
  const showNavbar =
    !loading &&
    isAuthenticated &&
    !isAuthPage &&
    !isOnboardingPage &&
    !onboardingRequired;
  const showFloatingThemeToggle = !loading && !isAuthenticated;

  useEffect(() => {
    trackPageView(`${location.pathname}${location.search}`, {
      subscriptionStatus: user?.subscription_status ?? null,
      metadata: {
        authenticated: isAuthenticated,
        onboarding_required: onboardingRequired,
      },
    });
  }, [
    isAuthenticated,
    location.pathname,
    location.search,
    onboardingRequired,
    user?.subscription_status,
  ]);

  if (
    !loading &&
    isAuthenticated &&
    onboardingRequired &&
    !isAuthPage &&
    !isOnboardingPage &&
    !isDevFlowPage &&
    !isProPage
  ) {
    return <Navigate to="/onboarding" replace />;
  }

  return (
    <>
      <style>
        {`
          @keyframes luma-spin {
            to {
              transform: rotate(360deg);
            }
          }
        `}
      </style>

      {showNavbar ? <Navbar /> : null}
      {showFloatingThemeToggle ? <ThemeToggle /> : null}
      <DevFlowBadge />

      {/* Deployment note: configure Vercel/Netlify SPA rewrites so deep links such
          as /dashboard, /settings, /search, and /verify-email all serve index.html. */}
      <div
        key={`${location.pathname}${location.search}${location.hash}`}
        className="luma-route-transition"
      >
        <Suspense fallback={<FullScreenStatus message="Loading page..." />}>
          <Routes>
        <Route path="/" element={<LandingPage />} />
        <Route path="/pro" element={<ProPage />} />
        {devFlowTestingEnabled ? (
          <Route path="/dev/test-flows" element={<DevFlowTestPage />} />
        ) : null}
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
          <Route
            path="/dashboard"
            element={
              <ProtectedRoute>
                <DashboardPage />
              </ProtectedRoute>
            }
          />
          <Route
            path="/onboarding"
            element={
              <OnboardingRoute>
                <OnboardingPage />
              </OnboardingRoute>
            }
          />
          <Route
            path="/subscribe"
            element={
              <ProtectedRoute>
                <SubscribePage />
              </ProtectedRoute>
            }
          />
          <Route
            path="/settings"
            element={
              <ProtectedRoute>
                <ProfileSettingsPage />
              </ProtectedRoute>
            }
          />
          <Route
            path="/verify-email"
            element={
              <ProtectedRoute>
                <VerifyEmailPage />
              </ProtectedRoute>
            }
          />
          <Route
            path="/admin/personas"
            element={
              <ProtectedRoute>
                <RequireAdmin>
                  <AdminPersonasPage />
                </RequireAdmin>
              </ProtectedRoute>
            }
          />
          <Route path="/profile" element={<Navigate to="/settings" replace />} />
          <Route
            path="/search"
            element={
              <ProtectedRoute>
                <SearchPage />
              </ProtectedRoute>
            }
          />
          <Route
            path="/chat"
            element={
              <ProtectedRoute>
                <ChatUI />
              </ProtectedRoute>
            }
          />
          <Route
            path="/flashcards"
            element={
              <ProtectedRoute>
                <Flashcards />
              </ProtectedRoute>
            }
          />
          <Route
            path="/image-to-notes"
            element={
              <ProtectedRoute>
                <ImageToNotes />
              </ProtectedRoute>
            }
          />
          <Route
            path="/voice-input"
            element={
              <ProtectedRoute>
                <VoiceInput />
              </ProtectedRoute>
            }
          />
          <Route
            path="/study-session"
            element={
              <ProtectedRoute>
                <StudySession />
              </ProtectedRoute>
            }
          />
          <Route path="*" element={<NotFoundPage />} />
          </Routes>
        </Suspense>
      </div>
      <footer
        style={{
          padding: 16,
          textAlign: "center",
          color: "var(--foreground-muted)",
          fontSize: 13,
        }}
      >
        {"\u00A9"} Luma. All rights reserved.
      </footer>
    </>
  );
}
