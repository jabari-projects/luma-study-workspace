import {
  API,
  AUTH_STORAGE_KEY,
  LEGACY_TOKEN_STORAGE_KEY,
} from "../api/api";

type AnalyticsEventName =
  | "page_view"
  | "feature_usage"
  | "premium_modal_open"
  | "study_tool_usage"
  | "onboarding_completed";

type AnalyticsEventGroup =
  | "navigation"
  | "feature"
  | "premium"
  | "study"
  | "onboarding";

type AnalyticsMetadataValue = string | number | boolean | null;
type AnalyticsMetadata = Record<string, AnalyticsMetadataValue>;

type QueuedAnalyticsEvent = {
  event_name: AnalyticsEventName;
  event_group: AnalyticsEventGroup;
  page_path?: string;
  feature_key?: string;
  subscription_tier?: string | null;
  surface?: string;
  metadata?: AnalyticsMetadata;
  occurred_at?: string;
};

type TrackOptions = {
  pagePath?: string;
  featureKey?: string;
  subscriptionStatus?: string | null;
  surface?: string;
  metadata?: AnalyticsMetadata;
};

const MAX_BATCH_SIZE = 20;
const FLUSH_INTERVAL_MS = 4000;
const MAX_QUEUE_SIZE = 100;

let analyticsQueue: QueuedAnalyticsEvent[] = [];
let flushTimer: number | null = null;
let isFlushing = false;
let listenersAttached = false;
let lastTrackedPageKey = "";

function isBrowser() {
  return typeof window !== "undefined";
}

function normalizeSubscriptionTier(value: string | null | undefined) {
  const normalized = value?.trim().toLowerCase();

  if (!normalized) {
    return null;
  }

  if (normalized === "premium" || normalized === "active") {
    return "premium";
  }

  if (normalized === "free") {
    return "free";
  }

  return normalized.slice(0, 24);
}

function sanitizeString(value: string | null | undefined, maxLength: number) {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, maxLength) : undefined;
}

function sanitizeMetadata(metadata?: AnalyticsMetadata) {
  if (!metadata) {
    return {};
  }

  const sanitized: AnalyticsMetadata = {};

  Object.entries(metadata).forEach(([key, value]) => {
    const sanitizedKey = sanitizeString(key, 48);
    if (!sanitizedKey) {
      return;
    }

    if (
      typeof value === "boolean" ||
      typeof value === "number" ||
      value === null
    ) {
      sanitized[sanitizedKey] = value;
      return;
    }

    if (typeof value === "string") {
      sanitized[sanitizedKey] = value.trim().slice(0, 160);
    }
  });

  return sanitized;
}

function readAccessToken() {
  if (!isBrowser()) {
    return null;
  }

  try {
    const persistedAuth = window.localStorage.getItem(AUTH_STORAGE_KEY);

    if (persistedAuth) {
      const parsed = JSON.parse(persistedAuth) as { accessToken?: unknown };

      if (
        typeof parsed.accessToken === "string" &&
        parsed.accessToken.trim().length > 0
      ) {
        return parsed.accessToken.trim();
      }
    }
  } catch {
    window.localStorage.removeItem(AUTH_STORAGE_KEY);
  }

  const legacyToken = window.localStorage.getItem(LEGACY_TOKEN_STORAGE_KEY);
  return legacyToken?.trim() ? legacyToken.trim() : null;
}

function scheduleFlush() {
  if (!isBrowser() || flushTimer !== null) {
    return;
  }

  flushTimer = window.setTimeout(() => {
    flushTimer = null;
    void flushAnalyticsQueue();
  }, FLUSH_INTERVAL_MS);
}

function clearScheduledFlush() {
  if (!isBrowser() || flushTimer === null) {
    return;
  }

  window.clearTimeout(flushTimer);
  flushTimer = null;
}

function enqueueAnalyticsEvent(event: QueuedAnalyticsEvent) {
  if (!isBrowser()) {
    return;
  }

  const sanitizedEvent: QueuedAnalyticsEvent = {
    event_name: event.event_name,
    event_group: event.event_group,
    page_path: sanitizeString(event.page_path, 200),
    feature_key: sanitizeString(event.feature_key, 80),
    subscription_tier: normalizeSubscriptionTier(event.subscription_tier),
    surface: sanitizeString(event.surface, 80),
    metadata: sanitizeMetadata(event.metadata),
    occurred_at: event.occurred_at ?? new Date().toISOString(),
  };

  analyticsQueue.push(sanitizedEvent);

  if (analyticsQueue.length > MAX_QUEUE_SIZE) {
    analyticsQueue = analyticsQueue.slice(-MAX_QUEUE_SIZE);
  }

  if (analyticsQueue.length >= MAX_BATCH_SIZE) {
    clearScheduledFlush();
    void flushAnalyticsQueue();
    return;
  }

  scheduleFlush();
}

async function postAnalyticsBatch(
  events: QueuedAnalyticsEvent[],
  keepalive = false,
) {
  const accessToken = readAccessToken();
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };

  if (accessToken) {
    headers.Authorization = `Bearer ${accessToken}`;
  }

  return fetch(`${API}/analytics/events`, {
    method: "POST",
    headers,
    body: JSON.stringify({ events }),
    keepalive,
  });
}

export async function flushAnalyticsQueue(options?: { keepalive?: boolean }) {
  if (!isBrowser() || isFlushing || analyticsQueue.length === 0) {
    return;
  }

  const batch = analyticsQueue.slice(0, MAX_BATCH_SIZE);
  analyticsQueue = analyticsQueue.slice(batch.length);
  isFlushing = true;

  try {
    await postAnalyticsBatch(batch, options?.keepalive ?? false);
  } catch {
    // Analytics must stay invisible to the user and never block UI flows.
  } finally {
    isFlushing = false;

    if (analyticsQueue.length > 0) {
      scheduleFlush();
    }
  }
}

export function initializeAnalytics() {
  if (!isBrowser() || listenersAttached) {
    return;
  }

  listenersAttached = true;

  window.addEventListener("pagehide", () => {
    void flushAnalyticsQueue({ keepalive: true });
  });

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") {
      void flushAnalyticsQueue({ keepalive: true });
    }
  });
}

export function trackPageView(
  path: string,
  options?: Pick<TrackOptions, "subscriptionStatus" | "metadata">,
) {
  const pagePath = sanitizeString(path, 200);
  if (!pagePath) {
    return;
  }

  if (pagePath === lastTrackedPageKey) {
    return;
  }

  lastTrackedPageKey = pagePath;

  enqueueAnalyticsEvent({
    event_name: "page_view",
    event_group: "navigation",
    page_path: pagePath,
    subscription_tier: options?.subscriptionStatus,
    metadata: options?.metadata,
  });
}

export function trackFeatureUsage(
  featureKey: string,
  options?: TrackOptions,
) {
  enqueueAnalyticsEvent({
    event_name: "feature_usage",
    event_group: "feature",
    feature_key: featureKey,
    page_path: options?.pagePath,
    subscription_tier: options?.subscriptionStatus,
    surface: options?.surface,
    metadata: options?.metadata,
  });
}

export function trackPremiumModalOpen(
  featureKey: string,
  options?: Omit<TrackOptions, "featureKey">,
) {
  enqueueAnalyticsEvent({
    event_name: "premium_modal_open",
    event_group: "premium",
    feature_key: featureKey,
    page_path: options?.pagePath,
    subscription_tier: options?.subscriptionStatus,
    surface: options?.surface,
    metadata: options?.metadata,
  });
}

export function trackStudyToolUsage(
  toolId: string,
  action: "open" | "locked_click" | "shortcut_insert",
  options?: Omit<TrackOptions, "featureKey">,
) {
  enqueueAnalyticsEvent({
    event_name: "study_tool_usage",
    event_group: "study",
    feature_key: toolId,
    page_path: options?.pagePath,
    subscription_tier: options?.subscriptionStatus,
    surface: options?.surface,
    metadata: {
      action,
      ...options?.metadata,
    },
  });
}

export function trackOnboardingCompleted(
  options?: Pick<TrackOptions, "subscriptionStatus" | "metadata">,
) {
  enqueueAnalyticsEvent({
    event_name: "onboarding_completed",
    event_group: "onboarding",
    subscription_tier: options?.subscriptionStatus,
    metadata: options?.metadata,
  });
}
