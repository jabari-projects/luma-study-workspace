import { useMemo, useState, type FormEvent } from "react";
import { Link, useSearchParams } from "react-router-dom";
import {
  getApiErrorMessage,
  resetPasswordRequest,
} from "../api/api";

const lavenderAccent = "#b59bff";
const lavenderAccentStrong = "#8c6fff";

export default function ResetPasswordPage() {
  const [searchParams] = useSearchParams();
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [passwordError, setPasswordError] = useState("");
  const [confirmPasswordError, setConfirmPasswordError] = useState("");
  const [submitError, setSubmitError] = useState("");
  const [successMessage, setSuccessMessage] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const resetToken = searchParams.get("token")?.trim() ?? "";

  const canSubmit = useMemo(() => {
    return (
      resetToken.length > 0 &&
      password.length > 0 &&
      confirmPassword.length > 0
    );
  }, [confirmPassword.length, password.length, resetToken.length]);

  function validateForm() {
    let isValid = true;

    if (!password) {
      setPasswordError("New password is required.");
      isValid = false;
    } else if (password.length < 6) {
      setPasswordError("Password must be at least 6 characters.");
      isValid = false;
    } else {
      setPasswordError("");
    }

    if (!confirmPassword) {
      setConfirmPasswordError("Please confirm your new password.");
      isValid = false;
    } else if (password !== confirmPassword) {
      setConfirmPasswordError("Passwords do not match.");
      isValid = false;
    } else {
      setConfirmPasswordError("");
    }

    if (!resetToken) {
      setSubmitError("This reset link is missing a token. Request a new one.");
      isValid = false;
    }

    return isValid;
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
      const response = await resetPasswordRequest(resetToken, password);
      setSuccessMessage(response.message);
      setPassword("");
      setConfirmPassword("");
    } catch (error) {
      setSubmitError(
        getApiErrorMessage(error, "Unable to reset the password right now."),
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
          gridTemplateColumns: "minmax(320px, 420px) minmax(0, 1fr)",
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
              New Password
            </span>

            <h1
              style={{
                margin: "12px 0",
                fontSize: 30,
                color: "var(--luma-text, #1d1730)",
              }}
            >
              Reset your password
            </h1>
            <p
              style={{
                margin: 0,
                color: "var(--luma-text-muted, #6a6284)",
                lineHeight: 1.6,
              }}
            >
              Choose a new password to finish the recovery flow. This page uses
              the reset token from your link and submits it to the backend reset
              endpoint.
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
                  New password
                </span>
                <input
                  type="password"
                  autoComplete="new-password"
                  value={password}
                  onChange={(event) => {
                    setPassword(event.target.value);
                    setPasswordError("");
                    setSubmitError("");
                    setSuccessMessage("");
                  }}
                  placeholder="At least 6 characters"
                  aria-invalid={Boolean(passwordError)}
                  style={{
                    width: "100%",
                    boxSizing: "border-box",
                    padding: 16,
                    borderRadius: 16,
                    border: `1px solid ${passwordError ? "#e27891" : "var(--border)"}`,
                    background: "var(--card)",
                    color: "var(--luma-text, #1d1730)",
                    fontSize: 15,
                    outline: "none",
                  }}
                />
                {passwordError ? (
                  <span style={{ color: "#c44f6e", fontSize: 13 }}>
                    {passwordError}
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
                  value={confirmPassword}
                  onChange={(event) => {
                    setConfirmPassword(event.target.value);
                    setConfirmPasswordError("");
                    setSubmitError("");
                    setSuccessMessage("");
                  }}
                  placeholder="Re-enter your new password"
                  aria-invalid={Boolean(confirmPasswordError)}
                  style={{
                    width: "100%",
                    boxSizing: "border-box",
                    padding: 16,
                    borderRadius: 16,
                    border: `1px solid ${
                      confirmPasswordError ? "#e27891" : "var(--border)"
                    }`,
                    background: "var(--card)",
                    color: "var(--luma-text, #1d1730)",
                    fontSize: 15,
                    outline: "none",
                  }}
                />
                {confirmPasswordError ? (
                  <span style={{ color: "#c44f6e", fontSize: 13 }}>
                    {confirmPasswordError}
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

            {!resetToken && !submitError ? (
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
                This reset link is incomplete. Request a new reset email to get
                a fresh token.
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
              {isSubmitting ? "Resetting..." : "Reset password"}
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
              to="/forgot-password"
              style={{
                color: lavenderAccentStrong,
                fontWeight: 700,
                textDecoration: "none",
              }}
            >
              Need a reset link first?
            </Link>
          </div>
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
            minHeight: 560,
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
              Secure Recovery
            </span>

            <h2
              style={{
                margin: "12px 0",
                fontSize: "clamp(2.3rem, 4vw, 4rem)",
                lineHeight: 1.03,
                color: "var(--luma-text, #1d1730)",
              }}
            >
              Set a fresh password and step back in.
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
              The reset flow validates your new password locally, then hands the
              token and password to the backend for final verification.
            </p>

            <div
              style={{
                marginTop: 12,
                display: "grid",
                gap: 12,
              }}
            >
              {[
                "Validates password strength and confirmation",
                "Uses the same lavender-mist auth styling",
                "Shows a clear fallback when the reset token is missing",
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
      </div>
    </div>
  );
}
