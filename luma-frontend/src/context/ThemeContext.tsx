import {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useState,
  type ReactNode,
} from "react";
import {
  API,
  api,
  AUTH_STORAGE_KEY,
  getApiErrorMessage,
  type AuthUser,
} from "../api/api";
import {
  DEFAULT_THEME_COLOR,
  getThemeVariableMap,
  isThemeMode,
  resolveThemeColor,
  resolveThemeMode,
  THEME_COLOR_OPTIONS,
  type ThemeColorOption,
  type ThemeMode,
  type ThemeSnapshot,
} from "../theme";
import { useAuth } from "./AuthContext";

export type { ThemeColorOption, ThemeMode } from "../theme";

type ThemeContextType = {
  themeMode: ThemeMode;
  themeColor: string;
  accentColor: string;
  isSaving: boolean;
  error: string;
  setThemeMode: (mode: ThemeMode) => Promise<void>;
  setThemeColor: (color: string) => Promise<void>;
  toggleTheme: () => Promise<void>;
  clearThemeError: () => void;
  themeColorOptions: readonly ThemeColorOption[];
};

type PersistedTheme = {
  themeMode?: unknown;
  themeColor?: unknown;
};

const ThemeContext = createContext<ThemeContextType | undefined>(undefined);

const THEME_STORAGE_KEY = "luma.theme";

function readThemeFromAuthStorage() {
  if (typeof window === "undefined") {
    return null;
  }

  try {
    const persistedAuth = window.localStorage.getItem(AUTH_STORAGE_KEY);

    if (!persistedAuth) {
      return null;
    }

    const parsedAuth = JSON.parse(persistedAuth) as {
      user?: {
        theme_mode?: string | null;
        theme_color?: string | null;
      };
    };

    return {
      themeMode: resolveThemeMode(parsedAuth.user?.theme_mode),
      themeColor: resolveThemeColor(parsedAuth.user?.theme_color),
    } satisfies ThemeSnapshot;
  } catch {
    return null;
  }
}

function readStoredThemeSnapshot(): ThemeSnapshot {
  if (typeof window === "undefined") {
    return {
      themeMode: "light",
      themeColor: DEFAULT_THEME_COLOR,
    };
  }

  try {
    const rawTheme = window.localStorage.getItem(THEME_STORAGE_KEY);

    if (rawTheme) {
      const parsedTheme = JSON.parse(rawTheme) as PersistedTheme;

      if (isThemeMode(parsedTheme.themeMode)) {
        return {
          themeMode: parsedTheme.themeMode,
          themeColor: resolveThemeColor(
            typeof parsedTheme.themeColor === "string" ? parsedTheme.themeColor : null,
          ),
        };
      }
    }
  } catch {
    window.localStorage.removeItem(THEME_STORAGE_KEY);
  }

  return (
    readThemeFromAuthStorage() ?? {
      themeMode: "light",
      themeColor: DEFAULT_THEME_COLOR,
    }
  );
}

function persistThemeSnapshot(snapshot: ThemeSnapshot) {
  if (typeof window === "undefined") {
    return;
  }

  window.localStorage.setItem(
    THEME_STORAGE_KEY,
    JSON.stringify({
      themeMode: snapshot.themeMode,
      themeColor: snapshot.themeColor,
    } satisfies PersistedTheme),
  );
}

function getThemeSnapshotFromUser(user: AuthUser | null, fallback: ThemeSnapshot) {
  if (!user) {
    return fallback;
  }

  return {
    themeMode: user.theme_mode ? resolveThemeMode(user.theme_mode) : fallback.themeMode,
    themeColor: user.theme_color ? resolveThemeColor(user.theme_color) : fallback.themeColor,
  } satisfies ThemeSnapshot;
}

function applyThemeSnapshot(snapshot: ThemeSnapshot) {
  if (typeof document === "undefined") {
    return;
  }

  const tokens = getThemeVariableMap(snapshot);
  const root = document.documentElement;
  const body = document.body;

  root.dataset.theme = snapshot.themeMode;
  root.dataset.themeVariant =
    snapshot.themeColor === DEFAULT_THEME_COLOR
      ? "lavender-mist-premium"
      : "standard";
  root.dataset.themeReady = "true";
  root.style.colorScheme = snapshot.themeMode;
  Object.entries(tokens).forEach(([name, value]) => {
    root.style.setProperty(name, value);
  });

  body.style.margin = "0";
  body.style.minHeight = "100vh";
  body.style.background = "var(--background-gradient)";
  body.style.color = "var(--foreground)";
  body.style.fontFamily = "var(--font-family-sans)";
}

export function initializeTheme() {
  const snapshot = readStoredThemeSnapshot();
  applyThemeSnapshot(snapshot);
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const { user, isAuthenticated, refreshUser } = useAuth();
  const [snapshot, setSnapshot] = useState<ThemeSnapshot>(() => readStoredThemeSnapshot());
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    setSnapshot((currentSnapshot) => {
      const nextSnapshot = getThemeSnapshotFromUser(user, currentSnapshot);

      if (
        currentSnapshot.themeMode === nextSnapshot.themeMode &&
        currentSnapshot.themeColor === nextSnapshot.themeColor
      ) {
        return currentSnapshot;
      }

      return nextSnapshot;
    });
  }, [user?.id, user?.theme_color, user?.theme_mode]);

  useLayoutEffect(() => {
    applyThemeSnapshot(snapshot);
    persistThemeSnapshot(snapshot);
  }, [snapshot]);

  async function setThemeMode(mode: ThemeMode) {
    setError("");

    const normalizedMode = resolveThemeMode(mode);
    const shouldPersistMode =
      isAuthenticated && (user?.theme_mode == null || user.theme_mode !== normalizedMode);

    if (normalizedMode === snapshot.themeMode && !shouldPersistMode) {
      return;
    }

    const previousSnapshot = snapshot;
    const optimisticSnapshot = {
      ...snapshot,
      themeMode: normalizedMode,
    } satisfies ThemeSnapshot;

    setSnapshot(optimisticSnapshot);

    if (!isAuthenticated) {
      return;
    }

    setIsSaving(true);

    try {
      await api.put(`${API}/me/profile`, {
        theme_mode: normalizedMode,
      });

      const refreshedUser = await refreshUser();

      if (refreshedUser) {
        setSnapshot(getThemeSnapshotFromUser(refreshedUser, optimisticSnapshot));
      }
    } catch (themeError) {
      setSnapshot(previousSnapshot);
      setError(getApiErrorMessage(themeError, "Unable to update your theme."));
    } finally {
      setIsSaving(false);
    }
  }

  async function setThemeColor(color: string) {
    setError("");

    const normalizedColor = resolveThemeColor(color);

    if (normalizedColor === snapshot.themeColor) {
      return;
    }

    setSnapshot((currentSnapshot) => ({
      ...currentSnapshot,
      themeColor: normalizedColor,
    }));
  }

  async function toggleTheme() {
    await setThemeMode(snapshot.themeMode === "dark" ? "light" : "dark");
  }

  function clearThemeError() {
    setError("");
  }

  return (
    <ThemeContext.Provider
      value={{
        themeMode: snapshot.themeMode,
        themeColor: snapshot.themeColor,
        accentColor: getThemeVariableMap(snapshot)["--accent"],
        isSaving,
        error,
        setThemeMode,
        setThemeColor,
        toggleTheme,
        clearThemeError,
        themeColorOptions: THEME_COLOR_OPTIONS,
      }}
    >
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  const context = useContext(ThemeContext);

  if (!context) {
    throw new Error("useTheme must be used within a ThemeProvider.");
  }

  return context;
}
