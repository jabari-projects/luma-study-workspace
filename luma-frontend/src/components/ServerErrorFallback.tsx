type ServerErrorFallbackProps = {
  title?: string;
  message?: string;
  statusCode?: 429 | 500 | number;
  actionLabel?: string;
  onAction?: () => void;
  secondaryHref?: string;
  secondaryLabel?: string;
  fullPage?: boolean;
  maxWidth?: number;
};

const styles = `
  .luma-error-shell {
    width: 100%;
    display: grid;
    place-items: center;
    padding: 16px;
  }

  .luma-error-shell--full {
    min-height: 100vh;
  }

  .luma-error-card {
    width: 100%;
    border-radius: 16px;
    border: 1px solid var(--border);
    background: var(--card);
    box-shadow: var(--shadow);
    padding: 16px;
    color: var(--foreground);
  }

  .luma-error-badge {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 84px;
    min-height: 40px;
    padding: 0 16px;
    border-radius: 999px;
    background: var(--surface-tint-soft);
    color: var(--accent-strong);
    font-size: 0.86rem;
    font-weight: 800;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }

  .luma-error-title {
    margin: 12px 0;
    color: var(--foreground);
    font-size: clamp(1.8rem, 4vw, 2.8rem);
    line-height: 1.04;
    letter-spacing: -0.04em;
  }

  .luma-error-copy {
    margin: 0;
    color: var(--foreground-muted);
    line-height: 1.7;
    font-size: 0.98rem;
  }

  .luma-error-actions {
    display: flex;
    align-items: center;
    gap: 12px;
    flex-wrap: wrap;
    margin-top: 12px;
  }

  .luma-error-primary,
  .luma-error-secondary {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-height: 48px;
    padding: 0 18px;
    border-radius: 16px;
    text-decoration: none;
    font-weight: 700;
    font-size: 0.95rem;
  }

  .luma-error-primary {
    border: none;
    background: var(--gradient-accent);
    color: var(--text-inverse);
    cursor: pointer;
    box-shadow: var(--shadow);
  }

  .luma-error-secondary {
    border: 1px solid var(--border);
    background: var(--card);
    color: var(--foreground);
  }
`;

export default function ServerErrorFallback({
  title = "We hit a temporary server issue.",
  message = "Please try again in a moment.",
  statusCode = 500,
  actionLabel,
  onAction,
  secondaryHref = "/",
  secondaryLabel = "Go back",
  fullPage = false,
  maxWidth = 620,
}: ServerErrorFallbackProps) {
  return (
    <>
      <style>{styles}</style>

      <div
        className={`luma-error-shell${fullPage ? " luma-error-shell--full" : ""}`}
      >
        <section
          className="luma-error-card"
          style={{ maxWidth }}
          role="alert"
          aria-live="polite"
        >
          <span className="luma-error-badge">{statusCode}</span>
          <h1 className="luma-error-title">{title}</h1>
          <p className="luma-error-copy">{message}</p>

          <div className="luma-error-actions">
            {actionLabel && onAction ? (
              <button
                className="luma-error-primary"
                type="button"
                onClick={onAction}
              >
                {actionLabel}
              </button>
            ) : null}

            <a className="luma-error-secondary" href={secondaryHref}>
              {secondaryLabel}
            </a>
          </div>
        </section>
      </div>
    </>
  );
}
