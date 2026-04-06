import { Link } from "react-router-dom";
import { useAuth } from "../context/AuthContext";

type NotFoundPageProps = {
  title?: string;
  message?: string;
};

export default function NotFoundPage({
  title = "Page not found",
  message = "The page you were looking for does not exist or has moved somewhere else in Luma.",
}: NotFoundPageProps) {
  const { isAuthenticated } = useAuth();

  return (
    <div
      style={{
        minHeight: "100vh",
        display: "grid",
        placeItems: "center",
        padding: 16,
      }}
    >
      <section
        style={{
          width: "100%",
          maxWidth: 640,
          padding: 16,
          borderRadius: 16,
          border: "1px solid var(--border)",
          background: "var(--card)",
          boxShadow: "var(--shadow)",
          textAlign: "center",
        }}
      >
        <span
          style={{
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            minWidth: 88,
            minHeight: 40,
            padding: "0 16px",
            borderRadius: 999,
            background: "rgba(181, 155, 255, 0.14)",
            color: "var(--accent-strong)",
            fontSize: 14,
            fontWeight: 800,
            letterSpacing: "0.08em",
            textTransform: "uppercase",
          }}
        >
          404
        </span>

        <h1
          style={{
            margin: "12px 0",
            color: "var(--foreground)",
            fontSize: "clamp(2rem, 4vw, 3rem)",
            lineHeight: 1.04,
            letterSpacing: "-0.04em",
          }}
        >
          {title}
        </h1>

        <p
          style={{
            margin: 0,
            color: "var(--foreground-muted)",
            lineHeight: 1.7,
            fontSize: 16,
          }}
        >
          {message}
        </p>

        <div
          style={{
            marginTop: 12,
            display: "flex",
            justifyContent: "center",
            gap: 12,
            flexWrap: "wrap",
          }}
        >
          <Link
            to={isAuthenticated ? "/dashboard" : "/"}
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
            {isAuthenticated ? "Go to dashboard" : "Return home"}
          </Link>

          <Link
            to="/search"
            style={{
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              minHeight: 48,
              padding: "0 18px",
              borderRadius: 16,
              textDecoration: "none",
              background: "var(--card)",
              border: "1px solid var(--border)",
              color: "var(--foreground)",
              fontWeight: 700,
            }}
          >
            Explore your tools
          </Link>
        </div>
      </section>
    </div>
  );
}
