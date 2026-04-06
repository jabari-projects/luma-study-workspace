import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { registerGlobalApiErrorHandler, type GlobalApiErrorPayload } from "../api/api";

type ApiErrorContextType = {
  error: GlobalApiErrorPayload | null;
  dismiss: () => void;
};

const ApiErrorContext = createContext<ApiErrorContextType | undefined>(undefined);

const styles = `
  .luma-api-error-toast {
    position: fixed;
    right: 18px;
    bottom: 18px;
    z-index: 1200;
    width: min(420px, calc(100vw - 36px));
    display: grid;
    gap: 12px;
    padding: 16px;
    border-radius: 20px;
    border: 1px solid var(--danger-border);
    background: color-mix(in srgb, var(--card) 92%, var(--danger-soft));
    box-shadow: var(--shadow-strong);
    animation: luma-api-error-toast-in var(--theme-transition-slow);
  }

  .luma-api-error-toast__top {
    display: flex;
    justify-content: space-between;
    gap: 12px;
    align-items: flex-start;
  }

  .luma-api-error-toast__badge {
    display: inline-flex;
    align-items: center;
    width: fit-content;
    padding: 6px 10px;
    border-radius: 999px;
    background: var(--danger-soft);
    color: var(--danger);
    font-size: var(--font-size-xs);
    font-weight: var(--font-weight-black);
    letter-spacing: 0.05em;
    text-transform: uppercase;
  }

  .luma-api-error-toast__title {
    margin: 10px 0 6px;
    color: var(--foreground);
    font-size: var(--font-size-lg);
    font-weight: var(--font-weight-bold);
  }

  .luma-api-error-toast__copy,
  .luma-api-error-toast__meta {
    margin: 0;
    color: var(--foreground-muted);
    line-height: 1.6;
    font-size: var(--font-size-sm);
  }

  .luma-api-error-toast__dismiss {
    border: 1px solid var(--border);
    background: var(--card);
    color: var(--foreground);
    min-height: 38px;
    padding: 0 12px;
    border-radius: var(--radius-sm);
    cursor: pointer;
    box-shadow: var(--shadow-soft);
  }

  @keyframes luma-api-error-toast-in {
    from {
      opacity: 0;
      transform: translateY(10px);
    }
    to {
      opacity: 1;
      transform: translateY(0);
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .luma-api-error-toast {
      animation: none;
    }
  }
`;

export function ApiErrorProvider({ children }: { children: ReactNode }) {
  const [error, setError] = useState<GlobalApiErrorPayload | null>(null);

  useEffect(() => {
    registerGlobalApiErrorHandler((payload) => {
      setError(payload);
    });

    return () => {
      registerGlobalApiErrorHandler(null);
    };
  }, []);

  const value = useMemo<ApiErrorContextType>(
    () => ({
      error,
      dismiss: () => {
        setError(null);
      },
    }),
    [error],
  );

  return (
    <ApiErrorContext.Provider value={value}>
      {children}
      {error ? (
        <>
          <style>{styles}</style>
          <aside
            className="luma-api-error-toast"
            role="status"
            aria-live="polite"
          >
            <div className="luma-api-error-toast__top">
              <div>
                <span className="luma-api-error-toast__badge">
                  API issue
                </span>
                <h2 className="luma-api-error-toast__title">
                  Something went wrong in the background.
                </h2>
                <p className="luma-api-error-toast__copy">{error.message}</p>
              </div>

              <button
                type="button"
                className="luma-api-error-toast__dismiss"
                onClick={() => {
                  setError(null);
                }}
              >
                Dismiss
              </button>
            </div>

            <p className="luma-api-error-toast__meta">
              {error.method} {error.url}
              {typeof error.status === "number" ? ` • ${error.status}` : ""}
            </p>
          </aside>
        </>
      ) : null}
    </ApiErrorContext.Provider>
  );
}

export function useApiError() {
  const context = useContext(ApiErrorContext);

  if (!context) {
    throw new Error("useApiError must be used within an ApiErrorProvider.");
  }

  return context;
}
