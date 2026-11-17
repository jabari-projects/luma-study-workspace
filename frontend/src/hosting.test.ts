// Checks the hosting files that keep signed-in pages out of search engines.
// Playwright runs against Vite, which ignores vercel.json, so the Vercel
// header is checked here by reading the file itself.
import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"

type VercelHeader = { key: string; value: string }
type VercelConfig = {
  headers?: Array<{ source: string; headers: VercelHeader[] }>
  rewrites?: Array<{ source: string; destination: string }>
}

const vercel = JSON.parse(readFileSync(new URL("../vercel.json", import.meta.url), "utf8")) as VercelConfig
const robots = readFileSync(new URL("../public/robots.txt", import.meta.url), "utf8")

/**
 * Vercel matches `source` with path-to-regexp. The patterns used here are
 * plain paths with unnamed regex groups like "/(.+)", which read the same as
 * an anchored regular expression. Named params (":id") are refused so this
 * stays a fair stand-in.
 */
function matches(source: string, path: string): boolean {
  assert.ok(!source.includes(":"), `named params are not supported by this check: ${source}`)
  return new RegExp(`^${source}$`).test(path)
}

function robotsTagFor(path: string): string | undefined {
  for (const rule of vercel.headers ?? []) {
    if (!matches(rule.source, path)) continue
    const header = rule.headers.find((h) => h.key.toLowerCase() === "x-robots-tag")
    if (header) return header.value
  }
  return undefined
}

// Signed-in app paths, including ones that only exist after sign-in.
const APP_PATHS = [
  "/dashboard",
  "/discover",
  "/search",
  "/notes",
  "/notes/abc",
  "/notes/new",
  "/notes/import",
  "/notes/voice",
  "/notes/image",
  "/notes/abc/edit",
  "/flashcards",
  "/flashcards/deck-1/study",
  "/study",
  "/quizzes",
  "/summaries",
  "/saved",
  "/settings",
  "/admin",
  "/admin/reports",
  "/study-sessions",
  "/image-to-notes",
  "/voice-input",
  "/import",
  "/profile",
]

describe("vercel.json", () => {
  it("sends X-Robots-Tag noindex, nofollow on every path except the front page", () => {
    for (const path of [...APP_PATHS, "/login", "/assets/index-abc123.js"]) {
      assert.equal(robotsTagFor(path), "noindex, nofollow", path)
    }
  })

  it("leaves the front page free to be listed", () => {
    assert.equal(robotsTagFor("/"), undefined)
  })

  it("keeps the single-page-app rewrite", () => {
    const rewrite = (vercel.rewrites ?? []).find((r) => r.destination === "/index.html")
    assert.ok(rewrite, "rewrite to /index.html is missing")
    assert.ok(matches(rewrite.source, "/dashboard"))
    assert.ok(matches(rewrite.source, "/"))
  })
})

describe("public/robots.txt", () => {
  const lines = robots.split(/\r?\n/).map((line) => line.trim())
  const disallowed = lines
    .filter((line) => /^disallow:/i.test(line))
    .map((line) => line.slice("disallow:".length).trim())
    .filter((value) => value !== "")

  /** Robots rules match by path prefix; "$" ends a rule and "*" is a wildcard. */
  function blocked(path: string): boolean {
    return disallowed.some((rule) => {
      const anchored = rule.endsWith("$")
      const body = anchored ? rule.slice(0, -1) : rule
      const pattern = body
        .split("*")
        .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
        .join(".*")
      return new RegExp(`^${pattern}${anchored ? "$" : ""}`).test(path)
    })
  }

  it("applies to every crawler", () => {
    assert.ok(lines.includes("User-agent: *"))
    assert.ok(lines.includes("Allow: /"))
  })

  // A noindex only works if the crawler may fetch the page and read it, so
  // robots.txt must not block the pages that carry the noindex.
  it("lets crawlers reach the front page and the app pages", () => {
    for (const path of ["/", ...APP_PATHS]) {
      assert.ok(!blocked(path), `robots.txt blocks ${path}, so crawlers cannot see its noindex`)
    }
  })

  it("would catch a Disallow line that blocks an app page", () => {
    disallowed.push("/dash*")
    try {
      assert.ok(blocked("/dashboard"))
      assert.ok(!blocked("/"))
    } finally {
      disallowed.pop()
    }
  })
})
