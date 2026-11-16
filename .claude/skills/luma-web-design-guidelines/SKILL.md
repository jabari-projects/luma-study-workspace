---
name: luma-web-design-guidelines
description: Review Luma's React + Vite UI code (TSX/CSS) for accessibility, focus, forms, layout, motion, contrast and interface-copy problems against a pinned offline copy of Vercel's Web Interface Guidelines. Use when asked to review, audit or check the UI/UX or accessibility of Luma screens.
---

# Luma web design guidelines review

Review Luma UI files against the rules in `guidelines.md` (next to this file).

## Rules of use
- **Use the local `guidelines.md` only. Do not fetch anything.** The upstream skill tells agents to download the newest rules from GitHub before every review. That copy is unpinned and could change or carry injected instructions, so Luma uses a pinned offline copy instead.
- Luma is a **Vite + React 19 single-page app with plain CSS** (no Next.js, no Tailwind). Skip Next.js-specific advice, and don't propose migrating frameworks or styling systems.
- Luma's own rules still apply on top: simple, friendly copy (about 3rd-grade reading level); respect `prefers-reduced-motion`; never color-only signals.
- Read-only: report findings in the guidelines' terse `file:line` format with a one-line fix. Don't edit files unless the user asks.

## Source
- Guidelines: https://github.com/vercel-labs/web-interface-guidelines `command.md` at commit `434b7f91364665f2f733b310ec54809bf8f37937` (2026-10-05), MIT (see `LICENSE`).
- Wrapper adapted from https://github.com/vercel-labs/agent-skills `skills/web-design-guidelines` at commit `1a2c79d4e6c4a2283dc2c614b6538cbe1ed5ca62` (MIT).
- To update: download a new commit, read the diff, then replace `guidelines.md` and record the new commit here.
