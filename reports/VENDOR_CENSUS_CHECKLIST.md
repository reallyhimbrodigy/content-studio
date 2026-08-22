# VENDOR CENSUS — a checklist for the card-statement read, not a spend claim

**JUDGE, 2026-08-22.** The $2,670/mo unaccounted (53% of the bill) is one read
away. This makes that read a **matching exercise against a closed list** rather
than an open "what else is there" — which is the difference between a five-minute
check and an afternoon.

**Every row below has a credential AND a verified code reference.** I checked
invocation rather than trusting a key name, because yesterday I put `bleed-meter`
on the board as a daily Pro-tier Gemini job when it makes **zero** Gemini calls —
it matched a grep on the word "model" in a *Modal* comment. **A key name is not a
call site, and a call site is not production traffic.**

## Already on the cost board

| vendor | $/mo | how known |
|---|---:|---|
| Modal | $1,050 | `[OWNER]` |
| Gemini / Vertex | $1,000 | `[OWNER]` — **and it is TWO surfaces, see `GEMINI_TWO_SURFACES.md`** |
| PostHog | $280 | `[MEASURED]` |

## NOT on the board — check each against the statement

**Metered AI/compute — the strongest candidates for a four-figure line:**

| vendor | credential | verified at | why it could be large |
|---|---|---|---|
| **Anthropic** | `ANTHROPIC_API_KEY`, `CLAUDE_API_KEY` | `server.js` (`api.anthropic.com`) | **an LLM API nobody has named in any cost discussion** |
| **OpenAI** | `OPENAI_API_KEY` | `server.js` (`api.openai.com`) | same — a second unnamed LLM vendor |
| **ElevenLabs** | `ELEVENLABS_API_KEY` | worker `modal_app.py`, `handler.py` | TTS bills per character; unmeasured |
| **Apify** | `APIFY_API_TOKEN` | `scripts/trend-video-pipeline.js` | paid scraping, runs on the **weekly** cron |

**Infrastructure and services:**

| vendor | credential | verified at |
|---|---|---|
| AWS S3 + CloudFront | `AWS_ACCESS_KEY` | both repos; egress bounded at **$17–171/mo** (see vendor board) |
| Supabase | `SUPABASE_SERVICE_ROLE_KEY` (+ S3 keys) | both repos |
| Render | — | hosts the server + the weekly cron |
| Deepgram | `DEEPGRAM_API_KEY` | both repos; **2,359 audio min/mo measured ≈ $10** |
| RevenueCat | `REVENUECAT_SECRET_KEY` | `server.js` |
| Resend | `RESEND_API_KEY` | `server.js` — email |
| HuggingFace | `HUGGINGFACE_TOKEN` | worker — model weights |
| Pexels | `PEXELS_API_KEY` | worker — b-roll |
| Apple APNs | `APNS_AUTH_KEY` | `server.js` — push |

**Named but NOT evidenced as live:** Stripe (`STRIPE_SECRET_KEY` appears only in
`README.md`, `js/landing.js` and a test — **no server call site found**), GCS
(`@google-cloud/storage` in `package.json`, no verified call path outside the
trend cron's env block).

**Not a vendor but a real line on an owner's total:** App Store / Google Play
commission, 15–30% of revenue. It is not infrastructure, which is exactly why an
infrastructure census would miss it — **check whether the ~$5,000 figure includes
it before hunting further.**

## The single highest-value question, unchanged

**Which lines on the statement are NOT in the table above?** Anything that
appears there and not here is a vendor the codebase does not explain, and that is
a bigger finding than any lever currently ranked. **Anthropic and OpenAI are the
two I would look for first** — both are metered LLM APIs with live credentials
and server-side call sites, and neither has ever appeared in a cost conversation
on this board.

## Honest limits

- **A verified call site is not proof of production traffic.** Any of these could
  be dormant. This list bounds *what is possible*, not what is spent.
- **I have no billing access to any of them**, so I cannot convert this list into
  dollars — which is precisely why the statement read outranks every measurement
  below it on the board.
