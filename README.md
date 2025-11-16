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

## Brand Brain (new feature)

**What it does:** Store your brand voice, guidelines, key messages, and examples. Future calendar generations will match your brand automatically.

**How to use:**
1. Click "Brand Brain" button in the header
2. Paste your brand docs (voice, tone, do/don'ts, audience, product info, past post examples)
3. Click "Save to Brand Brain"
4. Generate calendars — the AI will use your brand context to tailor every post

**Technical details:**
- Brand text is chunked and embedded using OpenAI `text-embedding-3-small`
- Stored locally in `data/brands/{userId}.json` (one profile per user)
- On generation, the server loads your brand profile and injects context into the prompt
- Test endpoints:
  - `POST /api/brand/ingest` with `{"userId":"...", "text":"..."}`
  - `GET /api/brand/profile?userId=...`

## UX improvements added

- Inline spinner on the "Generate Calendar" button while the AI is generating.
- Module-based JS (ES modules) for clearer scoping and maintainability.
- Centralized `user-store.js` for localStorage helpers.
- Brand Brain modal and backend integration for personalized content generation.

If you'd like, I can wire Playwright into GitHub Actions so every push runs the smoke test.

## Go live on your own domain (e.g., promptly.com)

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
4) Configure Nginx as a reverse proxy for `promptly.com` → `http://127.0.0.1:8000`
5) Issue a TLS cert with Let’s Encrypt (Certbot) and enable HTTP→HTTPS redirect

DNS checklist (regardless of host)

- registrar: add the records your host provides (don’t guess IPs)
- root domain (apex) `promptly.com`: likely an A record → host’s IP
- `www.promptly.com`: usually a CNAME to the host-provided target
- TTL: keep default; propagation can take up to 24h (often minutes)

Stripe updates once live

- Business website URL: `https://promptly.com`
- Checkout success URL: `https://promptly.com/checkout/success`
- Checkout cancel URL: `https://promptly.com/checkout/cancel`
- Webhook endpoint (when implemented): `https://promptly.com/webhooks/stripe`

Notes

- The server already reads `PORT` and serves static files + the API from the same origin, so one deployment covers both.
- Set `OPENAI_API_KEY` on the host; do not commit it to the repo.
