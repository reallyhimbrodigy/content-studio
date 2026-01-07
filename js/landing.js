(function () {
  if (!document.body.classList.contains('view-landing')) return;
  const modal = document.getElementById('upgrade-modal');
  const closeBtn = document.getElementById('upgrade-close');
  if (!modal || !closeBtn) return;
  const toggle = (show) => {
    modal.style.display = show ? 'block' : 'none';
    if (show) document.body.classList.add('no-scroll');
    else document.body.classList.remove('no-scroll');
  };
  if (typeof window.showUpgradeModal !== 'function') {
    window.showUpgradeModal = () => toggle(true);
    window.hideUpgradeModal = () => toggle(false);
  }
  closeBtn.addEventListener('click', () => toggle(false));
  modal.addEventListener('click', (event) => {
    if (event.target === modal) toggle(false);
  });
})();

document.addEventListener('DOMContentLoaded', () => {
  if (!document.body.classList.contains('view-landing')) return;
  const triggers = document.querySelectorAll('[data-upgrade-trigger]');
  if (triggers.length > 0) {
    triggers.forEach((trigger) => {
      trigger.addEventListener('click', (event) => {
        event.preventDefault();
        if (typeof window.showUpgradeModal === 'function') {
          window.showUpgradeModal();
        }
      });
    });
  }

  const upgradeBtn = document.getElementById('upgrade-btn');
  if (!upgradeBtn) return;
  upgradeBtn.addEventListener('click', async (event) => {
    event.preventDefault();
    const fallbackUrl = 'https://buy.stripe.com/5kQ5kE3Qw1G8aWoe5Cgbm00?locale=en';
    try {
      const resp = await fetch('/api/billing/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: '', priceLookupKey: 'promptly_pro_monthly' })
      });
      const data = await resp.json().catch(() => ({}));
      if (resp.ok && data && data.url) {
        window.location.href = data.url;
        return;
      }
      window.location.href = fallbackUrl;
    } catch (_) {
      window.location.href = fallbackUrl;
    }
  });
});
