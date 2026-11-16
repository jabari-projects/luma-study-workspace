---
name: luma-react-best-practices
description: React 19 performance and correctness review for Luma's Vite single-page app, using the portable subset of Vercel's React best-practices rules (re-render, rendering, bundle, client and JS rules). Use when reviewing or writing Luma React components for performance, bundle size, effects and state.
---

# Luma React best practices

Apply the rules in `rules/` (one rule per file) when reviewing or writing Luma's React code.

## Scope for Luma
- Luma is **React 19 + TypeScript + Vite**, a client-rendered single-page app with plain CSS and a FastAPI backend. It is **not Next.js**, and must not be migrated to it.
- **Removed on purpose** (they don't apply to a Vite SPA): every `server-*` rule (React Server Components, server actions, `React.cache`, `after()`), `rendering-hydration-*`, `async-api-routes`, `async-suspense-boundaries`, and `client-swr-dedup` (Luma doesn't use SWR).
- Some kept rules show **Next.js examples** (`next/dynamic`, `next/script`). Translate them to Vite/React: `React.lazy(() => import(...))` or a plain dynamic `import()`, and a `<script async>` tag or a dynamic import for third-party code. The idea carries over; the API doesn't.
- Luma's existing habits to keep: heavy libraries load only when needed (pdf.js, mammoth, confetti); icons come from `@phosphor-icons/react`; motion comes from `motion/react` with `MotionConfig reducedMotion="user"`.
- Read-only by default: report findings as `file:line: rule-name: problem → fix`. Don't change code unless asked, and don't add dependencies.

## Source
https://github.com/vercel-labs/agent-skills `skills/react-best-practices/rules` at commit `1a2c79d4e6c4a2283dc2c614b6538cbe1ed5ca62` (2026-10-27). License: MIT (stated in the repo README and the skill's frontmatter). Rule files were copied verbatim; only the server/Next-only ones were left out.
