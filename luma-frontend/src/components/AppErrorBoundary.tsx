import { Component, type ErrorInfo, type ReactNode } from "react";
import ServerErrorFallback from "./ServerErrorFallback";

type AppErrorBoundaryProps = {
  children: ReactNode;
};

type AppErrorBoundaryState = {
  hasError: boolean;
};

export default class AppErrorBoundary extends Component<
  AppErrorBoundaryProps,
  AppErrorBoundaryState
> {
  override state: AppErrorBoundaryState = {
    hasError: false,
  };

  static getDerivedStateFromError() {
    return {
      hasError: true,
    };
  }

  override componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error("Luma component crash:", error, errorInfo);
  }

  override render() {
    if (this.state.hasError) {
      return (
        <ServerErrorFallback
          fullPage
          statusCode={500}
          title="Something in the app crashed."
          message="The current screen hit an unexpected problem. Reload to recover and continue."
          actionLabel="Reload app"
          onAction={() => {
            window.location.reload();
          }}
          secondaryHref="/"
          secondaryLabel="Return home"
        />
      );
    }

    return this.props.children;
  }
}
