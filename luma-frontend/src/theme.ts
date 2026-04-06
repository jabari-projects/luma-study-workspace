export type ThemeMode = "light" | "dark";

export type ThemeColorOption = {
  value: string;
  label: string;
  accent: string;
  accentStrong: string;
  accentSoftLight: string;
  accentSoftDark: string;
  preview: string;
};

export type ThemeSnapshot = {
  themeMode: ThemeMode;
  themeColor: string;
};

type AccentPalette = {
  accent: string;
  accentStrong: string;
  accentSoft: string;
};

export const DEFAULT_THEME_COLOR = "lavender-mist";

export const THEME_COLOR_OPTIONS: readonly ThemeColorOption[] = [
  {
    value: DEFAULT_THEME_COLOR,
    label: "Lavender Mist",
    accent: "#b59bff",
    accentStrong: "#8c6fff",
    accentSoftLight: "#f3efff",
    accentSoftDark: "#241d3d",
    preview: "linear-gradient(135deg, #8c6fff, #b59bff)",
  },
  {
    value: "rose-dawn",
    label: "Rose Dawn",
    accent: "#ef8db8",
    accentStrong: "#d16194",
    accentSoftLight: "#fff0f7",
    accentSoftDark: "#331827",
    preview: "linear-gradient(135deg, #d16194, #ef8db8)",
  },
  {
    value: "sky-glow",
    label: "Sky Glow",
    accent: "#6db7ff",
    accentStrong: "#488edf",
    accentSoftLight: "#eef7ff",
    accentSoftDark: "#162536",
    preview: "linear-gradient(135deg, #488edf, #6db7ff)",
  },
  {
    value: "sage-light",
    label: "Sage Light",
    accent: "#70c7a7",
    accentStrong: "#449f80",
    accentSoftLight: "#eefaf4",
    accentSoftDark: "#163128",
    preview: "linear-gradient(135deg, #449f80, #70c7a7)",
  },
];

const THEME_COLOR_OPTION_MAP = new Map(
  THEME_COLOR_OPTIONS.map((option) => [option.value.toLowerCase(), option]),
);

const DESIGN_TOKENS = {
  spacing: {
    "space-1": "4px",
    "space-2": "8px",
    "space-3": "12px",
    "space-4": "16px",
    "space-5": "20px",
    "space-6": "24px",
    "space-7": "32px",
    "space-8": "40px",
    "space-9": "48px",
  },
  radii: {
    "radius-sm": "12px",
    "radius-md": "16px",
    "radius-lg": "20px",
    "radius-xl": "24px",
    "radius-2xl": "28px",
    "radius-3xl": "32px",
    "radius-pill": "999px",
  },
  typography: {
    "font-family-sans": '"Segoe UI", "Helvetica Neue", Arial, system-ui, sans-serif',
    "font-size-xs": "12px",
    "font-size-sm": "13px",
    "font-size-md": "14px",
    "font-size-base": "16px",
    "font-size-lg": "18px",
    "font-size-xl": "20px",
    "font-size-2xl": "24px",
    "font-size-3xl": "32px",
    "font-weight-regular": "400",
    "font-weight-medium": "500",
    "font-weight-semibold": "600",
    "font-weight-bold": "700",
    "font-weight-black": "800",
  },
  motion: {
    "motion-fast": "180ms",
    "motion-base": "220ms",
    "motion-slow": "320ms",
    "motion-ease": "cubic-bezier(0.2, 0.9, 0.2, 1)",
  },
} as const;

const SHADOW_TOKENS = {
  light: {
    shadow: "0 24px 70px rgba(55, 38, 98, 0.14)",
    "shadow-soft": "0 18px 44px rgba(72, 53, 121, 0.12)",
    "shadow-strong": "0 28px 90px rgba(55, 38, 98, 0.14)",
    "shadow-accent": "0 18px 36px rgba(140, 111, 255, 0.24)",
    "shadow-glow": "0 0 0 6px rgba(181, 155, 255, 0.18)",
  },
  dark: {
    shadow: "0 24px 70px rgba(0, 0, 0, 0.24)",
    "shadow-soft": "0 18px 44px rgba(0, 0, 0, 0.2)",
    "shadow-strong": "0 28px 90px rgba(0, 0, 0, 0.28)",
    "shadow-accent": "0 18px 36px rgba(140, 111, 255, 0.22)",
    "shadow-glow": "0 0 0 6px rgba(181, 155, 255, 0.18)",
  },
} as const;

export function isThemeMode(value: unknown): value is ThemeMode {
  return value === "light" || value === "dark";
}

export function resolveThemeMode(value: string | null | undefined): ThemeMode {
  return value === "dark" ? "dark" : "light";
}

export function getThemeColorOption(value: string | null | undefined) {
  const normalizedValue = value?.trim().toLowerCase();

  if (!normalizedValue) {
    return null;
  }

  return THEME_COLOR_OPTION_MAP.get(normalizedValue) ?? null;
}

export function resolveThemeColor(value: string | null | undefined) {
  const option = getThemeColorOption(value);

  if (option) {
    return option.value;
  }

  const trimmedValue = value?.trim();
  return trimmedValue ? trimmedValue : DEFAULT_THEME_COLOR;
}

function getAccentPalette(themeColor: string, isDarkMode: boolean): AccentPalette {
  const option = getThemeColorOption(themeColor);

  if (option) {
    return {
      accent: option.accent,
      accentStrong: option.accentStrong,
      accentSoft: isDarkMode ? option.accentSoftDark : option.accentSoftLight,
    };
  }

  return {
    accent: themeColor,
    accentStrong: "#8c6fff",
    accentSoft: isDarkMode ? "#241d3d" : "#f3efff",
  };
}

function getModeSurfaceTokens(themeMode: ThemeMode, isLavenderPremium: boolean) {
  if (themeMode === "dark") {
    return {
      background: "#100d1a",
      "background-gradient": isLavenderPremium
        ? "radial-gradient(circle at top, #3a2d60 0%, #1d1730 46%, #100d1a 100%)"
        : "radial-gradient(circle at top, #322655 0%, #171327 48%, #100d1a 100%)",
      foreground: "#f6f2ff",
      "foreground-muted": "#c5bcde",
      card: "#171327",
      "card-muted": "#201a34",
      border: "rgba(181, 155, 255, 0.22)",
      "border-strong": "rgba(181, 155, 255, 0.34)",
      "surface-glass": "rgba(23, 19, 39, 0.82)",
      "surface-overlay": "rgba(23, 19, 39, 0.84)",
      "surface-elevated": "rgba(17, 14, 29, 0.9)",
      "surface-hero": "rgba(24, 20, 40, 0.92)",
      "surface-hero-muted": "rgba(31, 25, 53, 0.92)",
      "overlay-scrim": "rgba(16, 11, 28, 0.48)",
      "overlay-subtle": "rgba(12, 10, 20, 0.18)",
      "text-inverse": "#ffffff",
      "hero-text": "#ffffff",
      "hero-text-muted": "rgba(255, 255, 255, 0.92)",
      "hero-pill-bg": "rgba(255, 255, 255, 0.08)",
    };
  }

  return {
    background: "#faf7ff",
    "background-gradient": isLavenderPremium
      ? "radial-gradient(circle at top, #efe7ff 0%, #faf7ff 44%, #ffffff 100%)"
      : "radial-gradient(circle at top, #ede6ff 0%, #f8f5ff 44%, #ffffff 100%)",
    foreground: "#1d1730",
    "foreground-muted": "#6a6284",
    card: "#ffffff",
    "card-muted": "#fbf9ff",
    border: "rgba(181, 155, 255, 0.24)",
    "border-strong": "rgba(181, 155, 255, 0.34)",
    "surface-glass": "rgba(255, 255, 255, 0.72)",
    "surface-overlay": "rgba(255, 255, 255, 0.84)",
    "surface-elevated": "rgba(255, 255, 255, 0.9)",
    "surface-hero": "rgba(255, 255, 255, 0.92)",
    "surface-hero-muted": "rgba(248, 245, 255, 0.96)",
    "overlay-scrim": "rgba(16, 11, 28, 0.48)",
    "overlay-subtle": "rgba(12, 10, 20, 0.18)",
    "text-inverse": "#ffffff",
    "hero-text": "#ffffff",
    "hero-text-muted": "rgba(255, 255, 255, 0.92)",
    "hero-pill-bg": "rgba(255, 255, 255, 0.7)",
  };
}

export function getThemeVariableMap(snapshot: ThemeSnapshot) {
  const isDarkMode = snapshot.themeMode === "dark";
  const isLavenderPremium = snapshot.themeColor === DEFAULT_THEME_COLOR;
  const accentPalette = getAccentPalette(snapshot.themeColor, isDarkMode);
  const surfaceTokens = getModeSurfaceTokens(
    snapshot.themeMode,
    isLavenderPremium,
  );
  const shadowTokens = SHADOW_TOKENS[snapshot.themeMode];

  return {
    "--accent": accentPalette.accent,
    "--accent-strong": accentPalette.accentStrong,
    "--accent-soft": accentPalette.accentSoft,
    "--background": surfaceTokens.background,
    "--background-gradient": surfaceTokens["background-gradient"],
    "--foreground": surfaceTokens.foreground,
    "--foreground-muted": surfaceTokens["foreground-muted"],
    "--text-inverse": surfaceTokens["text-inverse"],
    "--card": surfaceTokens.card,
    "--card-muted": surfaceTokens["card-muted"],
    "--border": surfaceTokens.border,
    "--border-strong": surfaceTokens["border-strong"],
    "--surface-glass": surfaceTokens["surface-glass"],
    "--surface-overlay": surfaceTokens["surface-overlay"],
    "--surface-elevated": surfaceTokens["surface-elevated"],
    "--surface-hero": surfaceTokens["surface-hero"],
    "--surface-hero-muted": surfaceTokens["surface-hero-muted"],
    "--surface-tint-soft": `color-mix(in srgb, var(--card) 92%, ${accentPalette.accent}14)`,
    "--surface-tint-strong": `color-mix(in srgb, var(--card) 88%, ${accentPalette.accent}24)`,
    "--overlay-scrim": surfaceTokens["overlay-scrim"],
    "--overlay-subtle": surfaceTokens["overlay-subtle"],
    "--hero-text": surfaceTokens["hero-text"],
    "--hero-text-muted": surfaceTokens["hero-text-muted"],
    "--hero-pill-bg": surfaceTokens["hero-pill-bg"],
    "--danger": "#b63d61",
    "--danger-strong": "#c44f6e",
    "--danger-soft": "rgba(226, 120, 145, 0.12)",
    "--danger-border": "rgba(226, 120, 145, 0.28)",
    "--success": snapshot.themeMode === "dark" ? "#9bf0c8" : "#1d7d58",
    "--success-strong": "#2f7f64",
    "--success-soft": "rgba(112, 199, 167, 0.12)",
    "--success-border": "rgba(112, 199, 167, 0.24)",
    "--warning": "#f4d36c",
    "--premium-gradient": "linear-gradient(135deg, #f4d36c, #d9a83c)",
    "--premium-text": "#4f3a00",
    "--premium-border": "rgba(217, 168, 60, 0.32)",
    "--focus-ring": `0 0 0 4px color-mix(in srgb, ${accentPalette.accent} 16%, transparent)`,
    "--gradient-accent": `linear-gradient(135deg, ${accentPalette.accentStrong}, ${accentPalette.accent})`,
    "--gradient-accent-soft": isDarkMode
      ? `linear-gradient(145deg, color-mix(in srgb, ${accentPalette.accent} 14%, transparent), rgba(24, 20, 40, 0.92))`
      : `linear-gradient(145deg, color-mix(in srgb, ${accentPalette.accent} 16%, transparent), rgba(255, 255, 255, 0.84))`,
    "--gradient-hero": isDarkMode
      ? `linear-gradient(145deg, color-mix(in srgb, ${accentPalette.accent} 16%, transparent), rgba(24, 20, 40, 0.92))`
      : `linear-gradient(145deg, color-mix(in srgb, ${accentPalette.accent} 18%, transparent), rgba(255, 255, 255, 0.86))`,
    "--glow-accent": `radial-gradient(circle at center, color-mix(in srgb, ${accentPalette.accent} 28%, transparent), transparent 66%)`,
    "--shadow": shadowTokens.shadow,
    "--shadow-soft": shadowTokens["shadow-soft"],
    "--shadow-strong": shadowTokens["shadow-strong"],
    "--shadow-accent": shadowTokens["shadow-accent"],
    "--shadow-glow": shadowTokens["shadow-glow"],
    "--interactive-raise": "translateY(-1px)",
    "--theme-transition": `${DESIGN_TOKENS.motion["motion-base"]} ${DESIGN_TOKENS.motion["motion-ease"]}`,
    "--theme-transition-slow": `${DESIGN_TOKENS.motion["motion-slow"]} ${DESIGN_TOKENS.motion["motion-ease"]}`,
    "--luma-accent": accentPalette.accent,
    "--luma-accent-strong": accentPalette.accentStrong,
    "--luma-accent-soft": accentPalette.accentSoft,
    "--luma-surface": surfaceTokens.card,
    "--luma-surface-muted": surfaceTokens["card-muted"],
    "--luma-text": surfaceTokens.foreground,
    "--luma-text-muted": surfaceTokens["foreground-muted"],
    ...DESIGN_TOKENS.spacing,
    ...DESIGN_TOKENS.radii,
    ...DESIGN_TOKENS.typography,
    ...DESIGN_TOKENS.motion,
  };
}
