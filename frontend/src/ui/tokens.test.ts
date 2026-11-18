// Checks the color tokens in styles.css: the old purple values are gone, and
// text, borders and accent text are readable in light and dark (WCAG 2.x
// contrast: 4.5:1 for text, 3:1 for borders and other parts you need to see).
import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"

import { contrastRatio, DEFAULT_ACCENT, ON_ACCENT_DARK, textOnAccent, themeColors } from "./themeColors.ts"

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8")
const styles = read("../styles.css")
const cssFiles: Record<string, string> = {
  "styles.css": styles,
  "capture/capture.css": read("../capture/capture.css"),
  "notes/notes.css": read("../notes/notes.css"),
  "study/study.css": read("../study/study.css"),
  "feedback/feedback.css": read("../feedback/feedback.css"),
}

type Tokens = Record<string, string>
type Rgb = [number, number, number]

/** The custom properties declared in the first rule whose selector list is exactly `selector`. */
function tokensOf(css: string, selector: string): Tokens {
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, "")
  const rule = /([^{}]+)\{([^{}]*)\}/g
  for (let match = rule.exec(withoutComments); match; match = rule.exec(withoutComments)) {
    const selectors = match[1].split(",").map((part) => part.trim()).join(", ")
    if (selectors !== selector) continue
    const tokens: Tokens = {}
    for (const declaration of match[2].split(";")) {
      const at = declaration.indexOf(":")
      const name = declaration.slice(0, at).trim()
      if (name.startsWith("--")) tokens[name] = declaration.slice(at + 1).trim()
    }
    return tokens
  }
  throw new Error(`No rule for ${selector} in styles.css`)
}

const hexToRgb = (hex: string): Rgb => {
  const match = /^#([0-9a-f]{6})$/i.exec(hex)
  assert.ok(match, `not a #rrggbb color: ${hex}`)
  return [0, 2, 4].map((at) => parseInt(match[1].slice(at, at + 2), 16)) as Rgb
}
const rgbToHex = (rgb: Rgb) => `#${rgb.map((v) => Math.round(v).toString(16).padStart(2, "0")).join("")}`

/** Splits "a, b, c" at top-level commas only. */
function splitArgs(text: string): string[] {
  const parts: string[] = []
  let depth = 0
  let start = 0
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "(") depth++
    else if (text[i] === ")") depth--
    else if (text[i] === "," && depth === 0) {
      parts.push(text.slice(start, i).trim())
      start = i + 1
    }
  }
  parts.push(text.slice(start).trim())
  return parts
}

/**
 * Resolves a token value to an opaque #rrggbb color. Understands hex colors,
 * white/black, var(--x) and color-mix(in srgb, A p%, B), which is a straight
 * mix of the sRGB channel values (the browser does the same for "in srgb").
 */
function resolve(value: string, tokens: Tokens, seen: string[] = []): string {
  const text = value.trim()
  if (/^#[0-9a-f]{6}$/i.test(text)) return text.toLowerCase()
  if (text === "white") return "#ffffff"
  if (text === "black") return "#000000"
  const variable = /^var\((--[\w-]+)\)$/.exec(text)
  if (variable) {
    const name = variable[1]
    assert.ok(!seen.includes(name), `token loop: ${[...seen, name].join(" -> ")}`)
    assert.ok(name in tokens, `missing token ${name}`)
    return resolve(tokens[name], tokens, [...seen, name])
  }
  const mix = /^color-mix\(in srgb,\s*([\s\S]+)\)$/.exec(text)
  if (mix) {
    const [first, second] = splitArgs(mix[1])
    const weighted = /^(.*?)\s+(\d+(?:\.\d+)?)%$/.exec(first)
    assert.ok(weighted, `color-mix needs a percentage on its first color: ${text}`)
    const share = Number(weighted[2]) / 100
    const a = hexToRgb(resolve(weighted[1], tokens, seen))
    const b = hexToRgb(resolve(second, tokens, seen))
    return rgbToHex([0, 1, 2].map((i) => a[i] * share + b[i] * (1 - share)) as Rgb)
  }
  throw new Error(`Can't resolve color "${text}"`)
}

const light = tokensOf(styles, ':root, [data-theme="light"]')
// Dark tokens sit on top of the light ones (the light block is on :root too).
const dark = { ...light, ...tokensOf(styles, '[data-theme="dark"]') }
const themes = { light, dark } as const

/** Asserts a contrast floor and reports the actual ratio when it is too low. */
function expectContrast(fg: string, bg: string, floor: number, label: string) {
  const ratio = contrastRatio(fg, bg)
  assert.ok(ratio >= floor, `${label}: ${fg} on ${bg} is ${ratio.toFixed(2)}:1, needs ${floor}:1`)
}

describe("color tokens", () => {
  it("leaves no old purple values in the style sheets", () => {
    const banned = [
      "#221d35", // old ink
      "#201c30", // old dark card and theme preview
      "#13111d", // old dark paper
      "#1a1727", // old dark paper-2
      "#322c47", // old dark line
      "#4a4266", // old dark line-strong and glow-new
      "#a69fba", // old dark muted
      "#2b2650", // limit nudge gradient
      "#3d3470", // limit nudge gradient
      "#ddd6f3", // limit nudge text
      "#8b6fd6", // lilac tile
      "#120f1c", // modal scrim
    ]
    for (const [file, css] of Object.entries(cssFiles)) {
      for (const hex of banned) {
        assert.ok(!css.toLowerCase().includes(hex), `${file} still uses ${hex}`)
      }
    }
  })

  it("has the Margins and Lamplight surfaces", () => {
    assert.equal(resolve("var(--paper)", light), "#fbf6ec")
    assert.equal(resolve("var(--card)", light), "#fffdf8")
    assert.equal(resolve("var(--ink)", light), "#1f1c18")
    assert.equal(resolve("var(--paper)", dark), "#15140f")
    assert.equal(resolve("var(--card-2)", dark), "#2a2720")
    assert.equal(resolve("var(--ink)", dark), "#f3ecdd")
  })

  for (const [name, tokens] of Object.entries(themes)) {
    describe(`${name} theme`, () => {
      const surfaces = ["--paper", "--paper-2", "--card", "--card-2"].map((token) => ({
        token,
        color: resolve(`var(${token})`, tokens),
      }))
      const color = (token: string) => resolve(`var(${token})`, tokens)

      it("ink, muted and yellow-family text are 4.5:1 or more on every surface", () => {
        for (const surface of surfaces) {
          for (const text of ["--ink", "--muted", "--star-ink"]) {
            expectContrast(color(text), surface.color, 4.5, `${text} on ${surface.token}`)
          }
        }
      })

      it("danger text is 4.5:1 or more on paper and card, success on paper and card", () => {
        for (const surface of ["--paper", "--card"]) {
          expectContrast(color("--danger"), color(surface), 4.5, `--danger on ${surface}`)
          expectContrast(color("--success"), color(surface), 4.5, `--success on ${surface}`)
        }
        expectContrast(color("--danger"), color("--paper-2"), 4.5, "--danger on --paper-2")
      })

      it("field borders are 3:1 or more on every surface", () => {
        for (const surface of surfaces) {
          expectContrast(color("--field-border"), surface.color, 3, `--field-border on ${surface.token}`)
        }
      })

      it("ink and muted text stay readable on the yellow highlight", () => {
        expectContrast(color("--ink"), color("--highlight"), 4.5, "--ink on --highlight")
        expectContrast(color("--muted"), color("--highlight"), 4.5, "--muted on --highlight")
      })

      it("the focus ring (ink) is 3:1 or more against every surface", () => {
        for (const surface of surfaces) {
          expectContrast(color("--ink"), surface.color, 3, `focus ring on ${surface.token}`)
        }
      })

      it("dark text on the yellow scribble fill is 4.5:1 or more", () => {
        expectContrast(color("--on-scribble"), color("--scribble"), 4.5, "--on-scribble on --scribble")
      })

      it("accent-colored text is 4.5:1 or more on every surface for all 10 theme colors", () => {
        for (const swatch of themeColors) {
          const accentInk = resolve("var(--accent-ink)", { ...tokens, "--accent": swatch.value })
          for (const surface of surfaces) {
            expectContrast(accentInk, surface.color, 4.5, `${swatch.name} --accent-ink on ${surface.token}`)
          }
        }
      })
    })
  }
})

describe("theme colors", () => {
  it("has 10 swatches with Teal as the default", () => {
    assert.equal(themeColors.length, 10)
    assert.equal(themeColors.find((swatch) => swatch.value === DEFAULT_ACCENT)?.name, "Teal")
  })

  it("text on every accent-filled button is 4.5:1 or more", () => {
    for (const swatch of themeColors) {
      expectContrast(textOnAccent(swatch.value), swatch.value, 4.5, `text on ${swatch.name}`)
    }
  })

  it("uses the warm graphite, not a purple-black, for dark text on light accents", () => {
    assert.equal(ON_ACCENT_DARK, "#15140f")
    assert.equal(textOnAccent("#ca8a04"), ON_ACCENT_DARK)
    assert.equal(textOnAccent("#0f766e"), "#ffffff")
  })
})
