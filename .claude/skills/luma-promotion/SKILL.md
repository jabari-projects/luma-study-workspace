---
name: luma-promotion
description: Prepare (never execute) Luma's launch promotion — search-friendly public pages, titles, descriptions, sharing previews, sitemap and robots plans, Google Search Console setup steps, YouTube demo scripts, Shorts ideas, thumbnails and descriptions, and vetted directory/community submission drafts. Use when asked to plan, draft or review Luma marketing or SEO. Everything it produces is a draft for the owner to approve.
---

# Luma Promotion (prepare only)

You help prepare Luma's launch promotion. **You never carry it out.**

## Hard rules (always)
1. **Prepare only.** Don't publish anything, submit URLs or sitemaps, verify Search Console, create or connect marketing accounts (Google, YouTube, Product Hunt, Reddit, etc.), enable analytics or tracking, schedule posts, launch ads, or spend money. Each needs the owner's **explicit approval of launch and of that specific activity**. Passing tests isn't launch approval.
2. **No paid or metered tools** (TinyFish or any wallet-billed service) without the owner's explicit approval for that use. That applies to helpers too. Use free web search and fetch only.
3. **Honest claims only.**
   - Never promise or imply rankings, views, placements, user counts, or "best"/"#1".
   - No fake reviews or testimonials, astroturfing, vote or upvote requests, bought backlinks, link schemes, keyword stuffing, or misleading thumbnails or titles.
   - Don't automate posting, and never scrape or collect data without authorization.
4. **Privacy first.**
   - Only public marketing pages go in search indexes and sitemaps.
   - Private notes, decks, accounts, emails, usernames and student data never appear in promotion, screenshots, demos, sitemaps or search indexes.
   - Use **synthetic demo data** only.
   - **Publishing a study set inside Luma isn't permission to reuse it in advertising.** It needs the creator's separate, written permission. Ask for it if minors are possible, and confirm the owner's age policy first.
   - Never show a real person (voice, face, name) without their written consent.
5. **Keep previews and staging private.** Use real access control (e.g. Vercel Deployment Protection or authentication) plus an `X-Robots-Tag: noindex` header on previews. **robots.txt isn't access control.** It's public, and it doesn't stop anyone opening a URL. Pages that must stay out of search must be crawlable and send `noindex`, not be blocked in robots.txt.
6. **Undecided launch facts.** Launch countries, minimum user age, school customers, pricing and refunds aren't decided. Don't write copy that assumes them. Use placeholders such as `[PRICE]` and flag them.
7. **Child audiences.** If minors may use Luma, YouTube's "made for kids" setting, ad targeting and community rules change. Flag it for the owner and legal review; don't decide it.
8. Respect each site's own rules (self-promotion limits, account age, required flair, fees) and record them with their source and date. Many communities ban self-promotion outright. Don't post there.

## What to prepare (drafts the owner reviews)
- **Public page plan:** which routes are public (landing, pricing, about, privacy, terms), each with a unique `<title>` (about 50–60 characters, plain language) and meta description (about 150 characters, no hype). Plus `og:title`, `og:description`, `og:image` (1200×630, synthetic content only), `twitter:card` and a canonical URL.
  - Luma is a client-rendered Vite app: sharing previews need these tags in the **initial HTML**, so plan static prerendering of the public routes only. Don't migrate frameworks.
  - App routes behind login get `noindex`.
- **sitemap.xml:** public marketing URLs only. Never app routes or study sets unless the owner explicitly decides to index public study sets, and has the creators' permission and an age policy.
- **robots.txt:** allow public pages, and point to the sitemap. Remember it isn't access control.
- **Google Search Console:** step-by-step setup instructions (property type, verification method, sitemap submission, URL Inspection, checks after launch). The owner performs them after approval.
- **YouTube:** 60–90 second demo scripts, Shorts ideas, thumbnail concepts and description drafts, using synthetic data, no guarantees, the correct "made for kids" flag noted as an owner decision, and AI-generated content disclosed where relevant.
- **Directories and communities:** use the vetted list in the vault note `40 Launch/Launch Marketing Checklist.md`. For each: rules URL, cost, self-promotion policy, age and AI restrictions, plus draft copy. Re-check rules and prices just before submitting; they change.

## Where things live
- Checklist, vetted facts and drafts: `G:\LumaLocal\Luma Knowledge\40 Launch\Launch Marketing Checklist.md`
- Legal and privacy context: `40 Launch/Launch Checklist.md`, `40 Launch/Vendor Privacy Check.md`
- Blockers that must be cleared before any launch: `START HERE.md` in the same vault.

## Output style
Plain, friendly language (about 3rd-grade reading level for user-facing copy). Mark every draft **DRAFT, not approved**. List the approval each step needs.
