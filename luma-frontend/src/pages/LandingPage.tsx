import { Link } from "react-router-dom";
import LumaStar from "../assets/luma-star.png";
import { useAuth } from "../context/AuthContext";

const featureCards = [
  {
    title: "Workspace",
    description:
      "Create a focused workspace with your avatar, theme, and study preferences.",
  },
  {
    title: "Themes",
    description:
      "Shape your study environment with light or dark mode and a calm accent palette.",
  },
  {
    title: "Search your notes",
    description:
      "Find your notes, flashcards, and study sessions quickly with focused search.",
  },
  {
    title: "Account",
    description:
      "Manage your settings, subscription, and study experience from one polished workspace.",
  },
];

export default function LandingPage() {
  const { isAuthenticated } = useAuth();

  return (
    <div
      style={{
        minHeight: "100vh",
        padding: "32px 20px 56px",
      }}
    >
      <style>
        {`
          .hero-star {
            width: 80px;
            height: auto;
            margin-bottom: 12px;
            animation: float 4s ease-in-out infinite;
          }

          @keyframes float {
            0% { transform: translateY(0px); }
            50% { transform: translateY(-6px); }
            100% { transform: translateY(0px); }
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
        <header
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            gap: 16,
            flexWrap: "wrap",
          }}
        >
          <Link
            to="/"
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 10,
              textDecoration: "none",
              color: "var(--foreground)",
              fontSize: 22,
              fontWeight: 800,
              letterSpacing: "-0.03em",
            }}
          >
            <span
              style={{
                width: 40,
                height: 40,
                display: "grid",
                placeItems: "center",
                borderRadius: 14,
                background: "linear-gradient(135deg, var(--accent-strong), var(--accent))",
                color: "#ffffff",
                boxShadow: "0 16px 32px rgba(140, 111, 255, 0.26)",
              }}
            >
              L
            </span>
            <span>Luma</span>
          </Link>

          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 12,
              flexWrap: "wrap",
            }}
          >
            <Link
              to={isAuthenticated ? "/dashboard" : "/login"}
              style={{
                textDecoration: "none",
                color: "var(--foreground)",
                fontWeight: 700,
                padding: "12px 16px",
                borderRadius: 16,
                border: "1px solid var(--border)",
                background: "var(--card)",
                boxShadow: "var(--shadow)",
              }}
            >
              {isAuthenticated ? "Dashboard" : "Sign In"}
            </Link>
            <Link
              to="/signup"
              style={{
                textDecoration: "none",
                color: "#ffffff",
                fontWeight: 800,
                padding: "12px 18px",
                borderRadius: 16,
                background: "linear-gradient(135deg, var(--accent-strong), var(--accent))",
                boxShadow: "0 18px 36px rgba(140, 111, 255, 0.28)",
              }}
            >
              Get Started
            </Link>
          </div>
        </header>

        <section
          style={{
            position: "relative",
            overflow: "hidden",
            borderRadius: 36,
            border: "1px solid var(--border)",
            background:
              "linear-gradient(145deg, rgba(181, 155, 255, 0.2), rgba(255, 255, 255, 0.7))",
            boxShadow: "var(--shadow)",
            padding: "clamp(28px, 6vw, 64px)",
          }}
        >
          <div
            style={{
              position: "absolute",
              inset: "auto -110px -120px auto",
              width: 300,
              height: 300,
              borderRadius: "50%",
              background: "rgba(181, 155, 255, 0.18)",
              filter: "blur(14px)",
            }}
          />

          <div
            style={{
              position: "absolute",
              inset: "-120px auto auto -80px",
              width: 240,
              height: 240,
              borderRadius: "50%",
              background: "rgba(181, 155, 255, 0.14)",
              filter: "blur(12px)",
            }}
          />

          <div
            className="luma-landing-hero"
            style={{
              position: "relative",
              zIndex: 1,
              display: "grid",
              gap: 28,
              gridTemplateColumns: "minmax(0, 1.3fr) minmax(280px, 0.7fr)",
              alignItems: "center",
            }}
          >
            <div style={{ display: "grid", gap: 18 }}>
              <span
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  width: "fit-content",
                  padding: "8px 14px",
                  borderRadius: 999,
                  background: "rgba(255, 255, 255, 0.72)",
                  color: "var(--accent-strong)",
                  fontSize: 12,
                  fontWeight: 800,
                  letterSpacing: "0.05em",
                  textTransform: "uppercase",
                  border: "1px solid rgba(181, 155, 255, 0.18)",
                }}
              >
                Private Learning Platform
              </span>

              <img src={LumaStar} alt="Luma Star" className="hero-star" />

              <h1
                style={{
                  margin: 0,
                  color: "var(--foreground)",
                  fontSize: "clamp(2.7rem, 6vw, 5.2rem)",
                  lineHeight: 0.96,
                  letterSpacing: "-0.05em",
                  maxWidth: 720,
                }}
              >
                Build a personal learning space that grows with you.
              </h1>

              <p
                style={{
                  margin: 0,
                  maxWidth: 640,
                  color: "var(--foreground-muted)",
                  fontSize: 18,
                  lineHeight: 1.75,
                }}
              >
                Luma is your calm, modern workspace for studying, notes,
                flashcards, AI tools, and steady progress toward mastery.
              </p>

              <div
                style={{
                  display: "flex",
                  gap: 14,
                  flexWrap: "wrap",
                  alignItems: "center",
                }}
              >
                <Link
                  to="/signup"
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    justifyContent: "center",
                    minHeight: 54,
                    padding: "0 22px",
                    borderRadius: 18,
                    textDecoration: "none",
                    background:
                      "linear-gradient(135deg, var(--accent-strong), var(--accent))",
                    color: "#ffffff",
                    fontSize: 16,
                    fontWeight: 800,
                    boxShadow: "0 20px 38px rgba(140, 111, 255, 0.28)",
                  }}
                >
                  Get Started
                </Link>

                <Link
                  to="/search"
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    justifyContent: "center",
                    minHeight: 54,
                    padding: "0 22px",
                    borderRadius: 18,
                    textDecoration: "none",
                    background: "var(--card)",
                    color: "var(--foreground)",
                    fontSize: 16,
                    fontWeight: 700,
                    border: "1px solid var(--border)",
                    boxShadow: "var(--shadow)",
                  }}
                >
                  Explore your tools
                </Link>
              </div>
            </div>

            <div
              style={{
                display: "grid",
                gap: 14,
                alignSelf: "stretch",
              }}
            >
              {[
                "Private workspace built for focus",
                "Light and dark themes that stay calm",
                "Flashcards, notes, and AI tools in one place",
              ].map((item) => (
                <div
                  key={item}
                  style={{
                    padding: "18px 18px 20px",
                    borderRadius: 24,
                    background: "rgba(255, 255, 255, 0.78)",
                    border: "1px solid rgba(181, 155, 255, 0.18)",
                    boxShadow: "0 18px 40px rgba(72, 53, 121, 0.1)",
                    color: "var(--foreground)",
                    fontWeight: 700,
                    lineHeight: 1.55,
                  }}
                >
                  {item}
                </div>
              ))}
            </div>
          </div>
        </section>

        <section
          style={{
            display: "grid",
            gap: 18,
          }}
        >
          <div style={{ display: "grid", gap: 10, maxWidth: 720 }}>
            <span
              style={{
                color: "var(--accent-strong)",
                fontSize: 12,
                fontWeight: 800,
                letterSpacing: "0.05em",
                textTransform: "uppercase",
              }}
            >
              Why Luma
            </span>
            <h2
              style={{
                margin: 0,
                color: "var(--foreground)",
                fontSize: "clamp(2rem, 4vw, 3rem)",
                lineHeight: 1.05,
              }}
            >
              Everything you need to learn, understand, and make progress.
            </h2>
            <p
              style={{
                margin: 0,
                color: "var(--foreground-muted)",
                fontSize: 16,
                lineHeight: 1.7,
              }}
            >
              Luma is your calm, modern workspace for studying, organizing your
              ideas, and making steady progress.
            </p>
          </div>

          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
              gap: 18,
            }}
          >
            {featureCards.map((feature) => (
              <article
                key={feature.title}
                style={{
                  height: "100%",
                  padding: "24px 22px",
                  borderRadius: 28,
                  background: "var(--card)",
                  border: "1px solid var(--border)",
                  boxShadow: "var(--shadow)",
                }}
              >
                <div
                  style={{
                    width: 46,
                    height: 46,
                    display: "grid",
                    placeItems: "center",
                    borderRadius: 16,
                    marginBottom: 16,
                    background: "rgba(181, 155, 255, 0.14)",
                    color: "var(--accent-strong)",
                    fontWeight: 800,
                    fontSize: 14,
                  }}
                >
                  {feature.title.slice(0, 1)}
                </div>
                <h3
                  style={{
                    margin: "0 0 10px",
                    color: "var(--foreground)",
                    fontSize: 22,
                  }}
                >
                  {feature.title}
                </h3>
                <p
                  style={{
                    margin: 0,
                    color: "var(--foreground-muted)",
                    lineHeight: 1.7,
                    fontSize: 15,
                  }}
                >
                  {feature.description}
                </p>
              </article>
            ))}
          </div>
        </section>
      </div>

      <style>
        {`
          @media (max-width: 920px) {
            .luma-landing-hero {
              grid-template-columns: 1fr;
            }
          }
        `}
      </style>
    </div>
  );
}
