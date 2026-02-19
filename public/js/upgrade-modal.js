(function () {
  function getModal() {
    return document.getElementById('upgrade-modal');
  }

  function lockBody(lock) {
    document.body.style.overflow = lock ? 'hidden' : '';
  }

  window.openUpgradeModal = function openUpgradeModal() {
    var modal = getModal();
    if (!modal) return;
    modal.style.display = 'flex';
    lockBody(true);
  };

  window.closeUpgradeModal = function closeUpgradeModal() {
    var modal = getModal();
    if (!modal) return;
    modal.style.display = 'none';
    lockBody(false);
  };

  document.addEventListener('keydown', function (event) {
    if (event.key === 'Escape') {
      var modal = getModal();
      if (modal && modal.style.display !== 'none' && modal.style.display !== '') {
        window.closeUpgradeModal();
      }
    }
  });

  document.addEventListener('click', function (event) {
    var modal = getModal();
    if (!modal || modal.style.display === 'none' || modal.style.display === '') return;
    if (event.target === modal) {
      window.closeUpgradeModal();
    }
  });
})();
