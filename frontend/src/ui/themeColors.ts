// The accent colors a student can pick in Settings, and the text color that
// goes on top of an accent-filled button. Kept in its own file (no React) so
// the node unit tests can check every swatch's contrast.

export const themeColors = [
  { name: "Red", value: "#dc2626" },
  { name: "Yellow", value: "#ca8a04" },
  { name: "Teal", value: "#0f766e" },
  { name: "Pink", value: "#db2777" },
  { name: "Gold", value: "#b7791f" },
  { name: "Cyan", value: "#0891b2" },
  { name: "Purple", value: "#7c3aed" },
  { name: "Orange", value: "#ea580c" },
  { name: "Green", value: "#16a34a" },
  { name: "Blue", value: "#3157d5" },
]

/** Teal. Used when a profile has no saved color yet (theme_color is null). */
export const DEFAULT_ACCENT = "#0f766e"

export const ON_ACCENT_LIGHT = "#ffffff"
/** The warm graphite of the dark theme's paper, so dark text on yellow swatches has no purple tint. */
export const ON_ACCENT_DARK = "#15140f"

/** WCAG relative luminance of a #rrggbb color (null when it can't be read). */
export function luminance(hex: string): number | null {
  const match = /^#?([0-9a-f]{6})$/i.exec(hex.trim())
  if (!match) return null
  const channels = [0, 2, 4].map((at) => {
    const value = parseInt(match[1].slice(at, at + 2), 16) / 255
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2]
}

/** WCAG contrast ratio of two #rrggbb colors (0 when either can't be read). */
export function contrastRatio(a: string, b: string): number {
  const la = luminance(a)
  const lb = luminance(b)
  if (la === null || lb === null) return 0
  const [hi, lo] = la > lb ? [la, lb] : [lb, la]
  return (hi + 0.05) / (lo + 0.05)
}

/** Text color for buttons filled with the accent: white when it is easy to read, dark otherwise. */
export function textOnAccent(accent: string): string {
  if (luminance(accent) === null) return ON_ACCENT_LIGHT
  const withWhite = contrastRatio(accent, ON_ACCENT_LIGHT)
  if (withWhite >= 4.5) return ON_ACCENT_LIGHT
  return contrastRatio(accent, ON_ACCENT_DARK) > withWhite ? ON_ACCENT_DARK : ON_ACCENT_LIGHT
}
