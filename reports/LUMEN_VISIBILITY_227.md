# Lumen visibility — the 227 client half + the $0.05 tease `[§2.1]`

**Design note, 2026-08-12. Server half is built dark today; this is what the
client must do and what the tease costs.** No client code written — §9 of my
standing rules: iOS is spec-only, the owner ships the build.

§2.1's ruling: *"the premium model is always **visible and named** in the
product (locked model = a product surface, not an absence)"*, and the visibility
problem is solved by **bounded exposure**, not generosity.

---

## §1 — The ModelPicker finding, CONFIRMED (and one correction)

The picker is **mounted and live** in the shipped client:

```
EditorView.swift:850            ModelPickerPill()                    ← mounted
ModelPicker.swift:28,79,93      Pill → ModelPickerSheet
ModelService.swift:50-52        premiumPipelineFlag(isPro:)
VideoModel.swift:69-71          premiumFlag = selected.isPremium && isPro
EditorView.swift:1789           createVideoJob(premiumPipeline: …)   ← dispatch
```

**Correction to my earlier report:** I first said the picker had *zero call
sites*. That was wrong — I grepped for `ModelPicker(` and the mounted symbol is
`ModelPickerPill()`. The client chain is fully wired and always was.

**What this means:** the client was never the blocker. A Pro user who opened the
picker and chose Lumen WOULD have sent `premium_pipeline_enabled: true`. The
blocker was the undeclared server env var, and the picker-dependency was a
*second* gate on top — a Pro user who never opened the picker got standard
silently.

**§2.1 removes the dependency server-side** (`lib/lumen-access.js`): entitlement
decides, and absence of the client field is no longer a decline. **The client
half below is therefore about VISIBILITY, not routing.** Routing works without
it. That is the right split: a client build must never again be load-bearing for
whether the #1 value can run.

---

## §2 — What 227 must do (client half)

### 2.1 The locked model is a product surface, not an absence

Today `showPremiumAccent` is `selected.isPremium && isPro` — so a **free user
sees no premium signal at all**. §2.1 says the opposite: always visible, always
named.

- The pill shows **Lumen by name** to every user, entitled or not.
- For a free user it renders **locked** (the sparkle + a lock affordance), never
  hidden and never greyed into meaninglessness.
- Tapping a locked Lumen opens **the wall carrying the founder's showcase
  examples** (§2.1) — not a generic paywall. The examples are the argument.

**The invariant:** a free user must be able to *see what they are not getting*,
by name, on the main surface. That is the entire mechanism by which §3.1's #1
value does any selling.

### 2.2 Selection is a preference, never a requirement

With the server tied to entitlement, the picker's job changes:

| user state | picker shows | what the client sends |
|---|---|---|
| Pro, Lumen selected | Lumen, active | nothing needed (server decides) |
| Pro, standard selected | Standard | `premium_pipeline_enabled: false` ← the explicit opt-out |
| Free | Lumen, **locked** + Standard active | nothing |

Only the explicit **opt-out** is load-bearing now. A Pro user who never touches
the picker gets Lumen because they are entitled — which is §2.1's ruling.

### 2.3 Quota is a sentence, not a meter

Paid Lumen carries a monthly quota (§2.1). §1 says the conversation is the only
interface, so **no gauge, no counter chrome**. When the quota is spent the
server returns the withheld note (`lumen-access.withheldNote`) and the client
renders it as **an assistant message**, like any other honest negotiation
(§4.5). The number appears only when it is relevant, in a sentence.

---

## §3 — The $0.05 personal tease `[§2.1]`

> *"a cheap personal tease (a single Lumen-styled still of the user's own video,
> ~$0.05) may accompany finished standard renders"*

**Why this is the strongest visibility lever available:** showcase examples are
someone else's video. A Lumen-styled still of **their own footage**, attached to
an edit they already like, is the only demonstration that answers *"what would
this look like for me?"* — and it costs ~5% of a full Lumen render.

### Mechanics (all pieces already exist)

The subject-still generator built for `GeneratedScene` is exactly this
capability: `handler.py:11233` generates one scene's subject still via Nano
Banana, on the premium path. The tease is that call, on the standard path, once,
against a frame of the user's own render.

```
standard render completes
  → pick ONE frame (the payoff beat's frame — already known to the plan)
  → one Nano Banana call: that frame, Lumen-styled
  → attach to the completion as a still, with one sentence
  → NEVER blocks delivery: it rides AFTER the video is delivered
```

### The five rules it must obey

1. **Never delays the edit.** §4.1 is 120s for the edit. The tease is
   post-delivery, always; a tease that costs a second of the user's wait has
   already failed.
2. **Never fails the job.** Generation failure = no tease, no note, no error.
   It is a bonus, and a bonus that can break a delivery is a defect.
3. **The note follows the artifact (§4.6).** The sentence ships only when the
   still exists and was verified — never "here's what Lumen could do" attached
   to nothing.
4. **Metered like everything else.** A `LUMEN_TEASE_ENABLED` flag (default off)
   and a per-day cap. At ~$0.05 × the free base this is the one place a small
   number becomes a large bill fastest.
5. **Once per user per period, not per render.** A tease on every render is an
   ad; a tease on the first good edit is a demonstration.

### Cost model

| | |
|---|---|
| per tease | ~$0.05 (one image gen) |
| vs a full Lumen render | ~5% |
| at 1,000 free users × 1 tease/month | ~$50/month |
| the cap that makes it safe | `LUMEN_TEASE_DAILY_BUDGET_USD`, default 0 |

**Not built.** Design only, pending the owner's word on whether the tease is
wanted at all — same posture as music (§7.3).

---

## §4 — What is already true today (server, dark)

| piece | state |
|---|---|
| `PREMIUM_PIPELINE_ENABLED` declared in `render.yaml` | ✅ (value: owner, dashboard) |
| Routing tied to entitlement, picker-independent | ✅ `lib/lumen-access.js` |
| Metered free dial, default **0** | ✅ |
| Paid monthly quota, default 30, month rides the key | ✅ (resets free, no cron) |
| Global daily budget cap | ✅ (0 = disabled) |
| Withheld-note copy, internal states never shown | ✅ |
| `premium_pipeline` on `/api/health` | ✅ |
| Per-render cost meter | ⏳ worker-side, next |
| The $0.05 tease | ⏳ design only, owner's call |

All dark. Nothing above changes a single user's experience until
`PREMIUM_PIPELINE_ENABLED` is set.
