import axios, { AxiosHeaders, type AxiosError } from "axios";
import { recordDevFlowApiCall } from "../context/DevFlowTestingContext";

function normalizeOrigin(value: string | undefined) {
  if (typeof value !== "string" || !value.trim()) {
    return null;
  }

  try {
    return new URL(value.trim()).origin.replace(/\/+$/, "").toLowerCase();
  } catch {
    return null;
  }
}

function resolveApiBaseUrl() {
  const explicitApiBaseUrl =
    import.meta.env.VITE_API_BASE_URL ?? import.meta.env.VITE_API_URL;
  const trimmedApiBaseUrl =
    typeof explicitApiBaseUrl === "string" ? explicitApiBaseUrl.trim() : "";
  const explicitApiOrigin = normalizeOrigin(trimmedApiBaseUrl);
  const publicAppOrigin = normalizeOrigin(import.meta.env.PUBLIC_APP_URL);
  const browserOrigin =
    typeof window !== "undefined"
      ? normalizeOrigin(window.location.origin)
      : null;
  const defaultDevelopmentApiBaseUrl = "http://127.0.0.1:8000";

  if (
    import.meta.env.DEV &&
    explicitApiOrigin &&
    explicitApiOrigin !== normalizeOrigin(defaultDevelopmentApiBaseUrl) &&
    (explicitApiOrigin === publicAppOrigin || explicitApiOrigin === browserOrigin)
  ) {
    console.warn(
      "VITE_API_BASE_URL points to the frontend app in development. Falling back to the local FastAPI backend at http://127.0.0.1:8000.",
    );
    return defaultDevelopmentApiBaseUrl;
  }

  if (trimmedApiBaseUrl) {
    return trimmedApiBaseUrl.replace(/\/+$/, "");
  }

  return defaultDevelopmentApiBaseUrl;
}

/*
Frontend .env.example
VITE_API_BASE_URL=http://127.0.0.1:8000
# Optional legacy fallback:
# VITE_API_URL=http://127.0.0.1:8000
# Custom domain placeholder:
# PUBLIC_APP_URL=https://yourdomain.com
# Supabase Auth dashboard:
# - add PUBLIC_APP_URL to Allowed Redirect URLs
# - add PUBLIC_APP_URL to Allowed Callback URLs

Deployment notes:
- Vercel or Netlify: set VITE_API_BASE_URL to your Render/Railway/Fly.io backend URL.
- Local development: keep VITE_API_BASE_URL pointed at the local FastAPI server.
- All real frontend API requests should go through the shared `api` instance below so
  they inherit API_BASE_URL, auth headers, and response handling consistently.
*/

// Deployment note: on Vercel or Netlify, set `VITE_API_BASE_URL` in the
// project environment settings so the built frontend points at your FastAPI
// deployment. `VITE_API_URL` remains supported for backwards compatibility.
export const API_BASE_URL = resolveApiBaseUrl();

export const AUTH_STORAGE_KEY = "luma.auth";
export const LEGACY_TOKEN_STORAGE_KEY = "token";
export const LEGACY_USER_STORAGE_KEY = "luma_user";
export const RATE_LIMIT_MESSAGE = "Too many requests, please wait.";

export interface AuthUser {
  id: string;
  email: string;
  username: string;
  display_name: string | null;
  avatar_url: string | null;
  theme_color: string | null;
  custom_theme_image_url: string | null;
  timezone: string | null;
  theme_mode: string | null;
  phone_number: string | null;
  birthday: string | null;
  subscription_status: string | null;
  role?: string | null;
  persona_id?: string | null;
  email_verified?: boolean;
}

export interface BasicAuthUser {
  id: string;
  email: string;
  username: string;
}

export interface AuthResponse {
  user: BasicAuthUser;
  access_token: string;
}

export interface ApiErrorResponse {
  detail?:
    | string
    | Array<{
        loc?: Array<string | number>;
        msg?: string;
        type?: string;
      }>;
  message?: string;
}

export interface VerificationStatusResponse {
  success: boolean;
  message: string;
}

type UnauthorizedHandler = () => void;
export type GlobalApiErrorPayload = {
  method: string;
  url: string;
  status: number | "network-error";
  message: string;
};
type GlobalApiErrorHandler = (payload: GlobalApiErrorPayload) => void;

let accessToken: string | null = null;
let unauthorizedHandler: UnauthorizedHandler | null = null;
let globalApiErrorHandler: GlobalApiErrorHandler | null = null;

function isBrowser() {
  return typeof window !== "undefined";
}

function readAccessTokenFromStorage() {
  if (!isBrowser()) {
    return accessToken;
  }

  try {
    const persistedAuth = window.localStorage.getItem(AUTH_STORAGE_KEY);

    if (persistedAuth) {
      const parsedAuth = JSON.parse(persistedAuth) as {
        accessToken?: unknown;
      };

      if (
        typeof parsedAuth.accessToken === "string" &&
        parsedAuth.accessToken.trim()
      ) {
        return parsedAuth.accessToken;
      }
    }
  } catch {
    window.localStorage.removeItem(AUTH_STORAGE_KEY);
  }

  const legacyToken = window.localStorage.getItem(LEGACY_TOKEN_STORAGE_KEY);
  return legacyToken && legacyToken.trim() ? legacyToken : null;
}

function getActiveAccessToken() {
  if (accessToken) {
    return accessToken;
  }

  accessToken = readAccessTokenFromStorage();
  return accessToken;
}

function getAuthorizationHeader(headers: unknown) {
  const normalizedHeaders = AxiosHeaders.from(
    headers as AxiosHeaders | Record<string, string> | string | undefined,
  );
  const value = normalizedHeaders.get("Authorization");
  return typeof value === "string" && value ? value : null;
}

export function setApiAccessToken(token: string | null) {
  accessToken = token && token.trim() ? token : null;
}

export function registerUnauthorizedHandler(handler: UnauthorizedHandler | null) {
  unauthorizedHandler = handler;
}

export function registerGlobalApiErrorHandler(
  handler: GlobalApiErrorHandler | null,
) {
  globalApiErrorHandler = handler;
}

export function getApiErrorMessage(
  error: unknown,
  fallbackMessage = "Something went wrong.",
) {
  if (axios.isAxiosError<ApiErrorResponse>(error)) {
    if (!error.response) {
      return "We couldn't reach Luma right now. Check your connection and try again.";
    }

    if (error.response?.status === 429) {
      return RATE_LIMIT_MESSAGE;
    }

    const responseData = error.response?.data;

    if (typeof responseData?.detail === "string" && responseData.detail) {
      return responseData.detail;
    }

    if (Array.isArray(responseData?.detail) && responseData.detail.length > 0) {
      const firstIssue = responseData.detail.find(
        (item) => typeof item?.msg === "string" && item.msg,
      );

      if (firstIssue?.msg) {
        return firstIssue.msg;
      }
    }

    if (typeof responseData?.message === "string" && responseData.message) {
      return responseData.message;
    }
  }

  if (error instanceof Error && error.message) {
    return error.message;
  }

  return fallbackMessage;
}

export function isRateLimitMessage(message: string) {
  return message.trim().toLowerCase() === RATE_LIMIT_MESSAGE.toLowerCase();
}

export async function sendVerificationEmail() {
  const response = await api.post<VerificationStatusResponse>(
    "/auth/send-verification",
  );
  return response.data;
}

export async function sendPasswordResetLink(email: string) {
  const response = await api.post<VerificationStatusResponse>(
    "/auth/request-reset",
    { email },
  );
  return response.data;
}

export async function resetPasswordRequest(
  token: string,
  newPassword: string,
) {
  const response = await api.post<VerificationStatusResponse>("/auth/reset", {
    token,
    new_password: newPassword,
  });
  return response.data;
}

export const api = axios.create({
  baseURL: API_BASE_URL,
  headers: {
    Accept: "application/json",
  },
});

api.interceptors.request.use((config) => {
  const token = getActiveAccessToken();
  const headers = AxiosHeaders.from(config.headers);

  if (token) {
    headers.set("Authorization", `Bearer ${token}`);
  } else {
    headers.delete("Authorization");
  }

  config.headers = headers;

  recordDevFlowApiCall({
    method: (config.method ?? "GET").toUpperCase(),
    url: `${config.baseURL ?? API_BASE_URL}${config.url ?? ""}`,
    status: "pending",
    timestamp: new Date().toISOString(),
  });

  return config;
});

api.interceptors.response.use(
  (response) => {
    recordDevFlowApiCall({
      method: (response.config.method ?? "GET").toUpperCase(),
      url: `${response.config.baseURL ?? API_BASE_URL}${response.config.url ?? ""}`,
      status: response.status,
      timestamp: new Date().toISOString(),
      detail: response.statusText || undefined,
    });

    return response;
  },
  (error: AxiosError<ApiErrorResponse>) => {
    const status = error.response?.status;
    const authorizationHeader = getAuthorizationHeader(error.config?.headers);
    const url = `${error.config?.baseURL ?? API_BASE_URL}${error.config?.url ?? ""}`;
    const message = getApiErrorMessage(error, "Request failed.");

    recordDevFlowApiCall({
      method: (error.config?.method ?? "GET").toUpperCase(),
      url,
      status: status ?? "network-error",
      timestamp: new Date().toISOString(),
      detail: message,
    });

    if (status === 401 && authorizationHeader && unauthorizedHandler) {
      unauthorizedHandler();
    }

    if (
      globalApiErrorHandler &&
      !url.includes("/analytics/events") &&
      (!status || status === 429 || status >= 500)
    ) {
      globalApiErrorHandler({
        method: (error.config?.method ?? "GET").toUpperCase(),
        url,
        status: status ?? "network-error",
        message,
      });
    }

    return Promise.reject(error);
  },
);

export default api;
