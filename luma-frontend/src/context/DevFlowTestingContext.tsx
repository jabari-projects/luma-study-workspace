import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

declare global {
  interface Window {
    DEV_FLOW_TESTING?: boolean;
  }
}

export interface DevFlowAuthSnapshot {
  loading: boolean;
  isAuthenticated: boolean;
  userId: string | null;
  email: string | null;
  username: string | null;
  tokenPreview: string | null;
}

export interface DevFlowApiSnapshot {
  method: string;
  url: string;
  status: number | "pending" | "network-error";
  timestamp: string;
  detail?: string;
}

export interface DevFlowNavigationSnapshot {
  path: string;
  navigationType: string;
  timestamp: string;
}

interface DevFlowState {
  authState: DevFlowAuthSnapshot;
  onboardingStep: number | null;
  subscriptionStatus: string | null;
  lastApiCall: DevFlowApiSnapshot | null;
  lastNavigationEvent: DevFlowNavigationSnapshot | null;
}

interface DevFlowTestingContextValue {
  enabled: boolean;
  panelOpen: boolean;
  togglePanel: () => void;
  openPanel: () => void;
  closePanel: () => void;
  state: DevFlowState;
}

const initialState: DevFlowState = {
  authState: {
    loading: true,
    isAuthenticated: false,
    userId: null,
    email: null,
    username: null,
    tokenPreview: null,
  },
  onboardingStep: null,
  subscriptionStatus: null,
  lastApiCall: null,
  lastNavigationEvent: null,
};

let storeState = initialState;
const storeListeners = new Set<(state: DevFlowState) => void>();

function ensureDevFlowTestingFlag() {
  if (!import.meta.env.DEV || typeof window === "undefined") {
    return false;
  }

  if (typeof window.DEV_FLOW_TESTING === "undefined") {
    window.DEV_FLOW_TESTING = true;
  }

  return window.DEV_FLOW_TESTING === true;
}

function notifyStoreListeners() {
  storeListeners.forEach((listener) => {
    listener(storeState);
  });
}

function patchStore(nextState: Partial<DevFlowState>) {
  storeState = {
    ...storeState,
    ...nextState,
  };
  notifyStoreListeners();
}

function devFlowConsoleLog(label: string, payload: unknown) {
  if (!ensureDevFlowTestingFlag()) {
    return;
  }

  console.info(`[Luma Dev Flow] ${label}`, payload);
}

export function isDevFlowTestingEnabled() {
  return ensureDevFlowTestingFlag();
}

export function subscribeToDevFlowTesting(
  listener: (state: DevFlowState) => void,
) {
  storeListeners.add(listener);
  listener(storeState);

  return () => {
    storeListeners.delete(listener);
  };
}

export function getDevFlowTestingSnapshot() {
  return storeState;
}

export function recordDevFlowAuthState(payload: {
  loading: boolean;
  isAuthenticated: boolean;
  userId: string | null;
  email: string | null;
  username: string | null;
  tokenPreview: string | null;
  subscriptionStatus: string | null;
}) {
  if (!ensureDevFlowTestingFlag()) {
    return;
  }

  patchStore({
    authState: {
      loading: payload.loading,
      isAuthenticated: payload.isAuthenticated,
      userId: payload.userId,
      email: payload.email,
      username: payload.username,
      tokenPreview: payload.tokenPreview,
    },
    subscriptionStatus: payload.subscriptionStatus,
  });

  devFlowConsoleLog("Auth state changed", payload);
}

export function recordDevFlowOnboardingStep(step: number) {
  if (!ensureDevFlowTestingFlag()) {
    return;
  }

  patchStore({
    onboardingStep: step,
  });

  devFlowConsoleLog("Onboarding step updated", {
    step,
  });
}

export function clearDevFlowOnboardingStep() {
  if (!ensureDevFlowTestingFlag()) {
    return;
  }

  patchStore({
    onboardingStep: null,
  });
}

export function recordDevFlowNavigation(
  payload: DevFlowNavigationSnapshot,
) {
  if (!ensureDevFlowTestingFlag()) {
    return;
  }

  patchStore({
    lastNavigationEvent: payload,
  });

  devFlowConsoleLog("Navigation event", payload);
}

export function recordDevFlowApiCall(payload: DevFlowApiSnapshot) {
  if (!ensureDevFlowTestingFlag()) {
    return;
  }

  patchStore({
    lastApiCall: payload,
  });

  devFlowConsoleLog("API event", payload);
}

const DevFlowTestingContext = createContext<DevFlowTestingContextValue | undefined>(
  undefined,
);

export function DevFlowTestingProvider({ children }: { children: ReactNode }) {
  const [enabled, setEnabled] = useState(() => isDevFlowTestingEnabled());
  const [panelOpen, setPanelOpen] = useState(false);
  const [state, setState] = useState<DevFlowState>(() =>
    getDevFlowTestingSnapshot(),
  );

  useEffect(() => {
    setEnabled(isDevFlowTestingEnabled());

    if (!import.meta.env.DEV) {
      return;
    }

    return subscribeToDevFlowTesting(setState);
  }, []);

  useEffect(() => {
    if (!enabled && panelOpen) {
      setPanelOpen(false);
    }
  }, [enabled, panelOpen]);

  const value = useMemo(
    () => ({
      enabled,
      panelOpen,
      togglePanel: () => {
        setPanelOpen((current) => !current);
      },
      openPanel: () => {
        setPanelOpen(true);
      },
      closePanel: () => {
        setPanelOpen(false);
      },
      state,
    }),
    [enabled, panelOpen, state],
  );

  return (
    <DevFlowTestingContext.Provider value={value}>
      {children}
    </DevFlowTestingContext.Provider>
  );
}

export function useDevFlowTesting() {
  const context = useContext(DevFlowTestingContext);

  if (!context) {
    throw new Error(
      "useDevFlowTesting must be used within a DevFlowTestingProvider.",
    );
  }

  return context;
}
