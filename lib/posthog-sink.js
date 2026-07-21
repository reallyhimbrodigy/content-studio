'use strict';

// PostHog server-side sink (the analytics-backbone mandate). INERT until
// POSTHOG_API_KEY is set — the same dark-until-flipped pattern as the wall
// knob, so this ships to production as a no-op and lights up on config alone.
//
// Server-side capture is reserved for events only the server truly knows
// (the RevenueCat webhook's transaction truth, wall decisions post-flip).
// Client events flow from the iOS wrapper directly; the names live in ONE
// registry (same strings both sides) so the schemas can never drift.

let _client = null;
let _initTried = false;

function phClient() {
  if (_initTried) return _client;
  _initTried = true;
  const key = process.env.POSTHOG_API_KEY || '';
  if (!key) return null; // dark — no key, no client, zero cost
  try {
    const { PostHog } = require('posthog-node');
    _client = new PostHog(key, {
      host: process.env.POSTHOG_HOST || 'https://us.i.posthog.com',
      // Server events are rare and precious (webhook truth) — send promptly
      // rather than batching for throughput we don't have.
      flushAt: 1,
      flushInterval: 5000,
    });
  } catch (e) {
    console.warn('[posthog] init failed (sink stays dark):', e && e.message);
    _client = null;
  }
  return _client;
}

/** Capture one server-side event. Never throws; returns whether it was sent. */
function phCapture(distinctId, event, properties = {}) {
  const c = phClient();
  if (!c) return false;
  try {
    c.capture({ distinctId: String(distinctId), event, properties });
    return true;
  } catch (e) {
    console.warn('[posthog] capture failed:', e && e.message);
    return false;
  }
}

/** Flush pending events (graceful shutdown). */
async function phShutdown() {
  try { if (_client) await _client.shutdown(); } catch (_) { /* best-effort */ }
}

module.exports = { phCapture, phShutdown, phClient };
