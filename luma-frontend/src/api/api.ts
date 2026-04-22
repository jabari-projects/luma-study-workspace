import axios, { AxiosHeaders, type AxiosError } from "axios";
import { recordDevFlowApiCall } from "../context/DevFlowTestingContext";

export const API =
  typeof import.meta.env.VITE_API_BASE_URL === "string"
    ? import.meta.env.VITE_API_BASE_URL.trim().replace(/\/+$/, "")
    : "";
export const API_BASE_URL = API;

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
    `${API}/auth/send-verification`,
  );
  return response.data;
}

export async function sendPasswordResetLink(email: string) {
  const response = await api.post<VerificationStatusResponse>(
    `${API}/auth/request-reset`,
    { email },
  );
  return response.data;
}

export async function resetPasswordRequest(
  token: string,
  newPassword: string,
) {
  const response = await api.post<VerificationStatusResponse>(
    `${API}/auth/reset`,
    {
      token,
      new_password: newPassword,
    },
  );
  return response.data;
}

export const api = axios.create({
  baseURL: API,
  headers: {
    Accept: "application/json",
  },
});

function resolveRequestUrl(url: string | undefined, baseURL?: string) {
  if (typeof url === "string" && /^https?:\/\//i.test(url)) {
    return url;
  }

  return `${baseURL ?? API}${url ?? ""}`;
}

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
    url: resolveRequestUrl(config.url, config.baseURL),
    status: "pending",
    timestamp: new Date().toISOString(),
  });

  return config;
});

api.interceptors.response.use(
  (response) => {
    recordDevFlowApiCall({
      method: (response.config.method ?? "GET").toUpperCase(),
      url: resolveRequestUrl(response.config.url, response.config.baseURL),
      status: response.status,
      timestamp: new Date().toISOString(),
      detail: response.statusText || undefined,
    });

    return response;
  },
  (error: AxiosError<ApiErrorResponse>) => {
    const status = error.response?.status;
    const authorizationHeader = getAuthorizationHeader(error.config?.headers);
    const url = resolveRequestUrl(error.config?.url, error.config?.baseURL);
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
