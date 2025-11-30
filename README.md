# Promptly — Content Studio (MVP)

Small local dev instructions and QA steps.

## Run locally

1. Install dependencies (none required for the static app except optional dev tools):

```bash
# start server
npm start
```

2. Open http://localhost:8000 in your browser.

## E2E smoke test (optional)

This project includes a small Playwright smoke test at `tests/e2e.spec.js` that:
- signs up a test user
- generates a 30-day calendar
- asserts 30 calendar cards render

To run it:

```bash
# install playwright (dev)
npm install --save-dev playwright

# install browser binaries
npx playwright install

# run the single test
npm run test:e2e
```

Notes
- The test will call your running local server at `http://localhost:8000` and requires a working OpenAI proxy backend (the server and OPENAI_API_KEY must be configured).
- Playwright is intentionally optional — it's not required to run the app, but it's a useful smoke test for CI.

### Stability sandbox check

There is also a lightweight integration check that pings Stability's sandbox endpoint with the exact multipart payload our server sends:

```bash
# export your sandbox (or production) key first
export STABILITY_SANDBOX_API_KEY=your_sandbox_key
npm run test:stability
```

If no sandbox key is set the script exits cleanly and prints "skipped", which allows it to run safely during CI/deploys.

## Brand Brain (new feature)

**What it does:** Store your brand voice, guidelines, key messages, and examples. Future calendar generations will match your brand automatically.

**How to use:**
1. Click "Brand Brain" button in the header
2. Paste your brand docs (voice, tone, do/don'ts, audience, product info, past post examples)
3. Click "Save to Brand Brain"
4. Generate calendars — the AI will use your brand context to tailor every post

### Brand Design uploads

Creators can now lock in logos, color palette, and typography once, and every Stability-generated asset will inherit those rules automatically.

- Open **Brand Brain → Brand Design** to set primary/secondary/accent colors, heading/body fonts, and an optional logo upload (PNG/JPG/SVG, ≤600 KB).
- Data is stored alongside the Brand Brain profile (`data/brands/{user}.json`), and the `/api/design/generate` endpoint injects kit directives into every Stability prompt.
- Assets triggered from calendar cards remember the originating day and appear inside the Design tab + calendar card chips, so text + visuals stay linked.

**Technical details:**
- Brand text is chunked and embedded using OpenAI `text-embedding-3-small`
- Stored locally in `data/brands/{userId}.json` (one profile per user)
- On generation, the server loads your brand profile and injects context into the prompt
- Test endpoints:
  - `POST /api/brand/ingest` with `{"userId":"...", "text":"..."}`
  - `GET /api/brand/profile?userId=...`

## LLM Response Parsing & Reliability

Generating structured JSON from an LLM can be brittle. We harden this layer with:

1. Network + transient retries: `openAIRequest` retries 502/503/504 and network errors with exponential backoff (1s, 2s, 4s).
2. Parse-level retry: For calendar and variants endpoints we request a second completion if the first cannot be parsed.
3. Sanitization pipeline (`parseLLMArray`):
  - Strip code fences / markdown
  - Remove zero‑width characters
  - Extract first JSON array region
  - Remove trailing commas and duplicate commas
  - Quote bare keys if the model omitted quotes
  - Multiple parse attempts (candidate, raw, wrapped)
  - Wrap single object / object with `posts` into array
4. Validation: Each item must include minimal required fields (`day` for calendar; `day` + `variants` object for variants). Failure triggers parse-level retry.
5. Diagnostics: Enable `DEBUG_AI_PARSE=1` to log attempt metadata (length, ok/error) for quick triage.
6. Partial success UI: Calendar generation runs 6 parallel 5‑day batches; failures surface in a collapsible error details panel while successful batches still render.

### Environment Flags

| Variable | Purpose |
|----------|---------|
| `OPENAI_API_KEY` | Auth for OpenAI requests |
| `CANONICAL_HOST` | Optional host redirect enforcement |
| `DEBUG_AI_PARSE=1` | Verbose parse diagnostics in server logs |
| `DEBUG_AI_PARSE=2` | Includes fallback details + raw length and attempt summaries |

### Common Failure Messages

- `OpenAI servers are temporarily unavailable` → Upstream 502/503/504
- `Failed to parse JSON after attempts` → Model returned non‑JSON; inspect truncated raw segment
- `Expected ',' or '}' after property value` → Usually caused by literal (unescaped) newline inside a quoted string; parser now auto-escapes these.
- `Variant items missing required fields` → Prompt drift; consider regenerating or tightening prompt

### Improving Robustness Further (Next Ideas)

- Add schema repair (e.g., regex patch missing quotes around values) before final failure
- Automatic backfill for failed calendar batches (re-request only missing days)
- Switch to structured output (JSON mode) once available for target model
- Leverage function calling / response schema (if model adds support) to enforce structure

Feel free to edit `parseLLMArray` in `server.js` for additional heuristics if new failure patterns appear.

## UX improvements added

- Inline spinner on the "Generate Calendar" button while the AI is generating.
- Module-based JS (ES modules) for clearer scoping and maintainability.
- Centralized `user-store.js` for localStorage helpers.
- Brand Brain modal and backend integration for personalized content generation.
- Skeleton loader: while batches generate, placeholder shimmer cards render immediately.
- Theme toggle: light/dark mode persisted in localStorage (`promptly_theme`).
- Generation errors panel: partial batch failures surface with toggleable details.
- SEO meta tags + Open Graph banner (`assets/og-banner.svg`).
- Accessibility focus outlines (`:focus-visible`) across interactive elements.
- Minified CSS build option (`node build.js`) producing `styles.min.css`.
 - PWA: service worker + manifest for installability & offline shell.
 - Offline fallback page (`offline.html`) for graceful network loss.
 - PNG icons (128/256/512) referenced in `manifest.json`.
 - Service worker registration with update polling every 30 minutes.
 - Gzip compression for text assets (HTML/CSS/JS/JSON) when client supports it.
 - Hardened Content Security Policy (removed `unsafe-inline` from `script-src`).

## Build & Performance

Run the optional build step to generate a minified stylesheet:

```bash
node build.js
```

This creates `styles.min.css` and you can ensure `index.html` points to it. Edit `styles.css` for development; re-run build to refresh.

Recommended next profiling:
1. Run Lighthouse (Chrome DevTools → Lighthouse) on local production build.
2. Verify CLS is low (skeletons reduce layout shift).
3. If needed, defer non-critical scripts (Stripe link, JSZip) with `loading=lazy` or dynamic import.
4. Consider adding HTTP/2 push or preconnect hints for OpenAI & Supabase if latency matters.
5. Use Lighthouse PWA category to confirm offline capability & manifest correctness.

## Theme Toggle

Implementation: adds `data-theme="light"` to the root element for light mode. Default inherits system preference, then user choice persists.

## Skeleton Loader

Adds 30 placeholder `div.skeleton-card` elements removed once the AI responses resolve. This improves perceived performance.

If you'd like, I can wire Playwright into GitHub Actions so every push runs the smoke test.

## Go live on your own domain (e.g., usepromptly.app)

The simplest path is to deploy the Node server (serves the frontend and API) to a managed host and attach a custom domain.

Option A — Render (recommended)

1) Push this repo to GitHub (public or private)
2) Create a Render account and "New +" → Web Service → Connect this repo
3) Settings on Render:
  - Environment: Node
  - Build Command: `npm install`
  - Start Command: `npm start`
  - Port: use the default (Render will inject PORT; the server reads `process.env.PORT`)
  - Environment Variables: add `OPENAI_API_KEY`
  - Optional: add `CANONICAL_HOST` (e.g., `promptlyapp.com`) to force www/non-www to redirect to a single host
4) Deploy. You’ll get a `https://<app>.onrender.com` URL.
5) Add your custom domain:
  - In your Render service → Settings → Custom Domains → Add `promptlyapp.com` (and `www.promptlyapp.com` if desired)
  - Follow the DNS instructions Render shows (create the exact A/CNAME records in your domain registrar)
  - Wait for verification and auto-SSL

We committed `render.yaml` for infra-as-code. From Render’s dashboard you can “Import from repo” and it will pick up sane defaults.

Option B — Your own VM with Nginx (manual)

1) Buy a VPS (e.g., DigitalOcean droplet)
2) SSH to the box and install Node 18+, `pm2`, and Nginx
3) Clone this repo and run `npm install` then `pm2 start npm --name promptly -- start`
4) Configure Nginx as a reverse proxy for `usepromptly.app` → `http://127.0.0.1:8000`
5) Issue a TLS cert with Let’s Encrypt (Certbot) and enable HTTP→HTTPS redirect

DNS checklist (regardless of host)

- registrar: add the records your host provides (don’t guess IPs)
- root domain (apex) `usepromptly.app`: likely an A record → host’s IP
- `www.usepromptly.app`: usually a CNAME to the host-provided target
- TTL: keep default; propagation can take up to 24h (often minutes)

Stripe Billing Setup

1) Create a Price in Stripe for your Pro subscription
- In Stripe Dashboard → Products → Create a product (e.g., Promptly Pro)
- Add a recurring monthly price
- Optional: set a Lookup Key (recommended), e.g., `promptly_pro_monthly`

2) Configure environment variables (Render → Environment, or local .env)
- `STRIPE_SECRET_KEY` — your Stripe Secret Key (starts with `sk_live_` or `sk_test_`)
- `STRIPE_WEBHOOK_SECRET` — from your Stripe webhook endpoint (next step)
- Either set `STRIPE_PRICE_ID` or `STRIPE_PRICE_LOOKUP_KEY`
- `PUBLIC_BASE_URL` — e.g., `https://usepromptly.app` (used for Checkout success/cancel URLs)

3) Add a webhook endpoint in Stripe
- Endpoint URL: `https://usepromptly.app/stripe/webhook`
- Events to send: `checkout.session.completed`, `customer.subscription.created`, `customer.subscription.updated`
- Copy the Signing Secret and set it as `STRIPE_WEBHOOK_SECRET`

4) How the flow works
- The app creates a Checkout Session using `STRIPE_PRICE_ID` or resolves `STRIPE_PRICE_LOOKUP_KEY`
- On success, Stripe redirects users to `PUBLIC_BASE_URL/success.html?session_id={CHECKOUT_SESSION_ID}`
- The success page calls `/api/billing/session` to verify and upgrades the user to Pro if the payment is paid and the email matches
- The webhook maps `email → stripe_customer_id` so the “Manage billing” button can open the Stripe Customer Portal

Local webhook testing (optional)

Use the Stripe CLI to forward events to your local server:

```bash
# in one terminal
stripe listen --forward-to localhost:8000/stripe/webhook

# copy the webhook signing secret the CLI prints (whsec_...) into STRIPE_WEBHOOK_SECRET
```

Notes

- The server already reads `PORT` and serves static files + the API from the same origin, so one deployment covers both.
- Set `OPENAI_API_KEY` on the host; do not commit it to the repo.
 - Gzip is performed at the app layer; most CDNs will also compress. Response includes `Vary: Accept-Encoding`.
 - For stricter CSP, move remaining inline styles into external CSS and remove `'unsafe-inline'` from `style-src`.

## AI Design Lab (Stability integration)

Promptly now includes a Pro-only “Design” tab so customers can request AI-generated graphics/templates/video snippets tied to their calendar posts.

### Frontend flow
- `script.js` wires the Design tab + modal (search for `design-lab`) so users can select a calendar entry and submit asset requests.
- Submissions send `POST /api/design/generate` with `{ assetType, tone, notes, day, caption, niche, aspectRatio }`.
- Successful responses are rendered into `#design-grid` with download + “Copy brief” buttons so users can immediately grab assets.

### Backend endpoint
- Implemented in `server.js` around `/api/design/generate`.
- Builds a descriptive Stability prompt via `buildDesignPrompt` using the selected post + custom notes.
- Image-style requests hit `/v2beta/stable-image/generate/sd3`; anything containing “video/clip/snippet” uses `/v2beta/stable-video/async/text-to-video` with polling until the asset is ready.
- Buffers are saved to `data/design-assets/<timestamp>-<slug>.{png|mp4}`, and the response returns `{ downloadUrl: "/data/design-assets/..." }`.
- Static serving already exposes `/data/design-assets/*`, so downloads work once the file lands on disk.

### Environment variables
| Variable | Purpose |
|----------|---------|
| `STABILITY_API_KEY` | Required bearer token for Stability |
| `PUBLIC_BASE_URL` (optional) | Set if you need fully-qualified download URLs |

Set `STABILITY_API_KEY` before `npm start`. Without it, the endpoint returns HTTP 501 and the UI shows “Design generation not configured”.

### Local smoke test
```bash
curl -X POST http://localhost:8000/api/design/generate \
  -H "Content-Type: application/json" \
  -d '{"assetType":"Story Template","tone":"bold","notes":"Add launch CTA","day":3,"caption":"Behind the scenes","niche":"Beauty brand"}'
```

Expect JSON containing a `downloadUrl`, and a file will appear under `data/design-assets/`.
