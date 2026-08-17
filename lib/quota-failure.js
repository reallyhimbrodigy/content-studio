// THE 429 MUST NAME ITS OWN QUOTA. [Rule 1, Rule 4]
//
// MEASURED 2026-08-17: chat is 502 on 100% of requests, and the cause is a
// Gemini 429. The ledger recorded `{ code: 502, route: '/api/chat' }` and
// nothing else, so answering the only question that matters — WHICH quota, at
// WHAT limit — required finding a log line in Render before it scrolled. The
// line itself was fine (the error path logs the full body); the problem is that
// a log is not a queryable artefact and a 429 body is where the answer lives.
//
// Google returns the answer in a structured detail block and we were throwing it
// away:
//
//   error.details[] with @type google.rpc.QuotaFailure
//     violations[]: { quotaMetric, quotaId, quotaValue, quotaDimensions }
//   error.details[] with @type google.rpc.ErrorInfo
//     reason (e.g. RATE_LIMIT_EXCEEDED), metadata { service, method, ... }
//   error.details[] with @type google.rpc.RetryInfo
//     retryDelay
//
// WHY THE METRIC NAME IS THE WHOLE POINT. Quota on GCP is per
// (project, service, metric). Chat calls generativelanguage.googleapis.com;
// Lumen's images call aiplatform.googleapis.com. Those are DIFFERENT SERVICES,
// so a Vertex image-gen grant does not raise a Generative Language limit even in
// the same project — unless the metric turns out to be project-wide across
// services, which only the metric NAME can settle. Reading it off the row ends
// the argument; inferring it from the service boundary does not.
//
// It also distinguishes free-tier from paid: a project not linked to a funded
// billing account reports the free-tier metric and a tiny quotaValue, which is a
// DASHBOARD fix, not a code fix. Persisting the value means nobody has to guess
// which of those two it is.

/**
 * Pull the quota story out of a Google API error body.
 * Returns null when the body carries none (so a caller can tell "no quota
 * failure present" from "we did not look").
 */
function parseQuotaFailure(bodyText) {
  if (!bodyText) return null;
  let parsed;
  try {
    parsed = typeof bodyText === 'string' ? JSON.parse(bodyText) : bodyText;
  } catch (_) {
    // NOT a silent null. A 429 whose body we cannot parse is its own finding —
    // it means the shape changed — and it must survive to the row rather than
    // being dropped for being inconvenient.
    return { parse_failed: true, raw: String(bodyText).slice(0, 400) };
  }
  const err = (parsed && parsed.error) || {};
  // A 429 IS NOT ALWAYS A RATE LIMIT — and reading it as one cost hours.
  //
  // Google returns 429 RESOURCE_EXHAUSTED for BILLING depletion too, with NO
  // QuotaFailure block at all: no metric, no violations, no retryDelay. Just a
  // message. Chat's real cause read exactly like this:
  //
  //   "Your prepayment credits are depleted. Please go to AI Studio ..."
  //
  // The null metric WAS the signal, but it presents as a parser failure, and I
  // very nearly reported my own instrument as broken. So the row now SAYS which
  // kind of 429 it is instead of leaving a reader to infer it from an absence.
  // Billing depletion is a DASHBOARD action; a quota ceiling is a code or quota
  // request. Naming the wrong one sends the fix to the wrong place.
  const details = Array.isArray(err.details) ? err.details : [];
  const out = {
    code: err.code || null,
    status: err.status || null,
    message: String(err.message || '').slice(0, 300),
  };
  for (const d of details) {
    const t = String(d['@type'] || '');
    if (t.endsWith('QuotaFailure')) {
      const v = Array.isArray(d.violations) ? d.violations : [];
      // EVERY violation, not just the first. A request can breach more than one
      // ceiling at once, and reporting only [0] is how you fix the wrong one.
      out.violations = v.slice(0, 6).map((x) => ({
        metric: x.quotaMetric || null,
        id: x.quotaId || null,
        value: x.quotaValue || null,
        dimensions: x.quotaDimensions || null,
      }));
    } else if (t.endsWith('ErrorInfo')) {
      out.reason = d.reason || null;
      out.service = (d.metadata && d.metadata.service) || null;
      out.method = (d.metadata && d.metadata.method) || null;
      // The metadata block is where free-vs-paid tier usually surfaces.
      out.metadata = d.metadata || null;
    } else if (t.endsWith('RetryInfo')) {
      out.retry_delay = d.retryDelay || null;
    }
  }
  // CLASSIFY, so the row is self-explaining.
  const msg = String(out.message || '');
  if (/prepay|prepayment|credits? (are )?depleted|billing|top ?up/i.test(msg)) {
    out.classification = 'billing_depleted';
    out.action = 'DASHBOARD: top up credits / fix billing — not a quota request, '
      + 'not a model change, not a code fix';
  } else if (/high demand|temporar|overloaded|try again later|capacity/i.test(msg)) {
    // A THIRD CLASS, learned the hard way an hour after shipping the first two.
    //
    // 05:37Z  "Your prepayment credits are depleted"        -> permanent, dashboard
    // 06:14Z  "This model is currently experiencing high     -> transient, retry
    //          demand. Spikes are usually temporary."
    //
    // SAME 429. SAME null metric. OPPOSITE responses. Without upstream_message on
    // the row both read as "chat still 429ing" and the obvious conclusion — that
    // the top-up had failed — would have been exactly wrong.
    //
    // My first classifier bucketed this as `unclassified_429`: technically true
    // and operationally useless. A classifier that has no category for what
    // actually happens is not classifying, it is deferring.
    out.classification = 'transient_capacity';
    out.action = 'RETRY with backoff — the upstream is contended, not misconfigured. '
      + 'No human action; newest models are the most contended.';
  } else if (out.violations && out.violations.length) {
    out.classification = 'quota_exceeded';
    out.action = 'quota increase for the named metric, or reduce rate';
  } else {
    out.classification = 'unclassified_429';
    out.action = 'read upstream_message — no QuotaFailure block was present';
  }
  return out;
}

/**
 * Persist it. Best-effort and never throws — an instrument that can break the
 * request it instruments is worse than no instrument.
 */
async function recordQuotaFailure(supabaseAdmin, {
  route, httpStatus, bodyText, userId = null, model = null, log = console,
}) {
  const q = parseQuotaFailure(bodyText);
  const metric = (q && q.violations && q.violations[0] && q.violations[0].metric) || null;
  const value = (q && q.violations && q.violations[0] && q.violations[0].value) || null;
  log.error(`[quota] ${route} upstream=${httpStatus} `
    + `CLASS=${(q && q.classification) || '?'} reason=${(q && q.reason) || '?'} `
    + `service=${(q && q.service) || '?'} metric=${metric || '?'} limit=${value || '?'}`);
  try {
    if (!supabaseAdmin) return q;
    await supabaseAdmin.from('analytics_events').insert({
      event: 'upstream_quota_failure',
      user_id: userId,
      props: {
        route,
        http_status: httpStatus,
        model,
        // the two fields that end the investigation
        quota_metric: metric,
        quota_limit: value,
        reason: (q && q.reason) || null,
        service: (q && q.service) || null,
        retry_delay: (q && q.retry_delay) || null,
        violations: (q && q.violations) || null,
        upstream_message: (q && q.message) || null,
        parse_failed: (q && q.parse_failed) || false,
        // the field that stops a reader mistaking a billing message for a
        // parser failure
        classification: (q && q.classification) || null,
        action: (q && q.action) || null,
      },
    });
  } catch (e) {
    log.error(`[quota] persist failed (${e && e.message}) — the log line above is `
      + 'the only copy');
  }
  return q;
}

module.exports = { parseQuotaFailure, recordQuotaFailure };
