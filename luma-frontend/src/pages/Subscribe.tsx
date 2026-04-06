import { useState } from "react";
import { Link } from "react-router-dom";
import { api, getApiErrorMessage } from "../api/api";
import { useAuth } from "../context/AuthContext";

const premiumFeatures = [
  {
    title: "Advanced Study Tools",
    description:
      "Unlock deeper learning tools and premium-only workflows as they roll out across Luma.",
  },
  {
    title: "Enhanced Personalization",
    description:
      "Access richer theme controls and future subscriber-only customization options.",
  },
  {
    title: "Priority Experience",
    description:
      "Get early access to new study improvements and premium account perks before the wider launch.",
  },
];

export default function SubscribePage() {
  const { user } = useAuth();
  const [message, setMessage] = useState<string | null>(null);
  const [isStartingCheckout, setIsStartingCheckout] = useState(false);
  const isPremium = user?.subscription_status === "premium";

  async function handleUpgrade() {
    if (isPremium || isStartingCheckout) {
      setMessage("Your account already has premium access.");
      return;
    }

    setIsStartingCheckout(true);
    setMessage(null);

    try {
      const response = await api.post<{ url: string }>("/api/create-checkout-session");

      if (!response.data?.url) {
        throw new Error("Unable to start checkout right now.");
      }

      window.location.href = response.data.url;
    } catch (error) {
      setMessage(
        getApiErrorMessage(error, "Unable to start checkout right now."),
      );
      setIsStartingCheckout(false);
    }
  }

  return (
    <main
      style={{
        minHeight: "calc(100vh - 96px)",
        padding: "32px 20px 56px",
      }}
    >
      <div
        style={{
          maxWidth: 1040,
          margin: "0 auto",
          display: "grid",
          gap: 24,
        }}
      >
        <section
          style={{
            padding: "32px clamp(22px, 4vw, 40px)",
            borderRadius: 28,
            background:
              "linear-gradient(135deg, rgba(181, 155, 255, 0.2), rgba(255, 255, 255, 0.78))",
            border: "1px solid rgba(181, 155, 255, 0.26)",
            boxShadow: "var(--shadow)",
            display: "grid",
            gap: 16,
          }}
        >
          <span
            style={{
              display: "inline-flex",
              width: "fit-content",
              padding: "7px 12px",
              borderRadius: 999,
              background:
                "linear-gradient(135deg, rgba(140, 111, 255, 0.16), rgba(181, 155, 255, 0.24))",
              color: "var(--accent-strong)",
              fontSize: 13,
              fontWeight: 800,
              letterSpacing: "0.01em",
            }}
          >
            {isPremium ? "Premium Active" : "Upgrade Available"}
          </span>

          <div style={{ display: "grid", gap: 10 }}>
            <h1
              style={{
                margin: 0,
                fontSize: "clamp(2rem, 5vw, 3.4rem)",
                lineHeight: 1.02,
                letterSpacing: "-0.04em",
                color: "var(--foreground)",
              }}
            >
              Upgrade your Luma workspace with premium study tools.
            </h1>
            <p
              style={{
                margin: 0,
                maxWidth: 660,
                fontSize: 16,
                lineHeight: 1.7,
                color: "var(--foreground-muted)",
              }}
            >
              Premium adds advanced learning tools, richer customization, and
              early access to the next wave of Luma features.
            </p>
          </div>

          <div
            style={{
              display: "flex",
              flexWrap: "wrap",
              gap: 12,
              alignItems: "center",
            }}
          >
            <button
              type="button"
              disabled={isPremium || isStartingCheckout}
              onClick={() => {
                void handleUpgrade();
              }}
              style={{
                minHeight: 48,
                padding: "0 18px",
                borderRadius: 16,
                border: "1px solid transparent",
                background: isPremium
                  ? "rgba(181, 155, 255, 0.18)"
                  : "linear-gradient(135deg, var(--accent-strong), var(--accent))",
                color: isPremium ? "var(--accent-strong)" : "#ffffff",
                fontSize: 15,
                fontWeight: 800,
                cursor: isPremium || isStartingCheckout ? "default" : "pointer",
                boxShadow: isPremium ? "none" : "0 18px 36px rgba(140, 111, 255, 0.24)",
                opacity: isStartingCheckout && !isPremium ? 0.82 : 1,
              }}
            >
              {isPremium
                ? "Premium Enabled"
                : isStartingCheckout
                  ? "Redirecting to Checkout..."
                  : "Upgrade to Premium"}
            </button>

            <Link
              to="/dashboard"
              style={{
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                minHeight: 48,
                padding: "0 18px",
                borderRadius: 16,
                border: "1px solid var(--border)",
                color: "var(--foreground)",
                textDecoration: "none",
                fontWeight: 700,
                background: "var(--card)",
              }}
            >
              Back to dashboard
            </Link>
          </div>

          {message ? (
            <p
              style={{
                margin: 0,
                padding: "13px 15px",
                borderRadius: 16,
                background: "rgba(181, 155, 255, 0.12)",
                border: "1px solid rgba(181, 155, 255, 0.24)",
                color: "var(--foreground)",
                lineHeight: 1.6,
              }}
            >
              {message}
            </p>
          ) : null}
        </section>

        <section
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
            gap: 16,
          }}
        >
          {premiumFeatures.map((feature) => (
            <article
              key={feature.title}
              style={{
                padding: 22,
                borderRadius: 22,
                background: "var(--card)",
                border: "1px solid var(--border)",
                boxShadow: "var(--shadow)",
                display: "grid",
                gap: 10,
              }}
            >
              <h2
                style={{
                  margin: 0,
                  fontSize: 18,
                  color: "var(--foreground)",
                }}
              >
                {feature.title}
              </h2>
              <p
                style={{
                  margin: 0,
                  color: "var(--foreground-muted)",
                  lineHeight: 1.7,
                  fontSize: 14,
                }}
              >
                {feature.description}
              </p>
            </article>
          ))}
        </section>
      </div>
    </main>
  );
}
