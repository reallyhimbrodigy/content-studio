> ⚠️ **SUPERSEDED 2026-07-21 — FREEMIUM pivot.** The trial model and the $19.99/$199.99 prices below are OBSOLETE. Promptly is now permanent FREE (2 videos/day) + PRO with NO trials: **weekly $12.99, monthly $39.99, yearly $399.99**. Prices in the app are read live from StoreKit. This doc is kept for history only.

# Promptly 1.2.0 — App Store Product-Page Pass

Bundle: `app.usepromptly.ios` · Current name: "Promptly - AI Video Editor" · Model: Pro $19.99/mo / $199.99/yr, 3-day free trial (limited), no free tier.

> **Trial tier — read before writing any trial copy.** The free trial is **limited**, not full Pro (`EntitlementTier.swift` `.trial` row; `lib/tier-capabilities.js`): 3 renders/day, 50 chats/day, 1 upload, **no re-edit, no Lumen**. Copy must never say "try Pro free" or imply the trial is full Pro. Use "Start a 3-day free trial" and disclose the limits. Re-edit and Lumen are Pro-only unlocks and must never be presented as trial features.

---

## 1. TITLE (max 30 chars)

| Rank | Title | Chars | Why |
|---|---|---|---|
| 1 | `Promptly - AI Video Editor` | 26 | Keep it. "AI video editor" is the head term with the most search volume, and it's already ranking history on this exact string. Changing a title resets algorithmic learning for zero gain. |
| 2 | `Promptly: AI Captions & Cuts` | 28 | Use only if we later decide "AI video editor" is too contested to win — trades the head term for two mid-volume terms (captions, cuts) we'd then free up from the subtitle. |
| 3 | `Promptly: Chat Video Editor` | 27 | Differentiator-first. Weakest for search ("chat video editor" has near-zero volume) but strongest for positioning if paid UA becomes the main channel and search matters less. |

**Recommendation: no title change in 1.2.0.** Spend the churn budget on subtitle + keywords.

## 2. SUBTITLE (max 30 chars)

| Rank | Subtitle | Chars | Why |
|---|---|---|---|
| 1 | `Auto captions, cuts & B-roll` | 28 | Three indexable feature terms not in the title, and it's literally what the product outputs. "Auto" also indexes ("auto captions" is a real query). |
| 2 | `Edit video by chatting with AI` | 30 | Best differentiator copy, but "video" and "AI" duplicate the title (wasted index space) and "chatting" has no search volume. Better as a screenshot headline than a subtitle. |
| 3 | `Captions, cuts & B-roll by AI` | 29 | Same terms as #1 but "AI" duplicates the title and drops "auto". Strictly dominated by #1. |

## 3. KEYWORD FIELD (max 100 chars)

```
subtitles,clips,reels,shorts,talking,head,creator,vlog,podcast,ugc,viral,trim,text,speech,interview
```
**99 characters.** Choices:

- **Zero duplication** with title ("promptly, ai, video, editor") or subtitle #1 ("auto, captions, cuts, b-roll"). Apple indexes those for free; repeating them wastes chars.
- **`subtitles`** — the single biggest miss if omitted; different query family from "captions" and huge in South Asia/MENA queries.
- **`talking,head`** as separate words, not the phrase — Apple recombines comma-separated words into phrases, so this still matches "talking head" and each word also combines with title/subtitle words ("talking head video," "head editor" noise costs nothing).
- **`reels,shorts`** — platform-format terms, generic enough to pass review (they're formats, not competitor app names). **Deliberately no `capcut`, no `tiktok`, no `instagram`** — trademarked app names in keywords are a metadata-rejection risk and the brief bans competitor names.
- **`ugc,creator,vlog,podcast,interview`** — the actual use cases of a talking-head editor; `ugc` is high-intent and cheap (3 chars).
- **`text,speech`** — recombine with each other and subtitle words to cover "speech to text," "text on video."
- **`trim,viral,clips`** — long-tail edit-intent fillers.
- No plurals-plus-singulars, no spaces after commas, no category name ("photo & video" is indexed from the category).

## 4. DESCRIPTION

**First 3 lines (above the truncation fold — this is all most people read):**

```
Film a talking-head video. Tell Promptly what you want in plain words.
Get it back with captions, dead air cut, B-roll placed, in the vibe you asked for.
Get every edit captioned, cut, and B-rolled. Start a 3-day free trial.
```

**Full body:**

```
Film a talking-head video. Tell Promptly what you want in plain words.
Get it back with captions, dead air cut, B-roll placed, in the vibe you asked for.
Get every edit captioned, cut, and B-rolled. Start a 3-day free trial.

Promptly is a video editor you talk to. No timeline, no keyframes, no tutorial.
Upload a clip of you talking to camera and chat your way to a finished edit.

WHAT IT DOES
• Auto captions — word-level, styled, ready for sound-off viewing
• Smart cuts — silences, stumbles, and dead air removed
• B-roll — relevant footage dropped in where your story needs it
• Vibes — describe the style you want and get the video in that vibe; ask for
  a different vibe to render it again in that style (each render counts toward
  your daily edits)
• Chat-driven re-edits — "bigger captions," "tighten the intro," "calmer vibe" —
  just say it (Pro)

MADE FOR PEOPLE WHO TALK TO CAMERA
Creators, coaches, founders, and anyone posting talking-head video for Reels,
Shorts, or long-form. If your editing backlog is the reason you don't post,
Promptly is the fix.

CAPTIONS IN 9 LANGUAGES
Promptly renders your video's captions in 9 languages, including Arabic and
Hindi — the finished video comes back with subtitles in the language you ask for.

HOW PRICING WORKS — NO SURPRISES
Promptly requires a Pro subscription. Every new account starts with a 3-day free
trial. The trial is limited: 3 edits a day with captions, cuts, and B-roll —
re-edits and Lumen unlock when you go Pro. Before you confirm, the app shows a
day-by-day timeline of exactly when your trial ends and when you'll be charged —
no silent rollover tricks. Turn on notifications and we'll remind you the day
before your trial ends. Cancel anytime in your Apple Account settings before the
trial ends and you pay nothing.

Promptly Pro is available as a monthly or annual auto-renewing subscription.
Payment is charged to your Apple Account at confirmation of purchase after the
free trial ends. The subscription renews automatically unless cancelled at
least 24 hours before the end of the current period. Manage or cancel in your
Apple Account settings.

Privacy Policy: https://usepromptly.app/privacy
Terms of Use: https://usepromptly.app/terms
```

Honesty check: no user counts, no ratings, no "featured by," no "#1," no "free app" claim — "free" appears only attached to the 3-day trial, which is true. The trial is disclosed as **limited** (3 edits/day; re-edit and Lumen are Pro-only) so no trial-gated feature is presented as part of the trial. The 9-languages claim is scoped to **video caption output** (certified/true), not to app-UI localization. The reminder is stated **permission-aware** ("turn on notifications and we'll remind you"), matching the in-app confirmation which reads "enable notifications to get one" when permission isn't granted. Prices stated nowhere in metadata that Apple doesn't auto-update (subscription prices live in the App Store's own IAP display; keeping dollar amounts out of the description means a price change never invalidates copy). *Confirm the privacy/terms URLs match the live domain before submission.*

## 5. SCREENSHOT STORYBOARD (7 screens, 6.9" + 6.5" portrait)

Rules applied throughout: **no dollar amounts in overlay art** (regional pricing would stale them — the trial wall's real price row in screen 7 is the exception and is intentional); no competitor names; no "free" except trial-scoped; every UI frame must be a **genuine pipeline output** (App Review compares assets to real app behavior). Packaging is limited to **crop / split / label / trim** — never a composited effect or a fabricated number.

| # | Headline overlay | UI shown |
|---|---|---|
| 1 | **"One take in. A finished edit out."** | Split frame: left = raw camera-roll clip (no captions, flat), right = the same frame post-Promptly (styled captions, tighter crop, B-roll inset). This is the money shot — before/after must be the *same visible moment*, and both halves must be frames that exist in the real render (no new effect composited at the seam). |
| 2 | **"Captions that keep up with you."** | Full-bleed player mid-video, word-level captions rendering in a bold style. A non-English caption chip (Arabic or Hindi) is allowed **only if it's a real Arabic/Hindi render from the caption pipeline** — produce the genuine Arabic render first, then screenshot it. Do not mock up the chip. This showcases the certified 9-language caption output, not app-UI localization. |
| 3 | **"Just tell it what you want."** | The chat UI over the video: user bubble "cut the pauses and add captions," Promptly's reply, and the edit visibly applied behind it. This is the differentiator screen. |
| 4 | **"Dead air, gone."** | Compact before/after duration readout from the real editor (original length vs edited length on an actual clip — use a real render, not an invented number) with the cut segments visualized. |
| 5 | **"One video. Every vibe."** | **Two genuine renders of the SAME clip in two different vibes, shown side by side as separate results** — both real pipeline outputs. This depicts the true chat-chip interaction (describe a vibe → get that vibe; ask for another → re-render). Do **not** show a fabricated vibe *picker* UI; the product does not pick from a grid, it re-renders on request. |
| 6 | **"Not right? Say so."** | Re-edit flow: user bubble "make the captions bigger and punchier," and the caption size visibly changed between two real frames. Proves it's iterative, not one-shot. (Re-edit is a Pro capability — this screen sells the product, not the trial.) |
| 7 | **"You'll know the day before it bills."** | The actual trial-timeline wall from `TrialWallView`, captured as it appears in-app — the Today / Day 2 reminder / Day 3 charge timeline **with the billed price row intact**. This is now an honest conversion asset: showing the real price and charge date up front pre-frames the paywall and raises trial-start quality. Never strip or crop the price off a billing surface. (Acceptable alternative: the post-purchase confirmation card showing trial-end date + amount — but the real wall with prices is preferred.) |

Optional 8th if slots allow: library/export screen, "From camera roll to posted, in one app." Screens 1–3 do the heavy lifting; order is fixed (before/after must be first — it's the only screenshot most browsers see).

## 6. PREVIEW VIDEO (one ~24s cut, portrait, designed for muted autoplay)

Concept: **the before/after is the video** — the entire preview is one real clip going through the real product. Captions carry the narrative because autoplay is muted (which is itself a demo of the product). Promptly's edit is a **~2-minute async job**, so the preview must show that honestly: every place the edit "happens" is a **visible time-skip** (a hard cut with an on-screen elapsed-time cue, or the stage-timeline states jumping), never an instant live edit.

| Time | Beat |
|---|---|
| 0:00–0:03 | Raw talking-head clip plays: flat framing, an "um," no captions. Overlay: "You filmed this." First frame must read as *deliberately* unpolished, not broken — the poster frame is this shot. |
| 0:03–0:05 | Hard cut to the same second of footage, fully edited: captions on, pause gone. Overlay: "Promptly edited it." |
| 0:05–0:11 | Chat UI slides up; message types out: "add captions, cut the dead air." The render kicks off — show the real stage-timeline advancing, then a **visible time-skip** (cut + on-screen "~2 min later" / elapsed cue) to the finished result. Never depict the edit applying instantly under the typing. Overlay: "It renders — takes about two minutes." |
| 0:11–0:15 | **Two real renders of the same clip in two vibes shown as separate results** (both genuine pipeline outputs). Overlay: "Ask for a different vibe." No fake style-carousel. |
| 0:15–0:18 | B-roll insert appears exactly where the speaker mentions the thing shown — from a real render. Overlay: "B-roll, placed for you." |
| 0:18–0:21 | Second chat message: "punchier." Time-skip cut to the tighter re-render. Overlay: "Re-edit by asking." (Pro.) |
| 0:21–0:24 | Finished clip plays full-bleed 2s, then end card: Promptly mark + "Talk. It edits." No price, no "free" on the end card. |

**Production integrity rules (apply to every screen-record beat here and to the screenshots):**
- **Honest time-skip rule.** The edit is async (~2 min). Any "edit happens" moment must be a visible time-skip — stage-timeline states jumping with a cut, or an on-screen elapsed-time cue. Never portray an instant/live edit.
- **Real-render rule.** All footage is a genuine Promptly render; one continuous source clip so the before/after is verifiably the same take. App Review compares previews to real app behavior.
- **Seam rule.** Any before/after cut (incl. a ShutterFlash-style transition) must land on a frame that **exists in the real render output**. No new effect composited at the before/after seam. Packaging allowance = crop / split / label / trim only.
- **No fabricated social proof.** Present every clip as a **capability demo only**. Never frame or imply a clip came from an organic user, a real customer, or a "found" post if it didn't. There is no "the demo is the social proof" angle.
- **No public-figure likeness in store assets.** Do not use third-party podcast footage or any public-figure likeness in any public asset unless written rights **and** likeness releases are in hand (same ownership/rights gate as source-clip ownership). Recommendation: exclude public-figure likeness from store assets entirely.

## 7. LOCALIZATION NOTE

**Two different things are called "9 languages" — keep them separate.**

- **Video caption output (TRUE / certified, ship it):** the render pipeline outputs captions in 9 languages, including Arabic and Hindi. This is the only "9 languages" claim allowed in store copy, and it belongs to the *video output*, not the app.
- **App-UI localization (NOT shipped on this branch):** the Xcode project's `knownRegions` is still `en` / `Base` only. The app UI is **not** localized into 9 languages yet, and store metadata is not localized. **Do not claim the app is localized.** The section below is forward-looking ASC strategy for when app/metadata localization actually ships — not a description of the current build.

Planning notes for when metadata localization does ship (each field is per-locale; each locale's keyword field is a fresh 100 chars indexed on that storefront):

- **Localize fully (per locale):** subtitle, keyword field, description, screenshot overlay text, preview-video overlay text, promotional text, What's New. Keywords must be *researched* per language, not translated — e.g., Arabic users search "ترجمة الفيديو" (video subtitling) patterns, not a literal translation of "captions."
- **Keep global:** title's brand part ("Promptly"); the descriptor half of the title *may* be localized per locale later, but hold that until a follow-up — one variable at a time.
- **Screenshots:** re-render overlay headlines per language; the *captions inside them* should be that locale's real caption render (an Arabic screenshot showing a genuine Arabic caption render is the single strongest signal we have — and it's the certified output claim, so it's honest). RTL check for Arabic overlays.
- **Critical storefront caveats for our audience:**
  - **App Store Connect has no Urdu (or Bengali/Punjabi) metadata locale.** If Urdu becomes an app language, the app UI could localize but store metadata cannot — Pakistan's storefront is served by English (UK) + Arabic metadata. Budget keywords accordingly.
  - **India** is served by English (UK) + Hindi locales — localize **en-GB separately from en-US** (it's a distinct keyword field; use it for India/Gulf English-language queries, effectively a second 100 chars).
  - **Gulf storefronts (SA/AE)** index Arabic + English (UK). Many Gulf users run phones in English, so en-GB metadata matters as much as Arabic there.
- **Do not localize:** support URL structure, subscription legal boilerplate beyond straight translation (keep it verbatim-faithful — it's compliance text).

Action item before any app-localization claim: confirm the actual list of shipped app-UI languages (repo's `knownRegions` at `/Users/zaclibman/content-studio/ios/Promptly/Promptly.xcodeproj` still shows only `en`/`Base`, so app localization is not on this branch) and map each shipped language to its App Store Connect locale, flagging any language with no store locale. Until that lands, the store copy claims **caption output** in 9 languages only.