import { useTheme } from "../context/ThemeContext";

type ThemeToggleProps = {
  variant?: "floating" | "inline";
  compact?: boolean;
};

const buttonBaseStyle = {
  border: "none",
  borderRadius: "var(--radius-sm)",
  padding: "10px 14px",
  fontSize: "var(--font-size-sm)",
  fontWeight: 700,
  cursor: "pointer",
  background: "transparent",
  color: "var(--foreground)",
  transition: "background-color var(--theme-transition), color var(--theme-transition)",
} as const;

export default function ThemeToggle({
  variant = "floating",
  compact = false,
}: ThemeToggleProps) {
  const { themeMode, setThemeMode, isSaving, error, clearThemeError } = useTheme();
  const isFloating = variant === "floating";

  return (
    <div
      style={{
        position: isFloating ? "fixed" : "static",
        top: isFloating ? 18 : undefined,
        right: isFloating ? 18 : undefined,
        zIndex: isFloating ? 1000 : "auto",
        display: "grid",
        gap: 8,
        justifyItems: isFloating ? "end" : "stretch",
      }}
    >
      <div
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 6,
          padding: 6,
          borderRadius: "var(--radius-lg)",
          background: "var(--surface-overlay)",
          border: "1px solid var(--border)",
          boxShadow: "var(--shadow)",
          backdropFilter: "blur(14px)",
          width: isFloating ? "auto" : "100%",
        }}
      >
        <button
          type="button"
          disabled={isSaving || themeMode === "light"}
          onClick={() => {
            clearThemeError();
            void setThemeMode("light");
          }}
          style={{
            ...buttonBaseStyle,
            borderRadius: compact ? "var(--radius-sm)" : "var(--radius-sm)",
            padding: compact ? "9px 12px" : "10px 14px",
            fontSize: compact ? "var(--font-size-xs)" : "var(--font-size-sm)",
            background: themeMode === "light" ? "var(--gradient-accent)" : "transparent",
            color: themeMode === "light" ? "var(--text-inverse)" : "var(--foreground)",
            opacity: isSaving && themeMode !== "light" ? 0.72 : 1,
          }}
          aria-label="Switch to light theme"
          title="Switch to light theme"
        >
          Light
        </button>
        <button
          type="button"
          disabled={isSaving || themeMode === "dark"}
          onClick={() => {
            clearThemeError();
            void setThemeMode("dark");
          }}
          style={{
            ...buttonBaseStyle,
            borderRadius: compact ? "var(--radius-sm)" : "var(--radius-sm)",
            padding: compact ? "9px 12px" : "10px 14px",
            fontSize: compact ? "var(--font-size-xs)" : "var(--font-size-sm)",
            background: themeMode === "dark" ? "var(--gradient-accent)" : "transparent",
            color: themeMode === "dark" ? "var(--text-inverse)" : "var(--foreground)",
            opacity: isSaving && themeMode !== "dark" ? 0.72 : 1,
          }}
          aria-label="Switch to dark theme"
          title="Switch to dark theme"
        >
          Dark
        </button>
      </div>

      {error ? (
        <div
          role="status"
          style={{
            maxWidth: isFloating ? 280 : 240,
            padding: "10px 12px",
            borderRadius: "var(--radius-sm)",
            background: "var(--danger-soft)",
            border: "1px solid var(--danger-border)",
            color: "var(--danger)",
            fontSize: "var(--font-size-xs)",
            lineHeight: 1.5,
            boxShadow: "var(--shadow)",
          }}
        >
          {error}
        </div>
      ) : null}
    </div>
  );
}
