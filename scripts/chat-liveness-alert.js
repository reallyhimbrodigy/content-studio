#!/usr/bin/env node
// Daily chat-liveness alert — the runtime companion to the deploy-time chat probe.
//
// Why this exists: chat failures are INVISIBLE. `logUsageEvent(userId,'chat')`
// fires only on a SUCCESSFUL AI reply, so a broken chat produces no row, no
// error_code, no alert — it just goes quiet. That is exactly how /api/chat sat
// dark for 44 days (last success 2026-06-20) while renders kept flowing and not
// one metric showed it.
//
// The check is a single comparison against a control: over the last 24h, if
// successful chats == 0 WHILE successful renders > 0, chat is dark. renders>0 is
// the control that rules out "quiet night / dead DB read" (per the standing rule:
// a wide-window zero is a failed read until a live control proves the pipe).
//
// Exit 1 (+ owner push) on DARK; exit 0 on healthy or inconclusive (renders also
// 0 → no traffic to judge against, not an outage). Run daily via cron.
'use strict';

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env.local') });
const { supabaseAdmin } = require('../services/supabase-admin');
const { sendOwnerAlert } = require('../services/pushNotifier');

const OWNER_USER_ID = 'ec702499-ca10-49e6-8850-df8f99840904'; // SUBMISSION_OWNER_USER_ID
const WINDOW_H = Number(process.env.CHAT_ALERT_WINDOW_H || 24);

async function count(kind, sinceIso) {
  const { count, error } = await supabaseAdmin
    .from('usage_events')
    .select('id', { count: 'exact', head: true })
    .eq('kind', kind)
    .gte('created_at', sinceIso);
  if (error) throw new Error(`count(${kind}) failed: ${error.message}`);
  return count || 0;
}

(async () => {
  // EXIT-CODE CONTRACT (2026-08-16): 0 = HEALTHY · 1 = DARK · 2 = UNKNOWN.
  // This previously exited 0 ("no false alarm") when it could not measure — but
  // exit 0 MEANS healthy to every caller, so a misconfiguration reported the
  // same code as a working chat. A sentinel whose job is to catch silence must
  // never answer silence with a pass. Unmeasurable is now 2, and a caller that
  // treats 2 as healthy is making that choice explicitly.
  if (!supabaseAdmin) {
    console.error('[chat-liveness] ⚠️ UNKNOWN — supabaseAdmin not configured; cannot judge. '
      + 'exit 2 (NOT healthy — an unmeasurable window is not a quiet one).');
    process.exit(2);
  }
  const since = new Date(Date.now() - WINDOW_H * 3600e3).toISOString();
  let chat, render;
  try {
    chat = await count('chat', since);
    render = await count('render', since);
  } catch (e) {
    // A failed READ is not a healthy chat. Same rule as above.
    console.error(`[chat-liveness] ⚠️ UNKNOWN — count query failed (${e && e.message}). exit 2.`);
    process.exit(2);
  }
  const dark = chat === 0 && render > 0;

  console.log(`[chat-liveness] window=${WINDOW_H}h  chat=${chat}  render(control)=${render}  → ${
    dark ? 'DARK ❌' : chat > 0 ? 'HEALTHY ✅' : 'INCONCLUSIVE (no render traffic to judge against)'
  }`);

  // HEARTBEAT: record that this ran, so a silent sentinel is distinguishable
  // from a healthy one. Absence of an alert must never be the only evidence.
  try {
    await supabaseAdmin.from('analytics_events').insert({
      event: 'sentinel_heartbeat', platform: 'server', app_version: 'chat-liveness',
      props: { window_h: WINDOW_H, chat, render, verdict: dark ? 'DARK' : (chat > 0 ? 'HEALTHY' : 'INCONCLUSIVE') },
    });
  } catch (_) { /* heartbeat is evidence, never a gate */ }

  if (!dark) process.exit(0);

  if (process.env.CHAT_ALERT_DRY_RUN === '1') {
    console.error('[chat-liveness] DARK detected — DRY_RUN set, owner alert SUPPRESSED.');
    process.exit(1);
  }

  // DARK: 0 successful chats while renders flow. Page the owner.
  try {
    await sendOwnerAlert({
      ownerUserId: OWNER_USER_ID,
      title: '⚠️ [Promptly] chat is DARK',
      body: `0 successful chats in ${WINDOW_H}h while ${render} renders completed. /api/chat likely broken (transport/credential).`,
      threadId: 'chat-liveness',
      supabaseAdmin,
    });
    console.error('[chat-liveness] owner alert fired.');
  } catch (e) {
    console.error('[chat-liveness] owner alert FAILED to send:', e && e.message ? e.message : e);
  }
  process.exit(1);
})().catch((e) => {
  console.error('[chat-liveness] fatal:', e && e.message ? e.message : e);
  process.exit(2); // distinct from a clean DARK(1): the check itself broke
});
