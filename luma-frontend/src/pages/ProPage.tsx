import { useState } from "react";
import { Link } from "react-router-dom";
import UpgradeModal from "../components/UpgradeModal";
import { useAuth } from "../context/AuthContext";

const proPageStyles = `
  .luma-pro {
    min-height: 100vh;
    padding: 28px 16px 64px;
    background:
      radial-gradient(circle at top right, rgba(181, 155, 255, 0.18), transparent 28%),
      radial-gradient(circle at top left, rgba(181, 155, 255, 0.12), transparent 30%),
      var(--background-gradient);
  }

  .luma-pro__shell {
    width: min(1160px, 100%);
    margin: 0 auto;
    display: grid;
    gap: 18px;
  }

  .luma-pro__hero,
  .luma-pro__section {
    background: var(--card);
    border: 1px solid var(--border);
    border-radius: 28px;
    box-shadow: var(--shadow);
  }

  .luma-pro__hero {
    position: relative;
    overflow: hidden;
    padding: clamp(28px, 5vw, 44px);
    background:
      radial-gradient(circle at top right, rgba(181, 155, 255, 0.18), transparent 28%),
      linear-gradient(145deg, rgba(181, 155, 255, 0.18), rgba(255, 255, 255, 0.86));
  }

  html[data-theme="dark"] .luma-pro__hero {
    background:
      radial-gradient(circle at top right, rgba(181, 155, 255, 0.16), transparent 28%),
      linear-gradient(145deg, rgba(181, 155, 255, 0.16), rgba(24, 20, 40, 0.92));
  }

  .luma-pro__heroGrid {
    display: grid;
    grid-template-columns: minmax(0, 1.15fr) minmax(280px, 0.85fr);
    gap: 24px;
    align-items: center;
  }

  .luma-pro__eyebrow {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    width: fit-content;
    padding: 8px 14px;
    border-radius: 999px;
    background: rgba(255, 255, 255, 0.74);
    color: var(--accent-strong);
    font-size: 0.76rem;
    font-weight: 800;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }

  html[data-theme="dark"] .luma-pro__eyebrow {
    background: rgba(20, 16, 34, 0.82);
  }

  .luma-pro__title {
    margin: 18px 0 14px;
    color: var(--foreground);
    font-size: clamp(2.5rem, 6vw, 4.8rem);
    line-height: 0.95;
    letter-spacing: -0.06em;
    max-width: 700px;
  }

  .luma-pro__copy {
    margin: 0;
    max-width: 640px;
    color: var(--foreground-muted);
    font-size: 1rem;
    line-height: 1.8;
  }

  .luma-pro__actions {
    display: flex;
    flex-wrap: wrap;
    gap: 12px;
    align-items: center;
    margin-top: 22px;
  }

  .luma-pro__cta,
  .luma-pro__secondary {
    min-height: 50px;
    padding: 0 18px;
    border-radius: 16px;
    font-weight: 800;
    text-decoration: none;
  }

  .luma-pro__cta {
    border: none;
    background: linear-gradient(135deg, var(--accent-strong), var(--accent));
    color: #ffffff;
    box-shadow: 0 20px 36px rgba(140, 111, 255, 0.22);
    cursor: pointer;
  }

  .luma-pro__secondary {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border: 1px solid var(--border);
    background: var(--card);
    color: var(--foreground);
  }

  .luma-pro__pricingCard {
    display: grid;
    gap: 16px;
    padding: 24px;
    border-radius: 24px;
    border: 1px solid rgba(181, 155, 255, 0.28);
    background:
      linear-gradient(145deg, rgba(181, 155, 255, 0.16), rgba(255, 255, 255, 0.82));
    box-shadow: var(--shadow);
  }

  html[data-theme="dark"] .luma-pro__pricingCard {
    background:
      linear-gradient(145deg, rgba(181, 155, 255, 0.14), rgba(24, 20, 40, 0.9));
  }

  .luma-pro__pricingLabel {
    margin: 0;
    color: var(--accent-strong);
    font-size: 0.8rem;
    font-weight: 800;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }

  .luma-pro__price {
    display: flex;
    align-items: baseline;
    gap: 8px;
    color: var(--foreground);
  }

  .luma-pro__priceValue {
    font-size: clamp(3rem, 5vw, 4rem);
    font-weight: 900;
    letter-spacing: -0.08em;
    line-height: 1;
  }

  .luma-pro__priceMeta {
    color: var(--foreground-muted);
    font-weight: 700;
  }

  .luma-pro__pricingCopy {
    margin: 0;
    color: var(--foreground-muted);
    line-height: 1.7;
  }

  .luma-pro__pillRow {
    display: flex;
    flex-wrap: wrap;
    gap: 10px;
  }

  .luma-pro__pill {
    display: inline-flex;
    align-items: center;
    min-height: 34px;
    padding: 0 12px;
    border-radius: 999px;
    background: rgba(181, 155, 255, 0.12);
    color: var(--accent-strong);
    font-size: 0.78rem;
    font-weight: 700;
  }

  .luma-pro__section {
    padding: 24px;
    display: grid;
    gap: 18px;
  }

  .luma-pro__sectionHeader {
    display: grid;
    gap: 8px;
  }

  .luma-pro__sectionEyebrow {
    margin: 0;
    color: var(--accent-strong);
    font-size: 0.78rem;
    font-weight: 800;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }

  .luma-pro__sectionTitle {
    margin: 0;
    color: var(--foreground);
    font-size: clamp(1.6rem, 3vw, 2.2rem);
    letter-spacing: -0.04em;
  }

  .luma-pro__sectionCopy {
    margin: 0;
    color: var(--foreground-muted);
    line-height: 1.7;
    max-width: 760px;
  }

  .luma-pro__featureGrid,
  .luma-pro__testimonialGrid {
    display: grid;
    gap: 16px;
  }

  .luma-pro__featureGrid {
    grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  }

  .luma-pro__featureCard,
  .luma-pro__testimonial {
    display: grid;
    gap: 12px;
    padding: 20px;
    border-radius: 22px;
    border: 1px solid var(--border);
    background: color-mix(in srgb, var(--card) 92%, rgba(181, 155, 255, 0.08));
    box-shadow: var(--shadow);
  }

  .luma-pro__featureIcon {
    width: 46px;
    height: 46px;
    display: grid;
    place-items: center;
    border-radius: 16px;
    background: rgba(181, 155, 255, 0.14);
    color: var(--accent-strong);
    border: 1px solid rgba(181, 155, 255, 0.2);
  }

  .luma-pro__featureIcon svg {
    width: 22px;
    height: 22px;
    stroke: currentColor;
  }

  .luma-pro__featureTitle,
  .luma-pro__testimonialName {
    margin: 0;
    color: var(--foreground);
    font-size: 1rem;
    font-weight: 800;
  }

  .luma-pro__featureCopy,
  .luma-pro__testimonialCopy {
    margin: 0;
    color: var(--foreground-muted);
    line-height: 1.65;
    font-size: 0.94rem;
  }

  .luma-pro__pricingGrid {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(260px, 320px);
    gap: 18px;
    align-items: start;
  }

  .luma-pro__pricingList {
    margin: 0;
    padding: 0;
    list-style: none;
    display: grid;
    gap: 12px;
  }

  .luma-pro__pricingItem {
    display: grid;
    grid-template-columns: 24px minmax(0, 1fr);
    gap: 10px;
    align-items: start;
    color: var(--foreground-muted);
    line-height: 1.65;
  }

  .luma-pro__pricingCheck {
    width: 24px;
    height: 24px;
    display: grid;
    place-items: center;
    border-radius: 999px;
    background: rgba(181, 155, 255, 0.14);
    color: var(--accent-strong);
    font-size: 0.82rem;
    font-weight: 900;
    margin-top: 1px;
  }

  .luma-pro__testimonialGrid {
    grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  }

  .luma-pro__testimonialRole {
    color: var(--accent-strong);
    font-size: 0.78rem;
    font-weight: 800;
    letter-spacing: 0.05em;
    text-transform: uppercase;
  }

  @media (max-width: 920px) {
    .luma-pro__heroGrid,
    .luma-pro__pricingGrid {
      grid-template-columns: 1fr;
    }
  }

  @media (max-width: 720px) {
    .luma-pro {
      padding: 18px 14px 48px;
    }

    .luma-pro__section,
    .luma-pro__hero {
      border-radius: 24px;
      padding: 22px;
    }
  }
`;

const featureRows = [
  {
    title: "Advanced study tools",
    description:
      "Unlock flashcards, image-to-notes, voice input, and focused session tools from one premium workspace.",
    icon: "cards",
  },
  {
    title: "Premium AI workflows",
    description:
      "Keep deeper AI-powered note creation and transcription tools ready when you need them.",
    icon: "spark",
  },
  {
    title: "Calm premium experience",
    description:
      "Enjoy a smoother, more intentional study environment with priority access to what comes next.",
    icon: "glow",
  },
  {
    title: "Contextual shortcuts",
    description:
      "Move between chat, study tools, and premium shortcuts without breaking focus.",
    icon: "arrow",
  },
];

const testimonialRows = [
  {
    name: "Placeholder testimonial",
    role: "Focused learner",
    quote:
      "A short premium testimonial will live here once customer stories are ready to share.",
  },
  {
    name: "Placeholder testimonial",
    role: "Student workflow",
    quote:
      "This space is ready for a concise quote about calmer studying, sharper tools, and faster progress.",
  },
  {
    name: "Placeholder testimonial",
    role: "Creator note",
    quote:
      "Use this card later for social proof that explains why Luma Pro feels different in everyday study.",
  },
];

function ProFeatureIcon({ icon }: { icon: string }) {
  if (icon === "cards") {
    return (
      <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <rect x="6" y="5" width="12" height="8" rx="2" strokeWidth="1.8" />
        <rect x="4" y="11" width="12" height="8" rx="2" strokeWidth="1.8" />
      </svg>
    );
  }

  if (icon === "spark") {
    return (
      <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path
          d="M12 3l1.7 5.3L19 10l-5.3 1.7L12 17l-1.7-5.3L5 10l5.3-1.7L12 3z"
          strokeWidth="1.8"
          strokeLinejoin="round"
        />
      </svg>
    );
  }

  if (icon === "glow") {
    return (
      <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <circle cx="12" cy="12" r="4.5" strokeWidth="1.8" />
        <path
          d="M12 2.5v3M12 18.5v3M21.5 12h-3M5.5 12h-3M18.7 5.3l-2.1 2.1M7.4 16.6l-2.1 2.1M18.7 18.7l-2.1-2.1M7.4 7.4L5.3 5.3"
          strokeWidth="1.8"
          strokeLinecap="round"
        />
      </svg>
    );
  }

  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M5 12h14M13 5l7 7-7 7"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export default function ProPage() {
  const { user } = useAuth();
  const [upgradeOpen, setUpgradeOpen] = useState(false);
  const isPremium = user?.subscription_status === "premium";

  return (
    <>
      <style>{proPageStyles}</style>

      <main className="luma-pro">
        <div className="luma-pro__shell">
          <section className="luma-pro__hero">
            <div className="luma-pro__heroGrid">
              <div>
                <span className="luma-pro__eyebrow">
                  <span>Luma Pro</span>
                </span>
                <h1 className="luma-pro__title">
                  Premium tools for a calmer, deeper study flow.
                </h1>
                <p className="luma-pro__copy">
                  Luma Pro brings your most powerful study tools into one quiet,
                  polished workspace. Unlock advanced workflows, premium AI
                  tools, and a sharper path from notes to mastery.
                </p>

                <div className="luma-pro__actions">
                  <button
                    type="button"
                    className="luma-pro__cta"
                    onClick={() => {
                      setUpgradeOpen(true);
                    }}
                  >
                    {isPremium ? "View Luma Pro details" : "Upgrade to Luma Pro"}
                  </button>

                  <Link className="luma-pro__secondary" to="/dashboard">
                    Back to workspace
                  </Link>
                </div>
              </div>

              <div className="luma-pro__pricingCard">
                <p className="luma-pro__pricingLabel">Premium access</p>
                <div className="luma-pro__price">
                  <span className="luma-pro__priceValue">$12</span>
                  <span className="luma-pro__priceMeta">/ month</span>
                </div>
                <p className="luma-pro__pricingCopy">
                  One plan, one polished study suite. Start with the upgrade
                  flow whenever you are ready.
                </p>
                <div className="luma-pro__pillRow">
                  <span className="luma-pro__pill">Flashcards</span>
                  <span className="luma-pro__pill">Image to Notes</span>
                  <span className="luma-pro__pill">Voice Input</span>
                  <span className="luma-pro__pill">Study Session</span>
                </div>
              </div>
            </div>
          </section>

          <section className="luma-pro__section">
            <div className="luma-pro__sectionHeader">
              <p className="luma-pro__sectionEyebrow">Feature Breakdown</p>
              <h2 className="luma-pro__sectionTitle">
                Built for focused, premium study sessions.
              </h2>
              <p className="luma-pro__sectionCopy">
                Every Pro feature is designed to reduce friction, keep your
                tools close, and help you move from input to understanding more
                smoothly.
              </p>
            </div>

            <div className="luma-pro__featureGrid">
              {featureRows.map((feature) => (
                <article key={feature.title} className="luma-pro__featureCard">
                  <span className="luma-pro__featureIcon" aria-hidden="true">
                    <ProFeatureIcon icon={feature.icon} />
                  </span>
                  <h3 className="luma-pro__featureTitle">{feature.title}</h3>
                  <p className="luma-pro__featureCopy">{feature.description}</p>
                </article>
              ))}
            </div>
          </section>

          <section className="luma-pro__section">
            <div className="luma-pro__sectionHeader">
              <p className="luma-pro__sectionEyebrow">Pricing</p>
              <h2 className="luma-pro__sectionTitle">
                One simple plan for the full premium suite.
              </h2>
            </div>

            <div className="luma-pro__pricingGrid">
              <ul className="luma-pro__pricingList">
                <li className="luma-pro__pricingItem">
                  <span className="luma-pro__pricingCheck">+</span>
                  <span>Unlock every premium study tool from one plan.</span>
                </li>
                <li className="luma-pro__pricingItem">
                  <span className="luma-pro__pricingCheck">+</span>
                  <span>Keep premium shortcuts visible across navigation and chat.</span>
                </li>
                <li className="luma-pro__pricingItem">
                  <span className="luma-pro__pricingCheck">+</span>
                  <span>Move into the existing secure upgrade flow when you are ready.</span>
                </li>
              </ul>

              <div className="luma-pro__pricingCard">
                <p className="luma-pro__pricingLabel">Luma Pro</p>
                <div className="luma-pro__price">
                  <span className="luma-pro__priceValue">$12</span>
                  <span className="luma-pro__priceMeta">/ month</span>
                </div>
                <p className="luma-pro__pricingCopy">
                  A premium workspace for learners who want deeper tools without
                  clutter or friction.
                </p>
                <button
                  type="button"
                  className="luma-pro__cta"
                  onClick={() => {
                    setUpgradeOpen(true);
                  }}
                >
                  Open upgrade details
                </button>
              </div>
            </div>
          </section>

          <section className="luma-pro__section">
            <div className="luma-pro__sectionHeader">
              <p className="luma-pro__sectionEyebrow">Testimonials</p>
              <h2 className="luma-pro__sectionTitle">
                Space ready for future customer proof.
              </h2>
              <p className="luma-pro__sectionCopy">
                These placeholders keep the layout ready for premium user
                stories without introducing fictional endorsements today.
              </p>
            </div>

            <div className="luma-pro__testimonialGrid">
              {testimonialRows.map((item, index) => (
                <article
                  key={`${item.name}-${index}`}
                  className="luma-pro__testimonial"
                >
                  <p className="luma-pro__testimonialRole">{item.role}</p>
                  <h3 className="luma-pro__testimonialName">{item.name}</h3>
                  <p className="luma-pro__testimonialCopy">{item.quote}</p>
                </article>
              ))}
            </div>
          </section>
        </div>
      </main>

      <UpgradeModal
        open={upgradeOpen}
        onClose={() => {
          setUpgradeOpen(false);
        }}
        featureName="Luma Pro"
      />
    </>
  );
}
