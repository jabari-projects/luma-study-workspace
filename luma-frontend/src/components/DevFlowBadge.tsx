import { useEffect, useMemo, useRef } from "react";
import { useLocation, useNavigate, useNavigationType } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import {
  recordDevFlowAuthState,
  recordDevFlowNavigation,
  useDevFlowTesting,
} from "../context/DevFlowTestingContext";

function DebugSection({
  title,
  value,
}: {
  title: string;
  value: unknown;
}) {
  return (
    <section
      style={{
        display: "grid",
        gap: 6,
      }}
    >
      <p
        style={{
          margin: 0,
          fontSize: 11,
          fontWeight: 800,
          letterSpacing: "0.08em",
          textTransform: "uppercase",
          color: "var(--foreground-muted)",
        }}
      >
        {title}
      </p>
      <pre
        style={{
          margin: 0,
          padding: 12,
          borderRadius: 14,
          background: "var(--card-muted)",
          border: "1px solid var(--border)",
          color: "var(--foreground)",
          fontSize: 12,
          lineHeight: 1.5,
          whiteSpace: "pre-wrap",
          wordBreak: "break-word",
        }}
      >
        {typeof value === "string"
          ? value
          : JSON.stringify(value, null, 2)}
      </pre>
    </section>
  );
}

export default function DevFlowBadge() {
  const navigate = useNavigate();
  const location = useLocation();
  const navigationType = useNavigationType();
  const { loading, isAuthenticated, user, accessToken } = useAuth();
  const { enabled, panelOpen, togglePanel, closePanel, state } =
    useDevFlowTesting();
  const lastAuthFingerprint = useRef<string>("");
  const lastNavigationFingerprint = useRef<string>("");

  const currentPath = `${location.pathname}${location.search}${location.hash}`;

  useEffect(() => {
    if (!enabled) {
      return;
    }

    const payload = {
      loading,
      isAuthenticated,
      userId: user?.id ?? null,
      email: user?.email ?? null,
      username: user?.username ?? null,
      tokenPreview: accessToken ? `${accessToken.slice(0, 12)}...` : null,
      subscriptionStatus: user?.subscription_status ?? null,
    };
    const fingerprint = JSON.stringify(payload);

    if (lastAuthFingerprint.current === fingerprint) {
      return;
    }

    lastAuthFingerprint.current = fingerprint;
    recordDevFlowAuthState(payload);
  }, [
    accessToken,
    enabled,
    isAuthenticated,
    loading,
    user?.email,
    user?.id,
    user?.subscription_status,
    user?.username,
  ]);

  useEffect(() => {
    if (!enabled) {
      return;
    }

    const payload = {
      path: currentPath,
      navigationType,
      timestamp: new Date().toISOString(),
    };
    const fingerprint = `${payload.navigationType}:${payload.path}`;

    if (lastNavigationFingerprint.current === fingerprint) {
      return;
    }

    lastNavigationFingerprint.current = fingerprint;
    recordDevFlowNavigation(payload);
  }, [currentPath, enabled, navigationType]);

  const onboardingLabel = useMemo(() => {
    if (state.onboardingStep == null) {
      return "Inactive";
    }

    return `Step ${state.onboardingStep} of 4`;
  }, [state.onboardingStep]);

  if (!enabled) {
    return null;
  }

  return (
    <>
      {panelOpen ? (
        <>
          <button
            type="button"
            aria-label="Close developer flow debug panel"
            onClick={closePanel}
            style={{
              position: "fixed",
              inset: 0,
              zIndex: 1198,
              border: "none",
              background: "var(--overlay-subtle)",
            }}
          />
          <aside
            style={{
              position: "fixed",
              left: 16,
              bottom: 68,
              zIndex: 1199,
              width: "min(360px, calc(100vw - 32px))",
              maxHeight: "min(72vh, 680px)",
              overflowY: "auto",
              display: "grid",
              gap: 12,
              padding: 16,
              borderRadius: 18,
              background: "var(--card)",
              border: "1px solid var(--border)",
              boxShadow: "var(--shadow)",
            }}
          >
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 12,
              }}
            >
              <div>
                <p
                  style={{
                    margin: 0,
                    fontSize: 11,
                    fontWeight: 800,
                    letterSpacing: "0.08em",
                    textTransform: "uppercase",
                    color: "var(--accent-strong)",
                  }}
                >
                  Developer Flow Testing
                </p>
                <h2
                  style={{
                    margin: "6px 0 0",
                    fontSize: 18,
                    color: "var(--foreground)",
                  }}
                >
                  Live flow inspector
                </h2>
              </div>

              <button
                type="button"
                onClick={() => {
                  navigate("/dev/test-flows");
                }}
                style={{
                  minHeight: 38,
                  padding: "0 14px",
                  borderRadius: 14,
                  border: "1px solid var(--border)",
                  background: "var(--surface-tint-soft)",
                  color: "var(--accent-strong)",
                  fontSize: 12,
                  fontWeight: 700,
                  cursor: "pointer",
                }}
              >
                Open tester
              </button>
            </div>

            <DebugSection title="Current Auth State" value={state.authState} />
            <DebugSection
              title="Current Onboarding Step"
              value={onboardingLabel}
            />
            <DebugSection
              title="Current Subscription Status"
              value={state.subscriptionStatus ?? "free"}
            />
            <DebugSection
              title="Last API Call + Status"
              value={state.lastApiCall ?? "No API traffic captured yet."}
            />
            <DebugSection
              title="Last Navigation Event"
              value={
                state.lastNavigationEvent ?? "No navigation event captured yet."
              }
            />
          </aside>
        </>
      ) : null}

      <button
        type="button"
        onClick={togglePanel}
        style={{
          position: "fixed",
          left: 16,
          bottom: 16,
          zIndex: 1200,
          minWidth: 72,
          minHeight: 40,
          padding: "0 14px",
          borderRadius: 999,
          border: "1px solid var(--border)",
          background: "var(--gradient-accent)",
          color: "var(--text-inverse)",
          fontSize: 12,
          fontWeight: 800,
          letterSpacing: "0.08em",
          textTransform: "uppercase",
          boxShadow: "var(--shadow)",
          cursor: "pointer",
        }}
      >
        Dev Flow
      </button>
    </>
  );
}
