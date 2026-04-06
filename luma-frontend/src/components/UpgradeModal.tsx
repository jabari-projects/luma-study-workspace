import { useEffect } from "react";
import { Link } from "react-router-dom";
import LockIcon from "./LockIcon";
import { trackPremiumModalOpen } from "../lib/analytics";

type UpgradeModalProps = {
  open: boolean;
  onClose: () => void;
  featureName?: string;
};

const premiumBenefits = [
  "Unlock advanced study tools and deeper AI workflows.",
  "Keep premium features visible across dashboard, chat, and study navigation.",
  "Get early access to the next wave of Luma learning tools.",
];

const comparisonRows = [
  {
    feature: "Workspace search",
    free: "Included",
    pro: "Included",
  },
  {
    feature: "Flashcards",
    free: "Preview only",
    pro: "Full access",
  },
  {
    feature: "Image to Notes",
    free: "Locked",
    pro: "Included",
  },
  {
    feature: "Voice Input",
    free: "Locked",
    pro: "Included",
  },
  {
    feature: "Study Session tools",
    free: "Locked",
    pro: "Included",
  },
];

const upgradeModalStyles = `
  @keyframes luma-upgrade-overlay-in {
    from {
      opacity: 0;
    }
    to {
      opacity: 1;
    }
  }

  @keyframes luma-upgrade-modal-in {
    from {
      opacity: 0;
      transform: translateY(12px) scale(0.96);
    }
    to {
      opacity: 1;
      transform: translateY(0) scale(1);
    }
  }

  .luma-upgrade-modal__overlay {
    position: fixed;
    inset: 0;
    z-index: 1200;
    display: grid;
    place-items: center;
    padding: 16px;
    background: var(--overlay-scrim);
    backdrop-filter: blur(10px);
    animation: luma-upgrade-overlay-in 220ms ease;
  }

  .luma-upgrade-modal__card {
    width: min(920px, 100%);
    max-height: min(88vh, 920px);
    overflow: auto;
    display: grid;
    gap: 20px;
    background:
      radial-gradient(circle at top right, color-mix(in srgb, var(--accent) 12%, transparent), transparent 34%),
      var(--card);
    border: 1px solid var(--border);
    border-radius: 28px;
    padding: 24px;
    box-shadow: var(--shadow);
    animation: luma-upgrade-modal-in 260ms cubic-bezier(0.2, 0.9, 0.2, 1);
  }

  .luma-upgrade-modal__hero {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 18px;
  }

  .luma-upgrade-modal__heroBody {
    display: grid;
    gap: 14px;
    min-width: 0;
  }

  .luma-upgrade-modal__eyebrow {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    width: fit-content;
    padding: 8px 12px;
    border-radius: 999px;
    background: var(--surface-tint-soft);
    color: var(--accent-strong);
    font-size: 0.74rem;
    font-weight: 800;
    letter-spacing: 0.06em;
    text-transform: uppercase;
  }

  .luma-upgrade-modal__title {
    margin: 0;
    color: var(--foreground);
    font-size: clamp(2rem, 4vw, 2.8rem);
    line-height: 1.02;
    letter-spacing: -0.04em;
  }

  .luma-upgrade-modal__copy {
    margin: 0;
    max-width: 640px;
    color: var(--foreground-muted);
    line-height: 1.7;
  }

  .luma-upgrade-modal__close {
    min-height: 42px;
    padding: 0 14px;
    border-radius: 14px;
    border: 1px solid var(--border);
    background: var(--card);
    color: var(--foreground);
    cursor: pointer;
    box-shadow: var(--shadow);
  }

  .luma-upgrade-modal__grid {
    display: grid;
    grid-template-columns: minmax(0, 1.3fr) minmax(280px, 0.7fr);
    gap: 18px;
    align-items: start;
  }

  .luma-upgrade-modal__section {
    display: grid;
    gap: 14px;
    padding: 18px;
    border-radius: 22px;
    background: var(--surface-tint-soft);
    border: 1px solid var(--border);
  }

  .luma-upgrade-modal__sectionTitle {
    margin: 0;
    color: var(--foreground);
    font-size: 1rem;
    font-weight: 800;
  }

  .luma-upgrade-modal__comparison {
    display: grid;
    gap: 10px;
  }

  .luma-upgrade-modal__comparisonHeader,
  .luma-upgrade-modal__comparisonRow {
    display: grid;
    grid-template-columns: minmax(0, 1.2fr) minmax(88px, 0.4fr) minmax(88px, 0.4fr);
    gap: 10px;
    align-items: center;
  }

  .luma-upgrade-modal__comparisonHeader {
    padding: 0 8px;
    color: var(--foreground-muted);
    font-size: 0.76rem;
    font-weight: 800;
    letter-spacing: 0.06em;
    text-transform: uppercase;
  }

  .luma-upgrade-modal__comparisonRow {
    padding: 12px 14px;
    border-radius: 16px;
    border: 1px solid var(--border);
    background: var(--card);
  }

  .luma-upgrade-modal__comparisonFeature {
    color: var(--foreground);
    font-size: 0.92rem;
    font-weight: 700;
  }

  .luma-upgrade-modal__comparisonValue {
    color: var(--foreground-muted);
    font-size: 0.84rem;
    text-align: center;
  }

  .luma-upgrade-modal__comparisonValue.is-pro {
    color: var(--accent-strong);
    font-weight: 800;
  }

  .luma-upgrade-modal__benefits {
    display: grid;
    gap: 10px;
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .luma-upgrade-modal__benefit {
    display: grid;
    grid-template-columns: 22px minmax(0, 1fr);
    gap: 10px;
    align-items: start;
    color: var(--foreground-muted);
    line-height: 1.6;
  }

  .luma-upgrade-modal__benefitMark {
    width: 22px;
    height: 22px;
    display: grid;
    place-items: center;
    border-radius: 999px;
    background: var(--surface-tint-soft);
    color: var(--accent-strong);
    font-size: 0.82rem;
    font-weight: 900;
    margin-top: 2px;
  }

  .luma-upgrade-modal__pricingCard {
    position: relative;
    overflow: hidden;
    display: grid;
    gap: 14px;
    padding: 22px;
    border-radius: 24px;
    background:
      var(--gradient-accent-soft);
    border: 1px solid var(--border-strong);
    box-shadow: var(--shadow);
  }

  html[data-theme="dark"] .luma-upgrade-modal__pricingCard {
    background: var(--gradient-accent-soft);
  }

  .luma-upgrade-modal__plan {
    margin: 0;
    color: var(--accent-strong);
    font-size: 0.8rem;
    font-weight: 800;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }

  .luma-upgrade-modal__price {
    display: flex;
    align-items: baseline;
    gap: 8px;
    color: var(--foreground);
  }

  .luma-upgrade-modal__priceValue {
    font-size: clamp(2.5rem, 5vw, 3.3rem);
    font-weight: 900;
    letter-spacing: -0.05em;
    line-height: 1;
  }

  .luma-upgrade-modal__priceMeta {
    color: var(--foreground-muted);
    font-size: 0.92rem;
    font-weight: 700;
  }

  .luma-upgrade-modal__priceCopy {
    margin: 0;
    color: var(--foreground-muted);
    line-height: 1.65;
  }

  .luma-upgrade-modal__actions {
    display: flex;
    gap: 12px;
    flex-wrap: wrap;
    align-items: center;
  }

  .luma-upgrade-modal__primary {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-height: 50px;
    padding: 0 20px;
    border-radius: 16px;
    text-decoration: none;
    background: var(--gradient-accent);
    color: var(--text-inverse);
    font-weight: 800;
    box-shadow: var(--shadow);
  }

  .luma-upgrade-modal__secondary {
    min-height: 50px;
    padding: 0 18px;
    border-radius: 16px;
    border: 1px solid var(--border);
    background: var(--card);
    color: var(--foreground);
    font-weight: 700;
    cursor: pointer;
    box-shadow: var(--shadow);
  }

  .luma-upgrade-modal__finePrint {
    margin: 0;
    color: var(--foreground-muted);
    font-size: 0.78rem;
    line-height: 1.55;
  }

  @media (max-width: 820px) {
    .luma-upgrade-modal__grid {
      grid-template-columns: 1fr;
    }

    .luma-upgrade-modal__hero {
      flex-direction: column;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .luma-upgrade-modal__overlay,
    .luma-upgrade-modal__card {
      animation: none !important;
    }
  }
`;

export default function UpgradeModal({
  open,
  onClose,
  featureName = "this premium feature",
}: UpgradeModalProps) {
  useEffect(() => {
    if (!open) {
      return;
    }

    trackPremiumModalOpen(featureName, {
      surface: "upgrade_modal",
    });
  }, [featureName, open]);

  useEffect(() => {
    if (!open) {
      return undefined;
    }

    function handleEscape(event: KeyboardEvent) {
      if (event.key === "Escape") {
        onClose();
      }
    }

    document.addEventListener("keydown", handleEscape);
    return () => {
      document.removeEventListener("keydown", handleEscape);
    };
  }, [onClose, open]);

  useEffect(() => {
    if (!open) {
      return undefined;
    }

    const { overflow } = document.body.style;
    document.body.style.overflow = "hidden";

    return () => {
      document.body.style.overflow = overflow;
    };
  }, [open]);

  if (!open) {
    return null;
  }

  return (
    <>
      <style>{upgradeModalStyles}</style>

      <div
        className="luma-upgrade-modal__overlay"
        aria-modal="true"
        role="dialog"
        aria-label="Upgrade to Luma Pro"
        onClick={(event) => {
          if (event.target === event.currentTarget) {
            onClose();
          }
        }}
      >
        <div className="luma-upgrade-modal__card">
          <div className="luma-upgrade-modal__hero">
            <div className="luma-upgrade-modal__heroBody">
              <span className="luma-upgrade-modal__eyebrow">
                <LockIcon size={16} />
                <span>Luma Pro</span>
              </span>

              <div style={{ display: "grid", gap: 10 }}>
                <h2 className="luma-upgrade-modal__title">
                  Unlock {featureName} with Luma Pro.
                </h2>
                <p className="luma-upgrade-modal__copy">
                  Upgrade for premium study tools, richer AI workflows, and a
                  smoother workspace built for deeper focus.
                </p>
              </div>
            </div>

            <button
              type="button"
              onClick={onClose}
              className="luma-upgrade-modal__close"
            >
              Close
            </button>
          </div>

          <div className="luma-upgrade-modal__grid">
            <div className="luma-upgrade-modal__section">
              <h3 className="luma-upgrade-modal__sectionTitle">
                Free vs Luma Pro
              </h3>

              <div className="luma-upgrade-modal__comparison">
                <div className="luma-upgrade-modal__comparisonHeader">
                  <span>Feature</span>
                  <span style={{ textAlign: "center" }}>Free</span>
                  <span style={{ textAlign: "center" }}>Luma Pro</span>
                </div>

                {comparisonRows.map((row) => (
                  <div
                    key={row.feature}
                    className="luma-upgrade-modal__comparisonRow"
                  >
                    <span className="luma-upgrade-modal__comparisonFeature">
                      {row.feature}
                    </span>
                    <span className="luma-upgrade-modal__comparisonValue">
                      {row.free}
                    </span>
                    <span className="luma-upgrade-modal__comparisonValue is-pro">
                      {row.pro}
                    </span>
                  </div>
                ))}
              </div>
            </div>

            <div style={{ display: "grid", gap: 18 }}>
              <div className="luma-upgrade-modal__section">
                <h3 className="luma-upgrade-modal__sectionTitle">
                  Premium benefits
                </h3>

                <ul className="luma-upgrade-modal__benefits">
                  {premiumBenefits.map((benefit) => (
                    <li key={benefit} className="luma-upgrade-modal__benefit">
                      <span className="luma-upgrade-modal__benefitMark">+</span>
                      <span>{benefit}</span>
                    </li>
                  ))}
                </ul>
              </div>

              <div className="luma-upgrade-modal__pricingCard">
                <p className="luma-upgrade-modal__plan">Pricing</p>
                <div className="luma-upgrade-modal__price">
                  <span className="luma-upgrade-modal__priceValue">$12</span>
                  <span className="luma-upgrade-modal__priceMeta">/ month</span>
                </div>
                <p className="luma-upgrade-modal__priceCopy">
                  Simple monthly access to the full premium study suite, with
                  checkout handled on the next screen.
                </p>

                <div className="luma-upgrade-modal__actions">
                  <Link
                    to="/subscribe"
                    onClick={onClose}
                    className="luma-upgrade-modal__primary"
                  >
                    Upgrade to Luma Pro
                  </Link>

                  <button
                    type="button"
                    onClick={onClose}
                    className="luma-upgrade-modal__secondary"
                  >
                    Maybe later
                  </button>
                </div>

                <p className="luma-upgrade-modal__finePrint">
                  You can review the full upgrade flow before any billing step
                  is confirmed.
                </p>
              </div>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
