import { useEffect, useMemo, useState } from "react";
import { supabase } from "../../api/supabase";
import RequireSubscription from "../../components/RequireSubscription";
import { useAuth } from "../../context/AuthContext";
import { trackFeatureUsage } from "../../lib/analytics";

const SESSION_DURATION_SECONDS = 25 * 60;

type StudySessionRecord = {
  id: string;
  duration_seconds: number;
  created_at: string | null;
};

const studySessionStyles = `
  .luma-study-session {
    min-height: 100vh;
    padding: 16px;
  }

  .luma-study-session__wrap {
    max-width: 980px;
    margin: 0 auto;
    display: grid;
    gap: 12px;
  }

  .luma-study-session__panel {
    background: var(--card);
    border: 1px solid var(--border);
    border-radius: 16px;
    padding: 20px;
    box-shadow: var(--shadow);
  }

  .luma-study-session__hero,
  .luma-study-session__section {
    display: grid;
    gap: 12px;
  }

  .luma-study-session__eyebrow {
    display: inline-flex;
    align-items: center;
    width: fit-content;
    padding: 8px 14px;
    border-radius: 999px;
    background: rgba(181, 155, 255, 0.14);
    color: var(--accent-strong);
    font-size: 12px;
    font-weight: 800;
    letter-spacing: 0.05em;
    text-transform: uppercase;
  }

  .luma-study-session__title {
    margin: 0;
    color: var(--foreground);
    font-size: clamp(2rem, 4vw, 3rem);
    line-height: 1.05;
  }

  .luma-study-session__copy,
  .luma-study-session__sectionCopy,
  .luma-study-session__summaryText {
    margin: 0;
    color: var(--foreground-muted);
    line-height: 1.6;
  }

  .luma-study-session__timerShell {
    display: grid;
    gap: 12px;
  }

  .luma-study-session__timerValue {
    margin: 0;
    color: var(--foreground);
    font-size: clamp(3rem, 7vw, 4.8rem);
    line-height: 1;
    letter-spacing: -0.05em;
  }

  .luma-study-session__statusRow {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    flex-wrap: wrap;
  }

  .luma-study-session__statusBadge {
    display: inline-flex;
    align-items: center;
    gap: 10px;
    padding: 8px 14px;
    border-radius: 999px;
    border: 1px solid var(--border);
    background: rgba(181, 155, 255, 0.08);
    color: var(--foreground);
    font-size: 14px;
    font-weight: 700;
  }

  .luma-study-session__statusDot {
    width: 10px;
    height: 10px;
    border-radius: 999px;
    background: #8c6fff;
  }

  .luma-study-session__statusDot.is-running {
    background: #6cd6a8;
    box-shadow: 0 0 0 6px rgba(108, 214, 168, 0.16);
  }

  .luma-study-session__progressTrack {
    width: 100%;
    height: 16px;
    border-radius: 999px;
    overflow: hidden;
    background: rgba(181, 155, 255, 0.12);
    border: 1px solid var(--border);
  }

  .luma-study-session__progressFill {
    height: 100%;
    border-radius: inherit;
    background: linear-gradient(135deg, var(--accent-strong), var(--accent));
    transition: width 220ms ease;
  }

  .luma-study-session__controls {
    display: flex;
    flex-wrap: wrap;
    gap: 12px;
  }

  .luma-study-session__button,
  .luma-study-session__buttonSecondary {
    min-height: 48px;
    padding: 0 18px;
    border-radius: 16px;
    font-size: 15px;
    font-weight: 700;
    cursor: pointer;
  }

  .luma-study-session__button {
    border: none;
    background: linear-gradient(135deg, var(--accent-strong), var(--accent));
    color: #ffffff;
    box-shadow: var(--shadow);
  }

  .luma-study-session__buttonSecondary {
    border: 1px solid var(--border);
    background: var(--card);
    color: var(--foreground);
    box-shadow: var(--shadow);
  }

  .luma-study-session__button:disabled,
  .luma-study-session__buttonSecondary:disabled {
    cursor: not-allowed;
    opacity: 0.65;
  }

  .luma-study-session__stats {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
    gap: 12px;
  }

  .luma-study-session__statCard {
    border-radius: 16px;
    border: 1px solid var(--border);
    background: var(--card);
    padding: 20px;
    box-shadow: var(--shadow);
    display: grid;
    gap: 8px;
  }

  .luma-study-session__statLabel {
    margin: 0;
    color: var(--foreground-muted);
    font-size: 13px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }

  .luma-study-session__statValue {
    margin: 0;
    color: var(--foreground);
    font-size: 24px;
    font-weight: 800;
  }

  .luma-study-session__summary {
    display: grid;
    gap: 12px;
  }

  .luma-study-session__summaryCard {
    border-radius: 16px;
    border: 1px solid rgba(108, 214, 168, 0.28);
    background: rgba(108, 214, 168, 0.12);
    padding: 20px;
    display: grid;
    gap: 12px;
  }

  .luma-study-session__history {
    display: grid;
    gap: 12px;
  }

  .luma-study-session__historyList {
    display: grid;
    gap: 12px;
  }

  .luma-study-session__historyItem {
    border-radius: 16px;
    border: 1px solid var(--border);
    background: var(--card);
    padding: 20px;
    box-shadow: var(--shadow);
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    flex-wrap: wrap;
  }

  .luma-study-session__historyValue,
  .luma-study-session__historyMeta {
    margin: 0;
  }

  .luma-study-session__historyValue {
    color: var(--foreground);
    font-size: 18px;
    font-weight: 800;
  }

  .luma-study-session__historyMeta {
    color: var(--foreground-muted);
    line-height: 1.6;
  }

  .luma-study-session__empty,
  .luma-study-session__loading {
    border-radius: 16px;
    border: 1px dashed var(--border);
    background: var(--card);
    padding: 20px;
    color: var(--foreground-muted);
    line-height: 1.6;
  }

  .luma-study-session__error {
    margin: 0;
    border-radius: 16px;
    border: 1px solid rgba(226, 120, 145, 0.28);
    background: rgba(226, 120, 145, 0.12);
    color: #b63d61;
    padding: 16px;
    line-height: 1.5;
  }
`;

function formatTime(totalSeconds: number) {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function formatHistoryDate(value: string | null) {
  if (!value) {
    return "Saved recently";
  }

  const parsedDate = new Date(value);

  if (Number.isNaN(parsedDate.getTime())) {
    return "Saved recently";
  }

  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(parsedDate);
}

function getStartOfWeek(referenceDate = new Date()) {
  const start = new Date(referenceDate);
  const day = start.getDay();
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - day);
  return start;
}

function StudySessionTool() {
  const { user } = useAuth();
  const [remainingSeconds, setRemainingSeconds] = useState(SESSION_DURATION_SECONDS);
  const [isRunning, setIsRunning] = useState(false);
  const [completedSeconds, setCompletedSeconds] = useState(0);
  const [isComplete, setIsComplete] = useState(false);
  const [history, setHistory] = useState<StudySessionRecord[]>([]);
  const [loadingHistory, setLoadingHistory] = useState(true);
  const [savingSession, setSavingSession] = useState(false);
  const [historyError, setHistoryError] = useState("");
  const [hasSavedCompletion, setHasSavedCompletion] = useState(false);

  const supabaseConfigError = !supabase
    ? "Supabase is not configured. Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY to save study session history."
    : "";

  useEffect(() => {
    if (!isRunning) {
      return;
    }

    const intervalId = window.setInterval(() => {
      setRemainingSeconds((current) => {
        if (current <= 1) {
          window.clearInterval(intervalId);
          setIsRunning(false);
          setIsComplete(true);
          return 0;
        }

        return current - 1;
      });
    }, 1000);

    return () => {
      window.clearInterval(intervalId);
    };
  }, [isRunning]);

  useEffect(() => {
    const spent = SESSION_DURATION_SECONDS - remainingSeconds;
    setCompletedSeconds(spent);
  }, [remainingSeconds]);

  useEffect(() => {
    if (!user) {
      setHistory([]);
      setLoadingHistory(false);
      return;
    }

    void fetchStudySessions();
  }, [user?.id]);

  useEffect(() => {
    if (!isComplete || completedSeconds <= 0 || hasSavedCompletion) {
      return;
    }

    setHasSavedCompletion(true);
    void saveCompletedSession(completedSeconds);
  }, [completedSeconds, hasSavedCompletion, isComplete]);

  const progressPercent = useMemo(() => {
    return (completedSeconds / SESSION_DURATION_SECONDS) * 100;
  }, [completedSeconds]);

  const totalTimeThisWeek = useMemo(() => {
    const startOfWeek = getStartOfWeek();

    return history.reduce((total, session) => {
      if (!session.created_at) {
        return total;
      }

      const createdAt = new Date(session.created_at);

      if (Number.isNaN(createdAt.getTime()) || createdAt < startOfWeek) {
        return total;
      }

      return total + session.duration_seconds;
    }, 0);
  }, [history]);

  async function fetchStudySessions() {
    if (!user) {
      return;
    }

    if (!supabase) {
      setHistoryError(supabaseConfigError);
      setLoadingHistory(false);
      return;
    }

    setLoadingHistory(true);
    setHistoryError("");

    const { data, error } = await supabase
      .from("study_sessions")
      .select("*")
      .eq("user_id", user.id)
      .order("created_at", { ascending: false });

    if (error) {
      setHistoryError(
        error.message || "Unable to load your study session history right now.",
      );
      setLoadingHistory(false);
      return;
    }

    setHistory(
      (data ?? []).map((row) => ({
        id: String(row.id ?? ""),
        duration_seconds: Number(row.duration_seconds ?? 0),
        created_at:
          typeof row.created_at === "string" ? row.created_at : null,
      })),
    );
    setLoadingHistory(false);
  }

  async function saveCompletedSession(durationSeconds: number) {
    if (!user) {
      setHistoryError("Sign in to save study sessions.");
      return;
    }

    if (!supabase) {
      setHistoryError(supabaseConfigError);
      return;
    }

    setSavingSession(true);
    setHistoryError("");

    const { error } = await supabase.from("study_sessions").insert([
      {
        user_id: user.id,
        duration_seconds: durationSeconds,
      },
    ]);

    if (error) {
      setSavingSession(false);
      setHistoryError(
        error.message || "Unable to save this study session right now.",
      );
      return;
    }

    await fetchStudySessions();
    trackFeatureUsage("study-session", {
      surface: "study_tool",
      subscriptionStatus: user?.subscription_status ?? null,
      metadata: {
        action: "complete_session",
        result: "success",
        duration_seconds: durationSeconds,
      },
    });
    setSavingSession(false);
  }

  function handleStart() {
    if (remainingSeconds === 0) {
      return;
    }

    setIsRunning(true);
    setIsComplete(false);
  }

  function handlePause() {
    setIsRunning(false);
  }

  function handleReset() {
    setIsRunning(false);
    setIsComplete(false);
    setRemainingSeconds(SESSION_DURATION_SECONDS);
    setCompletedSeconds(0);
    setHasSavedCompletion(false);
    setHistoryError("");
  }

  return (
    <>
      <style>{studySessionStyles}</style>

      <main className="luma-study-session">
        <div className="luma-study-session__wrap">
          <section className="luma-study-session__panel luma-study-session__hero">
            <span className="luma-study-session__eyebrow">Study Tools</span>
            <h1 className="luma-study-session__title">Study Session</h1>
            <p className="luma-study-session__copy">
              Run a focused study block with a simple session timer, visible
              progress, and synced session history once each block is complete.
            </p>
          </section>

          <section className="luma-study-session__panel luma-study-session__section">
            <div>
              <h2
                style={{
                  margin: 0,
                  color: "var(--foreground)",
                  fontSize: 22,
                }}
              >
                Session timer
              </h2>
              <p className="luma-study-session__sectionCopy">
                This session runs for 25 minutes by default, tracks your
                progress, and saves completed blocks to Supabase.
              </p>
            </div>

            <div className="luma-study-session__timerShell">
              <div className="luma-study-session__statusRow">
                <p className="luma-study-session__timerValue">
                  {formatTime(remainingSeconds)}
                </p>
                <span className="luma-study-session__statusBadge">
                  <span
                    className={`luma-study-session__statusDot${
                      isRunning ? " is-running" : ""
                    }`}
                  />
                  {isComplete
                    ? "Session complete"
                    : isRunning
                      ? "Running"
                      : "Paused"}
                </span>
              </div>

              <div className="luma-study-session__progressTrack" aria-hidden="true">
                <div
                  className="luma-study-session__progressFill"
                  style={{ width: `${progressPercent}%` }}
                />
              </div>

              <div className="luma-study-session__controls">
                <button
                  className="luma-study-session__button"
                  type="button"
                  onClick={handleStart}
                  disabled={isRunning || remainingSeconds === 0}
                >
                  Start
                </button>
                <button
                  className="luma-study-session__buttonSecondary"
                  type="button"
                  onClick={handlePause}
                  disabled={!isRunning}
                >
                  Pause
                </button>
                <button
                  className="luma-study-session__buttonSecondary"
                  type="button"
                  onClick={handleReset}
                >
                  Reset
                </button>
              </div>
            </div>
          </section>

          <section className="luma-study-session__stats">
            <article className="luma-study-session__statCard">
              <p className="luma-study-session__statLabel">Time Spent</p>
              <p className="luma-study-session__statValue">
                {formatTime(completedSeconds)}
              </p>
            </article>
            <article className="luma-study-session__statCard">
              <p className="luma-study-session__statLabel">Progress</p>
              <p className="luma-study-session__statValue">
                {Math.round(progressPercent)}%
              </p>
            </article>
            <article className="luma-study-session__statCard">
              <p className="luma-study-session__statLabel">Session Length</p>
              <p className="luma-study-session__statValue">
                {formatTime(SESSION_DURATION_SECONDS)}
              </p>
            </article>
            <article className="luma-study-session__statCard">
              <p className="luma-study-session__statLabel">This Week</p>
              <p className="luma-study-session__statValue">
                {formatTime(totalTimeThisWeek)}
              </p>
            </article>
          </section>

          <section className="luma-study-session__panel luma-study-session__history">
            <div>
              <h2
                style={{
                  margin: 0,
                  color: "var(--foreground)",
                  fontSize: 22,
                }}
              >
                Session History
              </h2>
              <p className="luma-study-session__sectionCopy">
                Review your recent completed sessions and keep an eye on your
                weekly study time.
              </p>
            </div>

            {historyError ? (
              <p className="luma-study-session__error" role="alert">
                {historyError}
              </p>
            ) : null}

            {loadingHistory ? (
              <div className="luma-study-session__loading">
                Loading your study session history...
              </div>
            ) : history.length === 0 ? (
              <div className="luma-study-session__empty">
                No completed sessions yet. Finish a study block to start building
                your history.
              </div>
            ) : (
              <div className="luma-study-session__historyList">
                {history.map((session) => (
                  <article key={session.id} className="luma-study-session__historyItem">
                    <div style={{ display: "grid", gap: 8 }}>
                      <p className="luma-study-session__historyValue">
                        {formatTime(session.duration_seconds)}
                      </p>
                      <p className="luma-study-session__historyMeta">
                        {formatHistoryDate(session.created_at)}
                      </p>
                    </div>
                    <span className="luma-study-session__statusBadge">
                      Completed session
                    </span>
                  </article>
                ))}
              </div>
            )}
          </section>

          {isComplete ? (
            <section className="luma-study-session__panel luma-study-session__summary">
              <div>
                <h2
                  style={{
                    margin: 0,
                    color: "var(--foreground)",
                    fontSize: 22,
                  }}
                >
                  Session summary
                </h2>
                <p className="luma-study-session__sectionCopy">
                  Your study block finished successfully.
                </p>
              </div>

              <div className="luma-study-session__summaryCard">
                <p
                  style={{
                    margin: 0,
                    color: "#2f7f64",
                    fontSize: 18,
                    fontWeight: 800,
                  }}
                >
                  Nice work. You spent {formatTime(completedSeconds)} focused on
                  this session.
                </p>
                <p className="luma-study-session__summaryText">
                  {savingSession
                    ? "Saving this session to your study history now."
                    : "Reset the timer whenever you're ready for another study block."}
                </p>
              </div>
            </section>
          ) : null}
        </div>
      </main>
    </>
  );
}

export default function StudySession() {
  return (
    <RequireSubscription
      featureName="Study Session"
      title="Study Session is for Premium members"
      description="Upgrade to unlock guided sessions, saved history, and deeper study tracking."
    >
      <StudySessionTool />
    </RequireSubscription>
  );
}
