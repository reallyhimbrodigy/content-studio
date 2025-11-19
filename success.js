import { getCurrentUser, setUserTier } from './user-store.js';
import { initTheme } from './theme.js';

initTheme();

(async () => {
  const params = new URLSearchParams(window.location.search || '');
  const sid = params.get('session_id');
  const msgEl = document.querySelector('.success-message');
  const countdownEl = document.getElementById('countdown');
  let redirectIn = 5;

  try {
    if (!sid) throw new Error('Missing session_id');
    const resp = await fetch(`/api/billing/session?session_id=${encodeURIComponent(sid)}`);
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || 'Failed to verify session');

    const me = await getCurrentUser();
    const emailMatch = me && data.customer_email && String(me).toLowerCase() === String(data.customer_email).toLowerCase();
    const paid = data.payment_status === 'paid' || data.status === 'complete';
    if (emailMatch && paid) {
      await setUserTier(me, 'pro');
      if (msgEl) msgEl.textContent = 'Your account is upgraded. Enjoy Promptly Pro!';
    } else {
      if (msgEl) msgEl.textContent = "Payment verified. If your upgrade doesn't show, please contact support.";
      // Give a bit more time to read the note
      redirectIn = 7;
    }
  } catch (e) {
    console.warn('Success verification note:', e);
  }

  // Countdown and redirect
  let countdown = redirectIn;
  const interval = setInterval(() => {
    countdown--;
    if (countdownEl) countdownEl.textContent = countdown;
    if (countdown <= 0) {
      clearInterval(interval);
      window.location.href = '/';
    }
  }, 1000);
})();
