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

      it("ink and muted text stay readable on the highlight wash for all 10 theme colors", () => {
        for (const swatch of themeColors) {
          const withAccent = { ...tokens, "--accent": swatch.value }
          const highlight = resolve("var(--highlight)", withAccent)
          expectContrast(color("--ink"), highlight, 4.5, `--ink on ${swatch.name} --highlight`)
          expectContrast(color("--muted"), highlight, 4.5, `--muted on ${swatch.name} --highlight`)
          // Icons drawn in the accent on the wash (the "Ready" icon) need 3:1.
          expectContrast(resolve("var(--accent-ink)", withAccent), highlight, 3, `${swatch.name} --accent-ink on --highlight`)
        }
      })

      it("the hand-drawn marks are 3:1 or more on paper and card for all 10 theme colors", () => {
        for (const swatch of themeColors) {
          const scribble = resolve("var(--scribble)", { ...tokens, "--accent": swatch.value })
          for (const surface of ["--paper", "--card"]) {
            expectContrast(scribble, color(surface), 3, `${swatch.name} --scribble on ${surface}`)
          }
        }
      })

      it("the focus ring (ink) is 3:1 or more against every surface", () => {
        for (const surface of surfaces) {
          expectContrast(color("--ink"), surface.color, 3, `focus ring on ${surface.token}`)
          // ...and against the grey halo around it.
          expectContrast(color("--ink"), color("--focus-halo"), 3, "focus ring on --focus-halo")
        }
      })

      it("lines, outlines, the focus halo and the note margin are plain grey, not a warm color", () => {
        for (const token of ["--line", "--line-strong", "--field-border", "--focus-halo", "--margin-rule"]) {
          const [r, g, b] = hexToRgb(color(token))
          assert.ok(Math.max(r, g, b) - Math.min(r, g, b) <= 6, `${token} is ${color(token)}, not a grey`)
        }
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

/** Every rule in the style sheets as { file, selector, body }, comments removed. */
function rulesOf(files: Record<string, string>) {
  const rules: { file: string; selector: string; body: string }[] = []
  for (const [file, css] of Object.entries(files)) {
    const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, "")
    const rule = /([^{}]+)\{([^{}]*)\}/g
    for (let match = rule.exec(withoutComments); match; match = rule.exec(withoutComments)) {
      rules.push({ file, selector: match[1].trim().replace(/\s+/g, " "), body: match[2] })
    }
  }
  return rules
}

describe("the student's color reaches every personal mark", () => {
  const rules = rulesOf(cssFiles)

  it("the underline marks and the highlight wash are made from --accent in light and dark", () => {
    for (const [name, tokens] of Object.entries(themes)) {
      assert.match(tokens["--scribble"], /var\(--accent\)/, `${name} --scribble`)
      assert.match(tokens["--highlight"], /var\(--accent\)/, `${name} --highlight`)
    }
  })

  it("the avatar circle is filled with the accent and its letter uses the accent's text color", () => {
    const avatar = rules.find((rule) => rule.file === "styles.css" && rule.selector === ".avatar")
    assert.ok(avatar, "no .avatar rule")
    assert.match(avatar.body, /background:\s*var\(--accent\)/)
    assert.match(avatar.body, /(^|[^-])color:\s*var\(--on-accent\)/)
  })

  it("every accent fill with text on it uses the accent's text color", () => {
    for (const rule of rules) {
      if (!/background:\s*var\(--accent\)\s*;/.test(rule.body) || !/(^|[\s;])color:/.test(rule.body)) continue
      assert.match(rule.body, /(^|[\s;])color:\s*var\(--on-accent\)/, `${rule.file} ${rule.selector}`)
    }
  })

  it("the fixed star yellow only appears on the star logo, the week stars and warnings", () => {
    // Anything else that is personal follows the theme color; outlines are grey.
    const allowed = [
      ".brand img",
      ".auth-brand img",
      ".hero-mark",
      ".paper-card.three img",
      ".week-dots li.lit .week-star",
      ".limit-nudge", // a warning
      ".limit-nudge svg",
      ".status-chip.reviewing", // a report status
    ]
    for (const rule of rules) {
      if (!/var\(--star(-ink)?\)/.test(rule.body)) continue
      assert.ok(allowed.includes(rule.selector), `${rule.file} ${rule.selector} uses the fixed star yellow`)
    }
    // The yellow hex values live only in the --star tokens: #f2b33d is light --star, #f7c35c is
    // dark --star and --star-ink. The old orange-red margin colors are gone.
    const expected: Record<string, number> = { "#f2b33d": 1, "#f7c35c": 2 }
    for (const [file, css] of Object.entries(cssFiles)) {
      const code = css.replace(/\/\*[\s\S]*?\*\//g, "").toLowerCase()
      for (const hex of ["#f2b33d", "#f7c35c", "#f5b82e", "#d9534f", "#e0736b"]) {
        const uses = code.split(hex).length - 1
        assert.equal(uses, file === "styles.css" ? (expected[hex] ?? 0) : 0, `${file} uses ${hex} ${uses} times`)
      }
    }
    assert.equal(light["--star"], "#f2b33d")
    assert.equal(dark["--star"], "#f7c35c")
  })

  it("the end-of-session star burst uses the student's color, with no fixed yellow in its place", () => {
    const celebrate = read("../study/celebrate.ts")
    assert.match(celebrate, /export function celebrate\(\)/)
    assert.match(celebrate, /getPropertyValue\("--accent"\)/)
    assert.ok(!celebrate.toLowerCase().includes("#f5b82e"), "celebrate.ts still has the old yellow")
  })

  it("leaves no old fixed-yellow tokens behind", () => {
    for (const [file, css] of Object.entries(cssFiles)) {
      assert.ok(!css.includes("--on-scribble"), `${file} still uses --on-scribble`)
    }
  })
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
