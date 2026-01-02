const DEFAULT_SETTINGS = {
  enabled: false,
  preset: 'direct_response',
  audience: '',
  offer: '',
  primary_cta: 'comment',
  risk_level: 45,
  levers: {
    stronger_hooks: true,
    shorter_captions: true,
    engagement_loops: true,
    retention_beats: true,
    cta_variety: true,
  },
};

const PRESET_LABELS = {
  direct_response: 'Direct Response',
  authority_builder: 'Authority Builder',
  viral_hybrid: 'Viral Hybrid',
};

const CTA_LABELS = {
  comment: 'Comment',
  dm: 'DM',
  link_in_bio: 'Link in bio',
  save_share: 'Save/Share',
  follow: 'Follow',
};

function normalizeSettings(raw = {}) {
  const safe = { ...DEFAULT_SETTINGS, ...(raw || {}) };
  safe.enabled = Boolean(raw?.enabled);
  safe.preset = PRESET_LABELS[raw?.preset] ? raw.preset : DEFAULT_SETTINGS.preset;
  safe.audience = typeof raw?.audience === 'string' ? raw.audience.trim() : '';
  safe.offer = typeof raw?.offer === 'string' ? raw.offer.trim() : '';
  safe.primary_cta = CTA_LABELS[raw?.primary_cta] ? raw.primary_cta : DEFAULT_SETTINGS.primary_cta;
  const risk = Number.isFinite(Number(raw?.risk_level)) ? Number(raw.risk_level) : DEFAULT_SETTINGS.risk_level;
  safe.risk_level = Math.max(0, Math.min(100, Math.round(risk)));
  const levers = raw?.levers && typeof raw.levers === 'object' ? raw.levers : {};
  safe.levers = {
    stronger_hooks: levers.stronger_hooks !== false,
    shorter_captions: levers.shorter_captions !== false,
    engagement_loops: levers.engagement_loops !== false,
    retention_beats: levers.retention_beats !== false,
    cta_variety: levers.cta_variety !== false,
  };
  return safe;
}

function buildRules(settings) {
  const rules = [];
  if (settings.levers.stronger_hooks) {
    rules.push('Use a 1-2 sentence hook that creates contrast or curiosity.');
  }
  if (settings.levers.retention_beats) {
    rules.push('Add a mid-caption retention beat (open loop or numbered step).');
  }
  rules.push('End with one clear CTA.');
  if (settings.levers.engagement_loops) {
    rules.push('Include one engagement loop (binary question or comment keyword).');
  }
  if (settings.levers.shorter_captions) {
    rules.push('Keep captions short and skimmable unless teaching steps.');
  }
  if (settings.levers.cta_variety) {
    rules.push('Rotate CTAs across the month to avoid repetition.');
  }

  if (settings.preset === 'direct_response') {
    rules.push('Clarify the offer and address one objection with ethical urgency.');
  } else if (settings.preset === 'authority_builder') {
    rules.push('Teach with proof, steps, or examples to build trust.');
  } else if (settings.preset === 'viral_hybrid') {
    rules.push('Use curiosity gaps or pattern interrupts, then tie back to the offer.');
  }

  if (settings.risk_level <= 40) {
    rules.push('Use safer claims and more educational framing.');
  } else if (settings.risk_level >= 70) {
    rules.push('Use bolder hooks and sharper contrasts without exaggeration.');
  }

  return rules;
}

function debounce(fn, delay) {
  let timer;
  return (...args) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => fn(...args), delay);
  };
}

export function initBrandBrainPanel({
  fetchWithAuth,
  isPro,
  getCurrentUser,
  getCurrentUserId,
  showUpgradeModal,
}) {
  const brandBtn = document.getElementById('brand-brain-btn');
  const brandModal = document.getElementById('brand-modal');
  if (!brandBtn || !brandModal) return;

  const statusPill = document.getElementById('brand-brain-status-pill');
  const toggleInput = document.getElementById('brand-brain-enabled');
  const presetRadios = Array.from(document.querySelectorAll('input[name="brand-brain-preset"]'));
  const audienceInput = document.getElementById('brand-brain-audience');
  const offerInput = document.getElementById('brand-brain-offer');
  const ctaSelect = document.getElementById('brand-brain-cta');
  const riskInput = document.getElementById('brand-brain-risk');
  const riskValue = document.getElementById('brand-brain-risk-value');
  const levers = {
    stronger_hooks: document.getElementById('brand-brain-lever-hooks'),
    shorter_captions: document.getElementById('brand-brain-lever-captions'),
    engagement_loops: document.getElementById('brand-brain-lever-loops'),
    retention_beats: document.getElementById('brand-brain-lever-retention'),
    cta_variety: document.getElementById('brand-brain-lever-cta'),
  };
  const rulesList = document.getElementById('brand-brain-rules-list');
  const saveIndicator = document.getElementById('brand-brain-save-indicator');
  const applyIndicator = document.getElementById('brand-brain-apply-indicator');
  const closeBtn = document.getElementById('brand-brain-close');

  let currentSettings = { ...DEFAULT_SETTINGS };
  let saveTimer = null;

  const renderRules = (settings) => {
    if (!rulesList) return;
    const rules = buildRules(settings);
    rulesList.innerHTML = '';
    rules.forEach((rule) => {
      const li = document.createElement('li');
      li.textContent = rule;
      rulesList.appendChild(li);
    });
  };

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
    presetRadios.forEach((radio) => {
      radio.checked = radio.value === settings.preset;
    });
    if (audienceInput) audienceInput.value = settings.audience || '';
    if (offerInput) offerInput.value = settings.offer || '';
    if (ctaSelect) ctaSelect.value = settings.primary_cta;
    if (riskInput) riskInput.value = String(settings.risk_level);
    if (riskValue) riskValue.textContent = String(settings.risk_level);
    Object.entries(levers).forEach(([key, input]) => {
      if (!input) return;
      input.checked = Boolean(settings.levers?.[key]);
    });
    renderRules(settings);
    updateStatus(settings);
  };

  const resolveIsPro = async () => {
    if (typeof window.cachedUserIsPro === 'boolean') return window.cachedUserIsPro;
    const email = await getCurrentUser();
    if (!email) return false;
    const pro = await isPro(email);
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
        console.warn('[BrandBrain] settings load failed', data?.error || resp.status);
        currentSettings = normalizeSettings(DEFAULT_SETTINGS);
      } else {
        currentSettings = normalizeSettings(data?.settings || data?.data || {});
      }
      applySettingsToUI(currentSettings);
      const pro = await resolveIsPro();
      setLockedState(!pro);
    } catch (err) {
      console.warn('[BrandBrain] settings fetch error', err?.message || err);
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
        body: JSON.stringify(settings),
      });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok || data?.ok === false) {
        throw new Error(data?.error || 'save_failed');
      }
      currentSettings = normalizeSettings(data.settings || settings);
      applySettingsToUI(currentSettings);
      updateSaveIndicator('Saved');
      setTimeout(() => updateSaveIndicator(''), 1600);
    } catch (err) {
      console.warn('[BrandBrain] save failed', err?.message || err);
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

  const handlePresetChange = async (value) => {
    const pro = await requirePro();
    if (!pro) {
      applySettingsToUI(currentSettings);
      return;
    }
    currentSettings = normalizeSettings({ ...currentSettings, preset: value });
    applySettingsToUI(currentSettings);
    persistSettings(currentSettings, { immediate: true });
  };

  const handleLeverChange = async (key, value) => {
    const pro = await requirePro();
    if (!pro) {
      applySettingsToUI(currentSettings);
      return;
    }
    currentSettings = normalizeSettings({
      ...currentSettings,
      levers: { ...currentSettings.levers, [key]: value },
    });
    applySettingsToUI(currentSettings);
    persistSettings(currentSettings, { immediate: true });
  };

  const scheduleTextSave = debounce(() => {
    persistSettings(currentSettings, { immediate: true });
  }, 700);

  const handleTextChange = async () => {
    const pro = await requirePro();
    if (!pro) {
      applySettingsToUI(currentSettings);
      return;
    }
    currentSettings = normalizeSettings({
      ...currentSettings,
      audience: audienceInput?.value || '',
      offer: offerInput?.value || '',
      primary_cta: ctaSelect?.value || currentSettings.primary_cta,
      risk_level: Number(riskInput?.value || currentSettings.risk_level),
    });
    if (riskValue) riskValue.textContent = String(currentSettings.risk_level);
    renderRules(currentSettings);
    updateStatus(currentSettings);
    scheduleTextSave();
  };

  const openPanel = async () => {
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

  presetRadios.forEach((radio) => {
    radio.addEventListener('change', () => handlePresetChange(radio.value));
  });

  Object.entries(levers).forEach(([key, input]) => {
    if (!input) return;
    input.addEventListener('change', () => handleLeverChange(key, input.checked));
  });

  if (audienceInput) audienceInput.addEventListener('input', handleTextChange);
  if (offerInput) offerInput.addEventListener('input', handleTextChange);
  if (ctaSelect) ctaSelect.addEventListener('change', handleTextChange);
  if (riskInput) riskInput.addEventListener('input', handleTextChange);

  brandModal.addEventListener('click', (event) => {
    const lockTarget = event.target.closest('[data-pro-lock]');
    if (!lockTarget) return;
    if (window.cachedUserIsPro !== true) {
      event.preventDefault();
      event.stopPropagation();
      if (typeof showUpgradeModal === 'function') showUpgradeModal();
    }
  });

  applySettingsToUI(currentSettings);
}
