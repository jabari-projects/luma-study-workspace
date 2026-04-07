import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { api, getApiErrorMessage, type AuthUser } from "../api/api";
import { supabase } from "../api/supabase";
import ApiErrorBoundary from "../components/ApiErrorBoundary";
import PageSkeleton from "../components/PageSkeleton";
import SearchBar from "../components/SearchBar";
import { useAuth } from "../context/AuthContext";
import { useTheme } from "../context/ThemeContext";
import {
  getFlashcardCount,
  getWeeklyStudyTime,
  type AnalyticsFlashcard,
  type AnalyticsSession,
} from "../utils/analytics";
import { getUsernameAvatarLetter } from "../utils/avatar";

type DashboardFlashcard = AnalyticsFlashcard;

type DashboardStudySession = AnalyticsSession & {
  id: string;
};

type DashboardAiUsage = {
  id: string;
  type: "notes" | "transcription" | null;
};

function formatDurationLabel(totalSeconds: number) {
  const totalMinutes = Math.floor(totalSeconds / 60);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;

  if (hours <= 0) {
    return `${totalMinutes}m`;
  }

  return `${hours}h ${String(minutes).padStart(2, "0")}m`;
}

export default function DashboardPage() {
  const { logout, user } = useAuth();
  const { themeMode } = useTheme();
  const [profile, setProfile] = useState<AuthUser | null>(null);
  const [flashcards, setFlashcards] = useState<DashboardFlashcard[]>([]);
  const [studySessions, setStudySessions] = useState<DashboardStudySession[]>([]);
  const [aiUsage, setAiUsage] = useState<DashboardAiUsage[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [analyticsLoading, setAnalyticsLoading] = useState(true);
  const [analyticsError, setAnalyticsError] = useState("");

  async function loadProfile() {
    setLoading(true);
    setError("");

    try {
      const response = await api.get<AuthUser>("/me/profile");
      setProfile(response.data);
    } catch (loadError) {
      setError(getApiErrorMessage(loadError, "Unable to load your dashboard."));
    } finally {
      setLoading(false);
    }
  }

  async function loadAnalytics() {
    if (!user) {
      setFlashcards([]);
      setStudySessions([]);
      setAiUsage([]);
      setAnalyticsError("");
      setAnalyticsLoading(false);
      return;
    }

    if (!supabase) {
      setFlashcards([]);
      setStudySessions([]);
      setAiUsage([]);
      setAnalyticsError(
        "Study and AI analytics are unavailable until Supabase is configured.",
      );
      setAnalyticsLoading(false);
      return;
    }

    setAnalyticsLoading(true);
    setAnalyticsError("");

    try {
      const [flashcardsResponse, sessionsResponse, aiUsageResponse] =
        await Promise.all([
          supabase.from("flashcards").select("id").eq("user_id", user.id),
          supabase
            .from("study_sessions")
            .select("id, duration_seconds, created_at")
            .eq("user_id", user.id)
            .order("created_at", { ascending: false }),
          supabase.from("ai_usage").select("id, type").eq("user_id", user.id),
        ]);

      if (
        flashcardsResponse.error ||
        sessionsResponse.error ||
        aiUsageResponse.error
      ) {
        throw new Error(
          flashcardsResponse.error?.message ||
            sessionsResponse.error?.message ||
            aiUsageResponse.error?.message ||
            "Unable to load your dashboard analytics.",
        );
      }

      setFlashcards(
        (flashcardsResponse.data ?? []).map((row) => ({
          id: String(row.id ?? ""),
        })),
      );

      setStudySessions(
        (sessionsResponse.data ?? []).map((row) => ({
          id: String(row.id ?? ""),
          duration_seconds: Number(row.duration_seconds ?? 0),
          created_at:
            typeof row.created_at === "string" ? row.created_at : null,
        })),
      );

      setAiUsage(
        (aiUsageResponse.data ?? []).map((row) => ({
          id: String(row.id ?? ""),
          type:
            row.type === "notes" || row.type === "transcription"
              ? row.type
              : null,
        })),
      );
    } catch (analyticsLoadError) {
      setFlashcards([]);
      setStudySessions([]);
      setAiUsage([]);
      setAnalyticsError(
        analyticsLoadError instanceof Error
          ? analyticsLoadError.message
          : "Unable to load your dashboard analytics.",
      );
    } finally {
      setAnalyticsLoading(false);
    }
  }

  async function refreshData() {
    await loadAnalytics();
  }

  useEffect(() => {
    void loadProfile();
  }, []);

  useEffect(() => {
    void refreshData();
  }, [user?.id]);

  useEffect(() => {
    if (!supabase || !user) {
      return;
    }

    const realtimeClient = supabase;

    const flashcardsChannel = realtimeClient
      .channel("flashcards-changes")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "flashcards" },
        () => {
          void refreshData();
        },
      )
      .subscribe();

    const studySessionsChannel = realtimeClient
      .channel("study-sessions-changes")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "study_sessions" },
        () => {
          void refreshData();
        },
      )
      .subscribe();

    return () => {
      void realtimeClient.removeChannel(flashcardsChannel);
      void realtimeClient.removeChannel(studySessionsChannel);
    };
  }, [user?.id]);

  const isDarkMode = themeMode === "dark";
  const weeklyStudyTime = useMemo(
    () => getWeeklyStudyTime(studySessions),
    [studySessions],
  );
  const hasWeeklyStudyTime = weeklyStudyTime > 0;
  const flashcardCount = useMemo(
    () => getFlashcardCount(flashcards),
    [flashcards],
  );
  const totalStudySessions = studySessions.length;
  const aiNotesCount = useMemo(
    () => aiUsage.filter((item) => item.type === "notes").length,
    [aiUsage],
  );
  const transcriptionCount = useMemo(
    () => aiUsage.filter((item) => item.type === "transcription").length,
    [aiUsage],
  );

  const theme = useMemo(
    () =>
      isDarkMode
        ? {
            shell: "rgba(16, 13, 26, 0.76)",
            surface: "rgba(23, 19, 39, 0.92)",
            surfaceMuted: "rgba(31, 25, 53, 0.92)",
            border: "rgba(181, 155, 255, 0.22)",
            text: "#f6f2ff",
            textMuted: "#c8bedf",
            heroOverlay:
              "linear-gradient(135deg, rgba(16, 13, 26, 0.4), rgba(34, 26, 57, 0.82))",
            heroFallback:
              "linear-gradient(135deg, rgba(98, 73, 173, 0.88), rgba(35, 27, 58, 0.98))",
            pill: "rgba(255, 255, 255, 0.08)",
            shadow: "0 28px 90px rgba(0, 0, 0, 0.28)",
            cardShadow: "0 18px 44px rgba(0, 0, 0, 0.2)",
          }
        : {
            shell: "rgba(255, 255, 255, 0.34)",
            surface: "rgba(255, 255, 255, 0.92)",
            surfaceMuted: "rgba(248, 245, 255, 0.96)",
            border: "rgba(181, 155, 255, 0.24)",
            text: "#1d1730",
            textMuted: "#6a6284",
            heroOverlay:
              "linear-gradient(135deg, rgba(255, 255, 255, 0.38), rgba(76, 56, 135, 0.58))",
            heroFallback:
              "linear-gradient(135deg, rgba(181, 155, 255, 0.88), rgba(140, 111, 255, 0.92))",
            pill: "rgba(255, 255, 255, 0.7)",
            shadow: "0 28px 90px rgba(55, 38, 98, 0.14)",
            cardShadow: "0 18px 44px rgba(72, 53, 121, 0.12)",
          },
    [isDarkMode],
  );

  if (loading) {
    return <PageSkeleton variant="dashboard" />;
  }

  if (!profile) {
    return (
      <ApiErrorBoundary
        fullPage
        title="Dashboard unavailable"
        error={error || "We couldn't load your dashboard details right now."}
        onRetry={() => {
          void loadProfile();
        }}
        secondaryHref="/"
        secondaryLabel="Return home"
      />
    );
  }

  const displayName = profile.display_name || profile.username;
  const isPremium = user?.subscription_status === "premium";
  const planBadgeLabel = isPremium ? "Premium" : "Free";
  const quickLinks = [
    {
      title: "Workspace Settings",
      description: "Manage your theme, account preferences, and study setup.",
      to: "/settings",
      external: false,
    },
    {
      title: "Luma Chat",
      description:
        "Open your assistant workspace and shape study prompts with contextual tools.",
      to: "/chat",
      external: false,
    },
    {
      title: "Explore your tools",
      description: isPremium
        ? "Open your study search and move quickly between notes, flashcards, and tools."
        : "Open your study search now and unlock advanced filters with Premium.",
      to: "/search",
      external: false,
    },
  ];

  return (
    <div
      style={{
        minHeight: "100vh",
        padding: "32px 20px 48px",
      }}
    >
      <style>
        {`
          @keyframes luma-spin {
            to {
              transform: rotate(360deg);
            }
          }
        `}
      </style>

      <div
        style={{
          maxWidth: 1180,
          margin: "0 auto",
          display: "grid",
          gap: 24,
        }}
      >
        <section
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            gap: 20,
            flexWrap: "wrap",
            background: "var(--card)",
            border: "1px solid var(--border)",
            borderRadius: 16,
            padding: 20,
            boxShadow: "var(--shadow)",
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 16,
              flexWrap: "wrap",
            }}
          >
            {profile.avatar_url ? (
              <img
                src={profile.avatar_url}
                alt={`${displayName} avatar`}
                loading="lazy"
                decoding="async"
                style={{
                  width: 72,
                  height: 72,
                  borderRadius: "50%",
                  objectFit: "cover",
                  flexShrink: 0,
                  border: "2px solid rgba(181, 155, 255, 0.18)",
                }}
              />
            ) : (
              <div
                style={{
                  width: 72,
                  height: 72,
                  borderRadius: "50%",
                  display: "grid",
                  placeItems: "center",
                  background:
                    "linear-gradient(135deg, rgba(181, 155, 255, 0.95), rgba(140, 111, 255, 0.95))",
                  color: "#ffffff",
                  fontSize: 24,
                  fontWeight: 800,
                  flexShrink: 0,
                }}
              >
                {getUsernameAvatarLetter(profile.username)}
              </div>
            )}

            <div style={{ display: "grid", gap: 8 }}>
              <span
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  width: "fit-content",
                  padding: "8px 14px",
                  borderRadius: 999,
                  background: "rgba(181, 155, 255, 0.14)",
                  color: "var(--accent-strong)",
                  fontSize: 12,
                  fontWeight: 800,
                  letterSpacing: "0.05em",
                  textTransform: "uppercase",
                }}
              >
                Luma Dashboard
              </span>

              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 12,
                  flexWrap: "wrap",
                }}
              >
                <h1
                  style={{
                    margin: 0,
                    fontSize: "clamp(2rem, 4vw, 3rem)",
                    lineHeight: 1.05,
                    color: theme.text,
                  }}
                >
                  {displayName}
                </h1>

                <span
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 8,
                    padding: "8px 14px",
                    borderRadius: 999,
                    background: isPremium
                      ? "linear-gradient(135deg, #f4d36c, #d9a83c)"
                      : "rgba(181, 155, 255, 0.12)",
                    color: isPremium ? "#4f3a00" : theme.textMuted,
                    border: isPremium
                      ? "1px solid rgba(217, 168, 60, 0.32)"
                      : "1px solid var(--border)",
                    fontSize: 13,
                    fontWeight: 800,
                  }}
                >
                  {isPremium ? "⭐" : null}
                  {planBadgeLabel}
                </span>
              </div>

              <p
                style={{
                  margin: 0,
                  color: theme.textMuted,
                  fontSize: 15,
                  fontWeight: 700,
                }}
              >
                Your workspace is private and built only for you.
              </p>
              <p
                style={{
                  margin: 0,
                  color: theme.textMuted,
                  fontSize: 15,
                  lineHeight: 1.6,
                }}
              >
                {isPremium
                  ? "Premium is active on your account, so your advanced tools are ready to go."
                  : "You are on the free plan. Upgrade anytime to unlock advanced study tools and enhanced features."}
              </p>
            </div>
          </div>

          <div
            style={{
              display: "grid",
              gap: 10,
              justifyItems: "end",
            }}
          >
            <div style={{ textAlign: "right" }}>
              <p
                style={{
                  margin: "0 0 6px",
                  color: theme.textMuted,
                  fontSize: 13,
                  fontWeight: 700,
                  textTransform: "uppercase",
                  letterSpacing: "0.05em",
                }}
              >
                Signed in as
              </p>
              <p
                style={{
                  margin: 0,
                  color: theme.text,
                  fontSize: 16,
                  fontWeight: 700,
                  wordBreak: "break-word",
                }}
              >
                {profile.email}
              </p>
            </div>

            <button
              type="button"
              onClick={logout}
              style={{
                border: "1px solid var(--border)",
                background: "var(--card)",
                color: theme.text,
                borderRadius: 16,
                padding: "12px 16px",
                fontWeight: 700,
                cursor: "pointer",
                boxShadow: "var(--shadow)",
              }}
            >
              Logout
            </button>
          </div>
        </section>

        {user && !user.email_verified ? (
          <section
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 18,
              flexWrap: "wrap",
              padding: "18px 20px",
              borderRadius: 24,
              background: "rgba(181, 155, 255, 0.1)",
              border: `1px solid ${theme.border}`,
              boxShadow: theme.cardShadow,
            }}
          >
            <div style={{ display: "grid", gap: 6 }}>
              <strong
                style={{
                  color: theme.text,
                  fontSize: 16,
                }}
              >
                Your email is still unverified
              </strong>
              <span
                style={{
                  color: theme.textMuted,
                  lineHeight: 1.6,
                }}
              >
                Verify {user.email} to confirm account ownership and stay ready
                for upcoming account security features.
              </span>
            </div>

            <Link
              to="/verify-email"
              style={{
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                minHeight: 48,
                padding: "0 18px",
                borderRadius: 16,
                textDecoration: "none",
                background: "linear-gradient(135deg, var(--accent-strong), var(--accent))",
                color: "#ffffff",
                fontWeight: 700,
                boxShadow: "0 18px 36px rgba(140, 111, 255, 0.26)",
              }}
            >
              Verify email
            </Link>
          </section>
        ) : null}

        {!isPremium ? (
          <section
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              gap: 20,
              flexWrap: "wrap",
              background: "var(--card)",
              border: "1px solid var(--border)",
              borderRadius: 16,
              padding: 20,
              boxShadow: "var(--shadow)",
            }}
          >
            <div style={{ display: "grid", gap: 8 }}>
              <h2
                style={{
                  margin: 0,
                  color: theme.text,
                  fontSize: 24,
                }}
              >
                Upgrade to Premium
              </h2>
              <p
                style={{
                  margin: 0,
                  color: theme.textMuted,
                  lineHeight: 1.6,
                }}
              >
                Unlock advanced study tools and enhanced features
              </p>
            </div>

            <Link
              to="/subscribe"
              style={{
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                minHeight: 48,
                padding: "0 18px",
                borderRadius: 16,
                textDecoration: "none",
                background: "linear-gradient(135deg, var(--accent-strong), var(--accent))",
                color: "#ffffff",
                fontWeight: 700,
                boxShadow: "var(--shadow)",
              }}
            >
              View plans
            </Link>
          </section>
        ) : null}

        <section
          style={{
            display: "grid",
            gap: 16,
          }}
        >
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "end",
              gap: 16,
              flexWrap: "wrap",
            }}
          >
            <div style={{ display: "grid", gap: 8 }}>
              <h2
                style={{
                  margin: 0,
                  color: theme.text,
                  fontSize: 28,
                }}
              >
                Study analytics
              </h2>
              <p
                style={{
                  margin: 0,
                  color: theme.textMuted,
                  lineHeight: 1.6,
                }}
              >
                Track your study momentum across time, flashcards, and completed
                sessions.
              </p>
            </div>

            <p
              style={{
                margin: "8px 0 0",
                fontSize: "0.9rem",
                color: "var(--foreground-muted)",
              }}
            >
              Keep going! You're doing great.
            </p>
          </div>

          {analyticsError ? (
            <div
              style={{
                padding: "16px",
                borderRadius: 16,
                background: "rgba(226, 120, 145, 0.12)",
                border: "1px solid rgba(226, 120, 145, 0.28)",
                color: "#b63d61",
              }}
            >
              {analyticsError}
            </div>
          ) : null}

          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
              gap: 16,
            }}
          >
            {[
              {
                label: "Study Time This Week",
                value: analyticsLoading
                  ? "Loading..."
                  : analyticsError
                    ? "--"
                    : formatDurationLabel(weeklyStudyTime),
                detail:
                  !analyticsLoading && !analyticsError && !hasWeeklyStudyTime
                    ? "No study time recorded this week."
                    : "Recorded completed study time for the last 7 days.",
              },
              {
                label: "Flashcards Created",
                value: analyticsLoading
                  ? "Loading..."
                  : analyticsError
                    ? "--"
                    : String(flashcardCount),
                detail:
                  !analyticsLoading && !analyticsError && flashcardCount === 0
                    ? "No flashcards yet."
                    : "Flashcards Created: " + String(flashcardCount),
              },
              {
                label: "Study Sessions Completed",
                value: analyticsLoading
                  ? "Loading..."
                  : analyticsError
                    ? "--"
                    : String(totalStudySessions),
                detail:
                  !analyticsLoading &&
                  !analyticsError &&
                  totalStudySessions === 0
                    ? "No study sessions yet."
                    : "Study Sessions Completed: " +
                      String(totalStudySessions),
              },
              {
                label: "AI Notes Generated",
                value: analyticsLoading
                  ? "Loading..."
                  : analyticsError
                    ? "--"
                    : String(aiNotesCount),
                detail:
                  !analyticsLoading && !analyticsError && aiNotesCount === 0
                    ? "No AI usage yet."
                    : "AI Notes Generated: " + String(aiNotesCount),
              },
              {
                label: "Transcriptions Processed",
                value: analyticsLoading
                  ? "Loading..."
                  : analyticsError
                    ? "--"
                    : String(transcriptionCount),
                detail:
                  !analyticsLoading &&
                  !analyticsError &&
                  transcriptionCount === 0
                    ? "No AI usage yet."
                    : "Transcriptions Processed: " +
                      String(transcriptionCount),
              },
            ].map((metric) => (
              <article
                key={metric.label}
                style={{
                  background: "var(--card)",
                  border: "1px solid var(--border)",
                  borderRadius: 16,
                  padding: 20,
                  boxShadow: "var(--shadow)",
                  display: "grid",
                  gap: 10,
                }}
              >
                <p
                  style={{
                    margin: 0,
                    color: theme.textMuted,
                    fontSize: 13,
                    fontWeight: 700,
                    textTransform: "uppercase",
                    letterSpacing: "0.04em",
                  }}
                >
                  {metric.label}
                </p>
                <p
                  style={{
                    margin: 0,
                    color: theme.text,
                    fontSize: 28,
                    fontWeight: 800,
                  }}
                >
                  {metric.value}
                </p>
                <p
                  style={{
                    margin: 0,
                    color: theme.textMuted,
                    fontSize: 14,
                    lineHeight: 1.6,
                  }}
                >
                  {metric.detail}
                </p>
              </article>
            ))}
          </div>
        </section>

        <section
          style={{
            position: "relative",
            overflow: "hidden",
            borderRadius: 32,
            minHeight: 320,
            padding: "28px clamp(20px, 4vw, 36px)",
            backgroundImage: profile.custom_theme_image_url
              ? `${theme.heroOverlay}, url(${profile.custom_theme_image_url})`
              : theme.heroFallback,
            backgroundSize: "cover",
            backgroundPosition: "center",
            border: `1px solid ${theme.border}`,
            boxShadow: theme.shadow,
          }}
        >
          <div
            style={{
              position: "absolute",
              inset: "auto -100px -120px auto",
              width: 260,
              height: 260,
              borderRadius: "50%",
              background: "rgba(255, 255, 255, 0.12)",
              filter: "blur(8px)",
            }}
          />

          <div
            style={{
              position: "relative",
              zIndex: 1,
              display: "grid",
              gap: 24,
              gridTemplateColumns: "minmax(0, 1.6fr) minmax(260px, 340px)",
              alignItems: "end",
            }}
          >
            <div
              style={{
                display: "grid",
                gap: 16,
              }}
            >
              <div
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 10,
                  padding: "10px 14px",
                  borderRadius: 999,
                  width: "fit-content",
                  background: "rgba(255, 255, 255, 0.18)",
                  color: "#ffffff",
                  border: "1px solid rgba(255, 255, 255, 0.18)",
                  backdropFilter: "blur(14px)",
                }}
              >
                <span
                  style={{
                    width: 10,
                    height: 10,
                    borderRadius: "50%",
                    background: "var(--accent)",
                    boxShadow: "0 0 0 6px rgba(181, 155, 255, 0.18)",
                  }}
                />
                {themeMode === "dark" ? "Dark theme active" : "Light theme active"}
              </div>

              <div>
                <h2
                  style={{
                    margin: 0,
                    color: "#ffffff",
                    fontSize: "clamp(2rem, 5vw, 3.4rem)",
                    lineHeight: 1.02,
                    textShadow: "0 10px 32px rgba(0, 0, 0, 0.18)",
                  }}
                >
                  {displayName}
                </h2>
                <p
                  style={{
                    margin: "12px 0 0",
                    color: "rgba(255, 255, 255, 0.92)",
                    maxWidth: 520,
                    fontSize: 16,
                    lineHeight: 1.7,
                  }}
                >
                  Your workspace is ready to update settings, personalize
                  themes, and keep your study flow organized in Luma.
                </p>
              </div>
            </div>

            <div
              style={{
                justifySelf: "end",
                width: "100%",
                maxWidth: 320,
                padding: 20,
                borderRadius: 28,
                background: "rgba(16, 13, 26, 0.26)",
                border: "1px solid rgba(255, 255, 255, 0.14)",
                backdropFilter: "blur(14px)",
                color: "#ffffff",
              }}
            >
              <div style={{ display: "grid", gap: 8 }}>
                <p style={{ margin: 0, fontSize: 14, opacity: 0.84 }}>
                  Workspace snapshot
                </p>
                <p
                  style={{
                    margin: 0,
                    fontSize: 24,
                    fontWeight: 700,
                  }}
                >
                  {isPremium ? "Premium plan" : "Free plan"}
                </p>
                <p
                  style={{
                    margin: 0,
                    fontSize: 14,
                    lineHeight: 1.6,
                    color: "rgba(255, 255, 255, 0.84)",
                    wordBreak: "break-word",
                  }}
                >
                  {profile.email}
                </p>
              </div>

              <div
                style={{
                  marginTop: 18,
                  display: "grid",
                  gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
                  gap: 12,
                }}
              >
                <div
                  style={{
                    padding: "12px 14px",
                    borderRadius: 18,
                    background: "rgba(255, 255, 255, 0.08)",
                  }}
                >
                  <p style={{ margin: "0 0 6px", fontSize: 12, opacity: 0.72 }}>
                    Timezone
                  </p>
                  <p style={{ margin: 0, fontWeight: 700 }}>
                    {profile.timezone || "Not set"}
                  </p>
                </div>
                <div
                  style={{
                    padding: "12px 14px",
                    borderRadius: 18,
                    background: "rgba(255, 255, 255, 0.08)",
                  }}
                >
                  <p style={{ margin: "0 0 6px", fontSize: 12, opacity: 0.72 }}>
                    Theme mode
                  </p>
                  <p style={{ margin: 0, fontWeight: 700 }}>
                    {themeMode === "dark" ? "Dark" : "Light"}
                  </p>
                </div>
                <div
                  style={{
                    padding: "12px 14px",
                    borderRadius: 18,
                    background: "rgba(255, 255, 255, 0.08)",
                    gridColumn: "1 / -1",
                  }}
                >
                  <p style={{ margin: "0 0 6px", fontSize: 12, opacity: 0.72 }}>
                    Email status
                  </p>
                  <p style={{ margin: 0, fontWeight: 700 }}>
                    {user?.email_verified ? "Verified" : "Needs verification"}
                  </p>
                </div>
              </div>
            </div>
          </div>
        </section>

        <section
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
            gap: 18,
          }}
        >
          {quickLinks.map((item) =>
            item.external ? (
              <a
                key={item.title}
                href={item.to}
                style={{
                  textDecoration: "none",
                  color: "inherit",
                }}
              >
                <article
                  style={{
                    height: "100%",
                    borderRadius: 26,
                    background: theme.surface,
                    border: `1px solid ${theme.border}`,
                    boxShadow: theme.cardShadow,
                    padding: "22px 20px",
                  }}
                >
                  <div
                    style={{
                      width: 44,
                      height: 44,
                      display: "grid",
                      placeItems: "center",
                      borderRadius: 14,
                      background: "rgba(181, 155, 255, 0.14)",
                      color: "var(--accent-strong)",
                      fontWeight: 800,
                      marginBottom: 16,
                    }}
                  >
                    {item.title.slice(0, 1)}
                  </div>
                  <h3
                    style={{
                      margin: "0 0 8px",
                      color: theme.text,
                      fontSize: 18,
                    }}
                  >
                    {item.title}
                  </h3>
                  <p
                    style={{
                      margin: 0,
                      color: theme.textMuted,
                      lineHeight: 1.6,
                      fontSize: 14,
                    }}
                  >
                    {item.description}
                  </p>
                </article>
              </a>
            ) : (
              <Link
                key={item.title}
                to={item.to}
                style={{
                  textDecoration: "none",
                  color: "inherit",
                }}
              >
                <article
                  style={{
                    height: "100%",
                    borderRadius: 26,
                    background: theme.surface,
                    border: `1px solid ${theme.border}`,
                    boxShadow: theme.cardShadow,
                    padding: "22px 20px",
                  }}
                >
                  <div
                    style={{
                      width: 44,
                      height: 44,
                      display: "grid",
                      placeItems: "center",
                      borderRadius: 14,
                      background: "rgba(181, 155, 255, 0.14)",
                      color: "var(--accent-strong)",
                      fontWeight: 800,
                      marginBottom: 16,
                    }}
                  >
                    {item.title.slice(0, 1)}
                  </div>
                  <h3
                    style={{
                      margin: "0 0 8px",
                      color: theme.text,
                      fontSize: 18,
                    }}
                  >
                    {item.title}
                  </h3>
                  <p
                    style={{
                      margin: 0,
                      color: theme.textMuted,
                      lineHeight: 1.6,
                      fontSize: 14,
                    }}
                  >
                    {item.description}
                  </p>
                </article>
              </Link>
            ),
          )}
        </section>

        <section id="search-workspace">
          <section
            style={{
              borderRadius: 32,
              background: theme.surface,
              border: `1px solid ${theme.border}`,
              boxShadow: theme.shadow,
              padding: "28px clamp(20px, 4vw, 32px)",
            }}
          >
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                gap: 18,
                alignItems: "end",
                flexWrap: "wrap",
                marginBottom: 22,
              }}
            >
              <div>
                <h2 style={{ margin: "0 0 8px", color: theme.text, fontSize: 28 }}>
                  Search your notes
                </h2>
                <p
                  style={{
                    margin: 0,
                    color: theme.textMuted,
                    lineHeight: 1.6,
                  }}
                >
                  Search notes, flashcards, study sessions, summaries, and
                  transcripts from one calm workspace.
                </p>
              </div>
              <span
                style={{
                  padding: "9px 14px",
                  borderRadius: 999,
                  background: "rgba(181, 155, 255, 0.14)",
                  color: "var(--accent-strong)",
                  fontSize: 13,
                  fontWeight: 700,
                }}
              >
                Private search
              </span>
            </div>

            <SearchBar />
          </section>
        </section>
      </div>
    </div>
  );
}
