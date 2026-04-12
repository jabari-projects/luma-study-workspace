import { useMemo, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import { useTheme } from "../context/ThemeContext";

type LoginValues = {
  email: string;
  password: string;
};

type LoginErrors = Partial<Record<keyof LoginValues, string>>;

const lavenderAccent = "#b59bff";
const lavenderAccentStrong = "#8c6fff";
const loginResponsiveStyles = `
  .luma-login-label {
    font-size: 14px;
    font-weight: 600;
    color: var(--luma-text, #1d1730);
  }

  html[data-theme="dark"] .luma-login-label {
    color: #e5e7eb;
  }

  .luma-login-submit,
  .luma-login-link,
  .luma-login-forgot {
    transition:
      background-color 200ms ease,
      color 200ms ease,
      box-shadow 200ms ease,
      transform 200ms ease;
  }

  .luma-login-submit:focus-visible,
  .luma-login-link:focus-visible,
  .luma-login-forgot:focus-visible {
    outline: none;
    box-shadow: 0 0 0 4px rgba(99, 102, 241, 0.16);
  }

  @media (max-width: 767px) {
    .luma-login-page {
      padding-left: 16px !important;
      padding-right: 16px !important;
    }

    .luma-login-layout {
      grid-template-columns: 1fr !important;
      gap: 24px !important;
    }

    .luma-login-card {
      width: 100% !important;
      max-width: 100% !important;
      margin-left: auto;
      margin-right: auto;
    }
  }

  @media (min-width: 640px) and (max-width: 767px) {
    .luma-login-page {
      padding-left: 16px !important;
      padding-right: 16px !important;
    }
  }

  @media (min-width: 768px) and (max-width: 1023px) {
    .luma-login-page {
      padding-left: 32px !important;
      padding-right: 32px !important;
    }
  }

  @media (min-width: 1024px) {
    .luma-login-page {
      padding-left: 32px !important;
      padding-right: 32px !important;
    }
  }
`;

function validateEmail(email: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

export default function LoginPage() {
  const { login } = useAuth();
  const { themeMode } = useTheme();
  const [values, setValues] = useState<LoginValues>({
    email: "",
    password: "",
  });
  const [errors, setErrors] = useState<LoginErrors>({});
  const [submitError, setSubmitError] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [focusedField, setFocusedField] = useState<keyof LoginValues | null>(
    null,
  );
  const [isSubmitHovered, setIsSubmitHovered] = useState(false);

  const canSubmit = useMemo(() => {
    return values.email.trim().length > 0 && values.password.length > 0;
  }, [values.email, values.password]);

  function updateValue(field: keyof LoginValues, value: string) {
    setValues((current) => ({
      ...current,
      [field]: value,
    }));

    setErrors((current) => ({
      ...current,
      [field]: undefined,
    }));

    setSubmitError("");
  }

  function getInputStyle(field: keyof LoginValues, hasError: boolean) {
    const isDarkMode = themeMode === "dark";

    return {
      width: "100%",
      boxSizing: "border-box" as const,
      padding: "14px 16px",
      borderRadius: 12,
      border: `1px solid ${
        hasError
          ? "#e27891"
          : focusedField === field
            ? lavenderAccent
            : isDarkMode
              ? "rgba(38, 38, 38, 0.96)"
              : "var(--border)"
      }`,
      background: isDarkMode
        ? "rgba(23, 23, 23, 0.6)"
        : "var(--card)",
      color: "var(--luma-text, #1d1730)",
      fontSize: 16,
      outline: "none",
      boxShadow:
        focusedField === field
          ? "0 0 0 4px rgba(99, 102, 241, 0.16)"
          : "none",
      transition:
        "border-color 200ms ease, box-shadow 200ms ease, background-color 200ms ease",
    };
  }

  function validateForm() {
    const nextErrors: LoginErrors = {};

    if (!values.email.trim()) {
      nextErrors.email = "Email is required.";
    } else if (!validateEmail(values.email.trim())) {
      nextErrors.email = "Enter a valid email address.";
    }

    if (!values.password) {
      nextErrors.password = "Password is required.";
    }

    setErrors(nextErrors);
    return Object.keys(nextErrors).length === 0;
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!validateForm()) {
      return;
    }

    setIsSubmitting(true);
    setSubmitError("");

    try {
      await login(values.email.trim(), values.password);
    } catch (error) {
      setSubmitError(
        error instanceof Error ? error.message : "Unable to sign in.",
      );
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <>
      <style>{loginResponsiveStyles}</style>
      <div
        className="luma-login-page max-w-full w-full px-4 sm:px-6 md:px-8 lg:px-0"
        style={{
          minHeight: "100vh",
          display: "grid",
          placeItems: "center",
          padding: 16,
        }}
      >
        <div
          className="luma-login-layout flex flex-col gap-6 md:flex-row md:gap-10 max-w-full w-full"
          style={{
            width: "100%",
            maxWidth: 1080,
            display: "grid",
            gridTemplateColumns: "minmax(0, 1.1fr) minmax(320px, 420px)",
            gap: 24,
            alignItems: "stretch",
          }}
        >
        <section
          className="luma-login-card w-full max-w-sm mx-auto px-4 sm:px-6 md:px-0"
          style={{
            position: "relative",
            overflow: "hidden",
            borderRadius: 16,
            padding: 24,
            background: "var(--card)",
            border: "1px solid var(--border)",
            boxShadow: "var(--shadow)",
            minHeight: 560,
          }}
        >
          <div
            style={{
              position: "absolute",
              inset: "auto -80px -120px auto",
              width: 280,
              height: 280,
              borderRadius: "50%",
              background: "rgba(181, 155, 255, 0.22)",
              filter: "blur(8px)",
            }}
          />

          <div
            style={{
              maxWidth: 520,
              position: "relative",
              zIndex: 1,
              display: "grid",
              gap: 24,
            }}
          >
            <span
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 8,
                padding: "8px 14px",
                borderRadius: 999,
                background: "rgba(255, 255, 255, 0.72)",
                color: lavenderAccentStrong,
                fontSize: 13,
                fontWeight: 700,
                letterSpacing: "0.04em",
                textTransform: "uppercase",
              }}
            >
              Luma
            </span>

            <h1
              style={{
                margin: "12px 0",
                fontSize: "clamp(2.4rem, 4vw, 4.25rem)",
                lineHeight: 1.02,
                color: "var(--luma-text, #1d1730)",
              }}
            >
              Welcome back to your space.
            </h1>

            <p
              style={{
                margin: 0,
                maxWidth: 460,
                fontSize: 17,
                lineHeight: 1.7,
                color: "var(--luma-text-muted, #6a6284)",
              }}
            >
              Sign in to return to a calm study space, your saved tools, and
              the next step in your learning flow.
            </p>

            <div
              style={{
                marginTop: 0,
                display: "grid",
                gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))",
                gap: 16,
              }}
            >
              {[
                "Quiet, focused account access",
                "Lavender-Mist light and dark themes",
                "A smooth handoff into onboarding or dashboard",
              ].map((item) => (
                <div
                  key={item}
                  style={{
                    padding: 16,
                    borderRadius: 16,
                    background: "var(--card)",
                    border: "1px solid var(--border)",
                    color: "var(--luma-text, #1d1730)",
                    fontSize: 14,
                    lineHeight: 1.5,
                    boxShadow: "var(--shadow)",
                  }}
                >
                  {item}
                </div>
              ))}
            </div>
          </div>
        </section>

        <section
          className="luma-login-card w-full max-w-sm mx-auto px-4 sm:px-6 md:px-0"
          style={{
            borderRadius: 16,
            background: "var(--card)",
            border: "1px solid var(--border)",
            boxShadow: "var(--shadow)",
            padding: 24,
            alignSelf: "center",
          }}
        >
          <div style={{ marginBottom: 16 }}>
            <h2
              style={{
                margin: 0,
                fontSize: 30,
                color: "var(--luma-text, #1d1730)",
              }}
            >
              Sign in
            </h2>
            <p
              style={{
                margin: "12px 0 0",
                color: "var(--luma-text-muted, #6a6284)",
                lineHeight: 1.6,
              }}
            >
              Enter your details to continue with a calm, minimal workspace.
            </p>
          </div>

          <form onSubmit={handleSubmit} noValidate>
            <div style={{ display: "grid", gap: 16 }}>
              <label style={{ display: "grid", gap: 8 }}>
                <span className="luma-login-label">Email</span>
                <input
                  className="w-full luma-login-input dark:bg-neutral-900/60 dark:border-neutral-800"
                  type="email"
                  inputMode="email"
                  autoComplete="email"
                  value={values.email}
                  onChange={(event) => updateValue("email", event.target.value)}
                  onFocus={() => setFocusedField("email")}
                  onBlur={() => setFocusedField(null)}
                  placeholder="you@company.com"
                  aria-invalid={Boolean(errors.email)}
                  style={getInputStyle("email", Boolean(errors.email))}
                />
                {errors.email ? (
                  <span style={{ color: "#c44f6e", fontSize: 13 }}>
                    {errors.email}
                  </span>
                ) : null}
              </label>

              <label style={{ display: "grid", gap: 8 }}>
                <span className="luma-login-label">Password</span>
                <input
                  className="w-full luma-login-input dark:bg-neutral-900/60 dark:border-neutral-800"
                  type="password"
                  autoComplete="current-password"
                  value={values.password}
                  onChange={(event) =>
                    updateValue("password", event.target.value)
                  }
                  onFocus={() => setFocusedField("password")}
                  onBlur={() => setFocusedField(null)}
                  placeholder="Enter your password"
                  aria-invalid={Boolean(errors.password)}
                  style={getInputStyle("password", Boolean(errors.password))}
                />
                {errors.password ? (
                  <span style={{ color: "#c44f6e", fontSize: 13 }}>
                    {errors.password}
                  </span>
                ) : null}
              </label>
            </div>

            {submitError ? (
              <div
                role="alert"
                style={{
                  marginTop: 12,
                  padding: 16,
                  borderRadius: 16,
                  background: "rgba(226, 120, 145, 0.12)",
                  border: "1px solid rgba(226, 120, 145, 0.28)",
                  color: "#b63d61",
                  fontSize: 14,
                  lineHeight: 1.5,
                }}
              >
                {submitError}
              </div>
            ) : null}

            <button
              className="w-full md:w-auto luma-login-submit"
              type="submit"
              disabled={!canSubmit || isSubmitting}
              onMouseEnter={() => setIsSubmitHovered(true)}
              onMouseLeave={() => setIsSubmitHovered(false)}
              style={{
                width: "100%",
                marginTop: 16,
                border: "none",
                borderRadius: 12,
                padding: "14px 16px",
                background: isSubmitHovered ? "#6366f1" : "#4f46e5",
                color: "#ffffff",
                fontSize: 16,
                fontWeight: 700,
                cursor: !canSubmit || isSubmitting ? "not-allowed" : "pointer",
                opacity: !canSubmit || isSubmitting ? 0.7 : 1,
                boxShadow: isSubmitHovered
                  ? "0 12px 28px rgba(79, 70, 229, 0.22)"
                  : "var(--shadow)",
                transform:
                  isSubmitHovered && canSubmit && !isSubmitting
                    ? "translateY(-1px)"
                    : "translateY(0)",
                transition:
                  "background-color 200ms ease, box-shadow 200ms ease, transform 200ms ease",
              }}
            >
              {isSubmitting ? "Signing in..." : "Continue"}
            </button>
          </form>

          <div
            style={{
              marginTop: 12,
              textAlign: "right",
            }}
          >
            <Link
              to="/forgot-password"
              className="luma-login-forgot"
              style={{
                color: lavenderAccentStrong,
                fontSize: 14,
                fontWeight: 700,
                textDecoration: "none",
              }}
            >
              Forgot password?
            </Link>
          </div>

          <p
            style={{
              margin: "12px 0 0",
              textAlign: "center",
              color: "var(--luma-text-muted, #6a6284)",
              fontSize: 14,
            }}
          >
            Need an account?{" "}
            <Link
              to="/signup"
              className="luma-login-link"
              style={{
                color: lavenderAccentStrong,
                fontWeight: 700,
                textDecoration: "none",
              }}
            >
              Create one
            </Link>
          </p>
        </section>
      </div>
      </div>
    </>
  );
}
