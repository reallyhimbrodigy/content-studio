# Promptly 1.2.0 — App Store Product-Page Pass

Bundle: `app.usepromptly.ios` · Current name: "Promptly - AI Video Editor" · Model: Pro $19.99/mo / $199.99/yr, 3-day free trial, no free tier.

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
Not right? Say "make it punchier" and it re-edits. Try Promptly Pro free for 3 days.
```

**Full body:**

```
Film a talking-head video. Tell Promptly what you want in plain words.
Get it back with captions, dead air cut, B-roll placed, in the vibe you asked for.
Not right? Say "make it punchier" and it re-edits. Try Promptly Pro free for 3 days.

Promptly is a video editor you talk to. No timeline, no keyframes, no tutorial.
Upload a clip of you talking to camera and chat your way to a finished edit.

WHAT IT DOES
• Auto captions — word-accurate, styled, ready for sound-off viewing
• Smart cuts — silences, stumbles, and dead air removed
• B-roll — relevant footage dropped in where your story needs it
• Vibes — the same video, rendered in multiple styles; pick the one that fits
• Chat-driven re-edits — "bigger captions," "tighten the intro," "calmer vibe" — just say it

MADE FOR PEOPLE WHO TALK TO CAMERA
Creators, coaches, founders, and anyone posting talking-head video for Reels,
Shorts, or long-form. If your editing backlog is the reason you don't post,
Promptly is the fix.

IN 9 LANGUAGES
Promptly 1.2.0 speaks your language — the app is localized into 9 languages,
including Arabic and Hindi.

HOW PRICING WORKS — NO SURPRISES
Promptly requires a Pro subscription. Every new account starts with a 3-day
free trial, and the app shows you a day-by-day timeline of exactly when the
trial ends before you confirm — no silent rollover tricks. Cancel anytime in
Settings before the trial ends and you pay nothing.

Promptly Pro is available as a monthly or annual auto-renewing subscription.
Payment is charged to your Apple Account at confirmation of purchase after the
free trial ends. The subscription renews automatically unless cancelled at
least 24 hours before the end of the current period. Manage or cancel in your
Apple Account settings.

Privacy Policy: https://usepromptly.app/privacy
Terms of Use: https://usepromptly.app/terms
```

Honesty check: no user counts, no ratings, no "featured by," no "#1," no "free app" claim — "free" appears only attached to the 3-day trial, which is true. Prices stated nowhere in metadata that Apple doesn't auto-update (subscription prices live in the App Store's own IAP display; keeping dollar amounts out of the description means a price change never invalidates copy). *Confirm the privacy/terms URLs match the live domain before submission.*

## 5. SCREENSHOT STORYBOARD (7 screens, 6.9" + 6.5" portrait)

Rule applied throughout: **no dollar amounts anywhere** (price changes and regional pricing would stale them), no competitor names, no "free" except trial-scoped.

| # | Headline overlay | UI shown |
|---|---|---|
| 1 | **"One take in. A finished edit out."** | Split frame: left = raw camera-roll clip (no captions, flat), right = the same frame post-Promptly (styled captions, tighter crop, B-roll inset). This is the money shot — before/after must be the *same visible moment*. |
| 2 | **"Captions that keep up with you."** | Full-bleed player mid-video, word-level captions rendering in a bold style. Show a non-English caption chip subtly (Arabic or Hindi) to signal localization. |
| 3 | **"Just tell it what you want."** | The chat UI over the video: user bubble "cut the pauses and add captions," Promptly's reply, and the edit visibly applied behind it. This is the differentiator screen. |
| 4 | **"Dead air, gone."** | Compact before/after duration readout from the real editor (e.g., original length vs edited length on an actual clip — use a real render, not an invented number) with the cut segments visualized. |
| 5 | **"One video. Every vibe."** | The vibe/style picker: 3–4 renders of the same clip in different styles, one selected. |
| 6 | **"Not right? Say so."** | Re-edit flow: user bubble "make the captions bigger and punchier," and the caption size visibly changed between two frames. Proves it's iterative, not one-shot. |
| 7 | **"You'll know the day before it bills."** | The actual trial-timeline paywall: Day 1 / Day 2 (reminder) / Day 3 (trial ends) timeline, exactly as it appears in-app, **with the price row cropped or omitted**. Transparency as a selling point — rare enough to be a conversion asset, and it pre-frames the hard paywall so trial-start intent is higher quality. |

Optional 8th if slots allow: library/export screen, "From camera roll to posted, in one app." Screens 1–3 do the heavy lifting; order is fixed (before/after must be first — it's the only screenshot most browsers see).

## 6. PREVIEW VIDEO (one 24s cut, portrait, designed for muted autoplay)

Concept: **the before/after is the video** — the entire preview is one real clip getting edited in real product UI. Captions carry the narrative because autoplay is muted (which is itself a demo of the product).

| Time | Beat |
|---|---|
| 0:00–0:03 | Raw talking-head clip plays: flat framing, an "um," no captions. Overlay: "You filmed this." First frame must read as *deliberately* unpolished, not broken — the poster frame is this shot. |
| 0:03–0:05 | Hard cut to the same second of footage, fully edited: captions on, pause gone. Overlay: "Promptly edited it." |
| 0:05–0:10 | Rewind. Chat UI slides up; message types out: "add captions, cut the dead air." Edit applies live on the video behind it. |
| 0:10–0:14 | Vibe switcher: same frame flicks through 3 styles, settles on one. Overlay: "Pick your vibe." |
| 0:14–0:18 | B-roll insert appears exactly where the speaker mentions the thing shown. Overlay: "B-roll, placed for you." |
| 0:18–0:21 | Second chat message: "punchier." Cut visibly tightens. Overlay: "Re-edit by asking." |
| 0:21–0:24 | Finished clip plays full-bleed 2s, then end card: Promptly mark + "Talk. It edits." No price, no "free" on the end card. |

Production notes: all footage must be a genuine Promptly render (App Review compares previews to real app behavior); one continuous source clip so the before/after is verifiably the same take; no hands/device frames needed — screen capture + the source video is enough.

## 7. LOCALIZATION NOTE (9 languages)

What localizes per App Store Connect locale — each of these is a **separate field per language**, and each locale's keyword field is a fresh 100 chars indexed on that storefront:

- **Localize fully (per locale):** subtitle, keyword field, description, screenshot overlay text, preview-video overlay text, promotional text, What's New. Keywords must be *researched* per language, not translated — e.g., Arabic users search "ترجمة الفيديو" (video subtitling) patterns, not a literal translation of "captions."
- **Keep global:** title's brand part ("Promptly"); the descriptor half of the title *may* be localized per locale if we want (e.g., Arabic descriptor), but recommend holding that until 1.3 — one variable at a time.
- **Screenshots:** re-render overlay headlines per language; the *UI inside them* should show that locale's captions (an Arabic screenshot showing Arabic captions is the single strongest localization signal we have). RTL check for Arabic overlays.
- **Critical storefront caveats for our audience:**
  - **App Store Connect has no Urdu (or Bengali/Punjabi) metadata locale.** If Urdu is one of our 9 app languages, the app UI localizes but store metadata cannot — Pakistan's storefront is served by English (UK) + Arabic metadata. Budget keywords accordingly.
  - **India** is served by English (UK) + Hindi locales — localize **en-GB separately from en-US** (it's a distinct keyword field; use it for India/Gulf English-language queries, effectively a second 100 chars).
  - **Gulf storefronts (SA/AE)** index Arabic + English (UK). Many Gulf users run phones in English, so en-GB metadata matters as much as Arabic there.
- **Do not localize:** support URL structure, subscription legal boilerplate beyond straight translation (keep it verbatim-faithful — it's compliance text).

Action item before submission: get the confirmed list of the 9 shipped languages (the repo's Xcode project at `/Users/zaclibman/content-studio/ios/Promptly/Promptly.xcodeproj` still shows only `en`/`Base` in `knownRegions`, so the localization work isn't on this branch) and map each to its App Store Connect locale, flagging any language that has no store locale.