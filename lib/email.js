'use strict';

// Transactional lifecycle emails via the Resend REST API (no SDK dependency —
// plain fetch). Sent from support@usepromptly.app (root domain, Zac-verified).
//
// DISCIPLINE:
//   - FAIL-SOFT everywhere. An email error must NEVER block signup or a purchase.
//     Every path is try/caught and returns an outcome object; nothing throws up.
//   - IDEMPOTENT per triggering event. RevenueCat retries webhooks, and clients
//     can re-fire signup_completed. We keep a send ledger in analytics_events
//     (event='email_sent', props.key = the idempotency key) and skip a key we've
//     already sent, so a retry never double-sends.
//   - AUDIT. Every send (success or failure) is logged to that same ledger.
//
// The ONLY external requirement is the RESEND_API_KEY env var on the server.

const RESEND_ENDPOINT = 'https://api.resend.com/emails';
const DOMAINS_ENDPOINT = 'https://api.resend.com/domains';
const FROM = process.env.EMAIL_FROM || 'Promptly <support@usepromptly.app>';
const REPLY_TO = process.env.EMAIL_REPLY_TO || 'support@usepromptly.app';
const APP_URL = 'https://usepromptly.app';
const MANAGE_URL = 'https://apps.apple.com/account/subscriptions';
const BILLING_URL = 'https://apps.apple.com/account/billing';

function resendConfigured() {
  return !!process.env.RESEND_API_KEY;
}

// --- raw Resend send -------------------------------------------------------
async function resendSend({ to, subject, html, replyTo }) {
  if (!resendConfigured()) return { ok: false, skipped: 'not_configured' };
  try {
    const r = await fetch(RESEND_ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ from: FROM, to: [to], subject, html, reply_to: replyTo || REPLY_TO }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) return { ok: false, status: r.status, error: (j && (j.message || j.name)) || `http_${r.status}` };
    return { ok: true, id: j && j.id };
  } catch (e) {
    return { ok: false, error: e && e.message };
  }
}

// --- domain verification (programmatic check) ------------------------------
async function verifyDomain(domain = 'usepromptly.app') {
  if (!resendConfigured()) return { ok: false, skipped: 'not_configured' };
  try {
    const r = await fetch(DOMAINS_ENDPOINT, { headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}` } });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) return { ok: false, status: r.status, error: (j && (j.message || j.name)) || `http_${r.status}` };
    const list = (j && j.data) || [];
    const d = list.find((x) => x.name === domain);
    return {
      ok: true,
      domain: d ? { name: d.name, status: d.status, region: d.region } : null,
      all: list.map((x) => ({ name: x.name, status: x.status })),
    };
  } catch (e) {
    return { ok: false, error: e && e.message };
  }
}

// --- idempotent, logged send ----------------------------------------------
async function sendOnce(supabaseAdmin, { key, kind, to, subject, html, replyTo }) {
  try {
    if (!to) return { skipped: 'no_recipient', kind };
    // Idempotency: skip a key we've already recorded a send for.
    if (supabaseAdmin && key) {
      const { data: prior } = await supabaseAdmin
        .from('analytics_events')
        .select('id')
        .eq('event', 'email_sent')
        .filter('props->>key', 'eq', key)
        .limit(1);
      if (Array.isArray(prior) && prior.length) return { skipped: 'already_sent', key, kind };
    }
    const res = await resendSend({ to, subject, html, replyTo });
    // Ledger every attempt (idempotency guard + audit trail).
    if (supabaseAdmin) {
      supabaseAdmin
        .from('analytics_events')
        .insert({
          event: 'email_sent',
          platform: 'server',
          app_version: 'email',
          props: { key, kind, to, ok: !!res.ok, resend_id: res.id || null, error: res.error || res.skipped || null },
        })
        .then(({ error }) => { if (error) console.warn(`[email] ledger insert failed (${kind}):`, error.message); });
    }
    console.log(`[email] ${kind} → ${to}: ${res.ok ? 'sent id=' + res.id : 'NOT SENT (' + (res.error || res.skipped) + ')'}`);
    return { ...res, key, kind };
  } catch (e) {
    console.warn(`[email] ${kind} send threw (fail-soft): ${e && e.message}`);
    return { ok: false, error: e && e.message, kind };
  }
}

// --- recipient lookup ------------------------------------------------------
async function getUserEmail(supabaseAdmin, userId) {
  if (!supabaseAdmin || !userId) return null;
  try {
    const { data, error } = await supabaseAdmin.auth.admin.getUserById(userId);
    if (error) return null;
    return (data && data.user && data.user.email) || null;
  } catch { return null; }
}

// --- plan labels (product_id → human label + price) ------------------------
const PLAN = {
  promptly_pro_weekly: { label: 'Promptly Pro (Weekly)', price: '$12.99 / week' },
  promptly_pro_monthly: { label: 'Promptly Pro (Monthly)', price: '$39.99 / month' },
  promptly_pro_yearly: { label: 'Promptly Pro (Yearly)', price: '$399.99 / year' },
};
function planFor(productId) {
  return PLAN[String(productId || '')] || { label: 'Promptly Pro', price: null };
}

// --- shared HTML shell (light, minimal, one accent) ------------------------
const ACCENT = '#C8A95E'; // Promptly gold
function shell({ heading, bodyHtml, cta }) {
  const button = cta
    ? `<tr><td style="padding:8px 0 4px;"><a href="${cta.href}" style="display:inline-block;background:${ACCENT};color:#1a1a1a;text-decoration:none;font-weight:700;font-size:15px;padding:13px 26px;border-radius:999px;">${cta.label}</a></td></tr>`
    : '';
  return `<!doctype html><html><body style="margin:0;background:#f5f4f2;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f5f4f2;padding:32px 16px;">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;background:#ffffff;border-radius:16px;padding:32px;">
        <tr><td style="font-size:20px;font-weight:800;color:#1a1a1a;letter-spacing:-0.3px;">Promptly</td></tr>
        <tr><td style="height:20px;"></td></tr>
        <tr><td style="font-size:22px;font-weight:700;color:#1a1a1a;line-height:1.3;">${heading}</td></tr>
        <tr><td style="height:12px;"></td></tr>
        <tr><td style="font-size:15px;color:#4a4a4a;line-height:1.6;">${bodyHtml}</td></tr>
        <tr><td style="height:20px;"></td></tr>
        ${button}
        <tr><td style="height:28px;"></td></tr>
        <tr><td style="border-top:1px solid #ececec;padding-top:16px;font-size:12px;color:#9a9a9a;line-height:1.6;">
          Promptly — the AI video editor for talking-to-camera clips.<br>
          Questions? Just reply to this email — <a href="mailto:support@usepromptly.app" style="color:#9a9a9a;">support@usepromptly.app</a>
        </td></tr>
      </table>
    </td></tr>
  </table></body></html>`;
}

// --- templates -------------------------------------------------------------
function welcomeTemplate() {
  return {
    subject: 'Welcome to Promptly 🎬',
    html: shell({
      heading: "You're in. Let's make your first video.",
      bodyHtml: `Upload a clip of yourself talking to camera, tell Promptly the vibe, and get a captioned, edited short back in a couple of minutes — no timeline, no editing.<br><br>Your free plan includes <b>one video edit every day</b>. Go make the first one.`,
      cta: { label: 'Create a video', href: APP_URL },
    }),
  };
}

function purchaseTemplate({ label, price }) {
  const planLine = price ? `${label} — <b>${price}</b>` : label;
  return {
    subject: "You're on Promptly Pro 🎉",
    html: shell({
      heading: "You're on Promptly Pro",
      bodyHtml: `Thanks for upgrading. Your plan: ${planLine}.<br><br>Everything's unlocked — <b>unlimited video edits</b>, unlimited AI chats, re-edit any finished video, and upload up to 10 at once.<br><br>You can view or change your subscription anytime in your Apple account.`,
      cta: { label: 'Start creating', href: APP_URL },
    }).replace('Start creating</a>', `Start creating</a>&nbsp;&nbsp;<a href="${MANAGE_URL}" style="font-size:13px;color:#9a9a9a;">Manage subscription</a>`),
  };
}

function completionTemplate({ jobUrl }) {
  return {
    subject: 'Your video is ready 🎬',
    html: shell({
      heading: 'Your video is ready',
      bodyHtml: `Your edit is done — captions, cuts, and all. Tap below to watch it and post it.<br><br>You can also re-edit it or make another anytime in Promptly.`,
      cta: { label: 'Watch your video', href: jobUrl },
    }),
  };
}

function billingTemplate() {
  return {
    subject: 'Your Promptly payment needs attention',
    html: shell({
      heading: "Your payment didn't go through",
      bodyHtml: `We couldn't process your latest Promptly Pro renewal — but don't worry, <b>your Pro access stays on while Apple retries the charge</b> over the next few days.<br><br>To keep it uninterrupted, update your payment method in your Apple account. If the retries don't clear, your plan will drop to Free and you can resubscribe anytime from the app.`,
      cta: { label: 'Update payment method', href: BILLING_URL },
    }),
  };
}

// --- high-level triggers (all fail-soft, all idempotent) -------------------
async function sendWelcomeEmail(supabaseAdmin, userId) {
  const to = await getUserEmail(supabaseAdmin, userId);
  const t = welcomeTemplate();
  return sendOnce(supabaseAdmin, { key: `welcome:${userId}`, kind: 'welcome', to, subject: t.subject, html: t.html });
}

async function sendPurchaseEmail(supabaseAdmin, { userId, eventId, productId }) {
  const to = await getUserEmail(supabaseAdmin, userId);
  const t = purchaseTemplate(planFor(productId));
  return sendOnce(supabaseAdmin, { key: `purchase:${eventId || userId}`, kind: 'purchase', to, subject: t.subject, html: t.html });
}

async function sendBillingEmail(supabaseAdmin, { userId, eventId }) {
  const to = await getUserEmail(supabaseAdmin, userId);
  const t = billingTemplate();
  return sendOnce(supabaseAdmin, { key: `billing:${eventId || userId}`, kind: 'billing', to, subject: t.subject, html: t.html });
}

// "Your video is ready" — the token-free recovery path (covers the ~50% on
// pre-instrumentation builds who will never see a push soft-prompt). Idempotent
// per JOB (key completion:<jobId>), so a retry or a double-fire never double-
// sends. The deep link lands on the specific job's public result page. The
// CALLER is responsible for firing this ONLY on a real completion (never on a
// failed render) and only when the feature flag is on.
async function sendCompletionEmail(supabaseAdmin, { userId, jobId }) {
  if (!jobId) return { skipped: 'no_job', kind: 'completion' };
  const to = await getUserEmail(supabaseAdmin, userId);
  const jobUrl = `${APP_URL}/v/${encodeURIComponent(jobId)}`;
  const t = completionTemplate({ jobUrl });
  return sendOnce(supabaseAdmin, { key: `completion:${jobId}`, kind: 'completion', to, subject: t.subject, html: t.html });
}

// --- test helpers (bypass idempotency; explicit recipient) -----------------
async function sendTestSuite(supabaseAdmin, to, stamp) {
  const w = welcomeTemplate();
  const p = purchaseTemplate(planFor('promptly_pro_monthly'));
  const b = billingTemplate();
  const out = {};
  out.welcome = await sendOnce(supabaseAdmin, { key: `test-welcome:${stamp}`, kind: 'test-welcome', to, subject: '[TEST] ' + w.subject, html: w.html });
  out.purchase = await sendOnce(supabaseAdmin, { key: `test-purchase:${stamp}`, kind: 'test-purchase', to, subject: '[TEST] ' + p.subject, html: p.html });
  out.billing = await sendOnce(supabaseAdmin, { key: `test-billing:${stamp}`, kind: 'test-billing', to, subject: '[TEST] ' + b.subject, html: b.html });
  return out;
}

module.exports = {
  resendConfigured,
  verifyDomain,
  sendOnce,
  getUserEmail,
  sendWelcomeEmail,
  sendPurchaseEmail,
  sendBillingEmail,
  sendCompletionEmail,
  sendTestSuite,
  welcomeTemplate,
  purchaseTemplate,
  billingTemplate,
  planFor,
};
