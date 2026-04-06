import axios from "axios";
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { useLocation, useNavigate } from "react-router-dom";
import {
  api,
  AUTH_STORAGE_KEY,
  getApiErrorMessage,
  LEGACY_TOKEN_STORAGE_KEY,
  LEGACY_USER_STORAGE_KEY,
  registerUnauthorizedHandler,
  setApiAccessToken,
  type AuthResponse,
  type AuthUser,
  type BasicAuthUser,
} from "../api/api";
import { supabase } from "../api/supabase";
import {
  createPersonaBot,
  type ChatBot,
} from "../features/chatbot/ChatEngine";
import StandardLumaBot from "../features/chatbot/StandardLumaBot";
import {
  normalizePersonaDefinition,
  type PersonaDefinition,
} from "../features/personas/personaTypes";

export interface SessionUser extends AuthUser {
  email_verified: boolean;
  persona_id: string | null;
  role: string | null;
}

interface StoredAuth {
  user: SessionUser | null;
  accessToken: string | null;
}

interface AuthContextType {
  user: SessionUser | null;
  accessToken: string | null;
  loading: boolean;
  isAuthenticated: boolean;
  activeBot: ChatBot;
  activePersona: PersonaDefinition | null;
  login: (email: string, password: string) => Promise<SessionUser>;
  signup: (
    email: string,
    password: string,
    username: string,
  ) => Promise<SessionUser>;
  logout: () => void;
  refreshUser: () => Promise<SessionUser | null>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

function isNullableString(value: unknown): value is string | null {
  return typeof value === "string" || value === null || value === undefined;
}

function normalizeSubscriptionStatus(value: unknown) {
  if (typeof value !== "string" || !value.trim()) {
    return "free";
  }

  const normalized = value.trim().toLowerCase();
  if (normalized === "premium" || normalized === "active") {
    return "premium";
  }

  return normalized;
}

function normalizePersonaId(value: unknown) {
  return typeof value === "string" && value.trim() ? value : null;
}

function normalizeRole(value: unknown) {
  return typeof value === "string" && value.trim()
    ? value.trim().toLowerCase()
    : "user";
}

function normalizeUser(
  value: unknown,
  emailVerifiedFallback = false,
): SessionUser | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const candidate = value as Record<string, unknown>;

  if (
    typeof candidate.id !== "string" ||
    typeof candidate.email !== "string" ||
    typeof candidate.username !== "string"
  ) {
    return null;
  }

  if (
    !isNullableString(candidate.display_name) ||
    !isNullableString(candidate.avatar_url) ||
    !isNullableString(candidate.theme_color) ||
    !isNullableString(candidate.custom_theme_image_url) ||
    !isNullableString(candidate.timezone) ||
    !isNullableString(candidate.theme_mode) ||
    !isNullableString(candidate.phone_number) ||
    !isNullableString(candidate.birthday) ||
    !isNullableString(candidate.persona_id) ||
    !isNullableString(candidate.role) ||
    !isNullableString(candidate.subscription_status)
  ) {
    return null;
  }

  return {
    id: candidate.id,
    email: candidate.email,
    username: candidate.username,
    display_name: candidate.display_name ?? null,
    avatar_url: candidate.avatar_url ?? null,
    theme_color: candidate.theme_color ?? null,
    custom_theme_image_url: candidate.custom_theme_image_url ?? null,
    timezone: candidate.timezone ?? null,
    theme_mode: candidate.theme_mode ?? null,
    phone_number: candidate.phone_number ?? null,
    birthday: candidate.birthday ?? null,
    persona_id: normalizePersonaId(candidate.persona_id),
    role: normalizeRole(candidate.role),
    subscription_status: normalizeSubscriptionStatus(
      candidate.subscription_status,
    ),
    email_verified:
      typeof candidate.email_verified === "boolean"
        ? candidate.email_verified
        : emailVerifiedFallback,
  };
}

function buildFallbackUser(
  user: BasicAuthUser,
  emailVerifiedFallback = false,
): SessionUser {
  return {
    id: user.id,
    email: user.email,
    username: user.username,
    display_name: null,
    avatar_url: null,
    theme_color: null,
    custom_theme_image_url: null,
    timezone: null,
    theme_mode: null,
    phone_number: null,
    birthday: null,
    persona_id: null,
    role: "user",
    subscription_status: "free",
    email_verified: emailVerifiedFallback,
  };
}

function attachEmailVerification(
  user: AuthUser,
  emailVerifiedFallback = false,
): SessionUser {
  return (
    normalizeUser(user, emailVerifiedFallback) ?? {
      ...user,
      persona_id: normalizePersonaId(user.persona_id),
      role: normalizeRole(user.role),
      subscription_status: normalizeSubscriptionStatus(
        user.subscription_status,
      ),
      email_verified: emailVerifiedFallback,
    }
  );
}

function readStoredAuth(): StoredAuth {
  if (typeof window === "undefined") {
    return {
      user: null,
      accessToken: null,
    };
  }

  try {
    const persistedAuth = window.localStorage.getItem(AUTH_STORAGE_KEY);

    if (persistedAuth) {
      const parsedAuth = JSON.parse(persistedAuth) as {
        user?: unknown;
        accessToken?: unknown;
      };

      return {
        user: normalizeUser(parsedAuth.user),
        accessToken:
          typeof parsedAuth.accessToken === "string" &&
          parsedAuth.accessToken.trim()
            ? parsedAuth.accessToken
            : null,
      };
    }
  } catch {
    window.localStorage.removeItem(AUTH_STORAGE_KEY);
  }

  try {
    const legacyUser = window.localStorage.getItem(LEGACY_USER_STORAGE_KEY);
    const legacyToken = window.localStorage.getItem(LEGACY_TOKEN_STORAGE_KEY);

    return {
      user: legacyUser ? normalizeUser(JSON.parse(legacyUser)) : null,
      accessToken: legacyToken && legacyToken.trim() ? legacyToken : null,
    };
  } catch {
    window.localStorage.removeItem(LEGACY_USER_STORAGE_KEY);
    window.localStorage.removeItem(LEGACY_TOKEN_STORAGE_KEY);
    return {
      user: null,
      accessToken: null,
    };
  }
}

function persistAuth(session: StoredAuth) {
  if (typeof window === "undefined") {
    return;
  }

  if (!session.accessToken) {
    window.localStorage.removeItem(AUTH_STORAGE_KEY);
    window.localStorage.removeItem(LEGACY_TOKEN_STORAGE_KEY);
    window.localStorage.removeItem(LEGACY_USER_STORAGE_KEY);
    return;
  }

  window.localStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify(session));
  window.localStorage.setItem(LEGACY_TOKEN_STORAGE_KEY, session.accessToken);

  if (session.user) {
    window.localStorage.setItem(
      LEGACY_USER_STORAGE_KEY,
      JSON.stringify(session.user),
    );
  } else {
    window.localStorage.removeItem(LEGACY_USER_STORAGE_KEY);
  }
}

function isPublicPath(pathname: string) {
  return (
    pathname === "/" ||
    pathname === "/login" ||
    pathname === "/signup" ||
    pathname === "/forgot-password" ||
    pathname === "/reset-password"
  );
}

function getCurrentPath(pathname: string, search: string, hash: string) {
  return `${pathname}${search}${hash}`;
}

function getLoginRedirectPath(targetPath: string) {
  if (!targetPath || targetPath === "/login" || targetPath === "/signup") {
    return "/login";
  }

  return `/login?redirect=${encodeURIComponent(targetPath)}`;
}

function requiresProfileSetup(user: SessionUser | null) {
  return Boolean(user && (user.display_name == null || user.theme_mode == null));
}

function getPostAuthDestination(user: SessionUser | null) {
  return requiresProfileSetup(user) ? "/onboarding" : "/dashboard";
}

function getAuthErrorMessage(error: unknown, mode: "login" | "signup") {
  if (axios.isAxiosError(error)) {
    if (!error.response) {
      return "We couldn't reach Luma right now. Check your connection and try again.";
    }

    if (mode === "login" && error.response.status === 401) {
      return "Incorrect email or password.";
    }

    if (error.response.status === 422) {
      return "Please complete every required field and try again.";
    }

    if (error.response.status >= 500) {
      return "Luma couldn't complete that request right now. Please try again shortly.";
    }
  }

  return getApiErrorMessage(
    error,
    mode === "login" ? "Login failed." : "Signup failed.",
  );
}

async function fetchProfilePersonaState(userId: string) {
  if (!supabase) {
    return {
      personaId: null,
      role: "user",
    };
  }

  try {
    const { data, error } = await supabase
      .from("profiles")
      .select("persona_id, role")
      .eq("user_id", userId)
      .maybeSingle();

    if (error) {
      return {
        personaId: null,
        role: "user",
      };
    }

    return {
      personaId: normalizePersonaId(data?.persona_id),
      role: normalizeRole(data?.role),
    };
  } catch {
    return {
      personaId: null,
      role: "user",
    };
  }
}

async function fetchActivePersona(personaId: string | null) {
  if (!supabase || !personaId) {
    return null;
  }

  try {
    const { data, error } = await supabase
      .from("personas")
      .select("id, name, avatar_url, system_prompt, voice_id, created_at")
      .eq("id", personaId)
      .maybeSingle();

    if (error) {
      return null;
    }

    return normalizePersonaDefinition(data);
  } catch {
    return null;
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<StoredAuth>(() => readStoredAuth());
  const [activePersona, setActivePersona] = useState<PersonaDefinition | null>(
    null,
  );
  const [loading, setLoading] = useState(true);
  const navigate = useNavigate();
  const location = useLocation();

  const user = session.user;
  const accessToken = session.accessToken;
  const isAuthenticated = Boolean(user && accessToken);

  function applySession(nextSession: StoredAuth) {
    setSession(nextSession);
    setApiAccessToken(nextSession.accessToken);
    persistAuth(nextSession);
  }

  async function fetchProfile(emailVerifiedFallback = false) {
    const response = await api.get<AuthUser>("/me/profile");
    const baseUser = attachEmailVerification(
      response.data,
      emailVerifiedFallback,
    );
    const { personaId, role } = await fetchProfilePersonaState(baseUser.id);

    return {
      ...baseUser,
      persona_id: personaId,
      role,
    };
  }

  async function resolveUserAfterAuth(
    token: string,
    fallbackUser: BasicAuthUser,
  ) {
    setApiAccessToken(token);
    await api.get("/protected");

    try {
      return await fetchProfile(session.user?.email_verified ?? false);
    } catch (error) {
      if (axios.isAxiosError(error) && error.response?.status === 404) {
        const fallback = buildFallbackUser(fallbackUser);
        const { personaId, role } = await fetchProfilePersonaState(fallback.id);
        return {
          ...fallback,
          persona_id: personaId,
          role,
        };
      }

      throw error;
    }
  }

  async function refreshUser() {
    const storedAuth = readStoredAuth();
    const token = accessToken ?? storedAuth.accessToken;
    const emailVerifiedFallback =
      session.user?.email_verified ?? storedAuth.user?.email_verified ?? false;

    if (!token) {
      applySession({
        user: null,
        accessToken: null,
      });
      return null;
    }

    try {
      setApiAccessToken(token);
      await api.get("/protected");
      const nextUser = await fetchProfile(emailVerifiedFallback);

      applySession({
        user: nextUser,
        accessToken: token,
      });

      return nextUser;
    } catch {
      applySession({
        user: null,
        accessToken: null,
      });

      if (!isPublicPath(location.pathname)) {
        navigate(
          getLoginRedirectPath(
            getCurrentPath(location.pathname, location.search, location.hash),
          ),
          { replace: true },
        );
      }

      return null;
    }
  }

  async function login(email: string, password: string) {
    try {
      const response = await api.post<AuthResponse>("/login", {
        email,
        password,
      });

      const token = response.data.access_token;
      const nextUser = await resolveUserAfterAuth(token, response.data.user);

      applySession({
        user: nextUser,
        accessToken: token,
      });

      navigate(getPostAuthDestination(nextUser), { replace: true });
      return nextUser;
    } catch (error) {
      applySession({
        user: null,
        accessToken: null,
      });
      throw new Error(getAuthErrorMessage(error, "login"));
    }
  }

  async function signup(email: string, password: string, username: string) {
    try {
      const response = await api.post<AuthResponse>("/signup", {
        email,
        password,
        username,
      });

      const token = response.data.access_token;
      const nextUser = await resolveUserAfterAuth(token, response.data.user);

      applySession({
        user: nextUser,
        accessToken: token,
      });

      navigate(getPostAuthDestination(nextUser), { replace: true });
      return nextUser;
    } catch (error) {
      applySession({
        user: null,
        accessToken: null,
      });
      throw new Error(getAuthErrorMessage(error, "signup"));
    }
  }

  function logout() {
    applySession({
      user: null,
      accessToken: null,
    });
    navigate("/login", { replace: true });
  }

  useEffect(() => {
    let cancelled = false;
    const storedAuth = readStoredAuth();

    if (!storedAuth.accessToken) {
      applySession({
        user: null,
        accessToken: null,
      });
      setLoading(false);
      return () => {
        cancelled = true;
      };
    }

    async function restoreSession() {
      try {
        setApiAccessToken(storedAuth.accessToken);
        await api.get("/protected");
        const nextUser = await fetchProfile(
          storedAuth.user?.email_verified ?? false,
        );

        if (cancelled) {
          return;
        }

        applySession({
          user: nextUser,
          accessToken: storedAuth.accessToken,
        });
      } catch {
        if (cancelled) {
          return;
        }

        applySession({
          user: null,
          accessToken: null,
        });

        if (!isPublicPath(location.pathname)) {
          navigate(
            getLoginRedirectPath(
              getCurrentPath(location.pathname, location.search, location.hash),
            ),
            { replace: true },
          );
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }

    void restoreSession();

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    registerUnauthorizedHandler(() => {
      applySession({
        user: null,
        accessToken: null,
      });

      if (!isPublicPath(location.pathname)) {
        navigate(
          getLoginRedirectPath(
            getCurrentPath(location.pathname, location.search, location.hash),
          ),
          { replace: true },
        );
      }
    });

    return () => {
      registerUnauthorizedHandler(null);
    };
  }, [location.hash, location.pathname, location.search, navigate]);

  useEffect(() => {
    let cancelled = false;

    async function loadActivePersona() {
      if (!user?.persona_id) {
        setActivePersona(null);
        return;
      }

      const persona = await fetchActivePersona(user.persona_id);

      if (!cancelled) {
        setActivePersona(persona);
      }
    }

    void loadActivePersona();

    return () => {
      cancelled = true;
    };
  }, [user?.persona_id]);

  const activeBot = useMemo(
    () =>
      activePersona ? createPersonaBot(activePersona) : StandardLumaBot,
    [activePersona],
  );

  return (
    <AuthContext.Provider
      value={{
        user,
        accessToken,
        loading,
        isAuthenticated,
        activeBot,
        activePersona,
        login,
        signup,
        logout,
        refreshUser,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);

  if (!context) {
    throw new Error("useAuth must be used within an AuthProvider.");
  }

  return context;
}
