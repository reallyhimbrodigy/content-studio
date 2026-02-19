(function () {
  function setBillingInterval(interval) {
    var priceAmount = document.getElementById('pro-price-amount');
    var billedNote = document.getElementById('pro-billed-note');
    var buttons = document.querySelectorAll('.pricing-toggle-btn');
    if (!priceAmount || !billedNote || !buttons.length) return;

    buttons.forEach(function (button) {
      var active = button.getAttribute('data-billing') === interval;
      button.classList.toggle('is-active', active);
      button.setAttribute('aria-pressed', active ? 'true' : 'false');
    });

    if (interval === 'yearly') {
      priceAmount.textContent = '$16.58';
      billedNote.hidden = false;
    } else {
      priceAmount.textContent = '$19.99';
      billedNote.hidden = true;
    }
  }

  document.addEventListener('DOMContentLoaded', function () {
    var toggleButtons = document.querySelectorAll('.pricing-toggle-btn');
    if (!toggleButtons.length) return;

    toggleButtons.forEach(function (button) {
      button.addEventListener('click', function () {
        var interval = button.getAttribute('data-billing');
        setBillingInterval(interval || 'monthly');
      });
    });

    setBillingInterval('monthly');
  });
})();
