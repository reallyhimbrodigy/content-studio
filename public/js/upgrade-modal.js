// Upgrade Modal Functions

function openUpgradeModal() {
  const modal = document.getElementById('upgrade-modal');
  if (modal) {
    modal.style.display = 'flex';
    document.body.style.overflow = 'hidden'; // Prevent background scroll
  }
}

function closeUpgradeModal() {
  const modal = document.getElementById('upgrade-modal');
  if (modal) {
    modal.style.display = 'none';
    document.body.style.overflow = 'auto'; // Restore scroll
  }
}

// Initialize modal event listeners
document.addEventListener('DOMContentLoaded', function() {
  const modal = document.getElementById('upgrade-modal');

  // Main upgrade button in pricing section
  const upgradeBtn = document.getElementById('upgrade-to-pro-btn');
  if (upgradeBtn) {
    upgradeBtn.addEventListener('click', function(e) {
      e.preventDefault();
      openUpgradeModal();
    });
  }

  // All other upgrade trigger buttons (hero, final CTA, etc.)
  const upgradeTriggers = document.querySelectorAll('.upgrade-trigger');
  upgradeTriggers.forEach(function(trigger) {
    trigger.addEventListener('click', function(e) {
      e.preventDefault();
      openUpgradeModal();
    });
  });

  // Close button
  const closeBtn = document.getElementById('modal-close-btn');
  if (closeBtn) {
    closeBtn.addEventListener('click', function(e) {
      e.preventDefault();
      closeUpgradeModal();
    });
  }

  // Close modal when clicking overlay background
  if (modal) {
    modal.addEventListener('click', function(e) {
      if (e.target === modal) {
        closeUpgradeModal();
      }
    });
  }

  // Close modal on ESC key
  document.addEventListener('keydown', function(e) {
    if (e.key === 'Escape') {
      const modal = document.getElementById('upgrade-modal');
      if (modal && modal.style.display === 'flex') {
        closeUpgradeModal();
      }
    }
  });
});
