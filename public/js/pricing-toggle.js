(function () {
  function setBillingInterval(interval) {
    var priceAmount = document.getElementById('pro-price-amount');
    var pricePeriod = document.getElementById('pro-price-period');
    var billedNote = document.getElementById('pro-billed-note');
    var buttons = document.querySelectorAll('.pricing-toggle-btn');
    if (!priceAmount || !billedNote || !buttons.length) return;

    buttons.forEach(function (button) {
      var active = button.getAttribute('data-billing') === interval;
      button.classList.toggle('is-active', active);
      button.setAttribute('aria-pressed', active ? 'true' : 'false');
    });

    if (interval === 'yearly') {
      priceAmount.textContent = '$200';
      if (pricePeriod) pricePeriod.textContent = '/year';
      billedNote.textContent = '(save $40)';
      billedNote.hidden = false;
    } else {
      priceAmount.textContent = '$19.99';
      if (pricePeriod) pricePeriod.textContent = '/month';
      billedNote.textContent = 'or $200/year (save $40)';
      billedNote.hidden = false;
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
