'use strict';
/**
 * ONE-OFF CAMPAIGN — "1.3.6 users: a newer build fixes crashes you may have hit"
 *
 * A push cannot be unsent. Everything here is built around that:
 *
 *   * DRY RUN BY DEFAULT. --send is required to transmit anything.
 *   * EXACT VERSION MATCH, never a prefix. '1.3.6' as a prefix does not catch
 *     1.3.16, but this repo has already been bitten by a version parser that
 *     sampled one format, and 1.3.10-1.3.19 is 527 live tokens sitting right
 *     next to the target. Equality on the full '1.3.6+224' cannot reach them.
 *   * ONE SEND PER PERSON. 1,102 users hold 1,115 matching tokens, so a naive
 *     per-token loop double-notifies whoever re-registered. Newest token per
 *     user only.
 *   * LEDGER FIRST. push_campaign_log has a unique (campaign, user_id); a
 *     re-run skips anyone already attempted, whatever the outcome.
 *   * PACED. services/push.js opens and CLOSES an http2 connection per send, so
 *     1,102 sends is 1,102 TLS handshakes to Apple. Low concurrency and a pause
 *     between batches keeps that gentle; the proper fix is one multiplexed
 *     connection, which is not something to write fresh against a live send.
 */
const path = require('path');
const { supabaseAdmin } = require(path.join(__dirname, '..', 'services', 'supabase-admin'));
const push = require(path.join(__dirname, '..', 'services', 'push'));

const CAMPAIGN = 'v136_update_prompt_2026_09';
const TARGET_VERSION = '1.3.6+224';
const ALERT = {
  title: 'Promptly',
  body: 'A new version fixes crashes you may have hit. Update from the App Store.',
};
const BATCH = Number(process.env.CAMPAIGN_BATCH || 5);
const PAUSE_MS = Number(process.env.CAMPAIGN_PAUSE_MS || 400);
const LIVE = process.argv.includes('--send');
const LIMIT = (() => {
  const i = process.argv.indexOf('--limit');
  return i > 0 ? Number(process.argv[i + 1]) : 0;
})();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  if (!supabaseAdmin) { console.error('no supabase admin handle'); process.exit(1); }

  // THE COHORT. Newest token per user, and only where that newest token is the
  // target build — "their latest build is exactly 1.3.6", not "they ever ran it".
  const { data: rows, error } = await supabaseAdmin
    .from('device_tokens')
    .select('user_id, token, app_version, last_seen_at, platform')
    .eq('platform', 'ios')
    .not('token', 'is', null)
    .order('last_seen_at', { ascending: false, nullsFirst: false });
  if (error) { console.error('cohort query failed:', error.message); process.exit(1); }

  const newestByUser = new Map();
  for (const r of rows || []) {
    if (!r.user_id || !r.token) continue;
    if (!newestByUser.has(r.user_id)) newestByUser.set(r.user_id, r);
  }
  let cohort = [...newestByUser.values()].filter((r) => r.app_version === TARGET_VERSION);

  // Already attempted?
  const { data: done } = await supabaseAdmin
    .from('push_campaign_log').select('user_id').eq('campaign', CAMPAIGN);
  const already = new Set((done || []).map((d) => d.user_id));
  const skipped = cohort.filter((r) => already.has(r.user_id)).length;
  cohort = cohort.filter((r) => !already.has(r.user_id));
  if (LIMIT > 0) cohort = cohort.slice(0, LIMIT);

  console.log(`campaign        : ${CAMPAIGN}`);
  console.log(`target version  : ${TARGET_VERSION} (exact match, never a prefix)`);
  console.log(`recipients      : ${cohort.length}  (already attempted: ${skipped})`);
  console.log(`mode            : ${LIVE ? 'LIVE SEND' : 'DRY RUN — nothing transmitted'}`);
  console.log(`pacing          : ${BATCH} concurrent, ${PAUSE_MS}ms between batches`);
  console.log(`copy            : ${ALERT.body}`);
  if (!LIVE) {
    console.log('\nsample of 3 recipients (user_id, token tail, version):');
    for (const r of cohort.slice(0, 3)) {
      console.log(`  ${r.user_id}  …${String(r.token).slice(-8)}  ${r.app_version}`);
    }
    console.log('\nre-run with --send to transmit.');
    return;
  }

  const tally = { sent: 0, failed: 0, invalid: 0 };
  const reasons = {};
  for (let i = 0; i < cohort.length; i += BATCH) {
    const slice = cohort.slice(i, i + BATCH);
    const results = await Promise.all(slice.map(async (r) => {
      // LEDGER BEFORE THE SEND. If the process dies mid-batch, the row already
      // exists and a re-run will not re-notify that person.
      await supabaseAdmin.from('push_campaign_log').insert({
        campaign: CAMPAIGN, user_id: r.user_id,
        token_tail: String(r.token).slice(-8), app_version: r.app_version,
        status: 'sending',
      });
      const res = await push.sendOne(r.token, ALERT, { campaign: CAMPAIGN });
      let status = 'sent';
      if (!res.ok) {
        status = (res.reason === 'BadDeviceToken' || res.reason === 'Unregistered'
                  || res.status === 410) ? 'invalid_token' : 'failed';
      }
      await supabaseAdmin.from('push_campaign_log')
        .update({ status, apns_status: res.status || null, apns_reason: res.reason || null })
        .eq('campaign', CAMPAIGN).eq('user_id', r.user_id);
      return { r, res, status };
    }));

    for (const { r, res, status } of results) {
      if (status === 'sent') tally.sent++;
      else if (status === 'invalid_token') {
        tally.invalid++;
        // APPLE SAYS THIS TOKEN IS DEAD. Deleting it is the whole reason a
        // campaign is worth running against a stale cohort: the next send is
        // aimed at fewer ghosts.
        await supabaseAdmin.from('device_tokens').delete().eq('token', r.token);
      } else {
        tally.failed++;
      }
      const key = res.reason || `http_${res.status}`;
      if (status !== 'sent') reasons[key] = (reasons[key] || 0) + 1;
    }
    const done2 = Math.min(i + BATCH, cohort.length);
    if (done2 % 100 < BATCH) {
      console.log(`  ${done2}/${cohort.length}  sent=${tally.sent} failed=${tally.failed} invalid=${tally.invalid}`);
    }
    if (i + BATCH < cohort.length) await sleep(PAUSE_MS);
  }

  console.log('\n=== CAMPAIGN COMPLETE ===');
  console.log(`  sent               : ${tally.sent}`);
  console.log(`  delivery failures  : ${tally.failed}`);
  console.log(`  token invalidations: ${tally.invalid}  (rows deleted from device_tokens)`);
  if (Object.keys(reasons).length) {
    console.log('  failure reasons    :');
    for (const [k, v] of Object.entries(reasons).sort((a, b) => b[1] - a[1])) {
      console.log(`     ${k}: ${v}`);
    }
  }
}

main().catch((e) => { console.error('campaign failed:', e); process.exit(1); });
