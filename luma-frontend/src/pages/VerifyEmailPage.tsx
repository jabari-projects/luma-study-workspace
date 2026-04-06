import { useState } from "react";
import { Link, Navigate } from "react-router-dom";
import {
  getApiErrorMessage,
  sendVerificationEmail,
} from "../api/api";
import { useAuth } from "../context/AuthContext";

const verifyEmailStyles = `
  .luma-verify {
    min-height: 100vh;
    display: grid;
    place-items: center;
    padding: 16px;
  }

  .luma-verify__card {
    width: min(720px, 100%);
    padding: 16px;
    border-radius: 16px;
    background: var(--card);
    border: 1px solid var(--border);
    box-shadow: var(--shadow);
    backdrop-filter: blur(18px);
  }

  .luma-verify__eyebrow {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    padding: 8px 14px;
    border-radius: 999px;
    background: rgba(181, 155, 255, 0.14);
    color: var(--accent-strong);
    font-size: 0.78rem;
    font-weight: 800;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }

  .luma-verify__title {
    margin: 12px 0;
    color: var(--foreground);
    font-size: clamp(2rem, 4vw, 3.2rem);
    line-height: 1.04;
    letter-spacing: -0.04em;
  }

  .luma-verify__copy {
    margin: 0;
    color: var(--foreground-muted);
    font-size: 1rem;
    line-height: 1.7;
  }

  .luma-verify__email {
    margin-top: 12px;
    padding: 16px;
    border-radius: 16px;
    background: var(--card);
    border: 1px solid var(--border);
    color: var(--foreground);
  }

  .luma-verify__emailLabel {
    margin: 0 0 8px;
    color: var(--foreground-muted);
    font-size: 0.82rem;
    font-weight: 700;
    letter-spacing: 0.05em;
    text-transform: uppercase;
  }

  .luma-verify__emailValue {
    margin: 0;
    font-size: 1.08rem;
    font-weight: 700;
    word-break: break-word;
  }

  .luma-verify__notes {
    display: grid;
    gap: 12px;
    margin-top: 12px;
  }

  .luma-verify__note {
    padding: 16px;
    border-radius: 16px;
    background: var(--card);
    border: 1px solid var(--border);
    color: var(--foreground-muted);
    line-height: 1.6;
  }

  .luma-verify__message {
    margin-top: 12px;
    padding: 16px;
    border-radius: 16px;
    font-size: 0.95rem;
    line-height: 1.6;
  }

  .luma-verify__message--success {
    background: rgba(112, 199, 167, 0.12);
    border: 1px solid rgba(112, 199, 167, 0.24);
    color: #2f7f64;
  }

  .luma-verify__message--error {
    background: rgba(226, 120, 145, 0.12);
    border: 1px solid rgba(226, 120, 145, 0.28);
    color: #b63d61;
  }

  .luma-verify__actions {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    flex-wrap: wrap;
    margin-top: 12px;
  }

  .luma-verify__link {
    color: var(--accent-strong);
    font-weight: 700;
    text-decoration: none;
  }

  .luma-verify__button {
    min-height: 54px;
    padding: 0 22px;
    border: none;
    border-radius: 16px;
    background: linear-gradient(135deg, var(--accent-strong), var(--accent));
    color: #ffffff;
    font-size: 0.96rem;
    font-weight: 800;
    cursor: pointer;
    box-shadow: var(--shadow);
  }

  .luma-verify__button:disabled {
    cursor: not-allowed;
    opacity: 0.72;
  }

  @media (max-width: 720px) {
    .luma-verify {
      padding: 16px;
    }

    .luma-verify__card {
      padding: 16px;
      border-radius: 16px;
    }
  }
`;

export default function VerifyEmailPage() {
  const { refreshUser, user } = useAuth();
  const [isSending, setIsSending] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [successMessage, setSuccessMessage] = useState("");
  const [errorMessage, setErrorMessage] = useState("");

  if (!user) {
    return null;
  }

  if (user.email_verified) {
    return <Navigate to="/dashboard" replace />;
  }

  async function handleResend() {
    setIsSending(true);
    setSuccessMessage("");
    setErrorMessage("");

    try {
      const response = await sendVerificationEmail();
      setSuccessMessage(response.message);
    } catch (error) {
      setErrorMessage(
        getApiErrorMessage(error, "Unable to resend the verification email."),
      );
    } finally {
      setIsSending(false);
    }
  }

  async function handleRefreshStatus() {
    setIsRefreshing(true);
    setSuccessMessage("");
    setErrorMessage("");

    try {
      const refreshedUser = await refreshUser();

      if (refreshedUser?.email_verified) {
        setSuccessMessage("Your email is verified and your session is up to date.");
      } else {
        setSuccessMessage(
          "Your email is not verified yet. Open the verification link in your inbox, then refresh here.",
        );
      }
    } catch (error) {
      setErrorMessage(
        getApiErrorMessage(error, "Unable to refresh your verification status."),
      );
    } finally {
      setIsRefreshing(false);
    }
  }

  return (
    <>
      <style>{verifyEmailStyles}</style>

      <div className="luma-verify">
        <section className="luma-verify__card">
          <span className="luma-verify__eyebrow">Email Verification</span>
          <h1 className="luma-verify__title">
            We sent a verification link to your email.
          </h1>
          <p className="luma-verify__copy">
            Open the link in your inbox to verify your account. If the message
            has not arrived yet, you can resend it from here and refresh your
            status after you verify.
          </p>

          <div className="luma-verify__email">
            <p className="luma-verify__emailLabel">Verification email</p>
            <p className="luma-verify__emailValue">{user.email}</p>
          </div>

          <div className="luma-verify__notes">
            <div className="luma-verify__note">
              Check your inbox, spam folder, and any filtered tabs if you do not
              see the message right away.
            </div>
            <div className="luma-verify__note">
              Your account still works while unverified, but email verification
              helps confirm ownership and prepares the app for future security
              features.
            </div>
          </div>

          {successMessage ? (
            <div className="luma-verify__message luma-verify__message--success">
              {successMessage}
            </div>
          ) : null}

          {errorMessage ? (
            <div className="luma-verify__message luma-verify__message--error">
              {errorMessage}
            </div>
          ) : null}

          <div className="luma-verify__actions">
            <Link className="luma-verify__link" to="/dashboard">
              Back to dashboard
            </Link>

            <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
              <button
                className="luma-verify__button"
                type="button"
                disabled={isRefreshing}
                onClick={() => {
                  void handleRefreshStatus();
                }}
              >
                {isRefreshing ? "Refreshing..." : "Refresh status"}
              </button>

              <button
                className="luma-verify__button"
                type="button"
                disabled={isSending}
                onClick={() => {
                  void handleResend();
                }}
              >
                {isSending ? "Resending..." : "Resend verification email"}
              </button>
            </div>
          </div>
        </section>
      </div>
    </>
  );
}
