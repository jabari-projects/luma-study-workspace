import { useMemo, useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { api, getApiErrorMessage, type AuthResponse } from "../api/api";
import { useAuth } from "../context/AuthContext";
import { useDevFlowTesting } from "../context/DevFlowTestingContext";

type TestCredentials = {
  email: string;
  username: string;
  password: string;
};

const pageStyles = `
  .luma-dev-flows {
    min-height: 100vh;
    padding: 24px 16px 48px;
    background:
      radial-gradient(circle at top left, rgba(181, 155, 255, 0.14), transparent 34%),
      var(--background);
  }

  .luma-dev-flows__shell {
    width: min(1120px, 100%);
    margin: 0 auto;
    display: grid;
    gap: 16px;
  }

  .luma-dev-flows__hero,
  .luma-dev-flows__card {
    background: var(--card);
    border: 1px solid var(--border);
    border-radius: 20px;
    box-shadow: var(--shadow);
  }

  .luma-dev-flows__hero {
    padding: 20px;
  }

  .luma-dev-flows__eyebrow {
    margin: 0 0 8px;
    color: var(--accent-strong);
    font-size: 0.76rem;
    font-weight: 800;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }

  .luma-dev-flows__title {
    margin: 0;
    color: var(--foreground);
    font-size: clamp(2rem, 4vw, 2.8rem);
    letter-spacing: -0.04em;
  }

  .luma-dev-flows__copy {
    margin: 12px 0 0;
    max-width: 760px;
    color: var(--foreground-muted);
    line-height: 1.7;
  }

  .luma-dev-flows__statusGrid,
  .luma-dev-flows__flowGrid {
    display: grid;
    gap: 16px;
  }

  .luma-dev-flows__statusGrid {
    grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  }

  .luma-dev-flows__card {
    padding: 16px;
  }

  .luma-dev-flows__label {
    margin: 0;
    color: var(--foreground-muted);
    font-size: 0.76rem;
    font-weight: 800;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }

  .luma-dev-flows__value {
    margin: 10px 0 0;
    color: var(--foreground);
    font-size: 1rem;
    line-height: 1.6;
    word-break: break-word;
  }

  .luma-dev-flows__flowHeader {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    margin-bottom: 14px;
  }

  .luma-dev-flows__flowTitle {
    margin: 0;
    color: var(--foreground);
    font-size: 1.08rem;
    font-weight: 700;
  }

  .luma-dev-flows__flowCopy {
    margin: 0 0 16px;
    color: var(--foreground-muted);
    line-height: 1.6;
  }

  .luma-dev-flows__buttonRow {
    display: flex;
    flex-wrap: wrap;
    gap: 10px;
  }

  .luma-dev-flows__button {
    min-height: 42px;
    padding: 0 16px;
    border-radius: 14px;
    border: 1px solid rgba(181, 155, 255, 0.22);
    background: rgba(181, 155, 255, 0.1);
    color: var(--accent-strong);
    font-size: 0.9rem;
    font-weight: 700;
    cursor: pointer;
  }

  .luma-dev-flows__button--primary {
    background: linear-gradient(135deg, var(--accent-strong), var(--accent));
    color: #ffffff;
    border-color: transparent;
  }

  .luma-dev-flows__code {
    margin: 12px 0 0;
    padding: 12px;
    border-radius: 16px;
    border: 1px solid var(--border);
    background: var(--card-muted);
    color: var(--foreground);
    font-size: 0.86rem;
    line-height: 1.6;
    white-space: pre-wrap;
    word-break: break-word;
  }
`;

function buildTestCredentials(): TestCredentials {
  const stamp = Date.now();

  return {
    email: `dev-flow-${stamp}@example.com`,
    username: `dev_flow_${stamp}`,
    password: "DevFlowPass!2026",
  };
}

function FlowCard({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <article className="luma-dev-flows__card">
      <div className="luma-dev-flows__flowHeader">
        <h2 className="luma-dev-flows__flowTitle">{title}</h2>
      </div>
      <p className="luma-dev-flows__flowCopy">{description}</p>
      {children}
    </article>
  );
}

export default function DevFlowTestPage() {
  const navigate = useNavigate();
  const { user, login, signup } = useAuth();
  const { state } = useDevFlowTesting();
  const [credentials, setCredentials] = useState<TestCredentials>(() =>
    buildTestCredentials(),
  );
  const [lastActionMessage, setLastActionMessage] = useState(
    "Ready to simulate flows.",
  );

  const authSummary = useMemo(() => {
    if (!state.authState.isAuthenticated) {
      return "Signed out";
    }

    return `Signed in as ${state.authState.email ?? state.authState.username ?? "unknown user"}`;
  }, [state.authState.email, state.authState.isAuthenticated, state.authState.username]);

  async function runAction(
    label: string,
    action: () => Promise<void> | void,
  ) {
    console.info(`[Luma Dev Flow] Starting: ${label}`);
    setLastActionMessage(`${label} started. Check the console for details.`);

    try {
      await action();
      console.info(`[Luma Dev Flow] Completed: ${label}`);
      setLastActionMessage(`${label} completed.`);
    } catch (error) {
      console.error(`[Luma Dev Flow] Failed: ${label}`, error);
      setLastActionMessage(getApiErrorMessage(error, `${label} failed.`));
    }
  }

  return (
    <>
      <style>{pageStyles}</style>

      <div className="luma-dev-flows">
        <div className="luma-dev-flows__shell">
          <section className="luma-dev-flows__hero">
            <p className="luma-dev-flows__eyebrow">Developer only</p>
            <h1 className="luma-dev-flows__title">Manual Flow Tester</h1>
            <p className="luma-dev-flows__copy">
              Use these controls to step through the major Luma flows in a
              development build. Every navigation change, auth transition, and
              API response is logged to the console and mirrored in the debug
              badge panel.
            </p>
            <pre className="luma-dev-flows__code">{lastActionMessage}</pre>
          </section>

          <section className="luma-dev-flows__statusGrid">
            <div className="luma-dev-flows__card">
              <p className="luma-dev-flows__label">Current Auth State</p>
              <p className="luma-dev-flows__value">{authSummary}</p>
            </div>
            <div className="luma-dev-flows__card">
              <p className="luma-dev-flows__label">Onboarding Step</p>
              <p className="luma-dev-flows__value">
                {state.onboardingStep == null
                  ? "Inactive"
                  : `Step ${state.onboardingStep} of 4`}
              </p>
            </div>
            <div className="luma-dev-flows__card">
              <p className="luma-dev-flows__label">Subscription Status</p>
              <p className="luma-dev-flows__value">
                {state.subscriptionStatus ?? "free"}
              </p>
            </div>
            <div className="luma-dev-flows__card">
              <p className="luma-dev-flows__label">Generated Test Account</p>
              <pre className="luma-dev-flows__code">
                {JSON.stringify(credentials, null, 2)}
              </pre>
            </div>
          </section>

          <section className="luma-dev-flows__flowGrid">
            <FlowCard
              title="Signup"
              description="Generate fresh credentials, open the signup screen, or run the signup request directly."
            >
              <div className="luma-dev-flows__buttonRow">
                <button
                  type="button"
                  className="luma-dev-flows__button"
                  onClick={() => {
                    const nextCredentials = buildTestCredentials();
                    console.info(
                      "[Luma Dev Flow] Regenerated test credentials",
                      nextCredentials,
                    );
                    setCredentials(nextCredentials);
                    setLastActionMessage("Generated a fresh dev test account.");
                  }}
                >
                  1. Regenerate credentials
                </button>
                <button
                  type="button"
                  className="luma-dev-flows__button"
                  onClick={() => {
                    console.info("[Luma Dev Flow] Navigating to /signup");
                    navigate("/signup");
                  }}
                >
                  2. Open signup screen
                </button>
                <button
                  type="button"
                  className="luma-dev-flows__button luma-dev-flows__button--primary"
                  onClick={() => {
                    void runAction("Signup API flow", async () => {
                      const response = await api.post<AuthResponse>("/signup", {
                        email: credentials.email,
                        username: credentials.username,
                        password: credentials.password,
                      });
                      console.info(
                        "[Luma Dev Flow] Signup response",
                        response.data,
                      );
                    });
                  }}
                >
                  3. Run signup API
                </button>
                <button
                  type="button"
                  className="luma-dev-flows__button"
                  onClick={() => {
                    void runAction("Frontend signup flow", async () => {
                      await signup(
                        credentials.email,
                        credentials.password,
                        credentials.username,
                      );
                    });
                  }}
                >
                  4. Run frontend signup
                </button>
              </div>
            </FlowCard>

            <FlowCard
              title="Login"
              description="Open the login screen, test the API contract directly, or run the frontend login flow with the current credentials."
            >
              <div className="luma-dev-flows__buttonRow">
                <button
                  type="button"
                  className="luma-dev-flows__button"
                  onClick={() => {
                    console.info("[Luma Dev Flow] Navigating to /login");
                    navigate("/login");
                  }}
                >
                  1. Open login screen
                </button>
                <button
                  type="button"
                  className="luma-dev-flows__button"
                  onClick={() => {
                    void runAction("Login API flow", async () => {
                      const response = await api.post<AuthResponse>("/login", {
                        email: credentials.email,
                        password: credentials.password,
                      });
                      console.info(
                        "[Luma Dev Flow] Login response",
                        response.data,
                      );
                    });
                  }}
                >
                  2. Run login API
                </button>
                <button
                  type="button"
                  className="luma-dev-flows__button luma-dev-flows__button--primary"
                  onClick={() => {
                    void runAction("Frontend login flow", async () => {
                      await login(credentials.email, credentials.password);
                    });
                  }}
                >
                  3. Run frontend login
                </button>
              </div>
            </FlowCard>

            <FlowCard
              title="Onboarding"
              description="Open onboarding directly and monitor the step tracker in the debug panel while you move through the setup."
            >
              <div className="luma-dev-flows__buttonRow">
                <button
                  type="button"
                  className="luma-dev-flows__button"
                  onClick={() => {
                    console.info("[Luma Dev Flow] Navigating to /onboarding");
                    navigate("/onboarding");
                  }}
                >
                  1. Open onboarding
                </button>
                <button
                  type="button"
                  className="luma-dev-flows__button"
                  onClick={() => {
                    console.info(
                      "[Luma Dev Flow] Current onboarding state",
                      state.onboardingStep,
                    );
                    setLastActionMessage(
                      state.onboardingStep == null
                        ? "Onboarding is inactive right now."
                        : `Onboarding is currently on step ${state.onboardingStep}.`,
                    );
                  }}
                >
                  2. Log onboarding step
                </button>
              </div>
            </FlowCard>

            <FlowCard
              title="Dashboard"
              description="Navigate into the main workspace and trigger a profile refresh so the latest authenticated state is visible in the console."
            >
              <div className="luma-dev-flows__buttonRow">
                <button
                  type="button"
                  className="luma-dev-flows__button"
                  onClick={() => {
                    console.info("[Luma Dev Flow] Navigating to /dashboard");
                    navigate("/dashboard");
                  }}
                >
                  1. Open dashboard
                </button>
                <button
                  type="button"
                  className="luma-dev-flows__button"
                  onClick={() => {
                    void runAction("Fetch profile", async () => {
                      const response = await api.get("/me/profile");
                      console.info(
                        "[Luma Dev Flow] Profile response",
                        response.data,
                      );
                    });
                  }}
                >
                  2. Fetch /me/profile
                </button>
              </div>
            </FlowCard>

            <FlowCard
              title="Chat"
              description="Open the chat workspace and log the active persona and bot identity currently loaded from auth state."
            >
              <div className="luma-dev-flows__buttonRow">
                <button
                  type="button"
                  className="luma-dev-flows__button"
                  onClick={() => {
                    console.info("[Luma Dev Flow] Navigating to /chat");
                    navigate("/chat");
                  }}
                >
                  1. Open chat
                </button>
                <button
                  type="button"
                  className="luma-dev-flows__button"
                  onClick={() => {
                    console.info("[Luma Dev Flow] Current chat user", user);
                    setLastActionMessage(
                      user
                        ? `Chat is ready for ${user.username}.`
                        : "Chat requires an authenticated user.",
                    );
                  }}
                >
                  2. Log chat context
                </button>
              </div>
            </FlowCard>

            <FlowCard
              title="Study Tools"
              description="Open each study route directly and verify premium gating or unlocked access in the dev console."
            >
              <div className="luma-dev-flows__buttonRow">
                {[
                  { label: "Flashcards", to: "/flashcards" },
                  { label: "Image to Notes", to: "/image-to-notes" },
                  { label: "Voice Input", to: "/voice-input" },
                  { label: "Study Session", to: "/study-session" },
                ].map((item) => (
                  <button
                    key={item.to}
                    type="button"
                    className="luma-dev-flows__button"
                    onClick={() => {
                      console.info(
                        `[Luma Dev Flow] Navigating to ${item.to}`,
                      );
                      navigate(item.to);
                    }}
                  >
                    Open {item.label}
                  </button>
                ))}
              </div>
            </FlowCard>

            <FlowCard
              title="Voice Input"
              description="Open the voice tool and log the audio formats the frontend is prepared to hand off to the authenticated transcription endpoint."
            >
              <div className="luma-dev-flows__buttonRow">
                <button
                  type="button"
                  className="luma-dev-flows__button"
                  onClick={() => {
                    console.info("[Luma Dev Flow] Navigating to /voice-input");
                    navigate("/voice-input");
                  }}
                >
                  1. Open voice input
                </button>
                <button
                  type="button"
                  className="luma-dev-flows__button"
                  onClick={() => {
                    const formats = [
                      "audio/wav",
                      "audio/mpeg",
                      "audio/mp4",
                      "audio/webm",
                      "audio/ogg",
                    ];
                    console.info(
                      "[Luma Dev Flow] Supported voice input formats",
                      formats,
                    );
                    setLastActionMessage(
                      `Voice input formats: ${formats.join(", ")}`,
                    );
                  }}
                >
                  2. Log supported formats
                </button>
              </div>
            </FlowCard>

            <FlowCard
              title="Navigation Snapshot"
              description="Quick links for the active debug targets. These are useful while watching redirect and route events in the console."
            >
              <div className="luma-dev-flows__buttonRow">
                <button
                  type="button"
                  className="luma-dev-flows__button"
                  onClick={() => {
                    navigate("/");
                  }}
                >
                  Landing
                </button>
                <button
                  type="button"
                  className="luma-dev-flows__button"
                  onClick={() => {
                    navigate("/settings");
                  }}
                >
                  Settings
                </button>
                <button
                  type="button"
                  className="luma-dev-flows__button"
                  onClick={() => {
                    navigate("/search");
                  }}
                >
                  Search
                </button>
              </div>
            </FlowCard>
          </section>
        </div>
      </div>
    </>
  );
}
