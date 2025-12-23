(function () {
  const modal = document.getElementById('upgrade-modal');
  const openBtn = document.getElementById('upgrade-btn');
  const closeBtn = document.getElementById('upgrade-close');
  if (!modal || !openBtn || !closeBtn) return;
  const toggle = (show) => {
    modal.style.display = show ? 'block' : 'none';
    if (show) document.body.classList.add('no-scroll');
    else document.body.classList.remove('no-scroll');
  };
  openBtn.addEventListener('click', () => toggle(true));
  closeBtn.addEventListener('click', () => toggle(false));
  modal.addEventListener('click', (event) => {
    if (event.target === modal) toggle(false);
  });
})();

document.addEventListener('DOMContentLoaded', () => {
  const trigger = document.querySelector('[data-upgrade-trigger]');
  if (!trigger) return;
  trigger.addEventListener('click', (event) => {
    event.preventDefault();
    if (typeof window.showUpgradeModal === 'function') {
      window.showUpgradeModal();
    } else {
      const upgradeBtn = document.getElementById('upgrade-btn');
      if (upgradeBtn) upgradeBtn.click();
    }
  });
});
