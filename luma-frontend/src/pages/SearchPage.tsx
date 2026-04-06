import { useState } from "react";
import LockedFeature from "../components/LockedFeature";
import SearchBar from "../components/SearchBar";
import { useAuth } from "../context/AuthContext";

export default function SearchPage() {
  const { user } = useAuth();
  const isPremium = user?.subscription_status === "premium";
  const [semanticEnabled, setSemanticEnabled] = useState(false);

  return (
    <div
      style={{
        minHeight: "100vh",
        padding: 16,
      }}
    >
      <div
        style={{
          maxWidth: 1080,
          margin: "0 auto",
          display: "grid",
          gap: 16,
        }}
      >
        <header
          style={{
            display: "grid",
            gap: 12,
            padding: 16,
            background: "var(--card)",
            border: "1px solid var(--border)",
            borderRadius: 16,
            boxShadow: "var(--shadow)",
          }}
        >
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
            Private Search
          </span>

          <h1
            style={{
              margin: 0,
              color: "var(--foreground)",
              fontSize: "clamp(2rem, 4vw, 3rem)",
              lineHeight: 1.05,
            }}
          >
            Search your notes, flashcards, and study history
          </h1>

          <p
            style={{
              margin: 0,
              color: "var(--foreground-muted)",
              lineHeight: 1.7,
              maxWidth: 760,
            }}
          >
            Luma search stays private to your account. Use it to find notes,
            flashcards, study sessions, summaries, and transcripts from your
            personal learning workspace.
          </p>
        </header>

        <section
          style={{
            display: "grid",
            gap: 16,
            padding: 16,
            background: "var(--card)",
            border: "1px solid var(--border)",
            borderRadius: 16,
            boxShadow: "var(--shadow)",
          }}
        >
          <div style={{ display: "grid", gap: 6 }}>
            <h2
              style={{
                margin: 0,
                color: "var(--foreground)",
                fontSize: 20,
              }}
            >
              Semantic Search (Pro)
            </h2>
            <p
              style={{
                margin: 0,
                color: "var(--foreground-muted)",
                lineHeight: 1.6,
              }}
            >
              Use AI-assisted semantic matching to reach related ideas before
              falling back to full-text search.
            </p>
          </div>

          {isPremium ? (
            <label
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 10,
                width: "fit-content",
                color: "var(--foreground)",
                fontWeight: 700,
                padding: "12px 14px",
                borderRadius: 16,
                border: "1px solid var(--border)",
                background: "color-mix(in srgb, var(--card) 92%, rgba(181, 155, 255, 0.08))",
                boxShadow: "var(--shadow)",
              }}
            >
              <input
                type="checkbox"
                checked={semanticEnabled}
                onChange={(event) => {
                  setSemanticEnabled(event.target.checked);
                }}
                style={{ width: 18, height: 18 }}
              />
              Enable semantic search
            </label>
          ) : (
            <LockedFeature
              featureName="Semantic Search"
              title="Semantic Search is for Premium members"
              description="Upgrade to use AI-assisted search that can spot related ideas across your private study workspace."
            />
          )}
        </section>

        <SearchBar semanticEnabled={isPremium && semanticEnabled} />
      </div>
    </div>
  );
}
