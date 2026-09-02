'use strict';

// Error-triggered agent wake (NOT polling — polling burns usage for nothing).
// Every THRESHOLD owner-alert also POSTs a diagnostic payload here, which
// forwards to AGENT_ALERT_WEBHOOK_URL — an external endpoint that can spawn a
// Claude agent to investigate without a query round-trip.
//
// Discipline mirrors the owner alerts exactly:
//   • THRESHOLD-only — the CALLER gates (never per-job; designed rejections and
//     client-upload failures never reach here — they go to the daily digest).
//   • The caller owns the 30-min cooldown + clear-on-success.
//   • This adds a HARD DAILY CAP so a systemic outage can't loop-spin an agent —
//     overflow is dropped here (the owner is still paged, and it's in the digest).
//   • DORMANT until AGENT_ALERT_WEBHOOK_URL is set — a no-op, safe to ship early.

let _wakesToday = 0;
let _wakesDay = '';
const DAILY_CAP = Number(process.env.AGENT_ALERT_DAILY_CAP) || 12;

function _utcDay() { return new Date().toISOString().slice(0, 10); }

/**
 * Forward a threshold alert to the agent-wake webhook. Fire-and-forget from the
 * caller's perspective; returns a small outcome object for logging/tests.
 * @param {object} payload - { error_class, count, window_min, job_ids, user_ids,
 *                             last_good_ts, hint }
 */
async function postAgentAlert(payload = {}) {
  const url = process.env.AGENT_ALERT_WEBHOOK_URL;
  if (!url) return { skipped: 'no_webhook_url' };            // dormant until wired
  const day = _utcDay();
  if (day !== _wakesDay) { _wakesDay = day; _wakesToday = 0; } // reset at UTC midnight
  if (_wakesToday >= DAILY_CAP) {
    console.warn(`[agent-alert] daily cap ${DAILY_CAP} reached — dropping wake (owner still paged; see digest)`);
    return { skipped: 'daily_cap' };
  }
  _wakesToday += 1;
  const body = {
    source: 'promptly-content-studio',
    ...payload,
    ts: new Date().toISOString(),
    wake_n_today: _wakesToday,
    daily_cap: DAILY_CAP,
  };
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) console.warn(`[agent-alert] webhook returned ${r.status}`);
    return { ok: r.ok, status: r.status, wake_n_today: _wakesToday };
  } catch (e) {
    console.warn('[agent-alert] webhook post failed:', e && e.message);
    return { ok: false, error: e && e.message };
  }
}

module.exports = { postAgentAlert };
