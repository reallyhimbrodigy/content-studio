# Promptly 1.2.0 — Onboarding Hook + App Store Preview: Demo Shortlist

**Ground rules applied (Honesty Law):** every candidate below is real pipeline output or an explicit plan to run a real take through the real pipeline. Nothing is mocked, sped-up-beyond-reality, or hand-edited to look better than the product. The only editing allowed on top of pipeline output is *packaging* (crop, split-screen compositing, BEFORE/AFTER labels, trim) — never touching the edit itself.

**One blocking check before anything ships:** renders 48ec08d8, f87d9f16, etc. came from `sources/<user_id>/...`. Confirm which jobs are **your own footage** vs. real users'. User-generated content in the pre-signup hook or App Store preview needs explicit rights. If a candidate turns out to be a user's clip, it drops off the list and Candidate C (constructed) takes its slot. Rankings below assume 48ec08d8 is yours or clearable.

---

## Ranked candidates

### 1. "Finance Bros" comedic talking-head — **REAL**, job `48ec08d8-8528-4bf2-9006-add101cbc8fc`

**(a) Before/after:** Raw static talking-head (retired accountant vs. finance bros bit, wife punchline) → fully produced short: 3 zoom types (SnapReframe / StepZoom / SmoothPush), 4 SFX, ShutterFlash, burned captions.

**(b) Why it converts:** It's the only clip in inventory that is *funny on mute*. The raw side is visibly amateur (locked-off framing, no captions); the edited side moves every ~1.5s. Comedy + visible motion = the viewer understands the product in one glance without audio. The edit_recipe exercises the full effect stack, so it's also an honest ceiling demo. `thumbnail_timestamp: 10.88s` marks the pipeline's own pick for the peak moment — open there.

**(c) Status:** REAL. Source + output both on CloudFront. Verify footage ownership (blocking check above).

**(d) Production:**
1. Pull source + output (`.../renders/48ec08d8.../1784604585616-edited.mp4`). Regenerate the S3 thumbnail — current presigned URL dies in days.
2. Crop both to 9:16 1080×1920 centered on the speaker.
3. **Hook cut (app, ~6s loop):** 1.2s of raw clip with a small "your clip" label → hard cut (reuse the pipeline's own ShutterFlash beat) → 4–5s of the edited clip starting at ~10.8s. Sequential beats split-screen here: full-frame "after" hits harder in the first 5s, and the raw side has nothing worth half the screen. Silent-autoplay-safe because the pipeline's burned captions carry the joke. Loop seamlessly; no audio dependency.
4. **App Store preview (15–30s):** Apple requires previews to be predominantly in-app experience — so wrap it: screen-record the actual app flow (paste clip → type vibe → progress → result plays in-app), with the before/after as the payoff inside the app UI. Do NOT ship the raw before/after alone as the preview.
5. You already have the compositing pattern: `zoom_AB_sidebyside.mp4` / `zoom_vibe_AB.mp4` are 1080×960 halves of a vertical stack — reuse that ffmpeg pipeline if you A/B a split-screen variant later.

### 2. Constructed founder take: "flat clip → viral edit" — **CONSTRUCTED** (real pipeline)

**(a) Before/after:** Zac records one deliberately plain 20–30s talking-head take — good light, static phone, zero energy in the *production* (not the delivery; deliver it well). Script suggestion: a punchy listicle with a twist ending ("3 editing mistakes that kill your videos — #3 is the one everyone makes"), because list beats give the pipeline natural zoom/SFX trigger points. Vibe to use: the exact prompt from 48ec08d8's recipe class — "viral engaging video: zooms, sound effects, captions, motion graphics." Render through prod, take the output as-is.

**(b) Why it converts:** Purpose-built for the 5-second window: you control framing so the 9:16 crop is perfect, the content is brand-safe, rights are unambiguous, and the "before" is honest (it's genuinely what a normal person's raw clip looks like). Slightly weaker than #1 only because engineered demos rarely beat genuinely funny found footage.

**(c) Status:** CONSTRUCTED but 100% honest — real recording, real production pipeline, untouched output. If the render underwhelms, re-record or re-prompt; do not touch the output file.

**(d) Production:** Same packaging as #1 steps 2–4. Bonus: because you own both sides, you can also cut a split-screen top(before)/bottom(after) synced-timeline variant for paid ads without rights anxiety.

### 3. Fast-paced viral podcast edit — **REAL**, job `f87d9f16-99b0-42ea-9d25-b1c44af58d3c`

**(a) Before/after:** Static podcast clip → cinematic zooms, dynamic captions, SFX, clean transitions.

**(b) Why it converts:** This is the core ICP use case (podcast clippers) shown literally — "your podcast clip becomes a $10k edit." Caption dynamism reads perfectly on mute. Less emotionally sticky than #1 (no joke), but the clearest "this is what the app is for" statement. Strong pick for the App Store preview even if #1 wins the in-app hook — the two assets don't have to be the same clip.

**(c) Status:** REAL. Rights check required (near-certainly third-party podcast content — likeness of the hosts matters for App Store review; this is its biggest risk).

**(d) Production:** Same as #1. For this one a **split-screen** works: podcast framing is symmetric enough that top-raw/bottom-edited with synced timelines makes the caption/zoom delta pop.

### 4. Netflix-documentary Musk edit — **REAL**, job `4f91d9c3-8fe8-4c05-8f88-e36a03061238`

**(a) Before/after:** Rambling take with pauses → tight documentary cut, pauses removed, cinematic zooms.

**(b) Why it converts:** Pause-removal is the most *magical* capability, but it's temporal — nearly impossible to show in a 5s mute clip (you can't see removed silence). Also: Musk content is polarizing and a third-party public figure in your App Store preview invites rejection risk.

**(c) Status:** REAL, but ranked low for demo-format fit, not quality.

**(d) Production:** If used at all, only inside the longer App Store preview with an on-screen counter ("47s → 31s, pauses removed") — that's the one honest way to visualize it.

### 5. Fitness motivational — **REAL**, job `5f8088c3-8ae4-43cd-a146-438a63f3248f`

**(a)** Raw gym/talking footage → dark motivational edit with VoiceOver. **(b)** Looks great with sound, but VoiceOver-driven wow dies on silent autoplay, and dark grading reads muddy at feed brightness. Weakest fit for a mute 5s hook. **(c)** REAL. **(d)** Keep as a *style variety* beat in the App Store preview montage (1–2s), not as the hook.

---

## Recommendation: **#1 (48ec08d8)** — with #2 pre-produced as the fallback

Reasoning: the hook has one job — make a stranger feel "I want *my* clips to look like that" before signup. 48ec08d8 is the only asset that's simultaneously (i) funny with no audio, (ii) a full-stack showcase of what the pipeline actually does (3 zoom types, SFX, ShutterFlash, captions), and (iii) an authentic creator clip rather than an obvious staged demo — which is exactly the Cal-AI trick: the demo *is* the social proof. The pipeline even tells you where the money shot is (10.88s).

Concrete next actions:
1. Confirm rights on 48ec08d8 (owner user_id vs. your accounts). If not clearable → shoot Candidate #2 this week (one hour of work: record, upload, render, package).
2. Regenerate a non-expiring thumbnail/poster for whichever wins.
3. Cut two deliverables from the winner: **6s loop** for the in-app pre-signup hook (sequential before→after, burned captions, silent-safe) and a **~25s App Store preview** where the before/after is the payoff *inside* a real screen-capture of the app flow (Apple's in-app-experience rule).
4. Ship both at 1080×1920 H.264; keep source project so you can re-render 886×1920 / other App Store device sizes.

Reference paths: existing packaging templates at `/Users/zaclibman/LiveNew/public/assets/zoom_AB_sidebyside.mp4` and `/Users/zaclibman/LiveNew/public/assets/zoom_vibe_AB.mp4` (1080×960 stack halves, 4s); prior 9:16 demo clips `viral_punch.mp4` / `corporate_glide.mp4` (1080×1920, 4s) show the target format.