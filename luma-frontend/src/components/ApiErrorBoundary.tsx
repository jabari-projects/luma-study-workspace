import {
  RATE_LIMIT_MESSAGE,
  isRateLimitMessage,
} from "../api/api";
import ServerErrorFallback from "./ServerErrorFallback";

type ApiErrorBoundaryProps = {
  error: string;
  title?: string;
  onRetry?: () => void;
  fullPage?: boolean;
  secondaryHref?: string;
  secondaryLabel?: string;
  maxWidth?: number;
};

export default function ApiErrorBoundary({
  error,
  title = "We couldn't load this data right now.",
  onRetry,
  fullPage = false,
  secondaryHref = "/",
  secondaryLabel = "Go back",
  maxWidth,
}: ApiErrorBoundaryProps) {
  const rateLimited = isRateLimitMessage(error);

  return (
    <ServerErrorFallback
      statusCode={rateLimited ? 429 : 500}
      title={rateLimited ? RATE_LIMIT_MESSAGE : title}
      message={
        rateLimited
          ? "Luma is temporarily limiting requests. Pause for a moment, then try again."
          : error
      }
      actionLabel={onRetry ? "Try again" : undefined}
      onAction={onRetry}
      fullPage={fullPage}
      secondaryHref={secondaryHref}
      secondaryLabel={secondaryLabel}
      maxWidth={maxWidth}
    />
  );
}
