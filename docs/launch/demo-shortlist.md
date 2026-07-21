File overwritten at /Users/zaclibman/content-studio/docs/launch/demo-shortlist.md. Below is the complete revised markdown.

Note on scope: the file is the demo-shortlist doc only — it contains no product-page copy (no title/subtitle/keyword arithmetic, no trial-copy/"9 languages"/"word-accurate"/"Cancel anytime in Settings" strings), so product-page fixes 1–8 have no anchor text in this file. Demo-shortlist fixes 9–12 plus the shared honesty ground-truth (ShutterFlash seam rule, honest time-skip) are all applied. If a separate product-page doc exists, fixes 1–8 belong there.

Applied here:
- 9 — Stripped all "Cal-AI trick / the demo IS social proof" framing (old line 64) and the "authentic creator clip" angle; #1 is now explicitly a capability demo with an anti-testimonial guard.
- 10 — Candidates #3 (podcast) and #4 (Musk) hard-blocked from any public asset absent written rights AND likeness releases; added blocking check #2 and an explicit recommendation to exclude public-figure likeness from store assets entirely.
- 11 — ShutterFlash/seam rule promoted to a binding ground rule and repeated in #1 step 3: cut must land on a real render frame, no new effect composited at the seam; packaging = crop/split/label/trim only.
- 12 — Honest time-skip rule added as a binding ground rule and attached to every screen-record beat (#1 step 4, #2, #3, action item 3).

---

# Promptly 1.2.0 — Onboarding Hook + App Store Preview: Demo Shortlist

**Ground rules applied (Honesty Law):** every candidate below is real pipeline output or an explicit plan to run a real take through the real pipeline. Nothing is mocked, sped-up-beyond-reality, or hand-edited to look better than the product. The only editing allowed on top of pipeline output is *packaging* — crop, split-screen compositing, BEFORE/AFTER labels, trim — and nothing else. Packaging never touches the edit itself.

**Two production rules that bind every beat below:**

- **ShutterFlash / seam rule:** any before→after cut must land on a frame that *actually exists* in the real render output. Reuse the pipeline's own ShutterFlash beat only if that flash is genuinely in the rendered file — never composite a new transition or effect at the before/after seam to smooth it. If the real render has no clean cut point, trim to one; do not manufacture one.
- **Honest time-skip rule (any screen-record beat):** the real edit is a ~2-minute async job. Any screen recording of the app flow must show that honestly — an explicit, *visible* time-skip (a hard cut between stage-timeline states, or an on-screen elapsed-time cue like "~2 min later"). Never present the result as an instant/live edit, and never speed the progress UI to imply it's faster than it is.

**Blocking checks before anything ships:**

1. **#1 ownership.** Renders 48ec08d8, f87d9f16, etc. came from `sources/<user_id>/...`. Confirm which jobs are **your own footage** vs. real users'. User-generated content in the pre-signup hook or App Store preview needs explicit rights. If a candidate turns out to be a user's clip, it drops off the list and Candidate #2 (constructed) takes its slot. Rankings below assume 48ec08d8 is yours or clearable. The clip is presented purely as a *capability* demo — never framed or captioned to imply it came from an organic user unless it verifiably did and is cleared for that use.
2. **#3 and #4 hard block.** Candidate #3 (third-party podcast) and Candidate #4 (public figure / Musk) are **hard-blocked from any public asset** — App Store preview, ads, pre-signup hook, anything shipped — unless written rights **and** likeness releases for every identifiable person are in hand. Same blocking bar as #1's ownership check, plus a likeness release on top. Recommendation: exclude public-figure likeness from store assets entirely; the review-rejection and legal exposure aren't worth it when a constructed clip does the same job cleanly.

---

## Ranked candidates

### 1. "Finance Bros" comedic talking-head — **REAL**, job `48ec08d8-8528-4bf2-9006-add101cbc8fc`

**(a) Before/after:** Raw static talking-head (retired accountant vs. finance bros bit, wife punchline) → fully produced short: 3 zoom types (SnapReframe / StepZoom / SmoothPush), 4 SFX, ShutterFlash, burned captions.

**(b) Why it converts:** It's the only clip in inventory that is *funny on mute*. The raw side is visibly amateur (locked-off framing, no captions); the edited side moves every ~1.5s. Comedy + visible motion = the viewer understands the product in one glance without audio. The edit_recipe exercises the full effect stack, so it's an honest ceiling demo of what the pipeline actually does. `thumbnail_timestamp: 10.88s` marks the pipeline's own pick for the peak moment — open there. Treat this strictly as a capability demonstration; do not caption or frame it as an organic user testimonial.

**(c) Status:** REAL. Source + output both on CloudFront. Verify footage ownership (blocking check #1).

**(d) Production:**
1. Pull source + output (`.../renders/48ec08d8.../1784604585616-edited.mp4`). Regenerate the S3 thumbnail — current presigned URL dies in days.
2. Crop both to 9:16 1080×1920 centered on the speaker.
3. **Hook cut (app, ~6s loop):** 1.2s of raw clip with a small "your clip" label → hard cut to ~4–5s of the edited clip starting at ~10.8s. Reuse the pipeline's own ShutterFlash beat *only if the cut lands on a frame that exists in the rendered output* — no new transition composited at the seam (seam rule above). Sequential beats, not split-screen: full-frame "after" hits harder in the first 5s, and the raw side has nothing worth half the screen. Silent-autoplay-safe because the pipeline's burned captions carry the joke. Loop seamlessly; no audio dependency.
4. **App Store preview (15–30s):** Apple requires previews to be predominantly in-app experience — so wrap it: screen-record the actual app flow (paste clip → type the vibe you want → progress → result plays in-app), with the before/after as the payoff inside the app UI. The progress→result beat **must carry a visible time-skip** (hard cut between stage-timeline states or an "~2 min later" cue) — never an instant edit (honest time-skip rule). Do NOT ship the raw before/after alone as the preview.
5. You already have the compositing pattern: `zoom_AB_sidebyside.mp4` / `zoom_vibe_AB.mp4` are 1080×960 halves of a vertical stack — reuse that ffmpeg pipeline if you A/B a split-screen variant later (packaging only).

### 2. Constructed founder take: "flat clip → viral edit" — **CONSTRUCTED** (real pipeline)

**(a) Before/after:** Zac records one deliberately plain 20–30s talking-head take — good light, static phone, zero energy in the *production* (not the delivery; deliver it well). Script suggestion: a punchy listicle with a twist ending ("3 editing mistakes that kill your videos — #3 is the one everyone makes"), because list beats give the pipeline natural zoom/SFX trigger points. Vibe to use: the exact prompt from 48ec08d8's recipe class — "viral engaging video: zooms, sound effects, captions, motion graphics." Render through prod, take the output as-is.

**(b) Why it converts:** Purpose-built for the 5-second window: you control framing so the 9:16 crop is perfect, the content is brand-safe, rights are unambiguous, and the "before" is honest (it's genuinely what a normal person's raw clip looks like). Slightly weaker than #1 only because engineered demos rarely beat genuinely funny found footage — but it carries zero rights or likeness risk, which is why it's the fallback for #1 and the safe choice for paid ads.

**(c) Status:** CONSTRUCTED but 100% honest — real recording, real production pipeline, untouched output. If the render underwhelms, re-record or re-prompt; do not touch the output file.

**(d) Production:** Same packaging as #1 steps 2–4, including the seam rule and the honest time-skip rule on any screen-record beat. Bonus: because you own both sides, you can also cut a split-screen top(before)/bottom(after) synced-timeline variant for paid ads without rights anxiety.

### 3. Fast-paced viral podcast edit — **REAL**, job `f87d9f16-99b0-42ea-9d25-b1c44af58d3c`

**(a) Before/after:** Static podcast clip → cinematic zooms, dynamic captions, SFX, clean transitions.

**(b) Why it converts:** This is the core ICP use case (podcast clippers) shown literally — "your podcast clip becomes a $10k edit." Caption dynamism reads perfectly on mute. Less emotionally sticky than #1 (no joke), but the clearest "this is what the app is for" statement.

**(c) Status:** REAL, but **HARD-BLOCKED for any public asset** (blocking check #2). This is near-certainly third-party podcast content; the hosts are identifiable, so it needs written rights **and** a likeness release for every person on screen before it can appear in an App Store preview, ad, or hook. Without both in hand, do not ship it — use #2 to make the same "podcast clip → pro edit" point with a clip you own.

**(d) Production (only if fully cleared):** Same as #1, including seam and time-skip rules. If cleared, a **split-screen** works here: podcast framing is symmetric enough that top-raw/bottom-edited with synced timelines makes the caption/zoom delta pop (packaging only).

### 4. Netflix-documentary Musk edit — **REAL**, job `4f91d9c3-8fe8-4c05-8f88-e36a03061238`

**(a) Before/after:** Rambling take with pauses → tight documentary cut, pauses removed, cinematic zooms.

**(b) Why it converts:** Pause-removal is the most *magical* capability, but it's temporal — nearly impossible to show in a 5s mute clip (you can't see removed silence).

**(c) Status:** REAL, but **HARD-BLOCKED for any public asset** (blocking check #2). It depicts a public figure's likeness; a third-party public figure in a store asset invites rejection risk and legal exposure, and no likeness release exists. **Recommendation: exclude public-figure likeness from store assets entirely** — do not ship this in any public surface. If you need to show pause-removal, reshoot the capability with your own take (constructed, per #2) and an on-screen "47s → 31s, pauses removed" counter — the one honest way to visualize a temporal edit, inside the longer preview only.

### 5. Fitness motivational — **REAL**, job `5f8088c3-8ae4-43cd-a146-438a63f3248f`

**(a)** Raw gym/talking footage → dark motivational edit with VoiceOver. **(b)** Looks great with sound, but VoiceOver-driven wow dies on silent autoplay, and dark grading reads muddy at feed brightness. Weakest fit for a mute 5s hook. **(c)** REAL (own-footage/rights check still applies before any public use). **(d)** Keep as a *style variety* beat in the App Store preview montage (1–2s), not as the hook.

---

## Recommendation: **#1 (48ec08d8)** — with #2 pre-produced as the fallback

Reasoning: the hook has one job — make a stranger feel "I want *my* clips to look like that" before signup. 48ec08d8 is the only asset that's simultaneously (i) funny with no audio and (ii) a full-stack showcase of what the pipeline actually does (3 zoom types, SFX, ShutterFlash, captions). It is used as a capability demo, nothing more — no "real user" framing unless the clip is verifiably a cleared user submission. The pipeline even tells you where the money shot is (10.88s). #2 is the fallback because it's rights-clean and covers the same ground if #1 can't clear ownership. #3 and #4 stay off every public surface unless full rights + likeness releases land (blocking check #2), and public-figure likeness should stay out of store assets regardless.

Concrete next actions:
1. Confirm rights on 48ec08d8 (owner user_id vs. your accounts). If not clearable → shoot Candidate #2 this week (one hour of work: record, upload, render, package).
2. Regenerate a non-expiring thumbnail/poster for whichever wins.
3. Cut two deliverables from the winner: **6s loop** for the in-app pre-signup hook (sequential before→after, burned captions, silent-safe, cut on a real render frame) and a **~25s App Store preview** where the before/after is the payoff *inside* a real screen-capture of the app flow (Apple's in-app-experience rule) — with a visible time-skip on the progress→result beat (honest time-skip rule).
4. Ship both at 1080×1920 H.264; keep source project so you can re-render 886×1920 / other App Store device sizes.

Reference paths: existing packaging templates at `/Users/zaclibman/LiveNew/public/assets/zoom_AB_sidebyside.mp4` and `/Users/zaclibman/LiveNew/public/assets/zoom_vibe_AB.mp4` (1080×960 stack halves, 4s); prior 9:16 demo clips `viral_punch.mp4` / `corporate_glide.mp4` (1080×1920, 4s) show the target format.