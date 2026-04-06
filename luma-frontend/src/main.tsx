import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import App from "./App";
import AppErrorBoundary from "./components/AppErrorBoundary";
import ServerErrorFallback from "./components/ServerErrorFallback";
import { ApiErrorProvider } from "./context/ApiErrorContext";
import { AuthProvider } from "./context/AuthContext";
import { DevFlowTestingProvider } from "./context/DevFlowTestingContext";
import { ThemeProvider, initializeTheme } from "./context/ThemeContext";
import { initializeAnalytics } from "./lib/analytics";
import { getFrontendProductionConfigError } from "./lib/environment";
import "./index.css";

initializeTheme();
initializeAnalytics();

const rootElement = document.getElementById("root");
const frontendConfigError = getFrontendProductionConfigError();

if (!rootElement) {
  throw new Error("Root element #root was not found.");
}

createRoot(rootElement).render(
  <StrictMode>
    <AppErrorBoundary>
      {frontendConfigError ? (
        <ServerErrorFallback
          fullPage
          statusCode={503}
          title="Frontend configuration is incomplete."
          message={frontendConfigError}
          secondaryHref="/"
          secondaryLabel="Reload after configuring"
        />
      ) : (
        <BrowserRouter>
          <AuthProvider>
            <ThemeProvider>
              <ApiErrorProvider>
                <DevFlowTestingProvider>
                  <AppErrorBoundary>
                    <App />
                  </AppErrorBoundary>
                </DevFlowTestingProvider>
              </ApiErrorProvider>
            </ThemeProvider>
          </AuthProvider>
        </BrowserRouter>
      )}
    </AppErrorBoundary>
  </StrictMode>,
);
