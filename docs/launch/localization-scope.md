# Localization — 1.2.0 scope (stated)

## Shipping in 1.2.0
- **Onboarding + trial wall localized into 9 languages** via `Localizable.xcstrings`
  (String Catalog): en, es, pt-BR, hi, ar, id, fr, de, ja. 78 keys.
- **Translation quality gate:** every string was machine-translated by a
  native-register agent, then **back-translated to English and compared**;
  a string only ships in a language if the back-translation preserved meaning
  AND all `%@ / %lld` placeholders were intact. Result: **624/624 language-string
  pairs passed — 0 fell back to English.** (Anything that had failed would have
  silently fallen back to English, never shipped broken.)
- **Format strings work:** interpolated copy localizes correctly — proven in-sim:
  Hindi "दिन 2 — हम आपको याद दिलाएँगे" (Day %lld→2), fineprint "3 दिन मुफ्त, फिर $199.99"
  (%lld days + %@ price); Arabic "اليوم 2 — نذكّرك", "3 أيام مجاناً، ثم $199.99".
- **RTL (Arabic):** the onboarding + wall layout **auto-mirrors correctly** under
  SwiftUI (timeline icons flip to the right, text right-aligns) — proven by
  presentation (`scratchpad/loc-proof/ar_wall.png`).
- **Loanwords preserved** across all languages: Promptly, B-roll, Pro, Apple
  Account, TikTok, Instagram Reels, YouTube Shorts, AI.
- The onboarding **language picker** (beat 3, step 1) captures the user's choice
  and feeds it to personalization + the PostHog `preferred_language` person property.
- **Video caption OUTPUT** already renders in 9 languages (the pipeline) — this is
  the claim the product page makes; it is independent of app-UI localization.

## Deferred to 1.2.1 (explicit)
- **Full app-chrome localization** (Editor, Library, Settings, chat, failure
  screens — the bulk of the app). Only the revenue-gating surfaces (onboarding +
  wall) are localized in 1.2.0. Rationale: doing the whole app right is a large,
  careful pass (hundreds of strings incl. dynamic/interpolated copy); a
  half-localized app is a worse experience than a clean scope, and the honesty
  law forbids claiming full localization before it's real. The App Store metadata
  correctly claims **caption-output** localization only, not app-UI.
- **Full-app RTL layout QA for Arabic.** Onboarding + wall RTL is proven; the
  rest of the app has custom layouts (hardcoded leading/trailing, fixed frames)
  that need a per-view RTL audit before an Arabic app-UI claim.
- **Dynamic building-reveal rows** ("Tuned for <your answer>") interpolate the
  user's English quiz answer and currently render English inside an otherwise
  localized flow — a minor personalization residue; localize with the app-chrome
  pass.

## Store-locale caveats (from the compliance review — for the metadata pass)
- **No Urdu / Bengali / Punjabi App Store metadata locale.** Pakistan's storefront
  is served by English (UK) + Arabic metadata. If Urdu is an app language, the app
  localizes but store metadata cannot.
- **en-GB is a separate keyword field** from en-US — use it for India/Gulf
  English-language queries (effectively a second 100 chars).
- **Gulf storefronts (SA/AE):** index Arabic + English (UK); many Gulf users run
  phones in English, so en-GB matters as much as Arabic there.
