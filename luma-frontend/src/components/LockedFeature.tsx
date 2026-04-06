import { useEffect, useState } from "react";
import LockIcon from "./LockIcon";
import UpgradeModal from "./UpgradeModal";

type LockedFeatureProps = {
  title?: string;
  description?: string;
  ctaLabel?: string;
  featureName?: string;
  autoOpen?: boolean;
};

const lockedFeatureStyles = `
  .luma-locked-feature {
    position: relative;
    overflow: hidden;
    background: var(--card);
    border: 1px solid var(--border);
    border-radius: 16px;
    padding: 20px;
    box-shadow: var(--shadow);
    display: grid;
    gap: 12px;
    transition: transform 180ms ease, border-color 180ms ease, box-shadow 220ms ease;
  }

  .luma-locked-feature::before {
    content: "";
    position: absolute;
    inset: -32% auto auto -12%;
    width: 180px;
    height: 180px;
    border-radius: 50%;
    background: var(--glow-accent);
    pointer-events: none;
  }

  .luma-locked-feature:hover {
    transform: translateY(-2px);
    border-color: var(--border-strong);
    box-shadow: var(--shadow-soft);
  }

  .luma-locked-feature__badge {
    display: inline-flex;
    align-items: center;
    width: fit-content;
    padding: 8px 12px;
    border-radius: 999px;
    background: var(--surface-tint-soft);
    color: var(--accent-strong);
    font-size: 0.72rem;
    font-weight: 800;
    letter-spacing: 0.04em;
    text-transform: uppercase;
  }

  .luma-locked-feature__icon {
    width: 48px;
    height: 48px;
    display: grid;
    place-items: center;
    border-radius: 16px;
    background: var(--surface-tint-soft);
    color: var(--accent-strong);
    transition: transform 180ms ease, filter 180ms ease;
  }

  .luma-locked-feature:hover .luma-locked-feature__icon {
    transform: scale(1.05);
    filter: brightness(1.06);
  }

  .luma-locked-feature__content {
    position: relative;
    z-index: 1;
    display: grid;
    gap: 8px;
  }

  .luma-locked-feature__title {
    margin: 0;
    color: var(--foreground);
    font-size: 22px;
    line-height: 1.2;
  }

  .luma-locked-feature__description {
    margin: 0;
    color: var(--foreground-muted);
    line-height: 1.6;
  }

  .luma-locked-feature__actions {
    position: relative;
    z-index: 1;
    display: flex;
    align-items: center;
    gap: 12px;
    flex-wrap: wrap;
  }

  .luma-locked-feature__button {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-height: 48px;
    padding: 0 18px;
    border-radius: 16px;
    border: none;
    background: linear-gradient(135deg, var(--accent-strong), var(--accent));
    color: var(--text-inverse);
    font-weight: 700;
    box-shadow: var(--shadow);
    cursor: pointer;
    transition: transform 180ms ease, filter 180ms ease, box-shadow 180ms ease;
  }

  .luma-locked-feature__button:hover,
  .luma-locked-feature__button:focus-visible {
    transform: translateY(-1px);
    filter: brightness(1.04);
    box-shadow: var(--shadow-accent);
    outline: none;
  }

  .luma-locked-feature__note {
    color: var(--foreground-muted);
    font-size: 0.85rem;
    line-height: 1.5;
  }
`;

export default function LockedFeature({
  title = "This feature is for Premium members",
  description = "Upgrade your plan to unlock this premium experience inside Luma.",
  ctaLabel = "Upgrade to Luma Pro",
  featureName = "this premium feature",
  autoOpen = false,
}: LockedFeatureProps) {
  const [upgradeModalOpen, setUpgradeModalOpen] = useState(false);
  const [autoOpened, setAutoOpened] = useState(false);

  useEffect(() => {
    if (autoOpen && !autoOpened) {
      setUpgradeModalOpen(true);
      setAutoOpened(true);
    }
  }, [autoOpen, autoOpened]);

  return (
    <>
      <style>{lockedFeatureStyles}</style>

      <section
        className="luma-locked-feature"
        role="note"
        aria-label="Premium feature locked"
      >
        <span className="luma-locked-feature__badge">Premium lock</span>

        <span className="luma-locked-feature__icon" aria-hidden="true">
          <LockIcon size={22} />
        </span>

        <div className="luma-locked-feature__content">
          <h2 className="luma-locked-feature__title">{title}</h2>
          <p className="luma-locked-feature__description">{description}</p>
        </div>

        <div className="luma-locked-feature__actions">
          <button
            type="button"
            className="luma-locked-feature__button"
            onClick={() => {
              setUpgradeModalOpen(true);
            }}
          >
            {ctaLabel}
          </button>
          <span className="luma-locked-feature__note">
            Premium keeps advanced tools ready when you need them.
          </span>
        </div>
      </section>

      <UpgradeModal
        open={upgradeModalOpen}
        onClose={() => setUpgradeModalOpen(false)}
        featureName={featureName}
      />
    </>
  );
}
