# Zac's single 1.2.0 test — one session, ~20 minutes

This is the only human gate before launch. Everything else is machine-verified
([verification.md](verification.md)). Do this once on a real device with a
**StoreKit sandbox account** (Settings → App Store → Sandbox Account) signed in.

Prereqs I'll have staged for you:
- 1.2.0 on TestFlight (build submitted by machine).
- Your account flagged wall-capable is automatic (any 1.2.0 build sends the header).
- To exercise the wall you flip **one server env var** when ready:
  `WALL_ENFORCEMENT=on` in Render (I'll give you the exact toggle at ship time).
  Leave it OFF for steps 1–2, ON for steps 3+.

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
