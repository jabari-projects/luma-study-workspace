import { useMemo, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { useAuth } from "../context/AuthContext";

type SignupValues = {
  username: string;
  email: string;
  password: string;
  confirmPassword: string;
};

type SignupErrors = Partial<Record<keyof SignupValues, string>>;

const lavenderAccent = "#b59bff";
const lavenderAccentStrong = "#8c6fff";

function validateEmail(email: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function validateUsername(username: string) {
  return /^[a-zA-Z0-9_]+$/.test(username);
}

export default function SignupPage() {
  const { signup } = useAuth();
  const [values, setValues] = useState<SignupValues>({
    username: "",
    email: "",
    password: "",
    confirmPassword: "",
  });
  const [errors, setErrors] = useState<SignupErrors>({});
  const [submitError, setSubmitError] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [focusedField, setFocusedField] = useState<keyof SignupValues | null>(
    null,
  );
  const [isCreateHovered, setIsCreateHovered] = useState(false);

  const canSubmit = useMemo(() => {
    return (
      values.username.trim().length > 0 &&
      values.email.trim().length > 0 &&
      values.password.length > 0 &&
      values.confirmPassword.length > 0
    );
  }, [
    values.confirmPassword.length,
    values.email,
    values.password.length,
    values.username,
  ]);

  function updateValue(field: keyof SignupValues, value: string) {
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

  function getInputStyle(field: keyof SignupValues, hasError: boolean) {
    return {
      width: "100%",
      boxSizing: "border-box" as const,
      padding: 16,
      borderRadius: 16,
      border: `1px solid ${
        hasError
          ? "#e27891"
          : focusedField === field
            ? lavenderAccent
            : "var(--border)"
      }`,
      background: "var(--card)",
      color: "var(--luma-text, #1d1730)",
      fontSize: 15,
      outline: "none",
      boxShadow:
        focusedField === field
          ? "0 0 0 4px rgba(181, 155, 255, 0.12)"
          : "none",
      transition: "border-color 180ms ease, box-shadow 180ms ease",
    };
  }

  function validateForm() {
    const nextErrors: SignupErrors = {};
    const trimmedUsername = values.username.trim();
    const trimmedEmail = values.email.trim();

    if (!trimmedUsername) {
      nextErrors.username = "Username is required.";
    } else if (trimmedUsername.length < 3) {
      nextErrors.username = "Username must be at least 3 characters.";
    } else if (!validateUsername(trimmedUsername)) {
      nextErrors.username =
        "Username can only contain letters, numbers, and underscores.";
    }

    if (!trimmedEmail) {
      nextErrors.email = "Email is required.";
    } else if (!validateEmail(trimmedEmail)) {
      nextErrors.email = "Enter a valid email address.";
    }

    if (!values.password) {
      nextErrors.password = "Password is required.";
    } else if (values.password.length < 6) {
      nextErrors.password = "Password must be at least 6 characters.";
    }

    if (!values.confirmPassword) {
      nextErrors.confirmPassword = "Please confirm your password.";
    } else if (values.password !== values.confirmPassword) {
      nextErrors.confirmPassword = "Passwords do not match.";
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
      await signup(
        values.email.trim(),
        values.password,
        values.username.trim(),
      );
    } catch (error) {
      setSubmitError(
        error instanceof Error ? error.message : "Unable to create account.",
      );
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <div
      style={{
        minHeight: "100vh",
        display: "grid",
        placeItems: "center",
        padding: 16,
      }}
    >
      <div
        style={{
          width: "100%",
          maxWidth: 1100,
          display: "grid",
          gridTemplateColumns: "minmax(320px, 430px) minmax(0, 1fr)",
          gap: 16,
          alignItems: "stretch",
        }}
      >
        <section
          style={{
            borderRadius: 16,
            background: "var(--card)",
            border: "1px solid var(--border)",
            boxShadow: "var(--shadow)",
            padding: 16,
            alignSelf: "center",
          }}
        >
          <div style={{ marginBottom: 12 }}>
            <span
              style={{
                display: "inline-flex",
                alignItems: "center",
                padding: "8px 14px",
                borderRadius: 999,
                background: "rgba(181, 155, 255, 0.14)",
                color: lavenderAccentStrong,
                fontSize: 12,
                fontWeight: 700,
                letterSpacing: "0.05em",
                textTransform: "uppercase",
              }}
            >
              Start with Luma
            </span>

            <h1
              style={{
                margin: "12px 0",
                fontSize: 30,
                color: "var(--luma-text, #1d1730)",
              }}
            >
              Create your account
            </h1>
            <p
              style={{
                margin: 0,
                color: "var(--luma-text-muted, #6a6284)",
                lineHeight: 1.6,
              }}
            >
              Create a calm, premium-feeling workspace for your notes, study
              tools, and progress.
            </p>
          </div>

          <form onSubmit={handleSubmit} noValidate>
            <div style={{ display: "grid", gap: 16 }}>
              <label style={{ display: "grid", gap: 8 }}>
                <span
                  style={{
                    fontSize: 14,
                    fontWeight: 600,
                    color: "var(--luma-text, #1d1730)",
                  }}
                >
                  Username
                </span>
                <input
                  type="text"
                  autoComplete="username"
                  value={values.username}
                  onChange={(event) =>
                    updateValue("username", event.target.value)
                  }
                  onFocus={() => setFocusedField("username")}
                  onBlur={() => setFocusedField(null)}
                  placeholder="username"
                  aria-invalid={Boolean(errors.username)}
                  style={getInputStyle("username", Boolean(errors.username))}
                />
                <span
                  style={{
                    color: "var(--luma-text-muted, #6a6284)",
                    fontSize: 13,
                    lineHeight: 1.5,
                  }}
                >
                  Choose a username you&apos;ll use across your private
                  workspace.
                </span>
                {errors.username ? (
                  <span style={{ color: "#c44f6e", fontSize: 13 }}>
                    {errors.username}
                  </span>
                ) : null}
              </label>

              <label style={{ display: "grid", gap: 8 }}>
                <span
                  style={{
                    fontSize: 14,
                    fontWeight: 600,
                    color: "var(--luma-text, #1d1730)",
                  }}
                >
                  Email
                </span>
                <input
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
                <span
                  style={{
                    fontSize: 14,
                    fontWeight: 600,
                    color: "var(--luma-text, #1d1730)",
                  }}
                >
                  Password
                </span>
                <input
                  type="password"
                  autoComplete="new-password"
                  value={values.password}
                  onChange={(event) =>
                    updateValue("password", event.target.value)
                  }
                  onFocus={() => setFocusedField("password")}
                  onBlur={() => setFocusedField(null)}
                  placeholder="At least 6 characters"
                  aria-invalid={Boolean(errors.password)}
                  style={getInputStyle("password", Boolean(errors.password))}
                />
                {errors.password ? (
                  <span style={{ color: "#c44f6e", fontSize: 13 }}>
                    {errors.password}
                  </span>
                ) : null}
              </label>

              <label style={{ display: "grid", gap: 8 }}>
                <span
                  style={{
                    fontSize: 14,
                    fontWeight: 600,
                    color: "var(--luma-text, #1d1730)",
                  }}
                >
                  Confirm password
                </span>
                <input
                  type="password"
                  autoComplete="new-password"
                  value={values.confirmPassword}
                  onChange={(event) =>
                    updateValue("confirmPassword", event.target.value)
                  }
                  onFocus={() => setFocusedField("confirmPassword")}
                  onBlur={() => setFocusedField(null)}
                  placeholder="Re-enter your password"
                  aria-invalid={Boolean(errors.confirmPassword)}
                  style={getInputStyle(
                    "confirmPassword",
                    Boolean(errors.confirmPassword),
                  )}
                />
                {errors.confirmPassword ? (
                  <span style={{ color: "#c44f6e", fontSize: 13 }}>
                    {errors.confirmPassword}
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
              type="submit"
              disabled={!canSubmit || isSubmitting}
              onMouseEnter={() => setIsCreateHovered(true)}
              onMouseLeave={() => setIsCreateHovered(false)}
              style={{
                width: "100%",
                marginTop: 12,
                border: "none",
                borderRadius: 16,
                padding: 16,
                background: `linear-gradient(135deg, ${
                  isCreateHovered ? "#7d61f5" : lavenderAccentStrong
                }, ${isCreateHovered ? "#c4b5ff" : lavenderAccent})`,
                color: "#ffffff",
                fontSize: 15,
                fontWeight: 700,
                cursor: !canSubmit || isSubmitting ? "not-allowed" : "pointer",
                opacity: !canSubmit || isSubmitting ? 0.7 : 1,
                boxShadow: isCreateHovered
                  ? "0 18px 36px rgba(140, 111, 255, 0.22)"
                  : "var(--shadow)",
                transform:
                  isCreateHovered && canSubmit && !isSubmitting
                    ? "translateY(-1px)"
                    : "translateY(0)",
                transition:
                  "background 180ms ease, box-shadow 180ms ease, transform 180ms ease",
              }}
            >
              {isSubmitting ? "Creating account..." : "Create account"}
            </button>
          </form>

          <p
            style={{
              margin: "12px 0 0",
              textAlign: "center",
              color: "var(--luma-text-muted, #6a6284)",
              fontSize: 14,
            }}
          >
            Already have an account?{" "}
            <Link
              to="/login"
              style={{
                color: lavenderAccentStrong,
                fontWeight: 700,
                textDecoration: "none",
              }}
            >
              Sign in
            </Link>
          </p>

          <p
            style={{
              margin: "12px 0 0",
              textAlign: "center",
              color: "var(--luma-text-muted, #6a6284)",
              fontSize: 14,
            }}
          >
            Forgot your password?{" "}
            <Link
              to="/forgot-password"
              style={{
                color: lavenderAccentStrong,
                fontWeight: 700,
                textDecoration: "none",
              }}
            >
              Recover access
            </Link>
          </p>
        </section>

        <section
          style={{
            position: "relative",
            overflow: "hidden",
            borderRadius: 16,
            padding: 16,
            background: "var(--card)",
            border: "1px solid var(--border)",
            boxShadow: "var(--shadow)",
            minHeight: 600,
          }}
        >
          <div
            style={{
              position: "absolute",
              inset: "-80px auto auto -60px",
              width: 240,
              height: 240,
              borderRadius: "50%",
              background: "rgba(181, 155, 255, 0.18)",
              filter: "blur(8px)",
            }}
          />

          <div style={{ position: "relative", zIndex: 1, maxWidth: 520 }}>
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
              Lavender-Mist Workspace
            </span>

            <h2
              style={{
                margin: "12px 0",
                fontSize: "clamp(2.3rem, 4vw, 4rem)",
                lineHeight: 1.03,
                color: "var(--luma-text, #1d1730)",
              }}
            >
              Build a private learning space that grows with you.
            </h2>

            <p
              style={{
                margin: 0,
                maxWidth: 470,
                fontSize: 17,
                lineHeight: 1.7,
                color: "var(--luma-text-muted, #6a6284)",
              }}
            >
              Luma gives you a private study environment for notes,
              flashcards, focused sessions, and AI-guided learning support.
            </p>

            <div
              style={{
                marginTop: 12,
                display: "grid",
                gap: 12,
              }}
            >
              {[
                {
                  title: "Set the tone",
                  copy:
                    "Choose your username, theme, and preferences in a workspace that stays personal.",
                },
                {
                  title: "Keep everything together",
                  copy:
                    "Move from onboarding into your dashboard, study tools, and settings without friction.",
                },
                {
                  title: "Start smoothly",
                  copy:
                    "Your account, setup, and next learning step stay connected from the first sign-in.",
                },
              ].map((item) => (
                <div
                  key={item.title}
                  style={{
                    padding: 16,
                    borderRadius: 16,
                    background: "var(--card)",
                    border: "1px solid var(--border)",
                    boxShadow: "var(--shadow)",
                  }}
                >
                  <h3
                    style={{
                      margin: "0 0 8px",
                      color: "var(--luma-text, #1d1730)",
                      fontSize: 16,
                    }}
                  >
                    {item.title}
                  </h3>
                  <p
                    style={{
                      margin: 0,
                      fontSize: 14,
                      lineHeight: 1.55,
                      color: "var(--luma-text-muted, #6a6284)",
                    }}
                  >
                    {item.copy}
                  </p>
                </div>
              ))}
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}
