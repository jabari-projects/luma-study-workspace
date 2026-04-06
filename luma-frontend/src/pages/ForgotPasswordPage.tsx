import { useMemo, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import {
  getApiErrorMessage,
  sendPasswordResetLink,
} from "../api/api";

const lavenderAccent = "#b59bff";
const lavenderAccentStrong = "#8c6fff";

function validateEmail(email: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [emailError, setEmailError] = useState("");
  const [submitError, setSubmitError] = useState("");
  const [successMessage, setSuccessMessage] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);

  const canSubmit = useMemo(() => email.trim().length > 0, [email]);

  function validateForm() {
    const trimmedEmail = email.trim();

    if (!trimmedEmail) {
      setEmailError("Email is required.");
      return false;
    }

    if (!validateEmail(trimmedEmail)) {
      setEmailError("Enter a valid email address.");
      return false;
    }

    setEmailError("");
    return true;
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!validateForm()) {
      return;
    }

    setIsSubmitting(true);
    setSubmitError("");
    setSuccessMessage("");

    try {
      const response = await sendPasswordResetLink(email.trim());
      setSuccessMessage(response.message);
    } catch (error) {
      setSubmitError(
        getApiErrorMessage(error, "Unable to send a reset link right now."),
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
          maxWidth: 1020,
          display: "grid",
          gridTemplateColumns: "minmax(0, 1fr) minmax(320px, 420px)",
          gap: 16,
          alignItems: "stretch",
        }}
      >
        <section
          style={{
            position: "relative",
            overflow: "hidden",
            borderRadius: 16,
            padding: 16,
            background: "var(--card)",
            border: "1px solid var(--border)",
            boxShadow: "var(--shadow)",
            minHeight: 560,
          }}
        >
          <div
            style={{
              position: "absolute",
              inset: "auto -80px -100px auto",
              width: 260,
              height: 260,
              borderRadius: "50%",
              background: "rgba(181, 155, 255, 0.2)",
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
              Password Reset
            </span>

            <h1
              style={{
                margin: "12px 0",
                fontSize: "clamp(2.3rem, 4vw, 4rem)",
                lineHeight: 1.03,
                color: "var(--luma-text, #1d1730)",
              }}
            >
              Regain access without the stress.
            </h1>

            <p
              style={{
                margin: 0,
                maxWidth: 470,
                fontSize: 17,
                lineHeight: 1.7,
                color: "var(--luma-text-muted, #6a6284)",
              }}
            >
              Enter the email tied to your Luma account and we will prepare a
              reset link. For security, Luma always returns the same response
              whether or not that email exists in the system.
            </p>

            <div
              style={{
                marginTop: 12,
                display: "grid",
                gap: 12,
              }}
            >
              {[ 
                "Uses the same email you sign in with",
                "Keeps the response generic for account privacy",
                "Works with the live backend reset request endpoint",
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
                    lineHeight: 1.55,
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
            <h2
              style={{
                margin: 0,
                fontSize: 30,
                color: "var(--luma-text, #1d1730)",
              }}
            >
              Forgot your password?
            </h2>
            <p
              style={{
                margin: "12px 0 0",
                color: "var(--luma-text-muted, #6a6284)",
                lineHeight: 1.6,
              }}
            >
              Send a reset link to your email and continue the recovery flow
              from there.
            </p>
          </div>

          <form onSubmit={handleSubmit} noValidate>
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
                value={email}
                onChange={(event) => {
                  setEmail(event.target.value);
                  setEmailError("");
                  setSubmitError("");
                  setSuccessMessage("");
                }}
                placeholder="you@company.com"
                aria-invalid={Boolean(emailError)}
                style={{
                  width: "100%",
                  boxSizing: "border-box",
                  padding: 16,
                  borderRadius: 16,
                  border: `1px solid ${emailError ? "#e27891" : "var(--border)"}`,
                  background: "var(--card)",
                  color: "var(--luma-text, #1d1730)",
                  fontSize: 15,
                  outline: "none",
                }}
              />
              {emailError ? (
                <span style={{ color: "#c44f6e", fontSize: 13 }}>
                  {emailError}
                </span>
              ) : null}
            </label>

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

            {successMessage ? (
              <div
                role="status"
                style={{
                  marginTop: 12,
                  padding: 16,
                  borderRadius: 16,
                  background: "rgba(112, 199, 167, 0.12)",
                  border: "1px solid rgba(112, 199, 167, 0.22)",
                  color: "#2f7f64",
                  fontSize: 14,
                  lineHeight: 1.5,
                }}
              >
                {successMessage}
              </div>
            ) : null}

            <button
              type="submit"
              disabled={!canSubmit || isSubmitting}
              style={{
                width: "100%",
                marginTop: 12,
                border: "none",
                borderRadius: 16,
                padding: 16,
                background: `linear-gradient(135deg, ${lavenderAccentStrong}, ${lavenderAccent})`,
                color: "#ffffff",
                fontSize: 15,
                fontWeight: 700,
                cursor: !canSubmit || isSubmitting ? "not-allowed" : "pointer",
                opacity: !canSubmit || isSubmitting ? 0.7 : 1,
                boxShadow: "var(--shadow)",
              }}
            >
              {isSubmitting ? "Sending..." : "Send reset link"}
            </button>
          </form>

          <div
            style={{
              marginTop: 12,
              display: "grid",
              gap: 10,
              justifyItems: "center",
              color: "var(--luma-text-muted, #6a6284)",
              fontSize: 14,
            }}
          >
            <Link
              to="/login"
              style={{
                color: lavenderAccentStrong,
                fontWeight: 700,
                textDecoration: "none",
              }}
            >
              Back to sign in
            </Link>
            <Link
              to="/reset-password"
              style={{
                color: lavenderAccentStrong,
                fontWeight: 700,
                textDecoration: "none",
              }}
            >
              Already have a reset link? Continue here
            </Link>
          </div>
        </section>
      </div>
    </div>
  );
}
