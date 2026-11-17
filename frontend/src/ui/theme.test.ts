// Light / Dark / Automatic rules. The same case table runs on src/ui/theme.ts (the app)
// and on public/theme-boot.js (the tiny script that paints the theme before the app
// loads), so the two can't drift apart. Fake storage and made-up account ids only.
//
// Times are written as local wall-clock times in America/Chicago, so the daylight saving
// cases mean the same thing on every computer.
process.env.TZ = "America/Chicago"

import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import vm from "node:vm"

import { AUTH_STORAGE_KEY, TAB_ACCOUNT_KEY } from "../accounts.ts"
import {
  AUTO_DARK_START,
  AUTO_LIGHT_START,
  THEME_BAR_COLOR,
  THEME_CACHE_PREFIX,
  msUntilNextSwitch,
  normalizeMode,
  readThemeCache,
  resolveMode,
  themeCacheKey,
  writeThemeCache,
} from "./theme.ts"
import type { ResolvedTheme, ThemeMode } from "./theme.ts"

const BOOT_SOURCE = readFileSync(new URL("../../public/theme-boot.js", import.meta.url), "utf8")

/** A local date and time (the TZ above), month 1-12. */
const at = (year: number, month: number, day: number, hour: number, minute = 0, second = 0) =>
  new Date(year, month - 1, day, hour, minute, second)

const MINUTE = 60 * 1000
const HOUR = 60 * MINUTE

class MemoryStorage implements Storage {
  private items = new Map<string, string>()
  get length() {
    return this.items.size
  }
  clear() {
    this.items.clear()
  }
  getItem(key: string) {
    return this.items.has(key) ? this.items.get(key)! : null
  }
  key(index: number) {
    return [...this.items.keys()][index] ?? null
  }
  removeItem(key: string) {
    this.items.delete(key)
  }
  setItem(key: string, value: string) {
    this.items.set(key, String(value))
  }
}

/** Storage that throws on every use, like a browser with site data blocked. */
const blockedStorage = new Proxy({} as Storage, {
  get() {
    throw new Error("SecurityError: storage is blocked")
  },
})

type BootResult = { theme: string | null; accent: string | null; onAccent: string | null; bar: string }

/** Runs public/theme-boot.js in a sandbox with fake storage, page path and clock. */
function runBoot({
  now,
  path = "/dashboard",
  local = new MemoryStorage() as Storage,
  session = new MemoryStorage() as Storage,
}: {
  now: Date
  path?: string
  local?: Storage
  session?: Storage
}): BootResult {
  const attributes = new Map<string, string>()
  const style = new Map<string, string>()
  const bar = { content: THEME_BAR_COLOR.light }
  const fixed = now.getTime()
  class FakeDate extends Date {
    constructor(...args: unknown[]) {
      if (args.length === 0) super(fixed)
      else super(...(args as [number]))
    }
    static now() {
      return fixed
    }
  }
  const documentElement = {
    setAttribute: (name: string, value: string) => attributes.set(name, String(value)),
    style: { setProperty: (name: string, value: string) => style.set(name, String(value)) },
  }
  const document = {
    documentElement,
    querySelector: (selector: string) =>
      selector === 'meta[name="theme-color"]'
        ? { setAttribute: (name: string, value: string) => name === "content" && (bar.content = value) }
        : null,
  }
  const sandbox = {
    Date: FakeDate,
    JSON,
    location: { pathname: path },
    localStorage: local,
    sessionStorage: session,
    document,
  }
  vm.runInNewContext(BOOT_SOURCE, sandbox, { filename: "theme-boot.js" })
  return {
    theme: attributes.get("data-theme") ?? null,
    accent: style.get("--accent") ?? null,
    onAccent: style.get("--on-accent") ?? null,
    bar: bar.content,
  }
}

/** A device where account "acc-1" is signed in and has saved a theme. */
function signedInDevice(mode: unknown, extra: Record<string, unknown> = {}) {
  const local = new MemoryStorage()
  local.setItem(
    AUTH_STORAGE_KEY,
    JSON.stringify({
      v: 2,
      accounts: { "acc-1": { status: "signed_in", accessToken: "fake", user: { id: "acc-1" } } },
      lastActiveId: "acc-1",
    }),
  )
  local.setItem(themeCacheKey("acc-1"), JSON.stringify({ mode, accent: "#0f766e", onAccent: "#ffffff", ...extra }))
  return local
}

// ---------------------------------------------------------------- shared case table
const clockCases: Array<{ name: string; mode: ThemeMode; now: Date; expected: ResolvedTheme }> = [
  { name: "auto 06:59", mode: "auto", now: at(2026, 11, 16, 6, 59), expected: "dark" },
  { name: "auto 07:00", mode: "auto", now: at(2026, 11, 16, 7, 0), expected: "light" },
  { name: "auto 12:00", mode: "auto", now: at(2026, 11, 16, 12, 0), expected: "light" },
  { name: "auto 18:59", mode: "auto", now: at(2026, 11, 16, 18, 59), expected: "light" },
  { name: "auto 19:00", mode: "auto", now: at(2026, 11, 16, 19, 0), expected: "dark" },
  { name: "auto 00:00", mode: "auto", now: at(2026, 11, 16, 0, 0), expected: "dark" },
  { name: "auto 23:59", mode: "auto", now: at(2026, 11, 16, 23, 59), expected: "dark" },
  // Daylight saving starts (2 am -> 3 am) and ends (2 am -> 1 am) in Chicago.
  { name: "auto on DST start 06:59", mode: "auto", now: at(2026, 3, 8, 6, 59), expected: "dark" },
  { name: "auto on DST start 07:00", mode: "auto", now: at(2026, 3, 8, 7, 0), expected: "light" },
  { name: "auto on DST end 19:00", mode: "auto", now: at(2026, 11, 1, 19, 0), expected: "dark" },
  { name: "light at night", mode: "light", now: at(2026, 11, 16, 22, 0), expected: "light" },
  { name: "dark at noon", mode: "dark", now: at(2026, 11, 16, 12, 0), expected: "dark" },
]

describe("the Automatic clock rule (same table for the app and the boot script)", () => {
  it("uses 7 am and 7 pm", () => {
    assert.equal(AUTO_LIGHT_START, 7)
    assert.equal(AUTO_DARK_START, 19)
  })

  for (const { name, mode, now, expected } of clockCases) {
    it(`app: ${name} -> ${expected}`, () => {
      assert.equal(resolveMode(mode, now), expected)
    })

    it(`boot script: ${name} -> ${expected}`, () => {
      const result = runBoot({ now, local: signedInDevice(mode) })
      assert.equal(result.theme, expected)
      assert.equal(result.bar, THEME_BAR_COLOR[expected])
      assert.equal(result.accent, "#0f766e")
      assert.equal(result.onAccent, "#ffffff")
    })
  }
})

describe("saved modes", () => {
  it("null, empty and unknown values mean Light (students who never picked keep Light)", () => {
    for (const value of [null, undefined, "", "purple", "AUTO", 3, {}]) {
      assert.equal(normalizeMode(value), "light", String(value))
      assert.equal(resolveMode(value, at(2026, 11, 16, 22, 0)), "light", String(value))
    }
    assert.equal(normalizeMode("dark"), "dark")
    assert.equal(normalizeMode("auto"), "auto")
  })

  it("the boot script paints nothing for an unknown saved mode", () => {
    const result = runBoot({ now: at(2026, 11, 16, 22, 0), local: signedInDevice("purple") })
    assert.equal(result.theme, null)
    assert.equal(result.accent, null)
    assert.equal(result.bar, THEME_BAR_COLOR.light)
  })
})

describe("msUntilNextSwitch", () => {
  it("18:30 -> 30 minutes", () => {
    assert.equal(msUntilNextSwitch(at(2026, 11, 16, 18, 30)), 30 * MINUTE)
  })

  it("06:00 -> 1 hour, 07:00 -> 12 hours, 19:00 -> 12 hours, 23:00 -> 8 hours", () => {
    assert.equal(msUntilNextSwitch(at(2026, 11, 16, 6, 0)), HOUR)
    assert.equal(msUntilNextSwitch(at(2026, 11, 16, 7, 0)), 12 * HOUR)
    assert.equal(msUntilNextSwitch(at(2026, 11, 16, 19, 0)), 12 * HOUR)
    assert.equal(msUntilNextSwitch(at(2026, 11, 16, 23, 0)), 8 * HOUR)
  })

  it("18:59:30 -> 30 seconds", () => {
    assert.equal(msUntilNextSwitch(at(2026, 11, 16, 18, 59, 30)), 30 * 1000)
  })

  it("counts real time across daylight saving (the clock jumps, the wait is shorter or longer)", () => {
    // Spring forward: 1:30 am to 7:00 am is 5.5 clock hours but only 4.5 real hours.
    const spring = at(2026, 3, 8, 1, 30)
    assert.equal(msUntilNextSwitch(spring), 4.5 * HOUR)
    assert.equal(resolveMode("auto", new Date(spring.getTime() + msUntilNextSwitch(spring))), "light")
    // Fall back: 7 pm on Oct 31 to 7 am on Nov 1 is 13 real hours.
    const fall = at(2026, 10, 31, 19, 0)
    assert.equal(msUntilNextSwitch(fall), 13 * HOUR)
    const next = new Date(fall.getTime() + msUntilNextSwitch(fall))
    assert.equal(next.getHours(), 7)
    assert.equal(next.getDate(), 1)
  })
})

describe("the theme saved on this device", () => {
  it("round-trips through storage under luma.theme:<id>", () => {
    const storage = new MemoryStorage()
    assert.equal(writeThemeCache(storage, "acc-1", { mode: "auto", accent: "#0f766e", onAccent: "#ffffff" }), true)
    assert.ok(storage.getItem("luma.theme:acc-1"))
    assert.deepEqual(readThemeCache(storage, "acc-1"), { mode: "auto", accent: "#0f766e", onAccent: "#ffffff" })
    assert.equal(readThemeCache(storage, "acc-2"), null)
  })

  it("a corrupt cache reads as nothing and never throws", () => {
    const storage = new MemoryStorage()
    for (const raw of ["{not json", "null", "[]", '"dark"', '{"mode":"purple"}', "{}"]) {
      storage.setItem(themeCacheKey("acc-1"), raw)
      assert.equal(readThemeCache(storage, "acc-1"), null, raw)
    }
  })

  it("drops colors that are not plain #rrggbb (nothing odd reaches the page styles)", () => {
    const storage = new MemoryStorage()
    storage.setItem(
      themeCacheKey("acc-1"),
      JSON.stringify({ mode: "dark", accent: "red; background: url(x)", onAccent: "#FFFFFF" }),
    )
    assert.deepEqual(readThemeCache(storage, "acc-1"), { mode: "dark", accent: null, onAccent: "#FFFFFF" })
  })

  it("blocked storage reads as nothing and a write says false", () => {
    assert.equal(readThemeCache(blockedStorage, "acc-1"), null)
    assert.equal(readThemeCache(null, "acc-1"), null)
    assert.equal(writeThemeCache(blockedStorage, "acc-1", { mode: "dark", accent: null, onAccent: null }), false)
    assert.equal(writeThemeCache(null, "acc-1", { mode: "dark", accent: null, onAccent: null }), false)
  })
})

describe("public/theme-boot.js", () => {
  const night = at(2026, 11, 16, 20, 0)

  it("uses the same storage key names as the app (src/accounts.ts and src/ui/theme.ts)", () => {
    const quoted = (name: string) => new RegExp(`var ${name} = "([^"]+)";`).exec(BOOT_SOURCE)?.[1]
    assert.equal(quoted("AUTH_KEY"), AUTH_STORAGE_KEY)
    assert.equal(quoted("TAB_ACCOUNT_KEY"), TAB_ACCOUNT_KEY)
    assert.equal(quoted("THEME_CACHE_PREFIX"), THEME_CACHE_PREFIX)
    assert.equal(Number(/var AUTO_LIGHT_START = (\d+);/.exec(BOOT_SOURCE)?.[1]), AUTO_LIGHT_START)
    assert.equal(Number(/var AUTO_DARK_START = (\d+);/.exec(BOOT_SOURCE)?.[1]), AUTO_DARK_START)
    assert.ok(BOOT_SOURCE.includes(`light: "${THEME_BAR_COLOR.light}"`))
    assert.ok(BOOT_SOURCE.includes(`dark: "${THEME_BAR_COLOR.dark}"`))
  })

  it("a corrupt cache: no throw and no data-theme", () => {
    for (const raw of ["{not json", "null", "[]", '"dark"', '{"mode":5}']) {
      const local = signedInDevice("dark")
      local.setItem(themeCacheKey("acc-1"), raw)
      const result = runBoot({ now: night, local })
      assert.equal(result.theme, null, raw)
    }
  })

  it("a corrupt account book: no throw and no data-theme", () => {
    for (const raw of ["{not json", "null", "[]", '{"accounts":null}', '{"accounts":{}}', "7"]) {
      const local = signedInDevice("dark")
      local.setItem(AUTH_STORAGE_KEY, raw)
      assert.equal(runBoot({ now: night, local }).theme, null, raw)
    }
  })

  it("blocked storage: no throw and no data-theme", () => {
    assert.equal(runBoot({ now: night, local: blockedStorage, session: blockedStorage }).theme, null)
    // Only sessionStorage blocked: falls back to the last active account.
    assert.equal(runBoot({ now: night, local: signedInDevice("dark"), session: blockedStorage }).theme, "dark")
  })

  it("an expired account gets no theme", () => {
    const local = signedInDevice("dark")
    const book = JSON.parse(local.getItem(AUTH_STORAGE_KEY)!)
    book.accounts["acc-1"].status = "expired"
    local.setItem(AUTH_STORAGE_KEY, JSON.stringify(book))
    assert.equal(runBoot({ now: night, local }).theme, null)
  })

  it("no signed-in account (or no saved theme) gets no theme", () => {
    assert.equal(runBoot({ now: night }).theme, null)
    const local = signedInDevice("dark")
    local.removeItem(themeCacheKey("acc-1"))
    assert.equal(runBoot({ now: night, local }).theme, null)
  })

  it("the account pages stay light even for a signed-in dark account", () => {
    for (const path of ["/login", "/signup/", "/verify-email", "/account-deleted", "/forgot-password", "/reset-password"]) {
      assert.equal(runBoot({ now: night, path, local: signedInDevice("dark") }).theme, null, path)
    }
    for (const path of ["/dashboard", "/settings", "/flashcards/d1/study", "/login-help"]) {
      assert.equal(runBoot({ now: night, path, local: signedInDevice("dark") }).theme, "dark", path)
    }
  })

  it("the home page: dark for a signed-in dark account (sent on to the dashboard), nothing when signed out", () => {
    assert.equal(runBoot({ now: night, path: "/", local: signedInDevice("dark") }).theme, "dark")
    assert.equal(runBoot({ now: night, path: "/" }).theme, null)
    // Signed out on this device: the saved theme is gone with the account.
    const local = signedInDevice("dark")
    local.removeItem(AUTH_STORAGE_KEY)
    assert.equal(runBoot({ now: night, path: "/", local }).theme, null)
  })

  it("uses this tab's account first, then the last active one", () => {
    const local = signedInDevice("light")
    const book = JSON.parse(local.getItem(AUTH_STORAGE_KEY)!)
    book.accounts["acc-2"] = { status: "signed_in", accessToken: "fake2", user: { id: "acc-2" } }
    local.setItem(AUTH_STORAGE_KEY, JSON.stringify(book))
    local.setItem(themeCacheKey("acc-2"), JSON.stringify({ mode: "dark", accent: "#2563eb", onAccent: "#ffffff" }))

    // No tab account yet: the last active account (acc-1, light).
    assert.equal(runBoot({ now: night, local }).theme, "light")
    // This tab uses acc-2 (dark).
    const session = new MemoryStorage()
    session.setItem(TAB_ACCOUNT_KEY, "acc-2")
    const result = runBoot({ now: night, local, session })
    assert.equal(result.theme, "dark")
    assert.equal(result.accent, "#2563eb")
  })

  it("only sets colors that are plain #rrggbb", () => {
    const local = signedInDevice("dark", { accent: "red;}", onAccent: "url(x)" })
    const result = runBoot({ now: night, local })
    assert.equal(result.theme, "dark")
    assert.equal(result.accent, null)
    assert.equal(result.onAccent, null)
  })
})
