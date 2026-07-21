# Zac's single 1.2.0 test — one session, ~20 minutes

This is the only human gate before launch. Everything else is machine-verified
([verification.md](verification.md)). Do this once on a real device with a
**StoreKit sandbox account** (Settings → App Store → Sandbox Account) signed in.

Prereqs (already staged):
- Build **208** is on TestFlight. Install it. Any 1.2.0 build is wall-capable automatically (sends the `X-Promptly-Wall-Capable` header).
- StoreKit **sandbox account** signed in (Settings → App Store → Sandbox Account).

### The Render toggle — exact steps (for the wall parts B/C)
To turn the wall ON for the test:
1. Render dashboard → the **`promptly`** web service → **Environment** tab.
2. Add a variable: key `WALL_ENFORCEMENT`, value `on` → **Save Changes**. Render auto-redeploys (~1–2 min).
3. **Do NOT set `WALL_FLIP_DATE`.** Leaving it unset means enforcement keys ONLY on the wall-capable header — so **only your TestFlight 208 device is affected.**
4. Verify it's on: open `https://usepromptly.app/api/health` — it should show `"wall_enforcement":"on"`.

To turn it back OFF when done:
5. Set `WALL_ENFORCEMENT` back to `off` (or delete the variable) → **Save** → wait for redeploy → confirm `api/health` shows `"wall_enforcement":"off"`.

> **🛡️ SAFETY — flipping the knob during this test does NOT wall the ~1,000 live users.** They're all on pre-1.2.0 binaries that don't send the wall-capable header, so the server never enforces on them (`shouldEnforceWall` returns false). Only wall-capable (208 TestFlight) clients — i.e. your test device — are affected. The test is safe to run against production.

Test order: Part A with the knob **OFF**; flip **ON** for Parts B & C; flip **OFF** again after.

---

## Part A — Knob OFF: "byte-for-byte today" (2 min)
Confirms the release is safe to ship dark before you flip anything.

- [ ] **A1** Launch on your existing account. You land in the app exactly as today — **no onboarding, no wall.** (Grandfather rule: existing signed-in users aren't forced through signup.)
- [ ] **A2** Do a normal render. Works as today. (Pro: unlimited. Free: 3/day.)
- [ ] **A3** Tap Re-edit as today. Same behavior as 1.1.7.

_If anything here differs from today, STOP — the dark deploy isn't inert. (Machine says it is: sanity 24/24, knob off.)_

## Part B — Flip the knob, fresh account (8 min)
Now `WALL_ENFORCEMENT=on`. Sign out; create a **brand-new** account.

- [ ] **B1 — Hook**: the before/after demo plays first, before any signup ask.
- [ ] **B2 — Signup**: Sign in with Apple. Flow continues into the quiz (not the app).
- [ ] **B3 — Quiz**: language step is FIRST. Pick one. Then the creator questions + the "90 days" aspiration. Progress bar advances; one-thumb taps.
- [ ] **B4 — Review prompt**: after the quiz / during "building your studio", the native rate prompt appears (may be suppressed by iOS if you've seen it 3× this year — fine).
- [ ] **B5 — Building**: "building your studio" assembles from your answers, lands on your aspiration line.
- [ ] **B6 — Social proof**: 700+ creators / ~2 min. (True numbers — flag if any look invented.)
- [ ] **B7 — THE WALL**:
  - [ ] Vertical timeline: **Today** (start creating) · **Day 2 🔔** (we remind you) · **Day 3** (the billed price is charged).
  - [ ] The **billed amount** ($199.99/yr or $19.99/mo) is the most prominent price. Monthly-equivalent is a smaller line **under** it, never above.
  - [ ] Timeline says "3 edits a day" — NOT "unlimited"/"re-edit" (limited trial, honest).
  - [ ] "Restore purchases" is visible; fineprint says auto-renews, cancel in **Apple Account settings**.

## Part C — The purchase paths (5 min, sandbox)

- [ ] **C1 — Abandon recovery**: tap **Start free trial**, then **cancel** the Apple sheet. You see "**No charge was made — your free trial is still here**", then it returns to the **same wall, same offer** (never a different price or a second flow).
- [ ] **C2 — Start trial (sandbox)**: tap Start free trial again, complete the sandbox purchase. Confirmation card shows **trial-ends date + the then-price + reminder status**.
- [ ] **C3 — Trial limits**: you're now in. Verify the trial tier:
  - [ ] 4th render in a day is blocked (3/day) → upgrade paywall (NOT the wall).
  - [ ] Re-edit → upgrade paywall ("Re-edit is a Pro feature").
  - [ ] Lumen model → upgrade paywall.
  - [ ] Uploading a 2nd video while one is rendering → blocked (1 upload on trial).

## Part D — Language + lapsed (5 min)

- [ ] **D1 — Language**: force the device (or app) to Hindi and Arabic. Re-launch the onboarding: it renders in that language. Arabic reads right-to-left. (Machine-proven; confirm it feels right.)
- [ ] **D2 — Lapsed** (optional / can wait for a real expiry): a user whose trial ended sees "**Your videos are waiting**" wall with the truthful resubscribe price — never a fresh "free trial" CTA.

---

## Sign-off
- [ ] Every claim on every screen is true.
- [ ] Billed amount is always the most prominent price.
- [ ] One wall — no decliner sees a different flow.
- [ ] Nothing the trial can't actually do is presented as included.

**When all boxes are checked → the two-move launch: (1) release the build, (2) flip `WALL_ENFORCEMENT=on` for everyone.** I run both by machine on your word.

_Evidence for every item is in [verification.md](verification.md); if a box fails, that's a real bug — tell me the box number and I reproduce it in the harness._
