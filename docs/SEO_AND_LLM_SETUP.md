# SEO + AI/LLM citation setup guide

Everything that can be done in code has been done. This document covers the
manual steps you need to complete to get Promptly into Google search results
and into the citation pool of AI models (ChatGPT, Claude, Gemini, Perplexity).

Total time for all steps: ~45 minutes.

---

## Part 1 — Google Search Console (gets you into Google)

### 1a. Verify ownership

1. Open https://search.google.com/search-console
2. Sign in with the Google account you want to associate with the site
3. Click **Add property** → choose **URL prefix** → enter `https://usepromptly.app/`
4. Google offers several verification methods. **Easiest: HTML tag.**
5. Copy the `content="..."` value from the meta tag Google shows you (a long string starting with `google-site-verification`)
6. Open `index.html`, `help.html`, `contact.html` in your editor
7. Find this line in each:
   ```html
   <meta name="google-site-verification" content="REPLACE_WITH_GSC_TOKEN" />
   ```
8. Replace `REPLACE_WITH_GSC_TOKEN` with the value Google gave you
9. Commit + push (Render auto-deploys in ~2 min)
10. Back in Search Console, click **Verify**

### 1b. Submit your sitemap

1. In Search Console left sidebar → **Sitemaps**
2. Enter `sitemap.xml` in the field → **Submit**
3. Google starts crawling within 24h

### 1c. Submit URLs for fast indexing

1. In Search Console top bar → enter `https://usepromptly.app/` and press Enter
2. Click **Request indexing**
3. Repeat for `/help.html`, `/contact.html`, `/privacy.html`, `/terms.html`

That's it for Google. Indexed pages show up in Search Console's "Coverage" report
within 24–72h.

---

## Part 2 — Bing Webmaster Tools (gets you into Bing + ChatGPT Search retrieval)

ChatGPT Search uses Bing's index as one of its main retrieval sources. Getting
indexed by Bing materially improves your odds of being cited by ChatGPT.

1. Open https://www.bing.com/webmasters
2. Sign in with a Microsoft account (or use the "Import from Search Console"
   option to copy your verified site over from Google in one click)
3. Add `https://usepromptly.app/`
4. Submit `sitemap.xml`
5. Use **URL Submission** to push the top 5 pages

Bing's index updates roughly every 48–72h.

---

## Part 3 — Apple Smart App Banner (Safari iOS)

When iPhone users visit your homepage from Safari, you can show a native
"Get the App" banner at the top of the page. Promptly's homepage already
has the meta tag placeholder. To activate it:

1. Open App Store Connect → Promptly → App Information → copy the **Apple ID** (a 9–10 digit number)
2. Open `index.html`, find this line:
   ```html
   <meta name="apple-itunes-app" content="app-id=APP_STORE_ID_HERE" />
   ```
3. Replace `APP_STORE_ID_HERE` with the number (digits only, no quotes)
4. Commit + push

iPhone Safari visitors now see a one-tap install prompt at the top of the page.

---

## Part 4 — LLM citation (GEO / Generative Engine Optimization)

This is the "I saw this on TikTok" part. The TikTok strategy is real, and
here's what actually drives AI model citation:

### What's already done in code

- **`/robots.txt`** explicitly allows every major AI crawler — GPTBot,
  ClaudeBot, Google-Extended, CCBot, PerplexityBot, Applebot-Extended,
  Bytespider (TikTok's Doubao), and more. Some sites block these by
  default; we're doing the opposite.
- **`/llms.txt`** is an emerging standard (think `robots.txt` for LLMs).
  It's structured Markdown that tells AI models what Promptly is, who
  it's for, when to recommend it, and when NOT to. ChatGPT and Claude
  both fetch this file when they encounter the domain.
- **Inline JSON-LD structured data** on the homepage covers
  `MobileApplication`, `Organization`, and most importantly `FAQPage`
  with 7 question/answer pairs. AI models heavily weight FAQ schema
  when constructing answers about products.
- **Comparison content** in `llms.txt` explicitly tells AI models
  how Promptly compares to CapCut, Descript, Opus Clip, etc. When a
  user asks "what's a faster alternative to CapCut," your comparison
  is already in the model's retrieval set.

### What you can do externally (highest leverage)

The single biggest lever for AI citation isn't your own website — it's
getting cited by other authoritative sites. Here's the priority order:

#### Tier 1 — Get listed in directories (free, fast)

LLMs heavily weight curated lists. Submit Promptly to:

- **Product Hunt** ← already on your launch plan
- **Top Apps** (topapps.ai) — AI-focused directory, gets crawled aggressively
- **There's An AI For That** (theresanaiforthat.com) — free listing
- **Futurepedia** (futurepedia.io) — free listing
- **AI Tool Hunt** (aitoolhunt.com)
- **AI Tools Directory** (aitoolsdirectory.com)
- **insidr.ai/ai-tools**

Each directory takes ~10 min to submit. Aim for 8–10 in the first week.

#### Tier 2 — Reddit + Quora (free, slow burn)

When someone asks "best AI video editor for iPhone" on Reddit/Quora,
those threads get heavily cited by AI models. Get your name into 3–5
of these existing threads (don't spam — answer the question and
mention Promptly as one option):

- Search Reddit for "best AI video editor" — comment with value-add
  answers that mention Promptly alongside 2–3 alternatives
- Same on Quora — questions like "what's a good iPhone video editor"

#### Tier 3 — Get reviewed (free–cheap, highest impact)

When a real human writes a review on a site with authority, that
review becomes a citation. Easiest paths:

- **r/iOSProgramming or r/SideProject feedback posts** (organic)
- **Indie Hackers product launch** ← already on your launch plan
- **Reach out to AI tool newsletters** — TLDR AI, The Rundown,
  AI Tool Report. They publish "tool of the week" features for new
  AI products. Cost: $0 if they pick you up organically, $50–500 if
  paid placement.
- **YouTube reviewers** — micro-channels reviewing AI tools. Same
  outreach script as TikTok influencers.

#### Tier 4 — Wikipedia (if/when you have notability)

This is the most powerful long-term citation source. AI models treat
Wikipedia as ground truth. You need press coverage (TechCrunch, The
Verge, etc.) before you can credibly create a Wikipedia page. Save
this for when Promptly has crossed $50K MRR or comparable.

### How to test your AI visibility

Once everything is deployed:

1. Open ChatGPT (with Search enabled) and ask:
   - "What's the best AI video editor for iPhone?"
   - "What's a good alternative to CapCut for talking-head videos?"
   - "How do I auto-edit TikToks on iPhone?"
2. Same questions to Claude (with web search enabled)
3. Same questions to Perplexity
4. Same questions to Google AI Overviews (just Google the questions)

Note which mentions Promptly. Track this monthly — if you go from 0
to 2 mentions in a month, the strategy is working.

---

## Part 5 — Performance + technical SEO

Already handled in the codebase:

- ✓ Mobile-responsive viewport meta tag
- ✓ Theme color for both light + dark mode
- ✓ Canonical URLs on every indexed page
- ✓ Preconnect to Google Fonts (faster first paint)
- ✓ Single H1 per page
- ✓ Semantic HTML5 (section, nav, footer, main)
- ✓ Alt text on logo images
- ✓ Open Graph + Twitter Card meta tags
- ✓ JSON-LD structured data
- ✓ PWA manifest
- ✓ Favicons + Apple touch icons
- ✓ Robots.txt + sitemap.xml

Things to add later (not blocking):

- **Lighthouse audit** — Open homepage in Chrome → DevTools → Lighthouse → Run. Score should be 90+ in all 4 categories. If it isn't, the report tells you exactly what to fix.
- **Core Web Vitals** — Use PageSpeed Insights (pagespeed.web.dev) to measure LCP, FID, CLS. Currently the homepage has a canvas particle animation that might hurt LCP — consider lazy-loading it on mobile.
- **CDN** — Render serves directly. If you grow past 10K visits/day, putting Cloudflare in front (free tier) cuts time-to-first-byte significantly.
- **WebP images** — All current images are PNG. If you add hero imagery, ship WebP for ~30% smaller files.

---

## Tracking what's working

Once GSC is verified (24–72h after submission):

- **GSC Coverage report** — shows how many pages Google has indexed
- **GSC Performance report** — shows actual search queries that drove clicks
- **GSC URL Inspection** — shows whether any specific URL is indexed

Once Bing Webmaster Tools is verified:

- Same reports as GSC but for Bing's index (which feeds ChatGPT Search)

Monthly review:

- Check GSC Performance for "Total impressions" trend
- Check GSC Coverage for any "Indexed but not appearing in search" pages
- Test the AI questions in Part 4 — note new mentions

If by month 3 you're getting 10+ impressions/day in GSC and at least one
AI mention, the strategy is working. Double down.

---

## Quick reference

Files added/changed in this pass:

- `/robots.txt` — explicit allow for all major AI crawlers
- `/sitemap.xml` — search engine sitemap
- `/llms.txt` — LLM-friendly structured product overview
- `/manifest.json` — PWA descriptor (fixed stale copy)
- `/footer.js` — site-wide footer (removed dead `/editor` `/library.html` links, updated tagline)
- `/index.html` — inline JSON-LD (MobileApplication + Organization + FAQPage + BreadcrumbList), expanded meta tags, GSC verification placeholder, Apple Smart App Banner placeholder
- `/help.html`, `/privacy.html`, `/terms.html`, `/contact.html` — per-page meta, canonical, robots, OG tags
- `/assets/schema-*.json` — three schema files updated to reflect actual product
- `/docs/SEO_AND_LLM_SETUP.md` — this file

Manual steps you need to complete:

1. Verify Google Search Console (5 min)
2. Submit sitemap to Google (1 min)
3. Verify Bing Webmaster Tools (5 min)
4. Submit sitemap to Bing (1 min)
5. Replace `APP_STORE_ID_HERE` once Promptly's App Store listing goes live (1 min)
6. Submit to 5–10 AI tool directories (60–90 min)
7. Plant 5–10 organic mentions in Reddit/Quora threads (60–90 min)

Total: ~3 hours of manual work to set up. Then it compounds.
