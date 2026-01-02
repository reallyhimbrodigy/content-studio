const DEFAULT_SETTINGS = {
  enabled: false,
};

function normalizeSettings(raw = {}) {
  return { enabled: Boolean(raw?.enabled) };
}

export function initBrandBrainPanel({
  fetchWithAuth,
  isPro,
  getUserTier,
  getCurrentUser,
  getCurrentUserId,
  showUpgradeModal,
}) {
  const brandBtn = document.getElementById('brand-brain-btn');
  const brandModal = document.getElementById('brand-modal');
  if (!brandBtn || !brandModal) return;

  const statusPill = document.getElementById('brand-brain-status-pill');
  const toggleInput = document.getElementById('brand-brain-enabled');
  const saveIndicator = document.getElementById('brand-brain-save-indicator');
  const applyIndicator = document.getElementById('brand-brain-apply-indicator');
  const closeBtn = document.getElementById('brand-brain-close');

  let currentSettings = { ...DEFAULT_SETTINGS };
let saveTimer = null;
  let hasLoggedLoad = false;

  const updateStatus = (settings) => {
    if (statusPill) {
      statusPill.textContent = settings.enabled ? 'Enabled' : 'Disabled';
      statusPill.dataset.state = settings.enabled ? 'enabled' : 'disabled';
    }
    if (applyIndicator) {
      applyIndicator.textContent = settings.enabled ? 'Applied to next generation' : 'Enable to apply on next generation';
    }
  };

  const updateSaveIndicator = (text = '') => {
    if (!saveIndicator) return;
    saveIndicator.textContent = text;
    saveIndicator.dataset.state = text ? 'visible' : 'hidden';
  };

  const setLockedState = (locked) => {
    brandModal.dataset.locked = locked ? 'true' : 'false';
  };

  const applySettingsToUI = (settings) => {
    if (toggleInput) toggleInput.checked = settings.enabled;
    updateStatus(settings);
  };

  const resolveIsPro = async () => {
    if (typeof window.cachedUserIsPro === 'boolean') return window.cachedUserIsPro;
    const email = await getCurrentUser();
    if (!email) return false;
    let pro = false;
    if (typeof getUserTier === 'function') {
      const tier = await getUserTier(email);
      pro = String(tier || '').toLowerCase().trim() === 'pro';
    } else {
      pro = await isPro(email);
    }
    window.cachedUserIsPro = pro;
    return pro;
  };

  const requirePro = async () => {
    const pro = await resolveIsPro();
    if (!pro) {
      if (typeof showUpgradeModal === 'function') showUpgradeModal();
      return false;
    }
    return true;
  };

  const loadSettings = async () => {
    try {
      const userId = await getCurrentUserId();
      if (!userId) {
        currentSettings = normalizeSettings(DEFAULT_SETTINGS);
        applySettingsToUI(currentSettings);
        setLockedState(true);
        return;
      }
      const resp = await fetchWithAuth('/api/brand-brain/settings', { method: 'GET' });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok || data?.ok === false) {
        currentSettings = normalizeSettings(DEFAULT_SETTINGS);
      } else {
        currentSettings = normalizeSettings(data?.settings || data?.data || {});
      }
      applySettingsToUI(currentSettings);
      if (!hasLoggedLoad) {
        hasLoggedLoad = true;
        console.info(`[BrandBrain] loaded enabled=${currentSettings.enabled}`);
      }
      const pro = await resolveIsPro();
      setLockedState(!pro);
    } catch (err) {
      currentSettings = normalizeSettings(DEFAULT_SETTINGS);
      applySettingsToUI(currentSettings);
    }
  };

  const persistSettings = async (settings, { immediate = false } = {}) => {
    if (!immediate) {
      if (saveTimer) clearTimeout(saveTimer);
      saveTimer = setTimeout(() => persistSettings(settings, { immediate: true }), 600);
      return;
    }

    try {
      updateSaveIndicator('Saving...');
      const resp = await fetchWithAuth('/api/brand-brain/settings', {
        method: 'POST',
        body: JSON.stringify({ enabled: settings.enabled }),
      });
      const data = await resp.json().catch(() => ({}));
      if (resp.status === 402 || data?.error === 'upgrade_required') {
        if (typeof showUpgradeModal === 'function') showUpgradeModal();
        updateSaveIndicator('');
        return;
      }
      if (!resp.ok || data?.ok === false) {
        throw new Error(data?.error || 'save_failed');
      }
      currentSettings = normalizeSettings(data.settings || data?.data || settings);
      applySettingsToUI(currentSettings);
      updateSaveIndicator('Saved');
      setTimeout(() => updateSaveIndicator(''), 1600);
      console.info(`[BrandBrain] saved enabled=${currentSettings.enabled}`);
    } catch (err) {
      updateSaveIndicator('');
    }
  };

  const handleToggleChange = async () => {
    const pro = await requirePro();
    if (!pro) {
      toggleInput.checked = currentSettings.enabled;
      return;
    }
    currentSettings = normalizeSettings({ ...currentSettings, enabled: toggleInput.checked });
    applySettingsToUI(currentSettings);
    persistSettings(currentSettings, { immediate: true });
  };

  const openPanel = async () => {
    const pro = await resolveIsPro();
    if (!pro) {
      if (typeof showUpgradeModal === 'function') showUpgradeModal();
      return;
    }
    brandModal.style.display = 'flex';
    document.documentElement.dataset.prevOverflow = document.documentElement.style.overflow || '';
    document.body.dataset.prevOverflow = document.body.style.overflow || '';
    document.documentElement.style.overflow = 'hidden';
    document.body.style.overflow = 'hidden';
    await loadSettings();
  };

  const closePanel = () => {
    brandModal.style.display = 'none';
    document.documentElement.style.overflow = document.documentElement.dataset.prevOverflow || '';
    document.body.style.overflow = document.body.dataset.prevOverflow || '';
  };

  brandBtn.addEventListener('click', openPanel);
  if (closeBtn) closeBtn.addEventListener('click', closePanel);

  if (toggleInput) {
    toggleInput.addEventListener('change', handleToggleChange);
  }

  applySettingsToUI(currentSettings);
}
