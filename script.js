import {
  getCurrentUser,
  getCurrentUserId,
  getCurrentUserDetails,
  saveUserCalendar,
  signOut as storeSignOut,
  getUserTier,
  setUserTier,
  isPro,
  getProfilePreferences,
  saveProfilePreferences,
  supabase
} from './user-store.js';

const grid = document.getElementById("calendar-grid");
  const pillarFilterBtn = document.getElementById("pillar-filter-btn");
  const pillarFilterMenu = document.getElementById("pillar-filter-menu");
  const pillarFilterLabel = document.getElementById("pillar-filter-label");
  const filterDropdownItems = document.querySelectorAll(".filter-dropdown-item");
  const userEmailEl = document.getElementById("user-email");
  const userTierBadge = document.getElementById("user-tier-badge");
  const signOutBtn = document.getElementById("sign-out-btn");
  const manageBillingBtn = document.getElementById('manage-billing-btn');
  const profileTrigger = document.getElementById('profile-trigger');
  const profileMenu = document.getElementById('profile-menu');
  const profileInitial = document.getElementById('profile-initial');
  const userPronounsEl = document.getElementById('user-pronouns');
  const accountOverviewBtn = document.getElementById('account-overview-btn');
  const profileSettingsBtn = document.getElementById('profile-settings-btn');
  const passwordSettingsBtn = document.getElementById('password-settings-btn');
  const accountModal = document.getElementById('account-modal');
  const accountCloseBtn = document.getElementById('account-close-btn');
  const accountCancelBtn = document.getElementById('account-cancel-btn');
  const accountForm = document.getElementById('account-settings-form');
  const accountDisplayNameInput = document.getElementById('account-display-name');
  const accountPronounsInput = document.getElementById('account-pronouns');
  const accountRoleInput = document.getElementById('account-role');
  const accountFeedback = document.getElementById('account-feedback');
  const prefersReducedMotionInput = document.getElementById('prefers-reduced-motion');
  const prefersHighContrastInput = document.getElementById('prefers-high-contrast');
  const prefersLargeTypeInput = document.getElementById('prefers-large-type');
  const accountEmailDisplay = document.getElementById('account-email-display');
  const accountEmailCopyBtn = document.getElementById('account-email-copy');
  const accountPasswordManageBtn = document.getElementById('account-password-manage');
  const accountPlanStatusEl = document.getElementById('account-plan-status');
const accountPlanLimitsEl = document.getElementById('account-plan-limits');
const accountLastLoginEl = document.getElementById('account-last-login');
const settingsTabButtons = document.querySelectorAll('[data-settings-tab]');
const settingsPanels = document.querySelectorAll('[data-settings-panel]');
const postFrequencyDisplay = document.getElementById('post-frequency-display');
const postFrequencySelect = document.getElementById('post-frequency-select');
const DESIGN_FEATURES_ENABLED = false;

if (!DESIGN_FEATURES_ENABLED) {
  const generateAssetModal = document.getElementById('generate-asset-modal');
  if (generateAssetModal) generateAssetModal.remove();
  const designLabSection = document.getElementById('design-lab');
  if (designLabSection) designLabSection.style.display = 'none';
}
const landingNavLinks = document.querySelector('.landing-nav__links');
const landingNavAnchors = document.querySelectorAll('.landing-nav__links a[href^="#"]');
const landingSampleActionButtons = document.querySelectorAll('.landing-samples__cards .calendar-card__actions button');
  const generateBtn = document.getElementById("generate-calendar");
  const upgradeModal = document.getElementById("upgrade-modal");
  const upgradeClose = document.getElementById("upgrade-close");
  const upgradeBtn = document.getElementById("upgrade-btn");
  const nicheInput = document.getElementById("niche-style-input");
  const feedbackEl = document.getElementById("niche-feedback");
  const exportBtn = document.getElementById("export-calendar");
  const exportCsvBtn = document.getElementById("export-csv");
  const saveBtn = document.getElementById("save-calendar");
  const brandBtn = document.getElementById("brand-brain-btn");
  const brandModal = document.getElementById("brand-modal");
  const brandText = document.getElementById("brand-text");
  const brandSaveBtn = document.getElementById("brand-save-btn");
  const brandCancelBtn = document.getElementById("brand-cancel-btn");
  const brandStatus = document.getElementById("brand-status");
  const brandPrimaryColorInput = document.getElementById('brand-primary-color');
  const brandSecondaryColorInput = document.getElementById('brand-secondary-color');
  const brandAccentColorInput = document.getElementById('brand-accent-color');
  const brandHeadingFontInput = document.getElementById('brand-heading-font');
  const brandBodyFontInput = document.getElementById('brand-body-font');
  const brandLogoInput = document.getElementById('brand-logo-input');
  const brandLogoPreview = document.getElementById('brand-logo-preview');
  const brandLogoPlaceholder = document.getElementById('brand-logo-placeholder');
const brandLogoClearBtn = document.getElementById('brand-logo-clear');
const brandKitSaveBtn = document.getElementById('brand-kit-save-btn');
const brandKitStatus = document.getElementById('brand-kit-status');
const appLayout = document.querySelector('.app-layout');
const proNavLinks = document.querySelectorAll('.sidebar-link--pro');
const appSidebar = document.getElementById('app-sidebar');
const sidebarToggle = document.getElementById('sidebar-toggle');
let fontPickers = [];
let fontPickerListenersBound = false;
  const exportIcsBtn = document.getElementById('export-ics');
  const downloadZipBtn = document.getElementById('download-zip');
  const copyAllCaptionsBtn = document.getElementById('copy-all-captions');
  const copyAllFullBtn = document.getElementById('copy-all-full');
  const exportVariantsCsvBtn = document.getElementById('export-variants-csv');
  const downloadVariantsZipBtn = document.getElementById('download-variants-zip');
  const downloadCalendarFolderBtn = document.getElementById('download-calendar-folder');
  const deleteCalendarBtn = document.getElementById('delete-calendar-button');
  const hub = document.getElementById('publish-hub');
  const hubNext = document.getElementById('hub-next');
  const hubAfter = document.getElementById('hub-after');
const designSection = document.getElementById('design-lab');
const designGrid = document.getElementById('design-grid');
const designEmpty = document.getElementById('design-empty');
const designEmptyGoCalendarBtn = document.getElementById('design-empty-go-calendar');
const designEmptyTitle = document.getElementById('design-empty-title');
const designEmptyBody = document.getElementById('design-empty-body');
const designEmptyClearFiltersBtn = document.getElementById('design-empty-clear-filters');
const designWorkspace = document.getElementById('design-workspace');
const designEditorPanel = document.getElementById('design-editor-panel');
const designModal = document.getElementById('design-modal');
const designForm = document.getElementById('design-form');
const designCloseBtn = document.getElementById('design-close-btn');
const designCancelBtn = document.getElementById('design-cancel-btn');
const designFeedbackEl = document.getElementById('design-feedback');
const designSelectedPost = document.getElementById('design-selected-post');
const designDayInput = document.getElementById('design-day');
const designAssetTypeInput = document.getElementById('design-asset-type');
const designToneInput = document.getElementById('design-tone');
const designNotesInput = document.getElementById('design-notes');
const designConceptInput = document.getElementById('design-concept');
const designCaptionCueInput = document.getElementById('design-caption-cue');
const designCtaInput = document.getElementById('design-cta');
const designConceptDisplay = document.getElementById('design-concept-display');
const designCaptionDisplay = document.getElementById('design-caption-display');
const designCtaDisplay = document.getElementById('design-cta-display');
const designTemplateSelect = document.getElementById('design-template-select');
const designTemplateClearBtn = document.getElementById('design-template-clear');
const designTemplateHint = document.getElementById('design-template-hint');
const designTemplateGallery = document.getElementById('design-template-gallery');
const designUseLastTemplateBtn = document.getElementById('design-use-last-template');
const designNotesToggle = document.getElementById('design-notes-toggle');
const designNotesPanel = document.getElementById('design-notes-panel');
const designViewGridBtn = document.getElementById('design-view-grid');
const designViewListBtn = document.getElementById('design-view-list');
const designFilterType = document.getElementById('design-filter-type');
const designFilterDay = document.getElementById('design-filter-day');
const designFilterTone = document.getElementById('design-filter-tone');
const designFilterCampaign = document.getElementById('design-filter-campaign');
const designFilterMonth = document.getElementById('design-filter-month');
const designFilterSearchInput = document.getElementById('design-filter-search');
const designSelectionCount = document.getElementById('design-selection-count');
const designExportSelectedBtn = document.getElementById('design-export-selected');
const designRegenerateSelectedBtn = document.getElementById('design-regenerate-selected');
const designPreviewEl = document.getElementById('design-preview');
const assetDetailModal = document.getElementById('asset-detail-modal');
const assetDetailPreview = document.getElementById('asset-detail-preview');
const assetDetailCloseBtn = document.getElementById('asset-detail-close');
const assetDetailForm = document.getElementById('asset-detail-form');
const assetDetailTypeLabel = document.getElementById('asset-detail-type-label');
const assetDetailDayLabel = document.getElementById('asset-detail-day-label');
const assetDetailSlides = document.getElementById('asset-detail-slides');
const assetDetailHeadline = document.getElementById('asset-detail-headline');
const assetDetailCaption = document.getElementById('asset-detail-caption');
const assetDetailCta = document.getElementById('asset-detail-cta');
const assetDetailNotes = document.getElementById('asset-detail-notes');
const assetDetailNotesToggle = document.getElementById('asset-detail-notes-toggle');
const assetDetailNotesPanel = document.getElementById('asset-detail-notes-panel');
const assetDetailMeta = document.getElementById('asset-detail-meta');
const assetDetailRegenerateBtn = document.getElementById('asset-detail-regenerate');
const assetDetailTimestamp = document.getElementById('asset-detail-timestamp');
const assetDetailCancelBtn = document.getElementById('asset-detail-cancel');
const assetDetailTemplateSelect = document.getElementById('asset-detail-template-select');
const assetDetailUseLastTemplateBtn = document.getElementById('asset-detail-use-last-template');
const assetDetailUndoBtn = document.getElementById('asset-detail-undo');
const assetDetailType = document.getElementById('asset-detail-type');
const assetDetailTone = document.getElementById('asset-detail-tone');
const assetDetailPrimaryColor = document.getElementById('asset-detail-primary-color');
const assetDetailSecondaryColor = document.getElementById('asset-detail-secondary-color');
const assetDetailAccentColor = document.getElementById('asset-detail-accent-color');
const assetDetailHeadingFont = document.getElementById('asset-detail-heading-font');
const assetDetailBodyFont = document.getElementById('asset-detail-body-font');
const designWorkspaceEnabled = Boolean(designWorkspace && designEditorPanel);
const designEditorForm = document.getElementById('design-editor-form');
const designEditorEmpty = document.getElementById('design-editor-empty');
const designEditorTitleInput = document.getElementById('design-editor-title');
const designEditorStatusSelect = document.getElementById('design-editor-status');
const designEditorTypeSelect = document.getElementById('design-editor-type');
const designEditorDaySelect = document.getElementById('design-editor-day');
const designEditorToneInput = document.getElementById('design-editor-tone');
const designEditorCampaignInput = document.getElementById('design-editor-campaign');
const designEditorMonthSelect = document.getElementById('design-editor-month');
const designEditorPromptInput = document.getElementById('design-editor-prompt');
const designEditorPreviewImg = document.getElementById('design-editor-preview-img');
const designEditorPreviewPlaceholder = document.getElementById('design-editor-preview-placeholder');
const designEditorBrandSection = document.getElementById('design-editor-brand');
const designEditorBrandPrimary = document.getElementById('design-editor-brand-primary');
const designEditorBrandSecondary = document.getElementById('design-editor-brand-secondary');
const designEditorBrandAccent = document.getElementById('design-editor-brand-accent');
const designEditorBrandFonts = document.getElementById('design-editor-brand-fonts');
const designEditorBrandVoice = document.getElementById('design-editor-brand-voice');
const designEditorStoryPanel = document.getElementById('design-editor-story-panel');
const designEditorStoryCopyInput = document.getElementById('design-editor-story-copy');
const designEditorCarouselPanel = document.getElementById('design-editor-carousel-panel');
const designEditorCarouselSlideInputs = {
  slide1: document.getElementById('design-editor-slide1'),
  slide2: document.getElementById('design-editor-slide2'),
  slide3: document.getElementById('design-editor-slide3'),
};
const designEditorStatusBadge = document.getElementById('design-editor-status-badge');
const designEditorStatusNote = document.getElementById('design-editor-status-note');
const designEditorSaveBtn = document.getElementById('design-editor-save');
const designEditorDuplicateBtn = document.getElementById('design-editor-duplicate');
const designEditorDeleteBtn = document.getElementById('design-editor-delete');
const assetEditorModal = document.getElementById('asset-editor-modal');
const assetEditorTitle = document.getElementById('asset-editor-title');
const assetEditorPreviewImage = document.getElementById('asset-editor-preview-image');
const assetEditorPreviewPlaceholder = document.getElementById('asset-editor-preview-placeholder');
const assetEditorTitleInput = document.getElementById('asset-editor-title-input');
const assetEditorSubtitleInput = document.getElementById('asset-editor-subtitle-input');
const assetEditorCtaInput = document.getElementById('asset-editor-cta-input');
const assetEditorNotesInput = document.getElementById('asset-editor-notes-input');
const assetEditorStatus = document.getElementById('asset-editor-status');
const assetEditorSaveButton = document.getElementById('asset-editor-save-button');
const assetEditorRegenerateButton = document.getElementById('asset-editor-regenerate-button');
const assetEditorDownloadButton = document.getElementById('asset-editor-download-button');
populateLinkedDaySelect(designEditorDaySelect);

function getDesignFailureMessage(asset) {
  if (!asset) return 'Generation failed. You can adjust the prompt or try again.';
  const message =
    asset.data?.error_message ||
    asset.error_message ||
    '';
  if (!message) return 'Generation failed. You can adjust the prompt or try again.';
  if (/request failed/i.test(message)) {
    return 'Generation failed. Check your template settings or try regenerating.';
  }
  return message;
}
const landingExperience = document.getElementById('landing-experience');
const appExperience = document.getElementById('app-experience');
const urlParams = new URLSearchParams(window.location.search || '');
const forceLandingView = urlParams.get('view') === 'landing';
// Tabs
  const tabPlan = document.getElementById('tab-plan');
  const tabPublish = document.getElementById('tab-publish');
  const calendarSection = document.querySelector('section.calendar');
  const toggleCompactBtn = document.getElementById('toggle-compact');
  const hubEmpty = document.getElementById('hub-empty');
  const hubEmptyGenBtn = document.getElementById('hub-empty-generate');
  const hubGrid = document.querySelector('.publish-hub__grid');
  const hubPrevBtn = document.getElementById('hub-prev');
  const hubNextBtn = document.getElementById('hub-btn-next');
  const hubSkipBtn = document.getElementById('hub-skip-unposted');
  const hubSkipPrevBtn = document.getElementById('hub-skip-prev');
  const hubProgress = document.getElementById('hub-progress');
  const hubMarkBtn = document.getElementById('hub-mark-posted');
const hubDaySelect = document.getElementById('hub-day-select');

const PROFILE_SETTINGS_LEGACY_KEY = 'promptly_profile_settings';
const PROFILE_SETTINGS_PREFIX = 'promptly_profile_settings_v2:';
const PROFILE_SETTINGS_VOLATILE_PREFIX = 'promptly_profile_settings_volatile:';
const PROFILE_SETTINGS_MEMORY_CACHE = {};
let profileSettingsQuotaWarned = false;
let profileSettingsPersistentDisabled = false;
let profileSettings = loadProfileSettings();
let profileSettingsSyncPromise = null;
let activeUserEmail = '';
let activeSettingsTab = 'account';
let forceAppAfterAuth = false;
try {
  forceAppAfterAuth = sessionStorage.getItem('promptly_show_app') === '1';
} catch (_) {}

if (forceLandingView) {
  try { sessionStorage.removeItem('promptly_show_app'); } catch (_) {}
  forceAppAfterAuth = false;
  if (landingExperience) landingExperience.style.display = '';
  if (appExperience) appExperience.style.display = 'none';
} else if (forceAppAfterAuth && landingExperience && appExperience) {
  landingExperience.style.display = 'none';
  appExperience.style.display = '';
}

  // Posted state per user+niche
let hubIndex = 0; // 0-based index into currentCalendar
let activeTab = 'plan';
let isCompact = false;
let cachedUserIsPro = false;
let currentPostFrequency = 1;
let pendingAssetGeneration = null;
let lastGenerateAssetOpener = null;
let designAssets = [];
const designAssetPollTimers = new Map();
const MAX_DESIGN_POLL_ATTEMPTS = 20; // Stop polling after N attempts to avoid hammering the server if renders never finish.
let designAssetsApiDisabled = false;
let isFetchingDesignAssets = false;
let activeDesignContext = null;
let currentBrandKit = null;
let brandKitLoaded = false;
let brandProfileLoaded = false;
let currentBrandText = '';
const BRAND_BRAIN_LOCAL_PREFIX = 'promptly_brand_brain_';
const BRAND_KIT_LOCAL_PREFIX = 'promptly_brand_kit_';
const selectedDesignAssetIds = new Set();
let designFocusedAssetId = null;
let draggedDesignAssetId = null;
let platformVariantSyncPromise = null;
const DESIGN_TEMPLATE_STORAGE_KEY = 'promptly_design_templates_v1';
const SIDEBAR_STORAGE_KEY = 'promptly_sidebar_collapsed';
const LAST_USER_STORAGE_KEY = 'promptly_active_user_v1';
const CALENDAR_STORAGE_PREFIX = 'promptly_calendar_state_v1:';
const DESIGN_ASSET_STORAGE_PREFIX = 'promptly_design_assets_v2:';
const DESIGN_USAGE_STORAGE_PREFIX = 'promptly_design_usage_v1:';
const DESIGN_FREE_MONTHLY_QUOTA = 3;
const DESIGN_LAST_TEMPLATE_KEY = 'promptly_design_last_template_v1';
const DESIGN_VIEW_MODE_KEY = 'promptly_design_view_mode_v1';

/**
 * @typedef {'draft'|'ready'|'exported'} AssetStatus
 * @typedef {Object} DesignAsset
 * @property {string} id
 * @property {string} title
 * @property {'carousel'|'story'|'other'} assetType
 * @property {string} linkedDayLabel
 * @property {number|null} linkedDay
 * @property {string} tone
 * @property {string} campaign
 * @property {string} monthLabel
 * @property {AssetStatus} status
 * @property {string} createdAt
 * @property {string} updatedAt
 * @property {string} prompt
 * @property {string=} previewUrl
 */

// TODO: Replace mock assets with real data from the backend once asset APIs are available.
let designTemplates = loadDesignTemplates();
let activeTemplateId = '';
let highlightDesignAssetId = urlParams.get('asset');
if (highlightDesignAssetId && highlightDesignAssetId.includes('%')) {
  try { highlightDesignAssetId = decodeURIComponent(highlightDesignAssetId); } catch (_) {}
}
let designFilterState = {
  type: designFilterType?.value || 'all',
  day: designFilterDay?.value || 'all',
  tone: designFilterTone?.value || 'all',
  campaign: designFilterCampaign?.value || 'all',
  month: designFilterMonth?.value || 'all',
  search: designFilterSearchInput?.value?.trim().toLowerCase() || '',
};
let designStorageDisabled = false;
let calendarStorageDisabled = false;
let designViewMode = (() => {
  try {
    return localStorage.getItem(DESIGN_VIEW_MODE_KEY) || 'grid';
  } catch {
    return 'grid';
  }
})();
let activeAssetDetailId = null;
let pendingAssetDetailId = null;
let isDesignRegenerating = false;
let currentDesignAsset = null;
if (designSelectionCount) designSelectionCount.textContent = '0 selected';

function getLastTemplateId() {
  try {
    return localStorage.getItem(DESIGN_LAST_TEMPLATE_KEY) || '';
  } catch {
    return '';
  }
}


function rememberLastTemplate(templateId) {
  if (!templateId) return;
  try {
    localStorage.setItem(DESIGN_LAST_TEMPLATE_KEY, String(templateId));
  } catch {}
  updateTemplateShortcuts();
  updateAssetDetailTemplateShortcut();
}

function updateTemplateShortcuts() {
  if (!designUseLastTemplateBtn) return;
  const lastId = getLastTemplateId();
  const exists = lastId && designTemplates.some((tpl) => String(tpl.id) === String(lastId));
  designUseLastTemplateBtn.disabled = !exists;
  if (exists) {
    updateLastTemplateButtonThumbnail(lastId);
  } else if (designUseLastTemplateBtn) {
    designUseLastTemplateBtn.innerHTML = 'Use last template';
  }
}

function updateLastTemplateButtonThumbnail(templateId = '') {
  if (!designUseLastTemplateBtn) return;
  const tpl = designTemplates.find((item) => String(item.id) === String(templateId || getLastTemplateId()));
  if (!tpl) return;
  const preview = tpl.previewInlineUrl
    ? `<img src="${escapeHtml(tpl.previewInlineUrl)}" alt="${escapeHtml(tpl.label)}" />`
    : `<span class="design-template-card__preview-text">${escapeHtml(tpl.label)}</span>`;
  designUseLastTemplateBtn.innerHTML = `<span class="design-use-last-thumb">${preview}</span><span>Reapply ${escapeHtml(tpl.label)}</span>`;
}

const designAutofillMap = {
  concept: {
    wrapper: document.querySelector('[data-autofill="concept"]'),
    display: designConceptDisplay,
    input: designConceptInput,
    editBtn: document.querySelector('[data-autofill-edit="concept"]'),
  },
  caption: {
    wrapper: document.querySelector('[data-autofill="caption"]'),
    display: designCaptionDisplay,
    input: designCaptionCueInput,
    editBtn: document.querySelector('[data-autofill-edit="caption"]'),
  },
  cta: {
    wrapper: document.querySelector('[data-autofill="cta"]'),
    display: designCtaDisplay,
    input: designCtaInput,
    editBtn: document.querySelector('[data-autofill-edit="cta"]'),
  },
};

function setAutofillField(field, value = '') {
  const config = designAutofillMap[field];
  if (!config) return;
  const textValue = value ? value.trim() : '';
  const fallback =
    (config.display && config.display.dataset && config.display.dataset.emptyLabel) || 'Tap Edit to add';
  if (config.display) config.display.textContent = textValue || fallback;
  if (config.input) {
    config.input.value = value || '';
    config.input.setAttribute('readonly', 'readonly');
  }
  if (config.wrapper) config.wrapper.classList.remove('is-editing');
  if (config.editBtn) config.editBtn.textContent = 'Edit';
}

function toggleAutofillEditing(field) {
  const config = designAutofillMap[field];
  if (!config || !config.wrapper || !config.input || !config.editBtn) return;
  const isEditing = !config.wrapper.classList.contains('is-editing');
  if (isEditing) {
    config.wrapper.classList.add('is-editing');
    config.input.removeAttribute('readonly');
    config.input.focus();
    const length = config.input.value.length;
    config.input.setSelectionRange(length, length);
    config.editBtn.textContent = 'Done';
  } else {
    config.input.setAttribute('readonly', 'readonly');
    config.wrapper.classList.remove('is-editing');
    config.editBtn.textContent = 'Edit';
    setAutofillField(field, config.input.value);
  }
}

function openGenerateAssetModal(context) {
  pendingAssetGeneration = context || null;
  console.log('[Promptly] openGenerateAssetModal called', pendingAssetGeneration);
  const modal = document.getElementById('generate-asset-modal');
  if (!modal) {
    console.warn('[Promptly] generate-asset-modal not found.');
    return;
  }
  lastGenerateAssetOpener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  modal.classList.remove('modal--hidden');
  modal.setAttribute('aria-hidden', 'false');
  modal.style.display = 'flex';
  modal.style.opacity = '1';
  modal.style.pointerEvents = 'auto';
  const initialFocusTarget =
    modal.querySelector('input[name="asset-type"]:checked') ||
    modal.querySelector('input[name="asset-type"]') ||
    modal.querySelector('#confirm-generate-asset-button') ||
    modal;
  if (initialFocusTarget && typeof initialFocusTarget.focus === 'function') {
    initialFocusTarget.focus();
  } else {
    modal.focus();
  }
  console.log('[Promptly] Generate Asset modal should now be visible');
}

function closeGenerateAssetModal() {
  const modal = document.getElementById('generate-asset-modal');
  if (!modal) return;
  if (modal.contains(document.activeElement) && document.activeElement instanceof HTMLElement) {
    document.activeElement.blur();
  }
  modal.classList.add('modal--hidden');
  modal.setAttribute('aria-hidden', 'true');
  modal.style.display = '';
  modal.style.opacity = '';
  modal.style.pointerEvents = '';
  console.log('[Promptly] Generate Asset modal closed');
  pendingAssetGeneration = null;
  if (lastGenerateAssetOpener && typeof lastGenerateAssetOpener.focus === 'function') {
    lastGenerateAssetOpener.focus();
  }
  lastGenerateAssetOpener = null;
}

async function createDesignAssetFromCalendar(context, type) {
  if (!context) throw new Error('Missing calendar context');
  const currentUserId = await getCurrentUserId();
  if (!currentUserId) {
    throw new Error('You must be signed in to generate assets.');
  }
  const payload = {
    type,
    calendarDayId: context.calendarDayId,
    linkedDay: context.linkedDay,
    userId: currentUserId,
    title: context.title || '',
    subtitle: context.subtitle || '',
    cta: context.cta || '',
    prompt: context.prompt || '',
    tone: context.tone || '',
    campaign: context.campaign || '',
    month: context.month || '',
    brand_color:
      context.brandColor ||
      context.brand?.primaryColor ||
      context.brand?.accentColor ||
      '#7f5af0',
    background_image: context.backgroundImageUrl || null,
    logo: context.logoUrl || context.brand?.logoUrl || '',
    platform: context.platform || 'instagram',
  };
  console.log('[Promptly] Creating design asset from calendar', payload);
  const response = await fetchWithAuth('/api/design-assets', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  let result = null;
  try {
    result = await response.json();
  } catch (_) {
    result = null;
  }
  if (response.status === 501) {
    designAssetsApiDisabled = true;
    const message = result?.error || 'Design pipeline is not available in this environment.';
    console.error('[Promptly] Design assets API disabled', { status: response.status, body: result });
    throw new Error(message);
  }
  if (!response.ok) {
    console.error('[Promptly] Design assets API failed', {
      status: response.status,
      body: result,
    });
    const message = result?.details || result?.error || `design_assets_api_error_${response.status}`;
    throw new Error(message);
  }
  console.log('[Promptly] Design asset created', {
    status: response.status,
    payload: result,
  });
  const assetId = result?.assetId || result?.id || null;
  if (assetId) {
    const placeholder = {
      id: assetId,
      assetType: type,
      typeLabel: formatAssetTypeLabel(type),
      title: payload.title,
      linkedDay: payload.linkedDay,
      day: payload.linkedDay,
      status: 'rendering',
      previewText: 'Rendering in Placid…',
      designUrl: `/design.html?asset=${encodeURIComponent(assetId)}`,
      origin: 'remote',
      createdAt: new Date().toISOString(),
      calendarDayId: payload.calendarDayId,
      data: { type },
    };
    mergeDesignAsset(placeholder);
    pendingAssetDetailId = assetId;
    highlightDesignAssetId = assetId;
    showDesignSuccess(`${formatAssetTypeLabel(type)} queued in Design Lab.`);
    window.location.href = `design.html?asset=${encodeURIComponent(assetId)}`;
  }
  return assetId;
}

function buildAssetContextFromEntry(entry = {}, day) {
  const resolvedCalendarId =
    entry?.calendar_day_id ||
    entry?.calendarDayId ||
    entry?.id ||
    buildCalendarDayIdentifier(entry, day);
  return {
    calendarDayId: resolvedCalendarId,
    linkedDay: day,
    title: entry?.idea || entry?.title || `Day ${String(day).padStart(2, '0')}`,
    subtitle: entry?.caption || entry?.description || '',
    cta: entry?.cta || 'Learn more',
    prompt: entry?.prompt || '',
    tone: entry?.tone || '',
    campaign: entry?.campaign || '',
    month: entry?.month || '',
    platform: (entry?.format || 'instagram').toLowerCase().includes('story') ? 'stories' : 'instagram',
    backgroundImageUrl: entry?.backgroundImageUrl || entry?.heroImage || '',
    logoUrl: entry?.brand?.logoUrl || entry?.logoUrl || '',
    brandColor: entry?.brand_color || entry?.brand?.primaryColor || entry?.brand?.accentColor || '',
    brand: {
      primaryColor: entry?.brand?.primaryColor || entry?.brand_color || '',
      accentColor: entry?.brand?.accentColor || '',
      logoUrl: entry?.brand?.logoUrl || '',
    },
  };
}

async function beginGenerateAssetFlow(entry, entryDay, triggerButton) {
  if (!DESIGN_FEATURES_ENABLED) return;
  const resolvedDay = Number(typeof entryDay === 'number' ? entryDay : entry?.day);
  if (!resolvedDay) {
    showDesignError('Pick a calendar day first', 'Select a post and try again.');
    return;
  }
  const buttonLabel = triggerButton?.textContent;
  if (triggerButton) {
    triggerButton.disabled = true;
    triggerButton.textContent = 'Preparing…';
  }
  try {
    const currentUserId = activeUserEmail || (await getCurrentUser());
    if (!currentUserId) {
      window.location.href = '/auth.html?mode=signup';
      return;
    }
    const userIsPro = cachedUserIsPro || (await isPro(currentUserId));
    if (!userIsPro) {
      showUpgradeModal();
      return;
    }
    cachedUserIsPro = true;
    const context = buildAssetContextFromEntry(entry, resolvedDay);
    openGenerateAssetModal(context);
  } finally {
    if (triggerButton) {
      triggerButton.disabled = false;
      triggerButton.textContent = buttonLabel || 'Generate Asset';
    }
  }
}

function getDesignAssetById(assetId) {
  return designAssets.find((item) => String(item.id) === String(assetId));
}

function applyAssetEditorFormValues(asset) {
  if (!asset) return;
  asset.title = assetEditorTitleInput?.value?.trim() || '';
  asset.subtitle = assetEditorSubtitleInput?.value?.trim() || '';
  asset.cta = assetEditorCtaInput?.value?.trim() || '';
  const notesForAi = assetEditorNotesInput?.value?.trim() || '';
  asset.notes = notesForAi;
  asset.notesForAi = notesForAi;
  asset.notes_for_ai = notesForAi;
  asset.previewText = asset.title || asset.subtitle || asset.previewText || '';
  asset.lastEdited = new Date().toISOString();
  asset.data = asset.data || {};
  asset.data.title = asset.title;
  asset.data.subtitle = asset.subtitle;
  asset.data.cta = asset.cta;
  asset.data.notes = asset.data.notes ?? notesForAi;
  asset.data.notes_for_ai = notesForAi;
}

function openAssetEditorModal(asset) {
  if (!assetEditorModal || !asset) return;
  currentDesignAsset = asset;
  if (assetEditorTitle) assetEditorTitle.textContent = asset.title || asset.name || 'Edit Asset';
  if (assetEditorTitleInput) assetEditorTitleInput.value = asset.data?.title || asset.title || '';
  if (assetEditorSubtitleInput) assetEditorSubtitleInput.value = asset.data?.subtitle || asset.subtitle || '';
  if (assetEditorCtaInput) assetEditorCtaInput.value = asset.data?.cta || asset.cta || '';
  if (assetEditorNotesInput) {
    const notesForAi =
      asset.data?.notes_for_ai ??
      asset.data?.notes ??
      asset.notesForAi ??
      asset.notes ??
      '';
    assetEditorNotesInput.value = notesForAi;
  }
  const previewSource = asset.previewInlineUrl || asset.previewUrl || asset.image_url || asset.cloudinaryUrl || '';
  if (previewSource && assetEditorPreviewImage) {
    assetEditorPreviewImage.src = previewSource;
    assetEditorPreviewImage.style.display = 'block';
    if (assetEditorPreviewPlaceholder) assetEditorPreviewPlaceholder.style.display = 'none';
  } else {
    if (assetEditorPreviewImage) {
      assetEditorPreviewImage.removeAttribute('src');
      assetEditorPreviewImage.style.display = 'none';
    }
    if (assetEditorPreviewPlaceholder) {
      assetEditorPreviewPlaceholder.style.display = 'flex';
      const statusKey = String(asset.status || '').toLowerCase();
      if (statusKey === 'failed') {
        assetEditorPreviewPlaceholder.textContent = getDesignFailureMessage(asset);
      } else if (statusKey === 'rendering' || statusKey === 'queued') {
        assetEditorPreviewPlaceholder.textContent = 'Rendering in progress. This may take a moment.';
      } else {
        assetEditorPreviewPlaceholder.textContent = 'Preview will appear after generation.';
      }
    }
  }
  if (assetEditorStatus) {
    const statusKey = String(asset.status || '').toLowerCase();
    if (statusKey === 'ready') {
      assetEditorStatus.textContent = 'Ready to export';
    } else if (statusKey === 'rendering' || statusKey === 'queued') {
      assetEditorStatus.textContent = 'Rendering…';
    } else if (statusKey === 'failed') {
      assetEditorStatus.textContent = getDesignFailureMessage(asset);
    } else {
      assetEditorStatus.textContent = '';
    }
  }
  assetEditorModal.classList.remove('modal--hidden');
  assetEditorModal.setAttribute('aria-hidden', 'false');
  assetEditorModal.focus();
}

function closeAssetEditorModal() {
  if (!assetEditorModal) return;
  if (assetEditorModal.contains(document.activeElement)) {
    document.activeElement.blur();
  }
  assetEditorModal.classList.add('modal--hidden');
  assetEditorModal.setAttribute('aria-hidden', 'true');
  currentDesignAsset = null;
}

function bindCalendarGenerateAssetClicks() {
  if (!DESIGN_FEATURES_ENABLED) return;
  const grid = document.getElementById('calendar-grid');
  if (!grid) {
    // Not on calendar page; nothing to bind.
    return;
  }
  grid.addEventListener('click', (event) => {
    const button = event.target.closest('[data-action="calendar-generate-asset"]');
    if (!button) return;
    event.preventDefault();
    const entryEl = button.closest('.calendar-card__entry');
    const card = button.closest('.calendar-card');
    const dayValue = Number(
      button.dataset.calendarDay ||
        entryEl?.dataset.day ||
        card?.dataset.day
    );
    if (!dayValue) {
      alert('Unable to determine which day to generate. Please try again.');
      return;
    }
    const entryIndex = Number(entryEl?.dataset.entryIndex || 0);
    const calendarEntry = findPostByDay(dayValue);
    let baseEntry = calendarEntry || null;
    if (Array.isArray(calendarEntry?.multiPosts) && calendarEntry.multiPosts.length) {
      baseEntry = calendarEntry.multiPosts[entryIndex] || calendarEntry;
    }
    if (!baseEntry) {
      console.warn('[Promptly] Unable to locate calendar entry for day', dayValue);
      return;
    }
    const resolvedCalendarDayId =
      button.dataset.calendarDayId ||
      card?.dataset.calendarDayId ||
      baseEntry?.calendar_day_id ||
      baseEntry?.calendarDayId ||
      baseEntry?.id ||
      null;
    const contextEntry = {
      ...baseEntry,
      calendarDayId: resolvedCalendarDayId || buildCalendarDayIdentifier(baseEntry, dayValue),
      calendar_day_id: resolvedCalendarDayId || undefined,
    };
    console.log('[Promptly] Calendar Generate Asset button clicked', {
      day: dayValue,
      calendarDayId: contextEntry.calendarDayId,
    });
    beginGenerateAssetFlow(contextEntry, dayValue, button).catch((err) => {
      console.error('Generate Asset flow failed', err);
    });
  });
}

function buildAssetEditorPatchPayload(regenerate = false) {
  const notesValue = assetEditorNotesInput?.value?.trim() || '';
  return {
    data: {
      title: assetEditorTitleInput?.value?.trim() || '',
      subtitle: assetEditorSubtitleInput?.value?.trim() || '',
      cta: assetEditorCtaInput?.value?.trim() || '',
      notes_for_ai: notesValue || null,
    },
    regenerate,
  };
}

async function persistAssetEditorChanges(regenerate = false) {
  if (!currentDesignAsset) return null;
  const payload = buildAssetEditorPatchPayload(regenerate);
  console.log('[Promptly] PATCH asset', currentDesignAsset.id, payload);
  const response = await fetchWithAuth(`/api/design-assets/${encodeURIComponent(currentDesignAsset.id)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  let json = null;
  try {
    json = await response.json();
  } catch (_) {
    json = {};
  }
  if (!response.ok) {
    if (json?.asset) {
      const erroredAsset = normalizeDesignAsset({ ...(json.asset || {}), origin: 'remote' });
      mergeDesignAsset(erroredAsset);
      currentDesignAsset = erroredAsset;
    }
    console.error('[Promptly] Asset update failed', { status: response.status, body: json });
    const error = new Error(
      json.error ||
        json.details ||
        (regenerate ? `asset_regenerate_failed_${response.status}` : `asset_update_failed_${response.status}`)
    );
    error.status = response.status;
    error.details = json.details || null;
    throw error;
  }
  const updatedAsset = normalizeDesignAsset({ ...(json.asset || json), origin: 'remote' });
  mergeDesignAsset(updatedAsset);
  currentDesignAsset = updatedAsset;
  return updatedAsset;
}

async function handleAssetEditorRegenerate() {
  if (!currentDesignAsset || !assetEditorRegenerateButton) return;
  try {
    assetEditorRegenerateButton.disabled = true;
    assetEditorRegenerateButton.textContent = 'Regenerating…';
    if (assetEditorSaveButton) {
      assetEditorSaveButton.disabled = true;
    }
    const updated = await persistAssetEditorChanges(true);
    if (assetEditorStatus) {
      assetEditorStatus.textContent = 'Rendering…';
    }
    if (assetEditorPreviewPlaceholder) {
      assetEditorPreviewPlaceholder.style.display = 'flex';
      assetEditorPreviewPlaceholder.textContent = 'Rendering in progress. This may take a moment.';
    }
    openAssetEditorModal(updated);
    showDesignSuccess('New version queued in Design Lab.');
  } catch (error) {
    console.error('Asset regenerate failed', error);
    alert(error?.message || 'Unable to regenerate asset right now.');
  } finally {
    assetEditorRegenerateButton.disabled = false;
    assetEditorRegenerateButton.textContent = 'Regenerate';
    if (assetEditorSaveButton) {
      assetEditorSaveButton.disabled = false;
    }
  }
  if (currentDesignAsset && (currentDesignAsset.status === 'queued' || currentDesignAsset.status === 'rendering')) {
    scheduleDesignAssetPoll(currentDesignAsset.id, 2500);
  }
}

async function handleAssetEditorSave() {
  if (!currentDesignAsset || !assetEditorSaveButton) return;
  const previousLabel = assetEditorSaveButton.textContent;
  try {
    assetEditorSaveButton.disabled = true;
    assetEditorSaveButton.textContent = 'Saving…';
    const updated = await persistAssetEditorChanges(false);
    openAssetEditorModal(updated);
    showDesignSuccess('Asset updated.');
  } catch (error) {
    console.error('Asset save failed', error);
    alert(error?.message || 'Unable to save asset right now.');
  } finally {
    assetEditorSaveButton.disabled = false;
    assetEditorSaveButton.textContent = previousLabel || 'Save';
  }
}

function handleAssetEditorDownload() {
  if (!currentDesignAsset) return;
  handleDesignAssetDownload(currentDesignAsset);
}

function applyAutofillDefaults(values = {}) {
  setAutofillField('concept', values.concept ?? (designConceptInput?.value || ''));
  setAutofillField('caption', values.caption ?? (designCaptionCueInput?.value || ''));
  setAutofillField('cta', values.cta ?? (designCtaInput?.value || ''));
}

function initializeDesignAutofillFields() {
  Object.entries(designAutofillMap).forEach(([field, config]) => {
    if (config.input) config.input.setAttribute('readonly', 'readonly');
    if (config.editBtn) {
      config.editBtn.addEventListener('click', () => toggleAutofillEditing(field));
    }
    if (config.input) {
      config.input.addEventListener('input', () => {
        if (config.wrapper?.classList.contains('is-editing') && config.display) {
          const fallback =
            (config.display.dataset && config.display.dataset.emptyLabel) || 'Tap Edit to add';
          config.display.textContent = config.input.value.trim() || fallback;
        }
      });
    }
    setAutofillField(field, config.input?.value || '');
  });
}

function setDesignNotesCollapsed(collapsed = true) {
  if (!designNotesPanel || !designNotesToggle) return;
  designNotesPanel.classList.toggle('is-open', !collapsed);
  designNotesPanel.classList.toggle('is-collapsed', collapsed);
  designNotesToggle.setAttribute('aria-expanded', (!collapsed).toString());
}

function setAssetDetailNotesCollapsed(collapsed = true) {
  if (!assetDetailNotesPanel || !assetDetailNotesToggle) return;
  const isCollapsed = Boolean(collapsed);
  assetDetailNotesPanel.classList.toggle('is-open', !isCollapsed);
  assetDetailNotesPanel.classList.toggle('is-collapsed', isCollapsed);
  if (isCollapsed) {
    assetDetailNotesPanel.style.maxHeight = '0px';
  } else {
    requestAnimationFrame(() => {
      const scrollHeight = assetDetailNotesPanel.scrollHeight || 0;
      assetDetailNotesPanel.style.maxHeight = `${scrollHeight}px`;
    });
  }
  assetDetailNotesToggle.setAttribute('aria-expanded', (!isCollapsed).toString());
}

initializeDesignAutofillFields();

function applyDesignViewMode(mode = 'grid') {
  designViewMode = mode === 'list' ? 'list' : 'grid';
  if (designViewGridBtn) {
    designViewGridBtn.classList.toggle('is-active', designViewMode === 'grid');
    designViewGridBtn.setAttribute('aria-pressed', String(designViewMode === 'grid'));
  }
  if (designViewListBtn) {
    designViewListBtn.classList.toggle('is-active', designViewMode === 'list');
    designViewListBtn.setAttribute('aria-pressed', String(designViewMode === 'list'));
  }
  if (designGrid) {
    designGrid.classList.toggle('design-assets-list--grid', designViewMode === 'grid');
    designGrid.classList.toggle('design-assets-list--list', designViewMode === 'list');
  }
  try {
    localStorage.setItem(DESIGN_VIEW_MODE_KEY, designViewMode);
  } catch {}
  renderDesignAssets();
}

function rememberActiveUserEmail(email = '') {
  if (typeof localStorage === 'undefined') return;
  if (email) {
    localStorage.setItem(LAST_USER_STORAGE_KEY, String(email).toLowerCase());
  } else {
    localStorage.removeItem(LAST_USER_STORAGE_KEY);
  }
}

function resolveStorageUserKey() {
  if (activeUserEmail) return String(activeUserEmail).toLowerCase();
  if (typeof localStorage !== 'undefined') {
    const cached = localStorage.getItem(LAST_USER_STORAGE_KEY);
    if (cached) return cached.toLowerCase();
  }
  return 'guest';
}

function getScopedStorageKey(prefix) {
  if (typeof localStorage === 'undefined') return null;
  return `${prefix}${resolveStorageUserKey()}`;
}

function persistDesignAssetsToStorage() {
  if (typeof localStorage === 'undefined' || designStorageDisabled) return;
  const key = getScopedStorageKey(DESIGN_ASSET_STORAGE_PREFIX);
  if (!key) return;
  try {
    const payload = JSON.stringify(designAssets.slice(0, 60).map(sanitizeAssetForStorage));
    localStorage.setItem(key, payload);
  } catch (err) {
    console.warn('Unable to persist design assets', err);
    if (err && err.name === 'QuotaExceededError') {
      designStorageDisabled = true;
    }
  }
}

function hydrateDesignAssetsFromStorage(force = false) {
  if (typeof localStorage === 'undefined') return;
  if (!force && Array.isArray(designAssets) && designAssets.length) return;
  const key = getScopedStorageKey(DESIGN_ASSET_STORAGE_PREFIX);
  if (!key) return;
  try {
    const raw = localStorage.getItem(key);
    if (!raw) {
      if (force) {
        designAssets = [];
        renderDesignAssets();
      }
      return;
    }
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return;
    designAssets = parsed.map((asset) => normalizeDesignAsset(asset));
    renderDesignAssets();
  } catch (err) {
    console.warn('Unable to hydrate design assets', err);
  }
}

function normalizeDesignAsset(asset = {}) {
  const normalized = { ...asset };
  normalized.id = String(normalized.id || Date.now());
  normalized.assetType = normalized.assetType || normalized.type || normalized.typeLabel || 'story';
  normalized.typeLabel = normalized.typeLabel || formatAssetTypeLabel(normalized.assetType);
  normalized.origin = normalized.origin || 'local';
  normalized.caption = normalized.caption || '';
  normalized.cta = normalized.cta || '';
  normalized.tone = normalized.tone || '';
  const normalizedNotes =
    normalized.notes_for_ai ??
    normalized.notesForAi ??
    normalized.notes ??
    normalized.data?.notes_for_ai ??
    normalized.data?.notes ??
    '';
  normalized.notes_for_ai = normalizedNotes || '';
  normalized.notesForAi = normalizedNotes || '';
  normalized.notes = normalized.notes || normalizedNotes || '';
  normalized.prompt = normalized.prompt || '';
  normalized.previewInlineUrl = normalized.previewInlineUrl || normalized.previewUrl || '';
  normalized.previewUrl = normalized.previewUrl || normalized.previewInlineUrl || '';
  normalized.campaign = normalized.campaign || '';
  normalized.calendarDayId = normalized.calendarDayId || '';
  normalized.cloudinaryPublicId = normalized.cloudinaryPublicId || '';
  normalized.image_url = normalized.image_url || normalized.cloudinaryUrl || '';
  normalized.cloudinaryUrl = normalized.cloudinaryUrl || normalized.image_url || '';
  if (!normalized.previewInlineUrl && (normalized.cloudinaryUrl || normalized.image_url)) {
    normalized.previewInlineUrl = normalized.cloudinaryUrl || normalized.image_url;
  }
  if (!normalized.previewUrl && (normalized.cloudinaryUrl || normalized.image_url)) {
    normalized.previewUrl = normalized.cloudinaryUrl || normalized.image_url;
  }
  normalized.data = normalized.data || null;
  if (normalized.data) {
    const notesForAi = normalized.data.notes_for_ai ?? normalizedNotes ?? '';
    normalized.data.notes_for_ai = notesForAi;
    if (normalized.data.notes === undefined) {
      normalized.data.notes = notesForAi;
    }
  }
  normalized.linkedDay = normalized.linkedDay || normalized.day || null;
  normalized.day = normalized.linkedDay || normalized.day || null;
  if (!normalized.linkedDayLabel) {
    normalized.linkedDayLabel = normalized.linkedDay
      ? `Day ${String(normalized.linkedDay).padStart(2, '0')}`
      : 'Unassigned';
  }
  if (!normalized.monthLabel && normalized.createdAt) {
    normalized.monthLabel = formatDesignAssetMonth(normalized.createdAt) || 'This Month';
  }
  normalized.designUrl = normalized.designUrl || `/design.html?asset=${encodeURIComponent(normalized.id)}`;
  normalized.previewText = normalized.previewText || normalized.title || 'AI asset ready to download';
  normalized.status = normalized.status || 'draft';
  normalized.createdAt = normalized.createdAt || new Date().toISOString();
  normalized.slides = normalizeSlides(normalized.slides);
  const descriptor = buildAssetPreviewDescriptor(normalized);
  normalized.previewType = descriptor.kind;
  if (descriptor.kind !== 'text' && !normalized.previewInlineUrl) {
    normalized.previewInlineUrl = descriptor.url;
  }
  if (descriptor.kind === 'text' && !normalized.previewText) {
    normalized.previewText = descriptor.text;
  }
  return normalized;
}

async function getSupabaseAccessToken() {
  try {
    const { data } = await supabase.auth.getSession();
    return data?.session?.access_token || null;
  } catch (error) {
    console.warn('Unable to resolve Supabase session token', error);
    return null;
  }
}

async function fetchWithAuth(path, options = {}, tokenOverride = null) {
  const token = tokenOverride || (await getSupabaseAccessToken());
  if (!token) {
    const err = new Error('Sign in required');
    err.status = 401;
    throw err;
  }
  const headers = new Headers(options.headers || {});
  if (options.body && !(options.body instanceof FormData) && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }
  headers.set('Authorization', `Bearer ${token}`);
  const finalOptions = { ...options, headers };
  return fetch(path, finalOptions);
}

async function deleteCalendarById(calendarId) {
  if (!calendarId) throw new Error('No calendar id provided');
  const response = await fetchWithAuth(`/api/calendars/${encodeURIComponent(calendarId)}`, {
    method: 'DELETE',
  });
  if (!response.ok) {
    const detail = await response.json().catch(() => ({}));
    const message = detail?.error || `Unable to delete calendar (status ${response.status})`;
    const error = new Error(message);
    error.status = response.status;
    throw error;
  }
  console.log('[Promptly] Calendar deleted', { calendarId });
}

async function deleteCalendarByIdIfPossible(calendarId) {
  if (!calendarId) {
    console.log('[Promptly] No calendar id to delete on backend, skipping server delete.');
    return;
  }
  try {
    await deleteCalendarById(calendarId);
  } catch (error) {
    console.warn('[Promptly] Backend calendar delete failed (non-blocking)', error?.message || error);
  }
}

function mergeDesignAsset(asset, options = {}) {
  if (!asset || !asset.id) return;
  const normalized = normalizeDesignAsset(asset);
  const index = designAssets.findIndex((existing) => String(existing.id) === String(normalized.id));
  if (index >= 0) {
    designAssets[index] = { ...designAssets[index], ...normalized };
  } else {
    designAssets.unshift(normalized);
  }
  const normalizedStatus = String(normalized.status || '').toLowerCase();
  if (normalizedStatus === 'rendering' || normalizedStatus === 'queued') {
    scheduleDesignAssetPoll(normalized.id, 3000);
  }
  if (!options.skipPersist) {
    persistDesignAssetsToStorage();
  }
  if (options.linkToCalendar !== false) {
    linkAssetToCalendarPost(normalized);
  }
  renderDesignAssets();
}

async function refreshDesignAssetById(assetId) {
  if (!assetId) return;
  try {
    const response = await fetchWithAuth(`/api/design-assets/${encodeURIComponent(assetId)}`, { method: 'GET' });
    if (response.status === 501) {
      designAssetsApiDisabled = true;
      console.warn('Design asset detail API unavailable.');
      return;
    }
    if (!response.ok) return;
    const asset = await response.json();
    if (asset && asset.id) {
      asset.origin = 'remote';
      mergeDesignAsset(asset);
      const statusKey = String(asset.status || '').toLowerCase();
      if (statusKey === 'rendering' || statusKey === 'queued') {
        scheduleDesignAssetPoll(asset.id);
      } else {
        designAssetPollTimers.delete(asset.id);
      }
    }
  } catch (error) {
    if (error?.status === 401) {
      return;
    }
    if (error?.status === 501) {
      designAssetsApiDisabled = true;
      console.warn('Design asset detail API unavailable.');
      return;
    }
    console.warn('Unable to refresh design asset', error);
    const existing = designAssets.find((item) => String(item.id) === String(assetId));
    if (existing && (existing.status === 'rendering' || existing.status === 'queued')) {
      existing.status = 'failed';
      existing.previewText = 'This asset could not be rendered.';
      renderDesignAssets();
    }
  }
}

function scheduleDesignAssetPoll(assetId, delay = 5000) {
  if (!assetId || designAssetPollTimers.has(assetId)) return;
  let attempt = 0;
  const runPoll = () => {
    attempt += 1;
    designAssetPollTimers.delete(assetId);
    refreshDesignAssetById(assetId).finally(() => {
      if (attempt >= MAX_DESIGN_POLL_ATTEMPTS) {
        const pending = designAssets.find((asset) => String(asset.id) === String(assetId));
        if (pending && (pending.status === 'rendering' || pending.status === 'queued')) {
          pending.status = 'failed';
          pending.previewText = 'Rendering timed out. Try regenerating in Design Lab.';
          renderDesignAssets();
        }
        return;
      }
      const timer = setTimeout(runPoll, delay);
      designAssetPollTimers.set(assetId, timer);
    });
  };
  const timer = setTimeout(runPoll, delay);
  designAssetPollTimers.set(assetId, timer);
}

async function refreshDesignAssetsFromServer(filters = {}) {
  if (!designWorkspaceEnabled && !designSection) return;
  if (designAssetsApiDisabled) return;
  if (isFetchingDesignAssets) return;
  isFetchingDesignAssets = true;
  try {
    const params = new URLSearchParams();
    if (filters.calendarDayId) params.set('calendarDayId', filters.calendarDayId);
    if (filters.type) params.set('type', filters.type);
    const suffix = params.toString() ? `?${params.toString()}` : '';
    const response = await fetchWithAuth(`/api/design-assets${suffix}`, { method: 'GET' });
    if (response.status === 501) {
      console.warn('Design asset API unavailable on this environment. Skipping remote assets.');
      designAssetsApiDisabled = true;
      return;
    }
    if (!response.ok) {
      console.warn('Design assets API error', response.status);
      return;
    }
    const data = await response.json();
    const remoteAssets = Array.isArray(data) ? data.map((asset) => ({ ...asset, origin: 'remote' })) : [];
    const localAssets = designAssets.filter((asset) => asset && asset.origin === 'local');
    designAssets = [...remoteAssets.map((asset) => normalizeDesignAsset(asset)), ...localAssets];
    remoteAssets.forEach((asset) => {
      const statusKey = String(asset.status || '').toLowerCase();
      if (asset.id && (statusKey === 'rendering' || statusKey === 'queued')) {
        scheduleDesignAssetPoll(asset.id, 2500);
      }
    });
    persistDesignAssetsToStorage();
    renderDesignAssets();
    let calendarUpdated = false;
    remoteAssets.forEach((asset) => {
      if (linkAssetToCalendarPost(asset, { silent: true })) {
        calendarUpdated = true;
      }
    });
    if (calendarUpdated) {
      renderCards(currentCalendar);
      persistCurrentCalendarState();
    }
  } catch (error) {
    if (error?.status === 401) {
      return;
    }
    if (error?.status === 501) {
      designAssetsApiDisabled = true;
      console.warn('Design asset API unavailable on this environment.');
      return;
    }
    console.warn('Unable to fetch design assets from server', error);
  } finally {
    isFetchingDesignAssets = false;
  }
}

function ingestFocusAssetSnapshot() {
  if (typeof sessionStorage === 'undefined') return;
  let encoded = null;
  try {
    encoded = sessionStorage.getItem('promptly_focus_asset');
  } catch (err) {
    encoded = null;
  }
  if (!encoded) return;
  try {
    sessionStorage.removeItem('promptly_focus_asset');
  } catch {}
  try {
    let payload = encoded;
    try {
      payload = decodeURIComponent(encoded);
    } catch (_) {}
    const snapshot = JSON.parse(payload);
    if (snapshot && snapshot.id) {
      mergeDesignAssetSnapshot(snapshot);
    }
  } catch (err) {
    console.warn('Unable to ingest focus asset', err);
  }
}

function mergeDesignAssetSnapshot(snapshot) {
  if (!snapshot || !snapshot.id) return;
  snapshot.origin = snapshot.origin || 'local';
  mergeDesignAsset(snapshot);
  highlightDesignAssetId = String(snapshot.id);
  pendingAssetDetailId = String(snapshot.id);
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error || new Error('Failed to read blob'));
    reader.readAsDataURL(blob);
  });
}

async function ensureAssetInlinePreview(asset) {
  if (!asset) return asset;
  if (!asset.previewInlineUrl && Array.isArray(asset.slides) && asset.slides.length) {
    const firstSlide = normalizeSlides(asset.slides)[0];
    if (firstSlide?.previewUrl) {
      asset.previewInlineUrl = firstSlide.previewUrl;
      return asset;
    }
  }
  if (asset.previewInlineUrl) return asset;
  const ext = getAssetExtension(asset);
  if (!['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'].includes(ext)) return asset;
  try {
    let blob = asset.fileBlob || null;
    if (!blob && asset.downloadUrl) {
      const resp = await fetch(asset.downloadUrl);
      if (!resp.ok) return asset;
      blob = await resp.blob();
    }
    if (!blob) return asset;
    const dataUrl = await blobToDataUrl(blob);
    asset.previewInlineUrl = dataUrl;
  } catch (err) {
    console.warn('Inline preview capture failed', err);
  }
  return asset;
}

hydrateDesignAssetsFromStorage();
populateAssetDetailTemplateOptions();
updateAssetDetailTemplateShortcut();
ingestFocusAssetSnapshot();

function currentMonthToken() {
  const now = new Date();
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
}

function designUsageKey(userId) {
  const normalized = (userId || resolveStorageUserKey() || 'guest').toLowerCase();
  return `${DESIGN_USAGE_STORAGE_PREFIX}${normalized}`;
}

function loadDesignUsage(userId) {
  if (typeof localStorage === 'undefined') return { month: currentMonthToken(), count: 0 };
  const key = designUsageKey(userId);
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return { month: currentMonthToken(), count: 0 };
    const parsed = JSON.parse(raw);
    if (!parsed || parsed.month !== currentMonthToken()) {
      return { month: currentMonthToken(), count: 0 };
    }
    return { month: parsed.month, count: Number(parsed.count) || 0 };
  } catch {
    return { month: currentMonthToken(), count: 0 };
  }
}

function persistDesignUsage(userId, record) {
  if (typeof localStorage === 'undefined') return;
  const key = designUsageKey(userId);
  try {
    localStorage.setItem(key, JSON.stringify({ month: record.month, count: record.count }));
  } catch (err) {
    console.warn('Unable to persist design usage', err);
  }
}

function getBrandPaletteDefaults() {
  const palette = currentBrandKit || {};
  const heading = brandHeadingFontInput?.value || palette.headingFont || '';
  const body = brandBodyFontInput?.value || palette.bodyFont || '';
  return {
    primaryColor: palette.primaryColor || '#7f5af0',
    secondaryColor: palette.secondaryColor || '#2cb1bc',
    accentColor: palette.accentColor || '#ff7ac3',
    headingFont: heading || 'Inter Bold',
    bodyFont: body || 'Source Sans Pro',
  };
}

function getRemainingDesignQuota(userId) {
  const usage = loadDesignUsage(userId);
  return Math.max(0, DESIGN_FREE_MONTHLY_QUOTA - usage.count);
}

function incrementDesignUsage(userId) {
  const usage = loadDesignUsage(userId);
  usage.month = currentMonthToken();
  usage.count = (usage.count || 0) + 1;
  persistDesignUsage(userId, usage);
  return Math.max(0, DESIGN_FREE_MONTHLY_QUOTA - usage.count);
}

function normalizeAssetTypeKey(value = '') {
  const raw = String(value || '').toLowerCase();
  if (!raw) return '';
  if (raw.includes('carousel')) return 'carousel';
  if (raw.includes('story')) return 'story';
  if (raw.includes('graphic') || raw.includes('post') || raw.includes('social')) return 'story';
  return raw.replace(/\s+/g, '_');
}

function buildEntryFromAsset(asset = {}) {
  const data = asset.data || {};
  return {
    idea: asset.title || '',
    title: asset.title || '',
    caption: asset.subtitle || data.story_copy || '',
    description: asset.subtitle || '',
    cta: asset.cta || '',
    heroImage: data.background_image || asset.previewInlineUrl || asset.previewUrl || '',
    campaign: asset.campaign || '',
    tone: asset.tone || '',
    format: asset.assetType || asset.type || '',
    prompt: data.prompt || asset.prompt || '',
  };
}

function applyDesignFilters(list = []) {
  return list.filter((asset) => {
    if (!asset) return false;
    const normalizedType = normalizeAssetTypeKey(asset.assetType || asset.type || asset.typeLabel || asset.data?.type);
    const allowedTypes = ['story', 'carousel'];
    if (normalizedType && !allowedTypes.includes(normalizedType)) {
      return false;
    }
    const searchTerm = (designFilterState.search || '').trim().toLowerCase();
    const typeFilter = designFilterState.type;
    if (typeFilter && typeFilter !== 'all') {
      const assetTypeKey = normalizedType;
      if (assetTypeKey !== typeFilter) return false;
    }
    const dayFilter = designFilterState.day;
    if (dayFilter && dayFilter !== 'all') {
      const assetDay = Number(asset.linkedDay || asset.day);
      if (String(assetDay || '') !== String(dayFilter)) return false;
    }
    const campaignFilter = designFilterState.campaign;
    if (campaignFilter && campaignFilter !== 'all') {
      if ((asset.campaign || '') !== campaignFilter) return false;
    }
    const toneFilter = designFilterState.tone;
    if (toneFilter && toneFilter !== 'all') {
      if ((asset.tone || '') !== toneFilter) return false;
    }
    const monthFilter = designFilterState.month;
    if (monthFilter && monthFilter !== 'all') {
      const createdAt = asset.createdAt || '';
      const month = createdAt ? String(createdAt).slice(0, 7) : '';
      if (month !== monthFilter) return false;
    }
    if (searchTerm) {
      const haystack = (asset.title || '').toLowerCase();
      if (!haystack.includes(searchTerm)) return false;
    }
    return true;
  });
}

function refreshDesignDayFilterOptions() {
  if (!designFilterDay) return;
  const previous = designFilterState.day;
  const days = Array.from(
    new Set(
      designAssets
        .map((asset) => Number(asset?.linkedDay || asset?.day))
        .filter((day) => Number.isFinite(day) && day > 0)
    )
  ).sort((a, b) => a - b);
  const options = [
    '<option value="all">All days</option>',
    ...days.map((day) => `<option value="${day}">Day ${String(day).padStart(2, '0')}</option>`),
  ].join('');
  designFilterDay.innerHTML = options;
  if (previous !== 'all' && days.some((day) => String(day) === String(previous))) {
    designFilterDay.value = previous;
  } else {
    designFilterDay.value = 'all';
    designFilterState.day = 'all';
  }
}

function refreshDesignCampaignFilterOptions() {
  if (!designFilterCampaign) return;
  const previous = designFilterState.campaign;
  const campaigns = Array.from(
    new Set(
      designAssets
        .map((asset) => (asset.campaign || '').trim())
        .filter(Boolean)
    )
  ).sort();
  const options = [
    '<option value="all">All campaigns</option>',
    ...campaigns.map((name) => `<option value="${escapeHtml(name)}">${escapeHtml(name)}</option>`),
  ].join('');
  designFilterCampaign.innerHTML = options;
  if (previous && previous !== 'all' && campaigns.includes(previous)) {
    designFilterCampaign.value = previous;
  } else {
    designFilterCampaign.value = 'all';
    designFilterState.campaign = 'all';
  }
}

function refreshDesignMonthFilterOptions() {
  if (!designFilterMonth) return;
  const previous = designFilterState.month;
  const months = Array.from(
    new Set(
      designAssets
        .map((asset) => (asset.createdAt || '').slice(0, 7))
        .filter((month) => month && month.includes('-'))
    )
  ).sort().reverse();
  const options = [
    '<option value="all">Any time</option>',
    ...months.map((month) => `<option value="${month}">${month}</option>`),
  ].join('');
  designFilterMonth.innerHTML = options;
  if (previous && previous !== 'all' && months.includes(previous)) {
    designFilterMonth.value = previous;
  } else {
    designFilterMonth.value = 'all';
    designFilterState.month = 'all';
  }
}
const ASSET_PRESETS = {
  education: {
    assetType: 'carousel',
    tone: 'bold',
    note: 'Infographic flow with labeled data points and icon callouts.'
  },
  lifestyle: {
    assetType: 'story',
    tone: 'playful',
    note: 'Photo-first layout with candid lifestyle prompts and overlay captions.'
  },
  promotion: {
    assetType: 'story',
    tone: 'bold',
    note: 'Product mockup spotlight with price badge and urgent CTA ribbon.'
  },
  'social proof': {
    assetType: 'story',
    tone: 'elegant',
    note: 'Testimonial card featuring quote, avatar placeholder, and star accents.'
  }
};
const TYPE_TO_PILLAR = {
  educational: 'education',
  promotional: 'promotion',
  lifestyle: 'lifestyle',
  interactive: 'lifestyle'
};

function normalizePillar(entry = {}) {
  const rawPillar = String(entry.pillar || '').toLowerCase().trim();
  if (rawPillar && ASSET_PRESETS[rawPillar]) return rawPillar;
  const typeKey = TYPE_TO_PILLAR[String(entry.type || '').toLowerCase().trim()];
  if (typeKey && ASSET_PRESETS[typeKey]) return typeKey;
  const fallback = rawPillar || typeKey || '';
  return fallback;
}

function deriveAssetPreset(entry = {}) {
  const pillarKey = normalizePillar(entry);
  let preset = pillarKey && ASSET_PRESETS[pillarKey] ? ASSET_PRESETS[pillarKey] : null;
  if (!preset) {
    const format = String(entry.format || '').toLowerCase();
    if (format.includes('story')) {
      preset = { assetType: 'story', tone: 'playful', note: 'Story-friendly vertical layout with photo prompts and sticker callouts.' };
    } else if (format.includes('reel') || format.includes('video')) {
      preset = { assetType: 'carousel', tone: 'bold', note: 'Turn video beats into a carousel storyboard with hook, proof, and CTA slides.' };
    }
  }
  if (!preset) {
    preset = { assetType: 'story', tone: 'bold', note: 'High-contrast CTA graphic anchored by branded gradients.' };
  }
  return preset;
}

function buildAutoNotes(entry = {}, preset = {}) {
  const parts = [];
  if (preset.note) parts.push(preset.note);
  const idea = entry.idea || entry.title;
  if (idea) parts.push(`Concept: ${idea}`);
  if (entry.caption) {
    const safeCaption = entry.caption.replace(/\s+/g, ' ').trim();
    parts.push(`Caption cue: ${safeCaption}`);
  }
  if (entry.cta) parts.push(`CTA: ${entry.cta}`);
  if (entry.designNotes) parts.push(`Existing notes: ${entry.designNotes}`);
  if (entry.storyPrompt) parts.push(`Story prompt: ${entry.storyPrompt}`);
  if (currentBrandKit) {
    const palette = [currentBrandKit.primaryColor, currentBrandKit.secondaryColor, currentBrandKit.accentColor].filter(Boolean).join(', ');
    if (palette) parts.push(`Brand palette: ${palette}`);
    const fonts = [currentBrandKit.headingFont, currentBrandKit.bodyFont].filter(Boolean).join(' / ');
    if (fonts) parts.push(`Fonts: ${fonts}`);
    if (currentBrandKit.logoDataUrl) parts.push('Reserve safe space for brand logo in a corner.');
  }
  return parts.filter(Boolean).join('\n');
}

function showDesignError(message = 'Unable to generate asset', detail = '') {
  if (!designFeedbackEl) return;
  const formattedDetail =
    detail && !String(detail).includes(String(message)) ? ` ${String(detail)}` : '';
  designFeedbackEl.textContent = `${message}${formattedDetail || ''}`;
  designFeedbackEl.classList.remove('success');
  designFeedbackEl.classList.add('error');
}

function showDesignSuccess(message = '') {
  if (!designFeedbackEl) return;
  designFeedbackEl.textContent = message;
  designFeedbackEl.classList.remove('error');
  if (message) {
    designFeedbackEl.classList.add('success');
  } else {
    designFeedbackEl.classList.remove('success');
  }
}

function clearDesignFeedback() {
  if (!designFeedbackEl) return;
  designFeedbackEl.textContent = '';
  designFeedbackEl.classList.remove('success');
  designFeedbackEl.classList.remove('error');
}

function loadDesignTemplates() {
  if (typeof localStorage === 'undefined') return [];
  try {
    const raw = localStorage.getItem(DESIGN_TEMPLATE_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    const userTemplates = Array.isArray(parsed)
      ? parsed
          .filter(Boolean)
          .map((tpl) => ({
            ...tpl,
            previewInlineUrl: tpl.previewInlineUrl || '',
            category: tpl.category || TEMPLATE_CATEGORY_MAP[tpl.assetType] || 'Saved Templates',
            tags: Array.isArray(tpl.tags) ? tpl.tags : (tpl.tone ? [tpl.tone] : []),
          }))
      : [];
    return [...BUILT_IN_TEMPLATES, ...userTemplates];
  } catch (error) {
    console.warn('Unable to load saved templates', error);
    return [...BUILT_IN_TEMPLATES];
  }
}

function persistDesignTemplates() {
  if (typeof localStorage === 'undefined') return;
  try {
    const userTemplates = designTemplates.filter((tpl) => !BUILT_IN_TEMPLATE_IDS.has(String(tpl.id)));
    const payload = JSON.stringify(userTemplates.slice(0, 60));
    localStorage.setItem(DESIGN_TEMPLATE_STORAGE_KEY, payload);
  } catch (error) {
    console.warn('Unable to store templates', error);
  }
}

function applySidebarState(collapsed) {
  if (!appSidebar) return;
  appSidebar.classList.toggle('collapsed', collapsed);
  if (appLayout) appLayout.classList.toggle('sidebar-collapsed', collapsed);
  if (sidebarToggle) {
    sidebarToggle.setAttribute('aria-expanded', String(!collapsed));
  }
  try {
    localStorage.setItem(SIDEBAR_STORAGE_KEY, collapsed ? '1' : '0');
  } catch (_) {}
}

function initSidebar() {
  if (!appSidebar || !sidebarToggle) return;
  let collapsed = true;
  try {
    const stored = localStorage.getItem(SIDEBAR_STORAGE_KEY);
    if (stored === null) {
      collapsed = true;
      localStorage.setItem(SIDEBAR_STORAGE_KEY, '1');
    } else {
      collapsed = stored === '1';
    }
  } catch (_) {}
  applySidebarState(collapsed);
  sidebarToggle.addEventListener('click', () => {
    const next = !appLayout.classList.contains('sidebar-collapsed');
    applySidebarState(next);
  });
}

function inferAssetTypeFromAsset(asset = {}) {
  if (asset.assetType) return asset.assetType;
  if (asset.typeLabel) {
    return asset.typeLabel.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
  }
  return 'story';
}

async function handleDesignTemplateSave(asset) {
  if (!asset) return;
  await ensureAssetInlinePreview(asset);
  const defaultLabel = asset.title || formatAssetTypeLabel(inferAssetTypeFromAsset(asset));
  const labelInput = typeof window !== 'undefined'
    ? window.prompt('Name this layout template', defaultLabel || 'Template')
    : defaultLabel;
  const label = (labelInput || '').trim();
  if (!label) return;
  const template = {
    id: Date.now(),
    label,
    assetType: inferAssetTypeFromAsset(asset),
    tone: asset.tone || 'bold',
    notes: asset.notes || asset.brief || '',
    previewText: asset.previewText || asset.title || '',
    previewInlineUrl: asset.previewInlineUrl || asset.previewUrl || '',
    category: TEMPLATE_CATEGORY_MAP[inferAssetTypeFromAsset(asset)] || 'Saved Templates',
    tags: Array.from(
      new Set(
        [asset.tone, (asset.campaign || '').trim(), ...(Array.isArray(asset.tags) ? asset.tags : [])].filter(Boolean)
      )
    ),
    createdAt: new Date().toISOString(),
  };
  const lower = label.toLowerCase();
  designTemplates = [template, ...designTemplates.filter((item) => (item?.label || '').toLowerCase() !== lower)].slice(0, 40);
  persistDesignTemplates();
  if (!activeTemplateId) {
    activeTemplateId = String(template.id);
  }
  renderDesignTemplateOptions(activeTemplateId);
  if (activeTemplateId === String(template.id)) {
    applyDesignTemplateSelection(template.id);
  } else {
    updateDesignTemplateHint(activeTemplateId);
  }
  if (designFeedbackEl) {
    designFeedbackEl.textContent = `Template "${label}" saved.`;
    setTimeout(() => {
      if (designFeedbackEl && designFeedbackEl.textContent?.includes(label)) {
        designFeedbackEl.textContent = '';
      }
    }, 2000);
  }
}

function deleteDesignTemplate(templateId) {
  if (!templateId) return;
  if (BUILT_IN_TEMPLATE_IDS.has(String(templateId))) return;
  const beforeCount = designTemplates.length;
  designTemplates = designTemplates.filter((tpl) => String(tpl.id) !== String(templateId));
  if (designTemplates.length === beforeCount) return;
  if (String(activeTemplateId) === String(templateId)) {
    activeTemplateId = '';
    if (designTemplateSelect) designTemplateSelect.value = '';
    updateDesignTemplateHint('');
    renderDesignLivePreview();
  }
  persistDesignTemplates();
  updateTemplateShortcuts();
  renderDesignTemplateOptions(activeTemplateId);
  renderDesignTemplateGallery(activeTemplateId);
}

function renderDesignTemplateOptions(selectedId = '') {
  if (!designTemplateSelect) return;
  const options = designTemplates
    .map((tpl) => `<option value="${tpl.id}">${escapeHtml(tpl.label)}</option>`)
    .join('');
  designTemplateSelect.innerHTML = `<option value="">No template</option>${options}`;
  designTemplateSelect.disabled = designTemplates.length === 0;
  const targetId = selectedId || activeTemplateId;
  if (targetId && designTemplates.some((tpl) => String(tpl.id) === String(targetId))) {
    designTemplateSelect.value = String(targetId);
    activeTemplateId = String(targetId);
  } else {
    designTemplateSelect.value = '';
    if (targetId) activeTemplateId = '';
  }
  updateDesignTemplateHint(designTemplateSelect.value || '');
  renderDesignTemplateGallery(selectedId || designTemplateSelect.value || '');
  updateTemplateShortcuts();
  populateAssetDetailTemplateOptions(selectedId || '');
}

function updateDesignTemplateHint(templateId = '') {
  if (!designTemplateHint) return;
  if (templateId) {
    const tpl = designTemplates.find((item) => String(item?.id) === String(templateId));
    designTemplateHint.textContent = tpl
      ? `Locked to "${tpl.label}" until you clear it.`
      : 'Saved layouts ready to use.';
  } else if (designTemplates.length) {
    designTemplateHint.textContent = 'Choose a saved layout to keep structure consistent.';
  } else {
    designTemplateHint.textContent = 'Save a favorite layout from the Design Lab.';
  }
  if (designTemplateClearBtn) {
    designTemplateClearBtn.disabled = !templateId;
  }
}

function renderDesignTemplateGallery(selectedId = '') {
  if (!designTemplateGallery) return;
  if (!Array.isArray(designTemplates) || !designTemplates.length) {
    designTemplateGallery.innerHTML = `<p class="design-template-hint">No saved layouts yet.</p>`;
    return;
  }
  const grouped = {};
  designTemplates.forEach((tpl) => {
    const category = tpl.category || 'Saved Templates';
    if (!grouped[category]) grouped[category] = [];
    grouped[category].push(tpl);
  });
  const currentType = designAssetTypeInput?.value || '';
  designTemplateGallery.innerHTML = Object.entries(grouped)
    .map(([category, templates]) => {
      const cards = templates
        .map((tpl) => {
          const isActive = String(tpl.id) === String(selectedId || activeTemplateId);
          const recommended = currentType && tpl.assetType === currentType;
          const preview = tpl.previewInlineUrl
            ? `<img src="${escapeHtml(tpl.previewInlineUrl)}" alt="${escapeHtml(tpl.label)} preview" loading="lazy" />`
            : `<div class="design-template-card__preview-text">${escapeHtml(tpl.previewText || tpl.label)}</div>`;
          const tags = Array.isArray(tpl.tags)
            ? tpl.tags
                .map((tag) => `<span class="design-template-card__tag">${escapeHtml(tag)}</span>`)
                .join('')
            : '';
          const badge = recommended ? `<span class="design-template-card__badge">Recommended</span>` : '';
          return `
            <div class="design-template-card${isActive ? ' is-active' : ''}" data-template-id="${tpl.id}">
              <div class="design-template-card__preview">${preview}${badge}</div>
              <strong>${escapeHtml(tpl.label)}</strong>
              <span>${escapeHtml(formatAssetTypeLabel(tpl.assetType || ''))}</span>
              <div class="design-template-card__tags">${tags}</div>
              <div class="design-template-card__actions">
                <button type="button" class="ghost" data-template-action="apply" data-template-id="${tpl.id}">Use template</button>
                ${
                  BUILT_IN_TEMPLATE_IDS.has(String(tpl.id))
                    ? ''
                    : `<button type="button" class="ghost danger" data-template-action="delete" data-template-id="${tpl.id}">Delete</button>`
                }
              </div>
            </div>
          `;
        })
        .join('');
      return `
        <div class="design-template-section">
          <header class="design-template-section__head">
            <h4>${escapeHtml(category)}</h4>
          </header>
          <div class="design-template-section__grid">${cards}</div>
        </div>
      `;
    })
    .join('');
  designTemplateGallery.querySelectorAll('[data-template-action]').forEach((button) => {
    button.addEventListener('click', () => {
      const id = button.dataset.templateId;
      if (!id) return;
      const action = button.dataset.templateAction;
      if (action === 'apply') {
        applyDesignTemplateSelection(id);
      } else if (action === 'delete') {
        deleteDesignTemplate(id);
      }
    });
  });
  updateLastTemplateButtonThumbnail();
}

function populateAssetDetailTemplateOptions(selectedId = '') {
  if (!assetDetailTemplateSelect) return;
  const safeSelected = selectedId || assetDetailTemplateSelect.value || '';
  const options = designTemplates
    .map((tpl) => `<option value="${escapeHtml(tpl.id)}">${escapeHtml(tpl.label)}</option>`)
    .join('');
  assetDetailTemplateSelect.innerHTML = `<option value="">No template</option>${options}`;
  assetDetailTemplateSelect.disabled = designTemplates.length === 0;
  if (safeSelected && designTemplates.some((tpl) => String(tpl.id) === String(safeSelected))) {
    assetDetailTemplateSelect.value = String(safeSelected);
  } else {
    assetDetailTemplateSelect.value = '';
  }
  updateAssetDetailTemplateShortcut();
}

function updateAssetDetailTemplateShortcut() {
  if (!assetDetailUseLastTemplateBtn) return;
  const lastId = getLastTemplateId();
  const tpl = lastId ? designTemplates.find((item) => String(item.id) === String(lastId)) : null;
  assetDetailUseLastTemplateBtn.disabled = !tpl;
  assetDetailUseLastTemplateBtn.textContent = tpl ? `Use ${tpl.label}` : 'Use last template';
}

function applyDesignTemplateSelection(templateId) {
  const template = designTemplates.find((tpl) => String(tpl.id) === String(templateId));
  if (!template) return;
  activeTemplateId = String(template.id);
  rememberLastTemplate(activeTemplateId);
  if (designTemplateSelect && designTemplateSelect.value !== String(template.id)) {
    designTemplateSelect.value = String(template.id);
  }
  if (designAssetTypeInput && template.assetType) {
    const hasOption = Array.from(designAssetTypeInput.options || []).some((opt) => opt.value === template.assetType);
    if (!hasOption) {
      const opt = document.createElement('option');
      opt.value = template.assetType;
      opt.textContent = formatAssetTypeLabel(template.assetType);
      opt.dataset.dynamic = '1';
      designAssetTypeInput.appendChild(opt);
    }
    designAssetTypeInput.value = template.assetType;
  }
  if (designToneInput && template.tone) {
    const hasTone = Array.from(designToneInput.options || []).some((opt) => opt.value === template.tone);
    if (!hasTone) {
      const toneOpt = document.createElement('option');
      toneOpt.value = template.tone;
      toneOpt.textContent = template.tone.replace(/\b\w/g, (c) => c.toUpperCase());
      toneOpt.dataset.dynamic = '1';
      designToneInput.appendChild(toneOpt);
    }
    designToneInput.value = template.tone;
  }
  if (designNotesInput && template.notes) {
    designNotesInput.value = template.notes;
  }
  if (designNotesInput) {
    setDesignNotesCollapsed(!(designNotesInput.value || '').trim());
  }
  updateDesignTemplateHint(template.id);
  renderDesignTemplateGallery(template.id);
  renderDesignLivePreview();
}

function clearDesignTemplateSelection() {
  activeTemplateId = '';
  if (designTemplateSelect) designTemplateSelect.value = '';
  updateDesignTemplateHint('');
  renderDesignTemplateGallery('');
  updateTemplateShortcuts();
}

function prunePostForStorage(post = {}) {
  const clone = { ...post };
  if (Array.isArray(clone.assets)) {
    clone.assets = clone.assets.map(sanitizeAssetForStorage);
  }
  return clone;
}

function updateDesignSelectionUI() {
  const count = selectedDesignAssetIds.size;
  if (designSelectionCount) {
    designSelectionCount.textContent = `${count} selected`;
  }
  if (designExportSelectedBtn) designExportSelectedBtn.disabled = count === 0;
  if (designRegenerateSelectedBtn) designRegenerateSelectedBtn.disabled = count !== 1 || isDesignRegenerating;
}

function toggleDesignAssetSelection(assetId, isSelected) {
  const normalized = String(assetId ?? '').trim();
  if (!normalized) return;
  if (isSelected) selectedDesignAssetIds.add(normalized);
  else selectedDesignAssetIds.delete(normalized);
  updateDesignSelectionUI();
}

function handleDesignExportSelected() {
  if (!selectedDesignAssetIds.size) return;
  const ids = Array.from(selectedDesignAssetIds);
  ids.forEach((assetId) => {
    const asset = designAssets.find((item) => String(item.id) === String(assetId));
    if (!asset) return;
    asset.status = 'exported';
    asset.updatedAt = new Date().toISOString();
  });
  persistDesignAssetsToStorage();
  renderDesignAssets();
  showDesignSuccess('Assets exported (local preview). TODO: Hook real export flow.');
  setTimeout(() => clearDesignFeedback(), 2000);
}

function handleDesignRegenerateSelected() {
  if (isDesignRegenerating || selectedDesignAssetIds.size !== 1) return;
  const assetId = Array.from(selectedDesignAssetIds)[0];
  const asset = designAssets.find((item) => String(item.id) === String(assetId));
  if (!asset) return;
  const day = Number(asset.linkedDay || asset.day);
  if (!day) {
    showDesignError('Assign a day before regenerating.', '');
    return;
  }
  isDesignRegenerating = true;
  updateDesignSelectionUI();
  setDesignRegeneratingState(true);
  const entry = buildEntryFromAsset(asset);
  const assetTypeKey = normalizeAssetTypeKey(asset.assetType || asset.type || 'story');
  triggerCalendarAssetGeneration(entry, day, null, { type: assetTypeKey, suppressRedirect: true })
    .then(() => {
      showDesignSuccess('New version queued in Design Lab.');
      setTimeout(() => clearDesignFeedback(), 1800);
    })
    .catch((err) => {
      showDesignError('Unable to regenerate asset', err.message || 'Try again soon.');
    })
    .finally(() => {
      isDesignRegenerating = false;
      setDesignRegeneratingState(false);
      updateDesignSelectionUI();
    });
}

async function regenerateSingleDesignAsset(asset) {
  if (!asset) return;
  const day = Number(asset.linkedDay || asset.day);
  if (!day) throw new Error('Linked day is required to regenerate this asset.');
  const entry = buildEntryFromAsset(asset);
  const assetTypeKey = normalizeAssetTypeKey(asset.assetType || asset.type || 'story');
  return triggerCalendarAssetGeneration(entry, day, null, { type: assetTypeKey, suppressRedirect: true });
}

function deleteDesignAsset(asset, assetDay) {
  if (!asset) return;
  const confirmed = window.confirm('Delete this asset from both the Design Lab and its calendar day?');
  if (!confirmed) return;
  designAssets = designAssets.filter((item) => String(item.id) !== String(asset.id));
  const targetDay = assetDay || asset.linkedDay || asset.day;
  if (targetDay && Array.isArray(currentCalendar)) {
    const targetEntry = findPostByDay(targetDay);
    if (targetEntry && Array.isArray(targetEntry.assets)) {
      targetEntry.assets = targetEntry.assets.filter((item) => String(item.id) !== String(asset.id));
      renderCards(currentCalendar);
      persistCurrentCalendarState();
    }
  }
  persistDesignAssetsToStorage();
  renderDesignAssets();
  showDesignSuccess('Asset deleted.');
}

function hexToRgba(hex, alpha = 1) {
  if (!hex) return `rgba(127,90,240,${alpha})`;
  const normalized = hex.replace('#', '');
  const isShort = normalized.length === 3;
  if (![3, 6].includes(normalized.length)) return hex;
  const expand = (str) => (isShort ? str + str : str);
  const r = parseInt(expand(normalized.substring(0, isShort ? 1 : 2)), 16);
  const g = parseInt(expand(normalized.substring(isShort ? 1 : 2, isShort ? 2 : 4)), 16);
  const b = parseInt(expand(normalized.substring(isShort ? 2 : 4, isShort ? 3 : 6)), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function getPreviewTheme(tone = 'bold') {
  const palette = getBrandPaletteDefaults();
  const base = {
    from: palette.primaryColor || '#7f5af0',
    to: palette.accentColor || '#ff7ac3',
    textColor: '#f5f6f8',
    canvas: `linear-gradient(145deg, rgba(4,6,20,0.95), ${hexToRgba(palette.accentColor || '#ff7ac3', 0.2)})`,
  };
  const toneMap = {
    minimal: {
      from: hexToRgba(palette.secondaryColor || '#9ca3af', 0.45),
      to: 'rgba(8,12,20,0.9)',
      textColor: '#e2e8f0',
      canvas: `linear-gradient(140deg, rgba(4,6,18,0.96), ${hexToRgba(palette.secondaryColor || '#9ca3af', 0.25)})`,
    },
    playful: {
      from: palette.secondaryColor || '#2cb1bc',
      to: palette.accentColor || '#ff7ac3',
      textColor: '#181a27',
      canvas: `linear-gradient(150deg, rgba(6,8,20,0.94), ${hexToRgba(palette.secondaryColor || '#2cb1bc', 0.25)})`,
    },
    elegant: {
      from: '#0f0c29',
      to: palette.primaryColor || '#7f5af0',
      textColor: '#f7f3e9',
      canvas: `linear-gradient(150deg, rgba(6,6,14,0.97), ${hexToRgba(palette.primaryColor || '#7f5af0', 0.2)})`,
    },
  };
  const resolved = { ...base, ...(toneMap[tone] || {}) };
  return {
    ...resolved,
    headingFont: palette.headingFont || 'Inter Bold',
    bodyFont: palette.bodyFont || 'Source Sans Pro',
    logo: (currentBrandKit && (currentBrandKit.logoDataUrl || currentBrandKit.logoUrl)) || '',
  };
}

function buildPreviewLogo(theme) {
  if (!theme.logo) {
    return `<span class="design-preview__logo">Logo</span>`;
  }
  return `<span class="design-preview__logo"><img src="${escapeHtml(theme.logo)}" alt="Brand logo" /></span>`;
}

function buildPreviewMarkup(type, tone) {
  const typeKey = normalizeAssetTypeKey(type);
  const theme = getPreviewTheme(tone);
  const baseStyle = `background: linear-gradient(135deg, ${theme.from}, ${theme.to}); color: ${theme.textColor}; font-family: ${theme.headingFont}, 'Inter', sans-serif;`;
  const secondaryStyle = `background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.2); color: ${theme.textColor}; font-family: ${theme.bodyFont}, 'Source Sans Pro', sans-serif;`;
  const logo = buildPreviewLogo(theme);
  const storySlides = ['Hook', 'Proof/Tip', 'CTA'];
  if (typeKey === 'story') {
    const slides = storySlides
      .map((label, idx) => {
        const frameStyle = idx === 1 ? secondaryStyle : `${baseStyle} font-family: ${theme.bodyFont}, 'Source Sans Pro', sans-serif;`;
        return `<div class="design-preview__story-frame" style="${frameStyle}"><span class="design-preview__slide-label">Slide ${idx + 1}</span>${label}</div>`;
      })
      .join('');
    return {
      html: `<div class="design-preview__mock design-preview__story" style="font-family:${theme.bodyFont}, 'Source Sans Pro', sans-serif;">${logo}${slides}</div>`,
      background: theme.canvas,
    };
  }
  if (typeKey === 'carousel') {
    const slides = ['Hook', 'Proof', 'Tip', 'CTA']
      .map((text, idx) => {
        const style =
          idx % 2 === 0
            ? `${baseStyle} font-family:${theme.bodyFont}, 'Source Sans Pro', sans-serif;`
            : secondaryStyle;
        return `<div class="design-preview__carousel-slide" style="${style}"><span class="design-preview__slide-label">Slide ${idx + 1}</span>${text}</div>`;
      })
      .join('');
    return {
      html: `<div class="design-preview__mock design-preview__carousel" style="font-family:${theme.bodyFont}, 'Source Sans Pro', sans-serif;">${logo}${slides}</div>`,
      background: theme.canvas,
    };
  }
  const headlineFont = `${theme.headingFont}, 'Inter', sans-serif`;
  const bodyFont = `${theme.bodyFont}, 'Source Sans Pro', sans-serif`;
  return {
    html: `
      <div class="design-preview__mock">
        ${logo}
        <div class="design-preview__graphic" style="${baseStyle}">
          <strong style="font-family:${headlineFont};">Hook headline</strong>
          <p style="font-family:${bodyFont};">“Caption preview tied to your concept.”</p>
          <div style="border-radius:999px;border:1px solid rgba(255,255,255,0.6);padding:0.2rem 0.9rem;font-size:0.8rem;">CTA Button</div>
        </div>
      </div>
    `,
    background: theme.canvas,
  };
}

function renderDesignLivePreview() {
  if (!designPreviewEl) return;
  const type = designAssetTypeInput?.value || 'story';
  const tone = designToneInput?.value || 'bold';
  const preview = buildPreviewMarkup(type, tone);
  designPreviewEl.innerHTML = preview.html;
  if (preview.background) {
    designPreviewEl.style.background = preview.background;
  }
}

function buildAssetDetailBrandPreview(asset = {}) {
  const typeKey = normalizeAssetTypeKey(asset.assetType || asset.type || asset.typeLabel || inferAssetTypeFromAsset(asset) || 'story');
  const toneKey = asset.creativeDirection || asset.tone || 'bold';
  const theme = getPreviewTheme(toneKey || 'bold');
  const headingFont = `${theme.headingFont || 'Inter'}`;
  const bodyFont = `${theme.bodyFont || 'Source Sans Pro'}`;
  const headline = escapeHtml(asset.title || asset.caption || 'Ready-to-post hook');
  const caption = escapeHtml(asset.caption || 'Share one sharp insight or proof point here.');
  const cta = escapeHtml(asset.cta || 'Add CTA');
  const notes = escapeHtml(asset.notes || 'Add creative direction notes or animation cues.');
  const logoMarkup = theme.logo
    ? `<span class="asset-detail__brand-logo"><img src="${escapeHtml(theme.logo)}" alt="Brand logo" loading="lazy" /></span>`
    : `<span class="asset-detail__brand-logo">Logo</span>`;
  const gradient = `linear-gradient(135deg, ${theme.from}, ${theme.to})`;
  const subduedBg = 'rgba(255,255,255,0.05)';
  const slideWrapper = (label, text, accent = false, index = 0) => {
    const bg = accent ? gradient : subduedBg;
    const font = accent && index === 0 ? headingFont : bodyFont;
    return `
      <article class="asset-detail__brand-slide" style="background:${bg};font-family:${font}, 'Inter', sans-serif;">
        <span class="asset-detail__brand-slide-label">${label}</span>
        <p>${text}</p>
      </article>
    `;
  };
  const baseWrapper = (content) =>
    `<div class="asset-detail__brand-preview" data-preview-type="${typeKey}" style="background:${theme.canvas};">${logoMarkup}<div class="asset-detail__brand-preview-grid">${content}</div></div>`;
  if (typeKey === 'story') {
    const slides = [
      slideWrapper('Slide 01 • Hook', headline, true, 0),
      slideWrapper('Slide 02 • Proof/Tip', caption, false, 1),
      slideWrapper('Slide 03 • CTA', cta, true, 2),
    ].join('');
    return { html: baseWrapper(slides), background: theme.canvas };
  }
  if (typeKey === 'carousel') {
    const slides = [
      slideWrapper('Slide 01 • Hook', headline, true, 0),
      slideWrapper('Slide 02 • Value', caption, false, 1),
      slideWrapper('Slide 03 • Value', notes || caption, false, 2),
      slideWrapper('Slide 04 • Engagement', escapeHtml(asset.engagementPrompt || 'Prompt saves or replies.'), false, 3),
      slideWrapper('Slide 05 • CTA', cta, true, 4),
    ].join('');
    return { html: baseWrapper(slides), background: theme.canvas };
  }
  const detailCard = `
    <article class="asset-detail__brand-card" style="background:${gradient};color:${theme.textColor};font-family:${bodyFont}, 'Source Sans Pro', sans-serif;">
      ${logoMarkup}
      <p class="asset-detail__brand-preview-headline" style="font-family:${headingFont}, 'Inter', sans-serif;">${headline}</p>
      <p class="asset-detail__brand-preview-caption">${caption}</p>
      <span class="asset-detail__brand-preview-cta">${cta}</span>
    </article>
  `;
  const notesCard = `
    <div class="asset-detail__brand-meta" style="font-family:${bodyFont}, 'Source Sans Pro', sans-serif;">
      <span class="asset-detail__brand-meta-label">Notes</span>
      <p>${notes}</p>
    </div>
  `;
  return {
    html: `<div class="asset-detail__brand-preview" data-preview-type="${typeKey}" style="background:${theme.canvas};">${detailCard}${notesCard}</div>`,
    background: theme.canvas,
  };
}

function getActiveAssetDetailDraft() {
  if (!activeAssetDetailId) return null;
  const asset = designAssets.find((item) => String(item.id) === String(activeAssetDetailId));
  if (!asset) return null;
  const draft = { ...asset };
  draft.title = assetDetailHeadline?.value?.trim() || '';
  draft.caption = assetDetailCaption?.value?.trim() || '';
  draft.cta = assetDetailCta?.value?.trim() || '';
  draft.notes = assetDetailNotes?.value?.trim() || '';
  return draft;
}

function refreshAssetDetailPreviewFromForm(forceBrand = true) {
  const draft = getActiveAssetDetailDraft();
  if (!draft) return;
  renderAssetDetailPreview(draft, { forceBrandPreview: forceBrand });
}

async function openDesignAssetDetail(target) {
  const lookupId = typeof target === 'object' ? null : String(target ?? '').trim();
  const asset =
    typeof target === 'object'
      ? target
      : designAssets.find((item) => String(item.id) === lookupId);
  if (!asset || !assetDetailModal) return;
  activeAssetDetailId = asset.id;
  const typeLabel = formatAssetTypeLabel(asset.assetType || asset.typeLabel);
  const linkedDay = asset.linkedDay || asset.day;
  if (assetDetailTypeLabel) {
    assetDetailTypeLabel.textContent = typeLabel || 'Asset';
  }
  if (assetDetailDayLabel) {
    assetDetailDayLabel.textContent = linkedDay ? `Day ${String(linkedDay).padStart(2, '0')}` : 'Unassigned';
  }
  await ensureAssetInlinePreview(asset);
  renderAssetDetailPreview(asset);
  if (assetDetailHeadline) assetDetailHeadline.value = asset.title || asset.caption || '';
  if (assetDetailCaption) assetDetailCaption.value = asset.caption || '';
  if (assetDetailCta) assetDetailCta.value = asset.cta || '';
  if (assetDetailNotes) assetDetailNotes.value = asset.notes || '';
  if (assetDetailMeta) {
    const campaign = asset.campaign ? `Campaign: ${asset.campaign}` : '';
    assetDetailMeta.textContent = campaign || '';
  }
  if (assetDetailTimestamp) {
    assetDetailTimestamp.textContent = asset.lastEdited
      ? `Last edited ${new Date(asset.lastEdited).toLocaleString()}`
      : 'Not edited yet';
  }
  if (!asset.originalSnapshot) {
    asset.originalSnapshot = JSON.parse(JSON.stringify(sanitizeAssetForStorage(asset)));
  }
  setAssetDetailNotesCollapsed(!(assetDetailNotes?.value || '').trim());
  assetDetailModal.style.display = 'flex';
}

function renderAssetDetailPreview(asset, options = {}) {
  if (!assetDetailPreview) return;
  const descriptor = options.forceBrandPreview ? null : buildAssetPreviewDescriptor(asset);
  const shouldUseBrandPreview = options.forceBrandPreview || !descriptor || descriptor.kind === 'text';
  if (shouldUseBrandPreview) {
    const preview = buildAssetDetailBrandPreview(asset);
    assetDetailPreview.innerHTML = preview.html;
    assetDetailPreview.style.background = preview.background || 'rgba(7,9,26,0.92)';
  } else {
    let html = `<div class="design-preview__graphic" style="width:100%;height:100%;border-radius:12px;background:rgba(255,255,255,0.05);display:flex;align-items:center;justify-content:center;">No preview available</div>`;
    if (descriptor.kind === 'carousel' && descriptor.slides?.length) {
      assetDetailPreview.innerHTML = buildCarouselSliderHtml(descriptor.slides, { context: 'detail' });
    } else if (descriptor.kind === 'image') {
      html = `<img src="${escapeHtml(descriptor.url)}" alt="${escapeHtml(asset.title || 'Asset preview')}" />`;
      assetDetailPreview.innerHTML = html;
    } else if (descriptor.kind === 'video') {
      html = `<video src="${escapeHtml(descriptor.url)}" controls playsinline preload="metadata"></video>`;
      assetDetailPreview.innerHTML = html;
    } else if (descriptor.text) {
      html = `<div class="design-preview__graphic">${escapeHtml(descriptor.text)}</div>`;
      assetDetailPreview.innerHTML = html;
    } else {
      assetDetailPreview.innerHTML = html;
    }
    assetDetailPreview.style.background = 'transparent';
  }
  if (assetDetailSlides) {
    const chips = buildSlideChipRowHtml(asset.slides, 'design');
    assetDetailSlides.innerHTML = chips || '';
  }
}

function closeDesignAssetDetail() {
  if (!assetDetailModal) return;
  assetDetailModal.style.display = 'none';
  activeAssetDetailId = null;
  if (assetDetailSlides) assetDetailSlides.innerHTML = '';
}

function handleAssetDetailSave(event) {
  event.preventDefault();
  if (!activeAssetDetailId) return;
  const asset = designAssets.find((item) => String(item.id) === String(activeAssetDetailId));
  if (!asset) return;
  if (!asset.originalSnapshot) {
    asset.originalSnapshot = JSON.parse(JSON.stringify(sanitizeAssetForStorage(asset)));
  }
  asset.title = assetDetailHeadline?.value?.trim() || '';
  asset.caption = assetDetailCaption?.value?.trim() || '';
  asset.cta = assetDetailCta?.value?.trim() || '';
  asset.notes = assetDetailNotes?.value?.trim() || '';
  asset.previewText = asset.title || asset.caption || asset.previewText || '';
  asset.lastEdited = new Date().toISOString();
  persistDesignAssetsToStorage();
  linkAssetToCalendarPost(asset);
  renderDesignAssets();
  showDesignSuccess('Asset updated.');
  closeDesignAssetDetail();
}
applyDesignViewMode(designViewMode);
(function syncPreviewPlacement() {
  try {
    const appPreviewPanel = document.querySelector('#app-experience .design-preview-panel');
    const appNotesRow = document.querySelector('#app-experience #design-notes')?.closest('.design-form__row');
    if (appPreviewPanel && appNotesRow && appPreviewPanel.nextElementSibling !== appNotesRow) {
      appNotesRow.parentElement.insertBefore(appPreviewPanel, appNotesRow);
    }
    const modalPreviewPanel = document.querySelector('#design-modal .design-preview-panel');
    const modalNotesRow = document.querySelector('#design-modal #design-notes')?.closest('.design-form__row');
    if (modalPreviewPanel && modalNotesRow && modalPreviewPanel.nextElementSibling !== modalNotesRow) {
      modalNotesRow.parentElement.insertBefore(modalPreviewPanel, modalNotesRow);
    }
  } catch (err) {
    console.warn('Unable to align preview panel placement', err);
  }
})();
renderDesignLivePreview();
const POST_FREQUENCY_KEY = 'promptly_post_frequency';
const PLAN_DETAILS = {
  pro: {
    label: 'Promptly Pro',
    limits: 'Unlimited calendars · downloads & Brand Brain',
  },
  free: {
    label: 'Free plan',
    limits: '1 calendar/month · single-platform exports',
  },
};

function getProfileSettingsStorageKey(email = '') {
  const normalized = (email || 'anon').toString().trim().toLowerCase();
  return `${PROFILE_SETTINGS_PREFIX}${normalized || 'anon'}`;
}

function getVolatileProfileSettingsKey(email = '') {
  const normalized = (email || 'anon').toString().trim().toLowerCase();
  return `${PROFILE_SETTINGS_VOLATILE_PREFIX}${normalized || 'anon'}`;
}

function readStoredProfileSettings(key) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed;
  } catch (error) {
    console.warn('Unable to parse profile settings', error);
    return null;
  }
}

function loadVolatileProfileSettings(email = '') {
  const key = getVolatileProfileSettingsKey(email);
  if (PROFILE_SETTINGS_MEMORY_CACHE[key]) return PROFILE_SETTINGS_MEMORY_CACHE[key];
  try {
    const raw = sessionStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') {
      PROFILE_SETTINGS_MEMORY_CACHE[key] = parsed;
      return parsed;
    }
  } catch (_err) {
    // Ignore sessionStorage access issues
  }
  return null;
}

function clearVolatileProfileSettings(email = '') {
  const key = getVolatileProfileSettingsKey(email);
  delete PROFILE_SETTINGS_MEMORY_CACHE[key];
  try {
    sessionStorage.removeItem(key);
  } catch (_err) {
    // Ignore sessionStorage access issues
  }
}

function persistVolatileProfileSettings(settings = {}, email = activeUserEmail, sourceError = null) {
  const key = getVolatileProfileSettingsKey(email);
  PROFILE_SETTINGS_MEMORY_CACHE[key] = settings;
  try {
    sessionStorage.setItem(key, JSON.stringify(settings));
  } catch (_err) {
    // Ignore inability to persist in sessionStorage; memory cache is still populated
  }
  return { ok: false, saved: settings, volatile: true, error: sourceError };
}

function loadProfileSettings(email = '') {
  const key = getProfileSettingsStorageKey(email);
  const stored = readStoredProfileSettings(key);
  if (stored) return stored;
  const volatile = loadVolatileProfileSettings(email);
  if (volatile) return volatile;
  const legacy = readStoredProfileSettings(PROFILE_SETTINGS_LEGACY_KEY);
  if (legacy) {
    try {
      localStorage.setItem(key, JSON.stringify(legacy));
      if (email) {
        localStorage.removeItem(PROFILE_SETTINGS_LEGACY_KEY);
      }
    } catch (error) {
      console.warn('Unable to migrate legacy profile settings', error);
    }
    return legacy;
  }
  return loadVolatileProfileSettings(email) || {};
}

function isQuotaExceededError(error) {
  if (!error) return false;
  if (error.name === 'QuotaExceededError' || error.name === 'NS_ERROR_DOM_QUOTA_REACHED') return true;
  return error.code === 22 || /quota/i.test(String(error.message || ''));
}

function persistProfileSettingsLocally(settings = {}, email = activeUserEmail) {
  if (profileSettingsPersistentDisabled) {
    return persistVolatileProfileSettings(settings, email);
  }
  const key = getProfileSettingsStorageKey(email);
  const payload = JSON.stringify(settings || {});
  try {
    localStorage.setItem(key, payload);
    clearVolatileProfileSettings(email);
    return { ok: true, saved: settings };
  } catch (error) {
    if (!profileSettingsQuotaWarned) {
      console.warn('Unable to save profile settings', error);
      profileSettingsQuotaWarned = true;
    }
    profileSettingsPersistentDisabled = true;
    return persistVolatileProfileSettings(settings, email, error);
  }
}

function getPostFrequency() {
  if (!cachedUserIsPro) return 1;
  const stored = localStorage.getItem(POST_FREQUENCY_KEY);
  const parsed = parseInt(stored, 10);
  if (!Number.isFinite(parsed) || parsed < 1) return 1;
  return Math.min(parsed, 6);
}

function setPostFrequency(value) {
  if (!cachedUserIsPro) return;
  const normalized = Math.min(Math.max(parseInt(value, 10) || 1, 1), 6);
  try {
    localStorage.setItem(POST_FREQUENCY_KEY, String(normalized));
  } catch (error) {
    console.warn('Unable to store post frequency', error);
  }
  if (postFrequencySelect) postFrequencySelect.value = String(normalized);
  if (postFrequencyDisplay) postFrequencyDisplay.textContent = `${normalized}x`;
  currentPostFrequency = normalized;
  renderCards(currentCalendar);
}

function updateProfileSettings(partial = {}, options = {}) {
  const { replace = false, targetEmail } = options;
  const merged = replace
    ? { ...(partial || {}) }
    : { ...(profileSettings || {}), ...(partial || {}) };
  const persistResult = persistProfileSettingsLocally(merged, targetEmail ?? activeUserEmail);
  if (persistResult?.saved) {
    profileSettings = persistResult.saved;
  } else {
    profileSettings = merged;
  }
  applyProfileSettings();
  return persistResult || { ok: true, saved: profileSettings };
}

function applyProfileSettings() {
  const settings = profileSettings || {};
  const displayName = (settings.displayName || '').trim();
  const initialsSource = displayName || activeUserEmail || 'P';
  if (profileInitial && initialsSource) {
    const initial = initialsSource.trim().charAt(0) || 'P';
    profileInitial.textContent = initial.toUpperCase();
  }
  if (userPronounsEl) {
    const pronouns = (settings.pronouns || '').trim();
    userPronounsEl.textContent = pronouns;
    userPronounsEl.style.display = pronouns ? '' : 'none';
  }
  document.body.classList.toggle('prefers-high-contrast', !!settings.highContrast);
  document.body.classList.toggle('prefers-large-type', !!settings.largeType);
  document.body.classList.toggle('prefers-reduced-motion', !!settings.reducedMotion);
  document.documentElement.style.fontSize = settings.largeType ? '18px' : '';
}

async function syncProfileSettingsFromSupabase() {
  if (!activeUserEmail) return;
  if (profileSettingsSyncPromise) return profileSettingsSyncPromise;
  profileSettingsSyncPromise = (async () => {
    try {
      const remoteSettings = await getProfilePreferences();
      const payload = remoteSettings && typeof remoteSettings === 'object' ? remoteSettings : {};
      updateProfileSettings(payload, { replace: true, targetEmail: activeUserEmail });
    } catch (error) {
      console.warn('Unable to sync profile settings from Supabase', error);
    } finally {
      profileSettingsSyncPromise = null;
    }
  })();
  return profileSettingsSyncPromise;
}

function setAccountSettingsTab(tab = 'account') {
  if (!tab) tab = 'account';
  activeSettingsTab = tab;
  settingsTabButtons.forEach((btn) => {
    const isActive = (btn.dataset.settingsTab || 'account') === tab;
    btn.classList.toggle('active', isActive);
    btn.setAttribute('aria-selected', String(isActive));
    if (isActive) {
      btn.removeAttribute('tabindex');
    } else {
      btn.setAttribute('tabindex', '-1');
    }
  });
  settingsPanels.forEach((panel) => {
    const isActive = (panel.dataset.settingsPanel || 'account') === tab;
    panel.classList.toggle('active-panel', isActive);
  });
}

if (settingsTabButtons.length) {
  settingsTabButtons.forEach((btn) => {
    btn.addEventListener('click', () => {
      const tab = btn.dataset.settingsTab || 'account';
      setAccountSettingsTab(tab);
    });
  });
  setAccountSettingsTab('account');
}

function updateAccountOverviewEmail(email) {
  if (accountEmailDisplay) {
    accountEmailDisplay.textContent = email || 'Not signed in';
  }
}

updateAccountOverviewEmail(activeUserEmail);

function updateAccountPlanInfo(state) {
  let plan;
  if (state === 'none') {
    plan = { label: 'Not signed in', limits: 'Sign in to manage your subscription.' };
  } else {
    const isPro = !!state;
    plan = isPro ? PLAN_DETAILS.pro : PLAN_DETAILS.free;
  }
  if (accountPlanStatusEl) accountPlanStatusEl.textContent = plan.label;
  if (accountPlanLimitsEl) accountPlanLimitsEl.textContent = plan.limits;
}

function updateAccountLastLogin(timestamp) {
  if (!accountLastLoginEl) return;
  if (!timestamp) {
    accountLastLoginEl.textContent = 'Not available';
    return;
  }
  try {
    const date = new Date(timestamp);
    accountLastLoginEl.textContent = isNaN(date.getTime())
      ? 'Not available'
      : date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  } catch {
    accountLastLoginEl.textContent = 'Not available';
  }
}

function hydrateAccountForm() {
  if (!accountForm) return;
  const settings = profileSettings || {};
  if (accountDisplayNameInput) accountDisplayNameInput.value = settings.displayName || '';
  if (accountPronounsInput) accountPronounsInput.value = settings.pronouns || '';
  if (accountRoleInput) accountRoleInput.value = settings.role || '';
  if (prefersHighContrastInput) prefersHighContrastInput.checked = !!settings.highContrast;
  if (prefersLargeTypeInput) prefersLargeTypeInput.checked = !!settings.largeType;
  if (prefersReducedMotionInput) prefersReducedMotionInput.checked = !!settings.reducedMotion;
}

function openAccountModal(initialTab = 'account') {
  if (!accountModal) return;
  hydrateAccountForm();
  if (accountFeedback) {
    accountFeedback.textContent = '';
    accountFeedback.classList.remove('success');
  }
  setAccountSettingsTab(initialTab);
  accountModal.style.display = 'flex';
}

function closeAccountModal() {
  if (!accountModal) return;
  accountModal.style.display = 'none';
}

applyProfileSettings();
  function postedKey() {
    const user = getCurrentUser() || 'guest';
    const niche = (currentNiche || nicheInput?.value || 'default').toLowerCase();
    // local slug helper to avoid ordering issues
    const slug = (s="") => String(s).toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/(^-|-$)/g,'').slice(0,40);
    return `promptly_posted_${user}_${slug(niche)}`;
  }
  function loadPostedMap() {
    try {
      return JSON.parse(localStorage.getItem(postedKey()) || '{}');
    } catch { return {}; }
  }
function updateTabs(){
    if (!calendarSection || !hub) return;
    const wantsDesign = activeTab === 'design';
    if (wantsDesign && !cachedUserIsPro) activeTab = 'plan';
    const hasCalendar = currentCalendar && currentCalendar.length > 0;
    // Toggle classes
    if (tabPlan) tabPlan.classList.toggle('active', activeTab==='plan');
    if (tabPublish) tabPublish.classList.toggle('active', activeTab==='publish');
    if (tabPlan) tabPlan.setAttribute('aria-pressed', String(activeTab==='plan'));
    if (tabPublish) tabPublish.setAttribute('aria-pressed', String(activeTab==='publish'));

    const showCalendar = activeTab === 'plan';
    const showHub = activeTab === 'publish';
    const showDesign = activeTab === 'design' && designSection;

    calendarSection.style.display = showCalendar ? '' : 'none';
    hub.style.display = showHub ? '' : 'none';
    if (designSection) designSection.style.display = showDesign ? 'flex' : 'none';

    if (showCalendar) {
      hub.style.opacity = '0';
      if (designSection) designSection.style.opacity = '0';
      requestAnimationFrame(() => { calendarSection.style.opacity = '1'; });
    } else if (showHub) {
      calendarSection.style.opacity = '0';
      if (designSection) designSection.style.opacity = '0';
      requestAnimationFrame(() => { hub.style.opacity = '1'; });
  if (!hasCalendar) {
        if (hubEmpty) hubEmpty.style.display = '';
        if (hubGrid) hubGrid.style.display = 'none';
      } else {
        if (hubEmpty) hubEmpty.style.display = 'none';
        if (hubGrid) hubGrid.style.display = '';
      }
    } else if (showDesign && designSection) {
      calendarSection.style.opacity = '0';
      hub.style.opacity = '0';
      requestAnimationFrame(() => { designSection.style.opacity = '1'; });
      renderDesignAssets();
    }
  }

function setDesignEmptyState(reason = 'none') {
  if (!designEmpty) return;
  const isFilterReason = reason === 'filters';
  if (designEmptyTitle) {
    designEmptyTitle.textContent = isFilterReason ? 'Nothing matches these filters.' : 'No assets yet.';
  }
  if (designEmptyBody) {
    designEmptyBody.textContent = isFilterReason
      ? 'Adjust or clear your filters to keep editing existing assets.'
      : 'Generate a post from your Content Calendar and it will appear here for editing.';
  }
  if (designEmptyClearFiltersBtn) {
    designEmptyClearFiltersBtn.style.display = isFilterReason ? '' : 'none';
  }
}

function showDesignEmptyState(reason = 'none') {
  setDesignEmptyState(reason);
  if (designEmpty) designEmpty.style.display = '';
  if (designWorkspace) designWorkspace.style.display = 'none';
}

function hideDesignEmptyState() {
  if (designEmpty) designEmpty.style.display = 'none';
  if (designWorkspace) designWorkspace.style.display = '';
}

function renderDesignAssets() {
    if (!designGrid || !designEmpty) return;
    const knownIds = new Set(designAssets.map((asset) => String(asset.id)));
    selectedDesignAssetIds.forEach((id) => {
      if (!knownIds.has(String(id))) selectedDesignAssetIds.delete(id);
    });
    refreshDesignDayFilterOptions();
    refreshDesignCampaignFilterOptions();
    refreshDesignMonthFilterOptions();

    if (!designAssets.length) {
      selectedDesignAssetIds.clear();
      designFocusedAssetId = null;
      showDesignEmptyState('none');
      designGrid.innerHTML = '';
      renderDesignEditor();
      updateDesignSelectionUI();
      return;
    }

    if (!designFocusedAssetId && designAssets.length) {
      designFocusedAssetId = String(designAssets[0].id);
    }

    const filteredAssets = applyDesignFilters(designAssets);
    const filteredHasFocus = filteredAssets.some((asset) => String(asset.id) === String(designFocusedAssetId));
    if (!filteredHasFocus && filteredAssets.length) {
      designFocusedAssetId = String(filteredAssets[0].id);
    }

    if (!filteredAssets.length) {
      showDesignEmptyState('filters');
      designGrid.innerHTML = '';
      renderDesignEditor();
      updateDesignSelectionUI();
      return;
    }

    hideDesignEmptyState();
    const markup =
      designViewMode === 'list'
        ? buildDesignAssetListHtml(filteredAssets)
        : buildDesignAssetGridHtml(filteredAssets);
    designGrid.innerHTML = markup;

    if (highlightDesignAssetId) {
      const spotlight = designGrid.querySelector(`[data-design-asset-id="${highlightDesignAssetId}"]`);
      if (spotlight) {
        spotlight.classList.add('is-focused');
        spotlight.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        highlightDesignAssetId = null;
        if (urlParams.has('asset')) {
          const newUrl = new URL(window.location.href);
          newUrl.searchParams.delete('asset');
          window.history.replaceState({}, '', newUrl.toString());
        }
      }
    }
    if (pendingAssetDetailId) {
      const pendingAsset = designAssets.find((asset) => String(asset.id) === String(pendingAssetDetailId));
      if (pendingAsset) openDesignAssetDetail(pendingAsset);
      pendingAssetDetailId = null;
    }
    renderDesignEditor();
    updateDesignSelectionUI();
}

function truncateBrandVoiceText(value = '', limit = 220) {
  if (!value) return '';
  const clean = value.replace(/\s+/g, ' ').trim();
  if (clean.length <= limit) return clean;
  return `${clean.slice(0, limit - 1).trim()}…`;
}

function updateDesignEditorBrandMeta(asset) {
  if (!designEditorBrandSection) return;
  if (!asset) {
    designEditorBrandSection.style.display = 'none';
    return;
  }
  const data = asset.data || {};
  const swatches = [
    { el: designEditorBrandPrimary, value: data.brand_primary_color },
    { el: designEditorBrandSecondary, value: data.brand_secondary_color },
    { el: designEditorBrandAccent, value: data.brand_accent_color },
  ];
  let hasSwatch = false;
  swatches.forEach(({ el, value }) => {
    if (!el) return;
    const next = (value || '').trim();
    if (next) {
      el.textContent = next;
      el.style.display = 'inline-flex';
      el.style.backgroundColor = next;
      el.style.borderColor = next;
      el.style.color = '#050505';
      hasSwatch = true;
    } else {
      el.textContent = '';
      el.style.display = 'none';
      el.style.backgroundColor = '';
      el.style.borderColor = '';
      el.style.color = '';
    }
  });
  const fonts = [data.brand_heading_font, data.brand_body_font].filter(Boolean).join(' / ');
  if (designEditorBrandFonts) {
    designEditorBrandFonts.textContent = fonts ? `Fonts: ${fonts}` : '';
  }
  const voice = (data.brand_voice || '').trim();
  if (designEditorBrandVoice) {
    designEditorBrandVoice.textContent = voice ? `Voice: ${truncateBrandVoiceText(voice)}` : '';
  }
  const shouldShow = hasSwatch || Boolean(fonts) || Boolean(voice);
  designEditorBrandSection.style.display = shouldShow ? 'flex' : 'none';
}

function buildDesignAssetGridHtml(list = []) {
  const cards = list
    .map((asset) => {
      const assetId = String(asset.id);
      const isFocused = String(assetId) === String(designFocusedAssetId);
      const isSelected = selectedDesignAssetIds.has(assetId);
      const typeLabel = formatAssetTypeLabel(asset.assetType || asset.typeLabel || asset.type || '');
      const dayLabel = asset.linkedDayLabel || (asset.linkedDay ? `Day ${String(asset.linkedDay).padStart(2, '0')}` : 'Unassigned');
      const campaignLabel = asset.campaign || 'General';
      const statusLabel = formatDesignAssetStatusLabel(asset.status);
      const updatedLabel = formatDesignAssetUpdatedLabel(asset.updatedAt);
      const monthLabel = asset.monthLabel || '';
      return `
        <article class="design-asset-card${isFocused ? ' is-focused' : ''}" data-design-asset-id="${escapeHtml(assetId)}" tabindex="0" role="button" aria-pressed="${isFocused}">
          <label class="design-asset-card__checkbox">
            <input type="checkbox" data-asset-select="${escapeHtml(assetId)}" ${isSelected ? 'checked' : ''} />
            <span class="sr-only">Select ${escapeHtml(asset.title || 'asset')}</span>
          </label>
          <div class="design-asset-card__body">
            <div class="design-asset-card__labels">
              <span class="design-asset-card__type">${escapeHtml(typeLabel)}</span>
              <span class="design-asset-card__status design-asset-card__status--${escapeHtml(asset.status || 'draft')}">${statusLabel}</span>
            </div>
            <div class="design-asset-card__title-row">
              <h3>${escapeHtml(asset.title || 'AI Asset')}</h3>
            </div>
            <p class="design-asset-card__meta">${escapeHtml(dayLabel)} • ${escapeHtml(monthLabel || formatDesignAssetMonth(asset.createdAt))}</p>
            <p class="design-asset-card__campaign">${escapeHtml(campaignLabel)}</p>
            <p class="design-asset-card__updated">${updatedLabel}</p>
          </div>
        </article>
      `;
    })
    .join('');
  return `<div class="design-assets-list design-assets-list--grid">${cards}</div>`;
}

function buildDesignAssetListHtml(list = []) {
  const header = `
    <div class="design-assets-row design-assets-row--head" role="row">
      <span class="design-assets-cell design-assets-cell--checkbox"></span>
      <span class="design-assets-cell">Title</span>
      <span class="design-assets-cell">Type</span>
      <span class="design-assets-cell">Linked Day</span>
      <span class="design-assets-cell">Campaign</span>
      <span class="design-assets-cell">Status</span>
      <span class="design-assets-cell">Updated</span>
    </div>
  `;
  const rows = list
    .map((asset) => {
      const assetId = String(asset.id);
      const isFocused = String(assetId) === String(designFocusedAssetId);
      const isSelected = selectedDesignAssetIds.has(assetId);
      const typeLabel = formatAssetTypeLabel(asset.assetType || asset.typeLabel || asset.type || '');
      const dayLabel = asset.linkedDayLabel || (asset.linkedDay ? `Day ${String(asset.linkedDay).padStart(2, '0')}` : 'Unassigned');
      const statusLabel = formatDesignAssetStatusLabel(asset.status);
      const updatedLabel = formatDesignAssetUpdatedLabel(asset.updatedAt);
      return `
        <div class="design-assets-row${isFocused ? ' is-focused' : ''}" data-design-asset-id="${escapeHtml(assetId)}" role="row" tabindex="0">
          <span class="design-assets-cell design-assets-cell--checkbox">
            <input type="checkbox" data-asset-select="${escapeHtml(assetId)}" ${isSelected ? 'checked' : ''} aria-label="Select ${escapeHtml(asset.title || 'asset')}" />
          </span>
          <span class="design-assets-cell design-assets-cell--title">${escapeHtml(asset.title || 'AI Asset')}</span>
          <span class="design-assets-cell"><span class="design-assets-type-badge">${escapeHtml(typeLabel)}</span></span>
          <span class="design-assets-cell">${escapeHtml(dayLabel)}</span>
          <span class="design-assets-cell">${escapeHtml(asset.campaign || 'General')}</span>
          <span class="design-assets-cell">${statusLabel}</span>
          <span class="design-assets-cell">${updatedLabel}</span>
        </div>
      `;
    })
    .join('');
  return `<div class="design-assets-table" role="table">${header}${rows}</div>`;
}

function renderDesignEditor() {
  if (!designWorkspaceEnabled || !designEditorPanel || !designEditorEmpty) return;
  setDesignRegeneratingState(isDesignRegenerating);
  const asset = designAssets.find((item) => String(item.id) === String(designFocusedAssetId));
  if (!asset) {
    if (designEditorForm) designEditorForm.style.display = 'none';
    designEditorEmpty.style.display = '';
    if (designEditorStatusBadge) {
      designEditorStatusBadge.textContent = 'No asset selected';
      designEditorStatusBadge.classList.remove('is-ready', 'is-rendering', 'is-failed');
      designEditorStatusBadge.classList.add('is-muted');
    }
    if (designEditorStatusNote) {
      designEditorStatusNote.textContent = '';
      designEditorStatusNote.style.display = 'none';
    }
    updateDesignEditorBrandMeta(null);
    return;
  }
  designEditorEmpty.style.display = 'none';
  if (designEditorForm) designEditorForm.style.display = 'flex';
  if (designEditorTitleInput) designEditorTitleInput.value = asset.title || '';
  if (designEditorStatusSelect) {
    const editableStatuses = ['draft', 'ready', 'exported'];
    designEditorStatusSelect.value = editableStatuses.includes(asset.status) ? asset.status : 'draft';
  }
  if (designEditorTypeSelect) designEditorTypeSelect.value = asset.assetType || 'story';
  if (designEditorDaySelect) designEditorDaySelect.value = asset.linkedDay ? String(asset.linkedDay) : '';
  if (designEditorToneInput) designEditorToneInput.value = asset.tone || '';
  if (designEditorCampaignInput) designEditorCampaignInput.value = asset.campaign || '';
  if (designEditorMonthSelect) designEditorMonthSelect.value = asset.monthLabel || 'This Month';
  if (designEditorPromptInput) designEditorPromptInput.value = asset.prompt || '';
  if (designEditorStatusBadge) {
    const statusKey = String(asset.status || 'draft').toLowerCase();
    designEditorStatusBadge.textContent = formatDesignAssetStatusLabel(statusKey);
    designEditorStatusBadge.classList.remove('is-ready', 'is-rendering', 'is-failed', 'is-muted');
    if (statusKey === 'rendering' || statusKey === 'queued') {
      designEditorStatusBadge.classList.add('is-rendering');
    } else if (statusKey === 'failed') {
      designEditorStatusBadge.classList.add('is-failed');
    } else if (statusKey === 'ready') {
      designEditorStatusBadge.classList.add('is-ready');
    } else {
      designEditorStatusBadge.classList.add('is-muted');
    }
  }
  const previewSource = asset.previewInlineUrl || asset.previewUrl || asset.image_url || asset.cloudinaryUrl || '';
  if (designEditorPreviewImg) {
    if (previewSource) {
      designEditorPreviewImg.src = previewSource;
      designEditorPreviewImg.style.display = 'block';
    } else {
      designEditorPreviewImg.removeAttribute('src');
      designEditorPreviewImg.style.display = 'none';
    }
  }
  if (designEditorPreviewPlaceholder) {
    if (asset.status === 'rendering' || asset.status === 'queued') {
      designEditorPreviewPlaceholder.style.display = 'flex';
      designEditorPreviewPlaceholder.textContent = 'Rendering in progress. This may take a moment.';
    } else if (asset.status === 'failed') {
      designEditorPreviewPlaceholder.style.display = 'flex';
      designEditorPreviewPlaceholder.textContent = getDesignFailureMessage(asset);
    } else {
      designEditorPreviewPlaceholder.style.display = previewSource ? 'none' : 'flex';
      designEditorPreviewPlaceholder.textContent = 'Preview will appear after generation.';
    }
  }
  if (designEditorStatusNote) {
    let note = '';
    if (asset.status === 'rendering' || asset.status === 'queued') {
      note = 'Rendering in progress. This may take a moment.';
    } else if (asset.status === 'failed') {
      note = getDesignFailureMessage(asset);
    }
    designEditorStatusNote.textContent = note;
    designEditorStatusNote.style.display = note ? 'block' : 'none';
  }
  const assetTypeKey = normalizeAssetTypeKey(asset.assetType || asset.type || asset.typeLabel || '');
  if (designEditorStoryPanel) {
    const storyValue = asset.data?.story_copy || asset.story_copy || asset.subtitle || '';
    designEditorStoryPanel.style.display = assetTypeKey === 'story' ? 'flex' : 'none';
    if (designEditorStoryCopyInput) designEditorStoryCopyInput.value = storyValue;
  }
  if (designEditorCarouselPanel) {
    const slides = asset.data?.slides || asset.slides || {};
    designEditorCarouselPanel.style.display = assetTypeKey === 'carousel' ? 'flex' : 'none';
    Object.entries(designEditorCarouselSlideInputs).forEach(([key, input]) => {
      if (input) input.value = slides?.[key] || '';
    });
  }
  updateDesignEditorBrandMeta(asset);
}

function populateLinkedDaySelect(selectEl) {
  if (!selectEl) return;
  const previous = selectEl.value;
  let options = '<option value="">Unassigned</option>';
  for (let day = 1; day <= 30; day += 1) {
    options += `<option value="${day}">Day ${String(day).padStart(2, '0')}</option>`;
  }
  selectEl.innerHTML = options;
  if (previous) {
    selectEl.value = previous;
  }
}

function setDesignRegeneratingState(isLoading) {
  if (!designWorkspaceEnabled || !designEditorPanel) return;
  designEditorPanel.classList.toggle('is-regenerating', isLoading);
  if (designEditorPreviewPlaceholder) {
    designEditorPreviewPlaceholder.textContent = isLoading
      ? 'Generating preview…'
      : 'Preview will appear after generation.';
  }
}

function generateMockPreviewUrl(asset = {}) {
  const label = formatAssetTypeLabel(asset.assetType || asset.typeLabel || 'Asset');
  return `https://placehold.co/600x800?text=${encodeURIComponent(label)}+${Date.now()}`;
}

function updateSelectedAssetField(field, rawValue) {
  if (!designFocusedAssetId) return;
  const idx = designAssets.findIndex((item) => String(item.id) === String(designFocusedAssetId));
  if (idx === -1) return;
  const next = { ...designAssets[idx] };
  const value = typeof rawValue === 'string' ? rawValue : rawValue ?? '';
  if (field === 'linkedDay') {
    const normalized = value ? Number(value) : null;
    next.linkedDay = Number.isFinite(normalized) ? normalized : null;
    next.linkedDayLabel = next.linkedDay ? `Day ${String(next.linkedDay).padStart(2, '0')}` : 'Unassigned';
  } else if (field === 'assetType') {
    next.assetType = value || 'story';
    next.typeLabel = formatAssetTypeLabel(next.assetType);
    next.data = Object.assign({}, next.data || {}, { type: next.assetType });
  } else if (field === 'status') {
    next.status = value || 'draft';
  } else if (field === 'monthLabel') {
    next.monthLabel = value || 'This Month';
  } else if (field === 'title') {
    next.title = value;
  } else if (field === 'tone') {
    next.tone = value;
  } else if (field === 'campaign') {
    next.campaign = value;
  } else if (field === 'prompt') {
    next.prompt = value;
  }
  next.updatedAt = new Date().toISOString();
  designAssets[idx] = next;
  persistDesignAssetsToStorage();
  renderDesignAssets();
}

function updateSelectedAssetDataField(path, value) {
  if (!designFocusedAssetId) return;
  const idx = designAssets.findIndex((item) => String(item.id) === String(designFocusedAssetId));
  if (idx === -1) return;
  const next = { ...designAssets[idx] };
  const data = { ...(next.data || {}) };
  if (path.startsWith('slides.')) {
    const key = path.split('.')[1];
    data.slides = Object.assign({}, data.slides || {});
    data.slides[key] = value || '';
    next.slides = data.slides;
  } else {
    data[path] = value || '';
    if (path === 'story_copy') next.story_copy = value || '';
  }
  next.data = data;
  next.updatedAt = new Date().toISOString();
  designAssets[idx] = next;
  persistDesignAssetsToStorage();
  renderDesignAssets();
}

function createDesignAsset(partial = {}) {
  const now = new Date().toISOString();
  const linkedDay = partial.linkedDay ?? null;
  const linkedDayLabel = partial.linkedDayLabel || (linkedDay ? `Day ${String(linkedDay).padStart(2, '0')}` : 'Unassigned');
  return {
    id: `asset-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
    title: partial.title || 'Untitled asset',
    assetType: partial.assetType || 'story',
    typeLabel: formatAssetTypeLabel(partial.assetType || 'story'),
    linkedDay,
    linkedDayLabel,
    tone: partial.tone || 'Default',
    campaign: partial.campaign || 'General',
    monthLabel: partial.monthLabel || formatDesignAssetMonth(now) || 'This Month',
    status: partial.status || 'draft',
    createdAt: now,
    updatedAt: now,
    prompt: partial.prompt || '',
    previewUrl: partial.previewUrl || '',
    previewInlineUrl: partial.previewInlineUrl || '',
  };
}

function addDesignAsset(asset, { select } = { select: true }) {
  designAssets.unshift(asset);
  persistDesignAssetsToStorage();
  if (select) {
    designFocusedAssetId = asset.id;
    selectedDesignAssetIds.clear();
  }
  renderDesignAssets();
}

function duplicateFocusedAsset() {
  if (!designFocusedAssetId) return;
  const asset = designAssets.find((item) => String(item.id) === String(designFocusedAssetId));
  if (!asset) return;
  const now = new Date().toISOString();
  const copy = {
    ...asset,
    id: `asset-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
    title: `${asset.title || 'AI Asset'} (Copy)`,
    status: 'draft',
    createdAt: now,
    updatedAt: now,
  };
  addDesignAsset(copy);
  showDesignSuccess('Asset duplicated.');
  setTimeout(() => clearDesignFeedback(), 1800);
}

function deleteFocusedAsset() {
  if (!designFocusedAssetId) return;
  const idx = designAssets.findIndex((item) => String(item.id) === String(designFocusedAssetId));
  if (idx === -1) return;
  const asset = designAssets[idx];
  const title = asset?.title || 'this asset';
  if (!window.confirm(`Delete ${title}?`)) return;
  designAssets.splice(idx, 1);
  selectedDesignAssetIds.delete(String(asset.id));
  designFocusedAssetId = designAssets[idx]?.id || designAssets[idx - 1]?.id || null;
  persistDesignAssetsToStorage();
  renderDesignAssets();
  showDesignSuccess('Asset deleted.');
  setTimeout(() => clearDesignFeedback(), 1500);
}

function formatDesignAssetStatusLabel(status = 'ready') {
  const map = {
    draft: 'Draft',
    ready: 'Ready',
    exported: 'Exported',
    rendering: 'Rendering…',
    queued: 'Queued',
    failed: 'Failed',
  };
  return map[status] || 'Draft';
}

function formatDesignAssetUpdatedLabel(value) {
  if (!value) return 'Updated just now';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Updated recently';
  return `Updated ${date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`;
}

function formatDesignAssetMonth(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
}

function setDesignFocusedAsset(assetId) {
  designFocusedAssetId = assetId ? String(assetId) : null;
  renderDesignAssets();
}

function clearDesignFilters() {
  designFilterState.type = 'all';
  designFilterState.day = 'all';
  designFilterState.campaign = 'all';
  designFilterState.tone = 'all';
  designFilterState.month = 'all';
  designFilterState.search = '';
  if (designFilterType) designFilterType.value = 'all';
  if (designFilterDay) designFilterDay.value = 'all';
  if (designFilterCampaign) designFilterCampaign.value = 'all';
  if (designFilterTone) designFilterTone.value = 'all';
  if (designFilterMonth) designFilterMonth.value = 'all';
  if (designFilterSearchInput) designFilterSearchInput.value = '';
  renderDesignAssets();
}

function getFileExtensionFromSource(source = '') {
  if (!source) return '';
  const clean = source.split('?')[0] || '';
  const idx = clean.lastIndexOf('.');
  if (idx === -1) return '';
  return clean.slice(idx + 1).toLowerCase();
}

function getAssetExtension(asset = {}) {
  const source = asset.downloadUrl || asset.fileName || '';
  return getFileExtensionFromSource(source);
}

function normalizeSlides(slides = []) {
  if (!Array.isArray(slides)) return [];
  return slides
    .map((slide, idx) => {
      if (!slide) return null;
      const downloadUrl = slide.downloadUrl || slide.url || '';
      const previewUrl = slide.previewUrl || downloadUrl;
      const label = slide.label || slide.role || `Slide ${idx + 1}`;
      return {
        id: String(slide.id || `${Date.now()}-${idx}`),
        label,
        role: slide.role || label,
        slideNumber: Number(slide.slideNumber || idx + 1),
        platform: slide.platform || slide.format || '',
        aspectRatio: slide.aspectRatio || '',
        width: slide.width || null,
        height: slide.height || null,
        downloadUrl,
        previewUrl,
      };
    })
    .filter((slide) => slide && (slide.downloadUrl || slide.previewUrl));
}

function buildAssetPreviewDescriptor(asset = {}) {
  if (Array.isArray(asset.slides) && asset.slides.length) {
    const slides = normalizeSlides(asset.slides);
    if (slides.length) {
      const first = slides[0];
      return { kind: 'carousel', slides, url: first.previewUrl || first.downloadUrl || '' };
    }
  }
  const inline = asset.previewInlineUrl || asset.image_url || asset.cloudinaryUrl || '';
  if (inline) {
    const lower = inline.slice(0, 30).toLowerCase();
    if (lower.includes('video')) {
      return { kind: 'video', url: inline };
    }
    return { kind: 'image', url: inline };
  }
  const url = asset.previewUrl || asset.image_url || asset.cloudinaryUrl || '';
  if (url && (url.startsWith('data:') || url.startsWith('blob:'))) {
    const lower = url.slice(0, 30).toLowerCase();
    if (lower.includes('video')) return { kind: 'video', url };
    return { kind: 'image', url };
  }
  return {
    kind: 'text',
    url: '',
    text: asset.previewText || asset.title || 'AI asset ready to download',
  };
}

function buildCarouselSliderHtml(slides = [], options = {}) {
  const normalized = normalizeSlides(slides);
  if (!normalized.length) {
    return `<div class="design-asset__preview-text">Carousel preview unavailable</div>`;
  }
  const contextClass = options.context ? ` design-slider--${options.context}` : '';
  const slidesHtml = normalized
    .map((slide, idx) => {
      const url = escapeHtml(slide.previewUrl || slide.downloadUrl || '');
      const alt = escapeHtml(slide.label || `Slide ${idx + 1}`);
      const caption = escapeHtml(slide.label || slide.role || `Slide ${idx + 1}`);
      return `
        <div class="design-slider__slide${idx === 0 ? ' is-active' : ''}" data-slide-index="${idx}">
          <img src="${url}" alt="${alt}" loading="lazy" />
          <span class="design-slider__caption">${caption}</span>
        </div>
      `;
    })
    .join('');
  const dotsHtml = normalized
    .map(
      (_, idx) =>
        `<button type="button" class="design-slider__dot${idx === 0 ? ' is-active' : ''}" data-carousel-dot="${idx}" aria-label="Go to slide ${idx + 1}"></button>`
    )
    .join('');
  return `
    <div class="design-slider${contextClass}" data-carousel-slider data-active-index="0">
      <button type="button" class="design-slider__nav design-slider__nav--prev" data-carousel-nav="prev" aria-label="Previous slide">‹</button>
      <div class="design-slider__track">
        ${slidesHtml}
      </div>
      <button type="button" class="design-slider__nav design-slider__nav--next" data-carousel-nav="next" aria-label="Next slide">›</button>
      <div class="design-slider__dots">${dotsHtml}</div>
    </div>
  `;
}

function buildSlideChipRowHtml(slides = [], context = 'design') {
  const normalized = normalizeSlides(slides);
  if (!normalized.length) return '';
  const wrapperClass = context === 'calendar' ? 'calendar-card__asset-slides' : 'design-asset__slides';
  const chipClass = context === 'calendar' ? 'calendar-card__asset-slide-chip' : 'design-asset__slide-chip';
  const chips = normalized
    .map((slide, idx) => {
      const href = escapeHtml(slide.downloadUrl || slide.previewUrl || '');
      if (!href) return '';
      const label = escapeHtml(slide.label || `Slide ${idx + 1}`);
      return `<a href="${href}" class="${chipClass}" download target="_blank" rel="noopener">${label}</a>`;
    })
    .join('');
  if (!chips) return '';
  return `<div class="${wrapperClass}">${chips}</div>`;
}

function buildDesignAssetPreviewBlock(asset = {}) {
  const descriptor = buildAssetPreviewDescriptor(asset);
  if (descriptor.kind === 'carousel' && descriptor.slides?.length) {
    return {
      isMedia: true,
      html: buildCarouselSliderHtml(descriptor.slides, { context: 'grid' }),
    };
  }
  if (descriptor.kind === 'image') {
    const safeUrl = escapeHtml(descriptor.url);
    const alt = escapeHtml(asset.title || 'AI asset preview');
    return {
      isMedia: true,
      html: `<img src="${safeUrl}" alt="${alt}" loading="lazy" />`,
    };
  }
  if (descriptor.kind === 'video') {
    const safeUrl = escapeHtml(descriptor.url);
    return {
      isMedia: true,
      html: `<video src="${safeUrl}" controls playsinline preload="metadata"></video>`,
    };
  }
  return {
    isMedia: false,
    html: `<div class="design-asset__preview-text">${escapeHtml(descriptor.text)}</div>`,
  };
}

function reorderDesignAssets(sourceId, targetId, insertBefore = true) {
    if (!Array.isArray(designAssets) || !designAssets.length) return;
    const safeSource = String(sourceId ?? '').trim();
    const safeTarget = String(targetId ?? '').trim();
    if (!safeSource || !safeTarget || safeSource === safeTarget) return;
    const sourceIndex = designAssets.findIndex((asset) => String(asset.id) === safeSource);
    const targetIndex = designAssets.findIndex((asset) => String(asset.id) === safeTarget);
    if (sourceIndex === -1 || targetIndex === -1) return;
    const [movedAsset] = designAssets.splice(sourceIndex, 1);
    let nextIndex = designAssets.findIndex((asset) => String(asset.id) === safeTarget);
    if (nextIndex === -1) {
      designAssets.splice(sourceIndex, 0, movedAsset);
      return;
    }
    if (!insertBefore) nextIndex += 1;
    designAssets.splice(nextIndex, 0, movedAsset);
    renderDesignAssets();
    persistDesignAssetsToStorage();
    if (designFeedbackEl) {
      designFeedbackEl.textContent = 'Asset order updated.';
      setTimeout(() => {
        if (designFeedbackEl.textContent === 'Asset order updated.') {
          designFeedbackEl.textContent = '';
        }
      }, 1500);
    }
  }

function clearDesignDragHighlights() {
    if (!designGrid) return;
    designGrid
      .querySelectorAll('.design-asset')
      .forEach((card) => {
        card.classList.remove('drag-over-top', 'drag-over-bottom');
        delete card.dataset.dropPosition;
      });
  }

async function requireProAccess() {
    if (cachedUserIsPro) return true;
    const user = await getCurrentUser();
    if (!user) return false;
    const userIsPro = await isPro(user);
    cachedUserIsPro = userIsPro;
    return userIsPro;
  }

async function startDesignModal(entry = null, entryDay = null) {
    const userId = activeUserEmail || (await getCurrentUser());
    if (!userId) {
      window.location.href = '/auth.html?mode=signup';
      return;
    }
  const userIsPro = cachedUserIsPro || (await isPro(userId));
  if (userIsPro && !cachedUserIsPro) cachedUserIsPro = true;
  const remainingQuota = userIsPro ? Infinity : getRemainingDesignQuota(userId);
  const resolvedDay = typeof entryDay === 'number' ? entryDay : (typeof entry?.day === 'number' ? entry.day : '');
  activeDesignContext = entry ? { entry, day: resolvedDay } : null;
  if (designForm) designForm.reset();
  if (designDayInput) designDayInput.value = resolvedDay || '';
  if (designConceptInput) {
    designConceptInput.value = entry ? (entry.idea || entry.title || '') : '';
  }
  if (designCaptionCueInput) {
    designCaptionCueInput.value = entry ? (entry.caption || entry.description || '') : '';
  }
  if (designCtaInput) {
    designCtaInput.value = entry ? (entry.cta || '') : '';
  }
  renderDesignTemplateOptions(activeTemplateId);

    let preset = null;
    if (entry) {
      preset = deriveAssetPreset(entry);
      if (designAssetTypeInput) {
        const hasOption = Array.from(designAssetTypeInput.options || []).some((opt) => opt.value === preset.assetType);
        designAssetTypeInput.value = hasOption ? preset.assetType : designAssetTypeInput.value;
      }
      if (designToneInput) {
        const hasTone = Array.from(designToneInput.options || []).some((opt) => opt.value === preset.tone);
        designToneInput.value = hasTone ? preset.tone : designToneInput.value;
      }
      if (designNotesInput) {
        designNotesInput.value = buildAutoNotes(entry, preset);
      }
    } else if (designNotesInput) {
      designNotesInput.value = '';
    }
    const conceptValue =
      entry?.idea ||
      entry?.title ||
      designConceptInput?.value ||
      '';
    const captionValue =
      entry?.caption ||
      entry?.description ||
      designCaptionCueInput?.value ||
      '';
    const ctaValue = entry?.cta || designCtaInput?.value || '';
    applyAutofillDefaults({
      concept: conceptValue,
      caption: captionValue,
      cta: ctaValue,
    });
    if (activeTemplateId) {
      applyDesignTemplateSelection(activeTemplateId);
    } else {
      updateDesignTemplateHint('');
    }
    updateTemplateShortcuts();
    renderDesignLivePreview();

    if (designSelectedPost) {
      if (entry && resolvedDay) {
        const idea = entry.idea || entry.title || 'Post';
        designSelectedPost.textContent = `Linked to Day ${String(resolvedDay).padStart(2, '0')}: ${idea}`;
      } else if (entry) {
        designSelectedPost.textContent = entry.idea || entry.title || 'Linked post';
      } else {
        designSelectedPost.textContent = 'General request (not linked to a specific day)';
      }
    }
    clearDesignFeedback();
    if (!userIsPro && designFeedbackEl) {
      designFeedbackEl.textContent =
        remainingQuota > 0
          ? `Free plan: ${remainingQuota} of ${DESIGN_FREE_MONTHLY_QUOTA} AI assets left this month.`
          : 'Free plan limit reached. Upgrade for unlimited AI assets.';
      designFeedbackEl.classList.toggle('error', remainingQuota <= 0);
    }
    setDesignNotesCollapsed(!(designNotesInput?.value || '').trim());
    if (designModal) designModal.style.display = 'flex';
  }

function closeDesignModal() {
    if (designModal) designModal.style.display = 'none';
    clearDesignFeedback();
    if (designForm) designForm.reset();
    if (designDayInput) designDayInput.value = '';
    if (designSelectedPost) designSelectedPost.textContent = '';
    applyAutofillDefaults({ concept: '', caption: '', cta: '' });
    setDesignNotesCollapsed(true);
    renderDesignTemplateOptions(activeTemplateId);
    activeDesignContext = null;
  }

function formatAssetTypeLabel(type) {
  const key = normalizeAssetTypeKey(type);
  switch (key) {
    case 'story':
      return 'Story';
    case 'carousel':
      return 'Carousel';
    default:
      return type
        ? String(type)
            .replace(/[-_]/g, ' ')
            .replace(/\b\w/g, (l) => l.toUpperCase())
        : 'Asset';
  }
}

async function handleDesignFormSubmit(event) {
    event.preventDefault();
    const currentUserId = activeUserEmail || (await getCurrentUser());
    if (!currentUserId) {
      showDesignError('Sign in required', 'Create a free account to generate AI assets.');
      window.location.href = '/auth.html?mode=signup';
      return;
    }
    const userIsPro = cachedUserIsPro || (await isPro(currentUserId));
    if (userIsPro && !cachedUserIsPro) cachedUserIsPro = true;
    let remainingQuota = userIsPro ? Infinity : getRemainingDesignQuota(currentUserId);
    if (!userIsPro && remainingQuota <= 0) {
      showDesignError('Monthly limit reached', 'Free plan includes 3 AI assets per month. Upgrade for unlimited designs.');
      showUpgradeModal();
      return;
    }
  const paletteDefaults = getBrandPaletteDefaults();
  const palette = {
    primaryColor: paletteDefaults.primaryColor,
    secondaryColor: paletteDefaults.secondaryColor,
    accentColor: paletteDefaults.accentColor,
    headingFont: paletteDefaults.headingFont,
    bodyFont: paletteDefaults.bodyFont,
  };
  const conceptValue =
    designConceptInput?.value?.trim() ||
    activeDesignContext?.entry?.idea ||
    activeDesignContext?.entry?.title ||
    '';
  const captionCueValue =
    designCaptionCueInput?.value?.trim() ||
    activeDesignContext?.entry?.caption ||
    activeDesignContext?.entry?.description ||
    '';
  const ctaValue = designCtaInput?.value?.trim() || activeDesignContext?.entry?.cta || '';
  const resolvedNiche = currentNiche || nicheInput?.value?.trim() || '';
  const payload = {
    day: Number(designDayInput?.value) || activeDesignContext?.day || null,
    assetType: designAssetTypeInput?.value || 'story',
    tone: designToneInput?.value || 'bold',
    notes: designNotesInput?.value?.trim() || '',
    userId: currentUserId || '',
    concept: conceptValue,
    caption: captionCueValue,
    captionCue: captionCueValue,
    cta: ctaValue,
    campaign: resolvedNiche,
    niche: resolvedNiche,
    title:
      (activeDesignContext?.entry && (activeDesignContext.entry.idea || activeDesignContext.entry.title)) ||
      (designDayInput?.value ? `Day ${designDayInput.value}` : `Asset for ${currentNiche || 'brand'}`),
    primaryColor: palette.primaryColor,
    secondaryColor: palette.secondaryColor,
    accentColor: palette.accentColor,
    headingFont: palette.headingFont,
    bodyFont: palette.bodyFont,
    brandPalette: {
      primaryColor: palette.primaryColor,
      secondaryColor: palette.secondaryColor,
      accentColor: palette.accentColor,
    },
    fonts: {
      heading: palette.headingFont,
      body: palette.bodyFont,
    },
  };
    if (activeTemplateId) {
      const tpl = designTemplates.find((item) => String(item?.id) === String(activeTemplateId));
      payload.templateId = activeTemplateId;
      if (tpl?.label) payload.templateLabel = tpl.label;
    }
    const kitSummary = summarizeBrandKitBrief(currentBrandKit);
    if (kitSummary) payload.brandKitSummary = kitSummary;
    showDesignSuccess('Generating asset…');
    try {
      let asset = await requestDesignAsset(payload);
      asset = await ensureAssetInlinePreview(asset);
      asset.createdAt = asset.createdAt || new Date().toISOString();
      asset.linkedDay = payload.day || activeDesignContext?.day || null;
      designAssets.unshift(asset);
      persistDesignAssetsToStorage();
      renderDesignAssets();
      if (activeDesignContext?.entry) {
        linkAssetToCalendarPost(asset);
      }
      if (!userIsPro) {
        remainingQuota = incrementDesignUsage(currentUserId);
      }
      const successMessage = asset.linkedDay
        ? `Asset linked to Day ${String(asset.linkedDay).padStart(2, '0')}.`
        : 'Asset added to Design tab.';
      const quotaSuffix =
        userIsPro || remainingQuota === Infinity
          ? ''
          : ` (${Math.max(0, remainingQuota)} of ${DESIGN_FREE_MONTHLY_QUOTA} free assets remain)`;
      showDesignSuccess(`${successMessage}${quotaSuffix}`);
      setTimeout(closeDesignModal, 1100);
    } catch (error) {
      console.error('Design asset error:', error);
      const detailMessage =
        error?.details?.detail ||
        (Array.isArray(error?.details?.errors) ? error.details.errors.join(', ') : '') ||
        '';
      showDesignError(error?.message || 'Unable to generate asset. Try again soon.', detailMessage);
    }
  }

async function requestDesignAsset(payload) {
    try {
      const response = await fetch('/api/design/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const raw = await response.text();
      if (!response.ok) {
        let detail;
        try {
          detail = raw ? JSON.parse(raw) : null;
        } catch {
          detail = null;
        }
        const err = new Error(detail?.error || detail?.detail || `Design API error ${response.status}`);
        err.isApiError = true;
        err.status = response.status;
        err.details = detail || { raw };
        throw err;
      }
      const data = raw ? JSON.parse(raw) : {};
      const paletteDefaults = getBrandPaletteDefaults();
      const slides = normalizeSlides(data.slides || []);
      const asset = {
        id: String(data.id || Date.now()),
        day: payload.day,
        title: data.title || payload.title,
        typeLabel: data.type || formatAssetTypeLabel(payload.assetType),
        previewText: data.previewText || data.summary || `${formatAssetTypeLabel(payload.assetType)} • ${payload.tone}`,
        downloadUrl: data.downloadUrl || '',
        bundleUrl: data.bundleUrl || '',
        previewInlineUrl: data.previewUrl || '',
        status: data.status || 'Ready',
        brief: data.brief || payload.notes || '',
        assetType: data.assetType || payload.assetType || inferAssetTypeFromAsset({ typeLabel: data.type }),
        tone: data.tone || payload.tone || 'bold',
        notes: data.notes || payload.notes || '',
        templateId: data.templateId || payload.templateId || null,
        templateLabel: data.templateLabel || payload.templateLabel || null,
        caption: data.caption || payload.caption || activeDesignContext?.entry?.caption || '',
        cta: data.cta || payload.cta || activeDesignContext?.entry?.cta || '',
        campaign: data.campaign || payload.campaign || '',
        primaryColor: data.primaryColor || payload.primaryColor || paletteDefaults.primaryColor,
        secondaryColor: data.secondaryColor || payload.secondaryColor || paletteDefaults.secondaryColor,
        accentColor: data.accentColor || payload.accentColor || paletteDefaults.accentColor,
        headingFont: data.headingFont || payload.headingFont || paletteDefaults.headingFont,
        bodyFont: data.bodyFont || payload.bodyFont || paletteDefaults.bodyFont,
        concept: data.concept || payload.concept || '',
        lastEdited: null,
        slides,
      };
      if (slides.length) {
        if (!asset.downloadUrl) {
          asset.downloadUrl = slides[0].downloadUrl || '';
        }
        if (!asset.previewInlineUrl) {
          asset.previewInlineUrl = slides[0].previewUrl || '';
        }
      }
      if (!asset.downloadUrl) {
        const blob = buildDesignPdfBlob(asset, payload);
        asset.fileBlob = blob;
        asset.fileName = `${slugify(asset.title || 'promptly-asset')}.pdf`;
        asset.downloadUrl = URL.createObjectURL(blob);
      }
      asset.designUrl = `/design.html?asset=${asset.id}`;
      if (!asset.previewText) {
        asset.previewText = `${formatAssetTypeLabel(payload.assetType)} • ${payload.tone}`;
      }
      return asset;
    } catch (error) {
      if (error?.isApiError) throw error;
      console.warn('Design asset generation fallback', error);
    }
    const paletteDefaults = getBrandPaletteDefaults();
    const fallback = {
      id: String(Date.now()),
      day: payload.day,
      title: payload.title,
      typeLabel: formatAssetTypeLabel(payload.assetType),
      previewText: `${formatAssetTypeLabel(payload.assetType)} • ${payload.tone}`,
      status: 'Ready',
      brief: payload.notes || '',
    assetType: payload.assetType || 'story',
      tone: payload.tone || 'bold',
      notes: payload.notes || '',
      templateId: payload.templateId || null,
      templateLabel: payload.templateLabel || null,
      caption: payload.caption || activeDesignContext?.entry?.caption || '',
      cta: payload.cta || activeDesignContext?.entry?.cta || '',
      campaign: payload.campaign || '',
      primaryColor: payload.primaryColor || paletteDefaults.primaryColor,
      secondaryColor: payload.secondaryColor || paletteDefaults.secondaryColor,
      accentColor: payload.accentColor || paletteDefaults.accentColor,
      headingFont: payload.headingFont || paletteDefaults.headingFont,
      bodyFont: payload.bodyFont || paletteDefaults.bodyFont,
      lastEdited: null,
      concept: payload.concept || '',
      bundleUrl: '',
      slides: [],
    };
    const blob = buildDesignPdfBlob(fallback, payload);
    fallback.fileBlob = blob;
    fallback.fileName = `${slugify(fallback.title || 'promptly-asset')}.pdf`;
    fallback.downloadUrl = URL.createObjectURL(blob);
    fallback.designUrl = `/design.html?asset=${fallback.id}`;
    return fallback;
}

function linkAssetToCalendarPost(asset, options = {}) {
  const dayToLink = asset.linkedDay || asset.day || activeDesignContext?.day || null;
  const targetEntry = dayToLink ? findPostByDay(dayToLink) : null;
  if (!targetEntry) return false;
  const descriptor = buildAssetPreviewDescriptor(asset);
  const slides = sanitizeSlidesForStorage(asset.slides);
  const summary = {
    id: asset.id,
    title: asset.title,
    typeLabel: asset.typeLabel,
    downloadUrl: asset.bundleUrl || asset.downloadUrl,
    bundleUrl: asset.bundleUrl || '',
    previewType: descriptor.kind,
    previewInlineUrl: asset.previewInlineUrl || asset.previewUrl || (descriptor.kind === 'text' ? '' : descriptor.url),
    previewText: descriptor.kind === 'text' ? (asset.previewText || descriptor.text) : asset.previewText,
    status: asset.status,
    createdAt: asset.createdAt || new Date().toISOString(),
      day: dayToLink,
      designUrl: asset.designUrl || `/design.html?asset=${asset.id}`,
      caption: asset.caption || targetEntry.caption || '',
      cta: asset.cta || targetEntry.cta || '',
      tone: asset.tone || '',
      notes: asset.notes || '',
      assetType: asset.assetType || asset.typeLabel || '',
      campaign: asset.campaign || '',
    primaryColor: asset.primaryColor || '',
    secondaryColor: asset.secondaryColor || '',
    accentColor: asset.accentColor || '',
    headingFont: asset.headingFont || '',
    bodyFont: asset.bodyFont || '',
    lastEdited: asset.lastEdited || '',
    concept: asset.concept || '',
    slides,
  };
    targetEntry.assets = Array.isArray(targetEntry.assets) ? targetEntry.assets.filter((existing) => existing && existing.id !== summary.id) : [];
  targetEntry.assets.unshift(summary);
  targetEntry.assets = targetEntry.assets.slice(0, 5);
  if (!options.silent) {
    renderCards(currentCalendar);
    persistCurrentCalendarState();
  }
  return true;
}

function handleDesignAssetDownload(asset, fileNameOverride) {
    const normalizedSlides = Array.isArray(asset.slides) ? normalizeSlides(asset.slides) : [];
    let url = asset.bundleUrl || asset.downloadUrl;
    let revokeLater = false;
    if (!url && normalizedSlides.length) {
      url = normalizedSlides[0].downloadUrl || normalizedSlides[0].previewUrl || '';
    }
    if (!url && asset.fileBlob) {
      url = URL.createObjectURL(asset.fileBlob);
      revokeLater = true;
    }
    if (!url) {
      const blob = buildDesignPdfBlob(asset, asset);
      url = URL.createObjectURL(blob);
      revokeLater = true;
    }
    const link = document.createElement('a');
    link.href = url;
    const ext = getFileExtensionFromSource(url) || (asset.bundleUrl ? 'zip' : getAssetExtension(asset) || 'pdf');
    const dayLabel = asset.linkedDay || asset.day ? `day-${String(asset.linkedDay || asset.day).padStart(2, '0')}` : 'asset';
    const typeLabel = slugify(asset.assetType || asset.typeLabel || 'design');
    const computedName = `${dayLabel}-${typeLabel}`;
    link.download = fileNameOverride || asset.fileName || `${computedName}.${ext}`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    if (revokeLater) URL.revokeObjectURL(url);
  }
  function savePostedMap(map) { localStorage.setItem(postedKey(), JSON.stringify(map)); }
  function isPosted(day) { const map = loadPostedMap(); return !!map[String(day)]; }
  function setPosted(day, val) { const map = loadPostedMap(); if (val) map[String(day)] = true; else delete map[String(day)]; savePostedMap(map); }
  function findNextUnposted(startIdx=0) {
    for (let i=startIdx; i<currentCalendar.length; i++) { if (!isPosted(currentCalendar[i].day)) return i; }
    return Math.min(startIdx, currentCalendar.length-1);
  }
  function findPrevUnposted(startIdx){
    let i = typeof startIdx==='number'? startIdx : (hubIndex>0? hubIndex-1 : 0);
    for (; i>=0; i--) { if (!isPosted(currentCalendar[i].day)) return i; }
    return 0;
  }
  function countPosted(){
    if (!currentCalendar) return {done:0,total:0};
    let done = 0; currentCalendar.forEach(p=>{ if (isPosted(p.day)) done++; });
    return { done, total: currentCalendar.length };
  }

  // Debug: Log which elements are found
  console.log("=== DOM Elements Check ===");
  console.log("generateBtn:", generateBtn ? "✓ found" : "✗ MISSING");
  console.log("nicheInput:", nicheInput ? "✓ found" : "✗ MISSING");
  console.log("feedbackEl:", feedbackEl ? "✓ found" : "✗ MISSING");
  console.log("exportBtn:", exportBtn ? "✓ found" : "✗ MISSING");
  console.log("saveBtn:", saveBtn ? "✓ found" : "✗ MISSING");
  console.log("grid:", grid ? "✓ found" : "✗ MISSING");
  console.log("signOutBtn:", signOutBtn ? "✓ found" : "✗ MISSING");
  console.log("brandBtn:", brandBtn ? "✓ found" : "✗ MISSING");

// Show/hide nav based on auth state
async function bootstrapApp(attempt = 0) {
  const currentUser = await getCurrentUser();
  const publicNav = document.getElementById('public-nav');
  const userMenu = document.getElementById('user-menu');

  if (forceLandingView) {
    if (landingExperience) landingExperience.style.display = '';
    if (appExperience) appExperience.style.display = 'none';
    if (publicNav) publicNav.style.display = 'flex';
    if (userMenu) userMenu.style.display = 'none';
    closeProfileMenu();
    return;
  }

  if (!currentUser && forceAppAfterAuth && attempt < 6) {
    setTimeout(() => bootstrapApp(attempt + 1), 400);
    return;
  }

  console.log('Auth check - currentUser:', currentUser);
  console.log('publicNav element:', publicNav);
  console.log('userMenu element:', userMenu);

  if (currentUser) {
    // User is logged in - show profile menu
    console.log('✓ User logged in:', currentUser);
    const previousStorageUser = resolveStorageUserKey();
    activeUserEmail = currentUser;
    rememberActiveUserEmail(currentUser);
    hydrateDesignAssetsFromStorage(true);
    const switchedUsers = previousStorageUser !== resolveStorageUserKey();
    const hydratedCalendar = hydrateCalendarFromStorage(switchedUsers);
    if (hydratedCalendar) ensurePlatformVariantsForCurrentCalendar('hydrate');
    profileSettings = loadProfileSettings(currentUser);
    applyProfileSettings();
    syncProfileSettingsFromSupabase();
    refreshBrandKit();
    await refreshDesignAssetsFromServer();
    if (publicNav) publicNav.style.display = 'none';
    if (userMenu) {
      userMenu.style.display = 'flex';
      console.log('✓ User menu displayed');
    }
    if (landingExperience) landingExperience.style.display = 'none';
    if (appExperience) appExperience.style.display = '';
    if (landingNavLinks) landingNavLinks.style.display = 'none';
    closeProfileMenu();
    
    // Populate user email and profile initial
    if (userEmailEl) {
      userEmailEl.textContent = currentUser;
      console.log('✓ Email set:', currentUser);
    }
    updateAccountOverviewEmail(currentUser);
    if (profileInitial && currentUser) {
      const initial = currentUser.trim().charAt(0) || 'P';
      profileInitial.textContent = initial.toUpperCase();
    }
    
    // Show Pro badge if applicable
    const userIsPro = await isPro(currentUser);
    console.log('User is Pro:', userIsPro);
    cachedUserIsPro = userIsPro;
    updatePostFrequencyUI();
    updateAccountPlanInfo(userIsPro);
    try {
      const userDetails = await getCurrentUserDetails();
      updateAccountLastLogin(userDetails?.last_sign_in_at || userDetails?.updated_at || userDetails?.created_at || '');
    } catch (err) {
      console.warn('Unable to fetch user details', err);
      updateAccountLastLogin('');
    }
    
    if (userTierBadge) {
      userTierBadge.style.display = userIsPro ? 'inline-flex' : 'none';
      userTierBadge.textContent = userIsPro ? 'PRO' : '';
      if (userIsPro) console.log('✓ Pro badge shown');
    }

    // Show Manage Billing for PRO users
    if (manageBillingBtn) {
      manageBillingBtn.style.display = userIsPro ? 'inline-block' : 'none';
      if (userIsPro && !manageBillingBtn.dataset.bound) {
        manageBillingBtn.dataset.bound = '1';
        manageBillingBtn.addEventListener('click', async (e) => {
          e.preventDefault();
          try {
            const resp = await fetch('/api/billing/portal', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ returnUrl: window.location.href, email: currentUser })
            });
            const data = await resp.json().catch(() => ({}));
            if (resp.ok && data && data.url) {
              window.location.href = data.url;
            } else {
              alert(data?.error || 'Billing portal is not configured yet.');
            }
          } catch (err) {
            alert('Billing portal unavailable. Please try again later.');
          }
        });
      }
    }

    // Attach sign out handler now that the button is visible
    const signOutBtnNow = document.getElementById('sign-out-btn');
    if (signOutBtnNow && !signOutBtnNow.dataset.bound) {
      signOutBtnNow.dataset.bound = '1';
      signOutBtnNow.addEventListener('click', async (e) => {
        e.preventDefault();
        e.stopPropagation();
        try { await storeSignOut(); } catch(err){ console.error('signOut error:', err); }
        window.location.replace('auth.html');
      });
    }

    if (forceAppAfterAuth) {
      try { sessionStorage.removeItem('promptly_show_app'); } catch (_) {}
      forceAppAfterAuth = false;
    }
  } else {
    // User is not logged in - show public nav
    console.log('✗ No user logged in - showing public nav');
    activeUserEmail = '';
    currentBrandKit = null;
    brandKitLoaded = false;
    applyBrandKitToForm(null);
    profileSettings = loadProfileSettings();
    applyProfileSettings();
    updateAccountOverviewEmail('');
    updateAccountPlanInfo('none');
    updateAccountLastLogin('');
    if (publicNav) {
      publicNav.style.display = 'flex';
      console.log('✓ Public nav displayed');
    }
    if (userMenu) userMenu.style.display = 'none';
    if (landingExperience) landingExperience.style.display = '';
    if (appExperience) appExperience.style.display = 'none';
    cachedUserIsPro = false;
    updatePostFrequencyUI();
    if (landingNavLinks) landingNavLinks.style.display = 'flex';
    closeProfileMenu();
    rememberActiveUserEmail('');
    designAssetPollTimers.forEach((timer) => clearTimeout(timer));
    designAssetPollTimers.clear();
    designAssets = [];
    persistDesignAssetsToStorage();
    renderDesignAssets();
    hydrateCalendarFromStorage(true);
  }
}

bootstrapApp();

if (supabase?.auth?.onAuthStateChange) {
  supabase.auth.onAuthStateChange((event) => {
    if (event === 'SIGNED_IN') {
      try {
        sessionStorage.setItem('promptly_show_app', '1');
      } catch (_) {
        // Ignore storage failures (e.g., Safari private mode)
      }
    }
    bootstrapApp();
  });
}

// Profile dropdown controls

function closeProfileMenu() {
  if (profileMenu) profileMenu.style.display = 'none';
  if (profileTrigger) profileTrigger.setAttribute('aria-expanded', 'false');
  document.body.classList.remove('profile-menu-open');
}

function toggleProfileMenu() {
  if (!profileMenu || !profileTrigger) return;
  const isOpen = profileMenu.style.display === 'block';
  if (isOpen) {
    closeProfileMenu();
  } else {
    profileMenu.style.display = 'block';
    profileTrigger.setAttribute('aria-expanded', 'true');
    document.body.classList.add('profile-menu-open');
  }
}

if (profileTrigger) {
  profileTrigger.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    toggleProfileMenu();
  });
}

function findPostByDay(day) {
  const target = Number(day);
  if (!Array.isArray(currentCalendar)) return null;
  return currentCalendar.find((post) => Number(post.day) === target);
}

function buildCalendarDayIdentifier(entry, day) {
  if (entry?.calendar_day_id) return String(entry.calendar_day_id);
  if (entry?.calendarDayId) return String(entry.calendarDayId);
  if (entry?.id) return String(entry.id);
  if (Number.isFinite(day) && day > 0) {
    const slotSuffix = entry && entry.slot ? `-slot-${entry.slot}` : '';
    return `day-${String(day).padStart(2, '0')}${slotSuffix}`;
  }
  return `session-${Date.now()}`;
}

if (profileMenu) {
  profileMenu.addEventListener('click', (event) => {
    event.stopPropagation();
  });
}

document.addEventListener('click', (event) => {
  if (!profileMenu || !profileTrigger) return;
  const target = event.target;
  if (profileTrigger.contains(target)) return;
  closeProfileMenu();
});

const postFrequencyContainer = document.querySelector('.post-frequency');
if (postFrequencyContainer) {
  postFrequencyContainer.addEventListener('pointerdown', () => {
    closeProfileMenu();
  });
}

if (postFrequencySelect) {
  postFrequencySelect.addEventListener('focus', () => {
    closeProfileMenu();
  });
}

const bindProfileMenuAction = (btn, handler) => {
  if (!btn) return;
  const invoke = (event) => {
    if (event) {
      event.preventDefault();
      event.stopPropagation();
    }
    handler();
  };
  let pointerTriggered = false;
  btn.addEventListener('pointerdown', (event) => {
    if (event.button !== undefined && event.button !== 0) return;
    pointerTriggered = true;
    invoke(event);
  });
  btn.addEventListener('click', (event) => {
    if (pointerTriggered) {
      pointerTriggered = false;
      return;
    }
    invoke(event);
  });
  btn.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      invoke(event);
    }
  });
};

bindProfileMenuAction(accountOverviewBtn, () => {
  closeProfileMenu();
  if (accountModal) {
    openAccountModal('account');
  } else {
    window.location.href = '/#account';
  }
});

bindProfileMenuAction(profileSettingsBtn, () => {
  closeProfileMenu();
  if (accountModal) {
    openAccountModal('profile');
  } else {
    window.location.href = '/#profile-settings';
  }
});

bindProfileMenuAction(passwordSettingsBtn, () => {
  closeProfileMenu();
  window.location.href = 'reset-password.html';
});

if (accountCloseBtn) {
  accountCloseBtn.addEventListener('click', () => {
    closeAccountModal();
  });
}

if (accountCancelBtn) {
  accountCancelBtn.addEventListener('click', () => {
    closeAccountModal();
  });
}

if (accountModal) {
  accountModal.addEventListener('click', (event) => {
    if (event.target === accountModal) {
      closeAccountModal();
    }
  });
}

if (document) {
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      closeAccountModal();
    }
  });
}

if (accountEmailCopyBtn) {
  const defaultLabel = accountEmailCopyBtn.textContent || 'Copy';
  accountEmailCopyBtn.addEventListener('click', async () => {
    if (!activeUserEmail) return;
    try {
      await navigator.clipboard.writeText(activeUserEmail);
      accountEmailCopyBtn.textContent = 'Copied!';
      setTimeout(() => {
        accountEmailCopyBtn.textContent = defaultLabel;
      }, 1200);
    } catch (e) {
      console.warn('Unable to copy email', e);
    }
  });
}

if (accountPasswordManageBtn) {
  accountPasswordManageBtn.addEventListener('click', () => {
    closeAccountModal();
    window.location.href = 'reset-password.html';
  });
}

if (postFrequencySelect) {
  const guardFreeChange = (event) => {
    if (cachedUserIsPro) return false;
    event?.preventDefault();
    postFrequencySelect.value = '1';
    postFrequencySelect.blur();
    if (typeof showUpgradeModal === 'function') showUpgradeModal();
    return true;
  };

  postFrequencySelect.addEventListener('mousedown', (event) => {
    if (guardFreeChange(event)) return;
  });

  postFrequencySelect.addEventListener('keydown', (event) => {
    if (event.key === ' ' || event.key === 'Enter') {
      if (guardFreeChange(event)) return;
    }
  });

  postFrequencySelect.addEventListener('change', () => {
    if (guardFreeChange()) return;
    setPostFrequency(postFrequencySelect.value);
  });
}

if (accountForm) {
  accountForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (accountFeedback) {
      accountFeedback.textContent = activeUserEmail ? 'Saving preferences...' : 'Preferences saved locally.';
      accountFeedback.classList.remove('error');
      accountFeedback.classList.remove('success');
    }

    const payload = {
      displayName: accountDisplayNameInput?.value.trim() || '',
      pronouns: accountPronounsInput?.value.trim() || '',
      role: accountRoleInput?.value.trim() || '',
      highContrast: !!prefersHighContrastInput?.checked,
      largeType: !!prefersLargeTypeInput?.checked,
      reducedMotion: !!prefersReducedMotionInput?.checked
    };
    const persistResult = updateProfileSettings(payload, { targetEmail: activeUserEmail });

    let syncedToSupabase = false;
    let shouldCloseModal = !activeUserEmail;
    let localSaveNote = persistResult?.volatile ? ' Settings will reset when you close this tab.' : '';

    if (activeUserEmail) {
      try {
        const savedRemote = await saveProfilePreferences(profileSettings);
        updateProfileSettings(savedRemote, { replace: true, targetEmail: activeUserEmail });
        syncedToSupabase = true;
        shouldCloseModal = true;
      } catch (error) {
        console.warn('Unable to sync profile settings to Supabase', error);
        shouldCloseModal = false;
      }
    }

    if (accountFeedback) {
      if (syncedToSupabase) {
        accountFeedback.textContent = `Preferences saved.${localSaveNote}`;
        accountFeedback.classList.add('success');
      } else if (!activeUserEmail) {
        accountFeedback.textContent = `Preferences saved locally.${localSaveNote}`;
        accountFeedback.classList.add('success');
      } else {
        accountFeedback.textContent = `Saved locally, but syncing failed. Try again soon.${localSaveNote}`;
        accountFeedback.classList.add('error');
      }
    }

    if (shouldCloseModal) {
      setTimeout(() => {
        closeAccountModal();
        if (accountFeedback) {
          accountFeedback.textContent = '';
          accountFeedback.classList.remove('success', 'error');
        }
      }, 800);
    }
  });
}

function setupLandingNavScroll() {
  if (!landingNavAnchors || landingNavAnchors.length === 0) return;
  landingNavAnchors.forEach((anchor) => {
    anchor.addEventListener('click', (event) => {
      const targetId = anchor.getAttribute('href');
      if (!targetId || !targetId.startsWith('#')) return;
      const section = document.querySelector(targetId);
      if (!section) return;
      event.preventDefault();
      section.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  });
}

setupLandingNavScroll();

function setupLandingSampleActionRedirects() {
  if (!landingSampleActionButtons || landingSampleActionButtons.length === 0) return;
  landingSampleActionButtons.forEach((button) => {
    button.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      window.location.href = '/auth.html?mode=signup';
    });
  });
}

setupLandingSampleActionRedirects();

// Sign out handler is attached after auth check when user-menu is shown

// Upgrade modal handlers
function showUpgradeModal() {
  if (upgradeModal) upgradeModal.style.display = 'flex';
}

function hideUpgradeModal() {
  if (upgradeModal) upgradeModal.style.display = 'none';
}

if (upgradeClose) {
  upgradeClose.addEventListener('click', hideUpgradeModal);
}

if (upgradeModal) {
  upgradeModal.addEventListener('click', (e) => {
    if (e.target === upgradeModal) hideUpgradeModal();
  });
}

if (upgradeBtn) {
  upgradeBtn.addEventListener('click', async () => {
    const fallbackUrl = 'https://buy.stripe.com/5kQ5kE3Qw1G8aWoe5Cgbm00?locale=en';
    try {
      // Try in-app Checkout first
      const user = await getCurrentUser();
      const resp = await fetch('/api/billing/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: user || '', priceLookupKey: 'promptly_pro_monthly' })
      });
      const data = await resp.json().catch(()=>({}));
      if (resp.ok && data && data.url) {
        window.location.href = data.url;
        return;
      }
      // Fallback to Payment Link if not configured
      const win = window.open(fallbackUrl, '_blank', 'noopener,noreferrer');
      if (!win) window.location.href = fallbackUrl;
      if (typeof hideUpgradeModal === 'function') hideUpgradeModal();
    } catch (e) {
      // Final fallback
      window.location.href = fallbackUrl;
    }
  });
}

// Export function for other parts of the app to trigger upgrade modal
window.showUpgradeModal = showUpgradeModal;

// Library tab handler

// Brand Brain modal handlers
function openBrandModal() {
  // Use flex to take advantage of modal-overlay centering styles
  if (brandModal) brandModal.style.display = 'flex';
}
function closeBrandModal() {
  if (brandModal) brandModal.style.display = 'none';
}

function updateBrandLogoPreview(src) {
  if (!brandLogoPreview) return;
  if (src) {
    brandLogoPreview.src = src;
    brandLogoPreview.style.display = 'block';
    brandLogoPreview.dataset.logo = src;
    if (brandLogoPlaceholder) brandLogoPlaceholder.style.display = 'none';
  } else {
    brandLogoPreview.removeAttribute('src');
    brandLogoPreview.style.display = 'none';
    if (brandLogoPreview.dataset) delete brandLogoPreview.dataset.logo;
    if (brandLogoPlaceholder) brandLogoPlaceholder.style.display = 'block';
  }
}

function applyBrandKitToForm(kit) {
  const defaults = {
    primaryColor: '#7f5af0',
    secondaryColor: '#2cb1bc',
    accentColor: '#ff7ac3',
  };
  if (brandPrimaryColorInput) brandPrimaryColorInput.value = kit?.primaryColor || defaults.primaryColor;
  if (brandSecondaryColorInput) brandSecondaryColorInput.value = kit?.secondaryColor || defaults.secondaryColor;
  if (brandAccentColorInput) brandAccentColorInput.value = kit?.accentColor || defaults.accentColor;
  if (brandHeadingFontInput) brandHeadingFontInput.value = kit?.headingFont || '';
  if (brandBodyFontInput) brandBodyFontInput.value = kit?.bodyFont || '';
  updateFontPickerSelection('brand-heading-font', brandHeadingFontInput?.value || '');
  updateFontPickerSelection('brand-body-font', brandBodyFontInput?.value || '');
  updateBrandLogoPreview(kit?.logoDataUrl || '');
  renderDesignLivePreview();
}

function serializeBrandKitForm() {
  return {
    primaryColor: brandPrimaryColorInput?.value || '',
    secondaryColor: brandSecondaryColorInput?.value || '',
    accentColor: brandAccentColorInput?.value || '',
    headingFont: brandHeadingFontInput?.value?.trim() || '',
    bodyFont: brandBodyFontInput?.value?.trim() || '',
    logoDataUrl: brandLogoPreview?.dataset.logo ?? '',
  };
}

function updateFontPickerSelection(targetId, value) {
  fontPickers.forEach((picker) => {
    if (picker.dataset.target !== targetId) return;
    const options = Array.from(picker.querySelectorAll('.font-picker__option'));
    let activeOption = null;
    options.forEach((btn) => {
      const isMatch = (btn.dataset.font || '') === (value || '');
      btn.classList.toggle('is-active', isMatch);
      if (isMatch) activeOption = btn;
    });
    const label = picker.querySelector('.font-picker__label');
    if (label) {
      label.className = 'font-picker__label';
      if (activeOption) {
        label.textContent = activeOption.textContent.trim();
        if (activeOption.dataset.previewClass) {
          label.classList.add(activeOption.dataset.previewClass);
        }
      } else {
        label.textContent = 'Default';
      }
    }
  });
}

function summarizeBrandKitBrief(kit) {
  if (!kit) return '';
  const parts = [];
  const palette = [kit.primaryColor, kit.secondaryColor, kit.accentColor].filter(Boolean);
  if (palette.length) parts.push(`Palette ${palette.join(', ')}`);
  const fonts = [kit.headingFont, kit.bodyFont].filter(Boolean);
  if (fonts.length) parts.push(`Fonts ${fonts.join(' / ')}`);
  if (kit.logoDataUrl) parts.push('Reserve space for logo mark.');
  return parts.join(' | ');
}

function brandBrainLocalKey(email = activeUserEmail) {
  const normalized = (email || 'guest').toString().trim().toLowerCase();
  return `${BRAND_BRAIN_LOCAL_PREFIX}${normalized || 'guest'}`;
}

function loadBrandBrainLocal(email = activeUserEmail) {
  try {
    return localStorage.getItem(brandBrainLocalKey(email)) || '';
  } catch {
    return '';
  }
}

function persistBrandBrainLocal(text, email = activeUserEmail) {
  try {
    const key = brandBrainLocalKey(email);
    if (!text) localStorage.removeItem(key);
    else localStorage.setItem(key, text);
  } catch (_) {}
}

function brandKitLocalKey(email = activeUserEmail) {
  const normalized = (email || 'guest').toString().trim().toLowerCase();
  return `${BRAND_KIT_LOCAL_PREFIX}${normalized || 'guest'}`;
}

function loadBrandKitLocal(email = activeUserEmail) {
  try {
    const raw = localStorage.getItem(brandKitLocalKey(email));
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function persistBrandKitLocal(kit, email = activeUserEmail) {
  try {
    const key = brandKitLocalKey(email);
    if (!kit) {
      localStorage.removeItem(key);
    } else {
      localStorage.setItem(key, JSON.stringify(kit));
    }
  } catch (_) {}
}

async function refreshBrandBrain(force = false) {
  if (brandProfileLoaded && !force) return currentBrandText;
  const userId = activeUserEmail || (await getCurrentUser());
  if (!userId) return '';
  const localCopy = loadBrandBrainLocal(userId);
  if (!brandProfileLoaded && localCopy && brandText) {
    brandText.value = localCopy;
    currentBrandText = localCopy;
  }
  try {
    const resp = await fetch(`/api/brand/profile?userId=${encodeURIComponent(userId)}`, {
      cache: 'no-store',
      redirect: 'manual',
    });
    if (resp.ok) {
      const data = await resp.json().catch(() => ({}));
      currentBrandText = data.text || localCopy || '';
      if (brandText) brandText.value = currentBrandText;
      persistBrandBrainLocal(currentBrandText, userId);
    } else {
      console.warn('Brand profile request failed with status', resp.status);
    }
  } catch (err) {
    console.warn('Unable to load Brand Brain profile:', err?.message || err);
  }
  brandProfileLoaded = true;
  return currentBrandText;
}

async function refreshBrandKit(force = false) {
  if (brandKitLoaded && !force) return currentBrandKit;
  const userId = activeUserEmail || await getCurrentUser();
  if (!userId) return null;
  const localKit = loadBrandKitLocal(userId);
  if (!brandKitLoaded && localKit) {
    currentBrandKit = localKit;
    applyBrandKitToForm(currentBrandKit);
  }
  try {
    const resp = await fetch(`/api/brand/kit?userId=${encodeURIComponent(userId)}`, { cache: 'no-store', redirect: 'manual' });
    if (resp.ok) {
      const data = await resp.json().catch(() => ({}));
      currentBrandKit = data.kit || localKit || null;
      persistBrandKitLocal(currentBrandKit, userId);
      applyBrandKitToForm(currentBrandKit);
    } else {
      throw new Error('kit endpoint unavailable');
    }
  } catch (err) {
    console.warn('Brand Design fetch failed, falling back to profile preferences:', err?.message || err);
    try {
      const prefs = await getProfilePreferences();
      currentBrandKit = prefs?.brandKit || localKit || null;
      persistBrandKitLocal(currentBrandKit, userId);
      applyBrandKitToForm(currentBrandKit);
    } catch (fallbackErr) {
      console.warn('Unable to load Brand Design from preferences:', fallbackErr?.message || fallbackErr);
    }
  }
  brandKitLoaded = true;
  return currentBrandKit;
}

async function handleBrandKitSave() {
  const userId = activeUserEmail || await getCurrentUser();
  if (!userId) {
    if (brandKitStatus) brandKitStatus.textContent = 'Sign in to save your Brand Design.';
    return;
  }
  const kitPayload = serializeBrandKitForm();
  if (brandKitStatus) {
    brandKitStatus.textContent = 'Saving Brand Design...';
    brandKitStatus.classList.remove('success');
  }
  if (brandKitSaveBtn) brandKitSaveBtn.disabled = true;
  let saved = false;
  try {
    const resp = await fetch('/api/brand/kit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId, kit: kitPayload }),
      redirect: 'manual',
    });
    if (resp.ok) {
      const data = await resp.json().catch(() => ({}));
      currentBrandKit = data.kit || kitPayload;
      saved = true;
      persistBrandKitLocal(currentBrandKit, userId);
    } else {
      throw new Error('Kit API unavailable');
    }
  } catch (err) {
    console.warn('Brand Design save via API failed, falling back to profile preferences:', err?.message || err);
    try {
      const prefs = await getProfilePreferences();
      const nextPrefs = Object.assign({}, prefs, { brandKit: kitPayload });
      await saveProfilePreferences(nextPrefs);
      currentBrandKit = kitPayload;
      saved = true;
      persistBrandKitLocal(currentBrandKit, userId);
    } catch (fallbackErr) {
      console.error('Brand Design fallback save failed:', fallbackErr);
      if (brandKitStatus) {
        brandKitStatus.textContent = fallbackErr.message || 'Unable to save Brand Design';
        brandKitStatus.classList.remove('success');
      }
    }
    if (!saved) {
      currentBrandKit = kitPayload;
      persistBrandKitLocal(currentBrandKit, userId);
      saved = true;
    }
  } finally {
    if (brandKitSaveBtn) brandKitSaveBtn.disabled = false;
    if (brandKitStatus) {
      if (saved) {
        brandKitStatus.textContent = '✓ Brand design saved';
        brandKitStatus.classList.add('success');
        brandKitLoaded = true;
        applyBrandKitToForm(currentBrandKit);
        closeBrandModal();
      }
      setTimeout(() => {
        brandKitStatus.textContent = '';
        brandKitStatus.classList.remove('success');
      }, 2600);
    }
  }
}

function handleBrandLogoUpload(event) {
  const file = event?.target?.files?.[0];
  if (!file) return;
  if (file.size > 2 * 1024 * 1024) {
    if (brandKitStatus) {
      brandKitStatus.textContent = 'Logo is too large (max 2MB).';
      brandKitStatus.classList.remove('success');
    }
    event.target.value = '';
    return;
  }
  const reader = new FileReader();
  reader.onload = () => {
    const result = reader.result;
    if (typeof result === 'string' && result.startsWith('data:image/')) {
      updateBrandLogoPreview(result);
    } else if (brandKitStatus) {
      brandKitStatus.textContent = 'Unsupported logo format.';
    }
  };
  reader.readAsDataURL(file);
}

function clearBrandLogoPreview() {
  if (brandLogoInput) brandLogoInput.value = '';
  updateBrandLogoPreview('');
}

if (brandPrimaryColorInput || brandSecondaryColorInput || brandAccentColorInput) {
  applyBrandKitToForm(null);
}

fontPickers = Array.from(document.querySelectorAll('.font-picker'));
if (fontPickers.length) {
  const closeAllFontPickers = () => fontPickers.forEach((picker) => picker.classList.remove('is-open'));

  document.addEventListener('click', (event) => {
    const trigger = event.target.closest('.font-picker__trigger');
    if (trigger) {
      event.preventDefault();
      const picker = trigger.closest('.font-picker');
      if (!picker) return;
      const targetId = picker.dataset.target;
      const isOpen = picker.classList.contains('is-open');
      closeAllFontPickers();
      if (!isOpen) {
        picker.classList.add('is-open');
        const currentValue = document.getElementById(targetId)?.value || '';
        updateFontPickerSelection(targetId, currentValue);
      }
      return;
    }

    const option = event.target.closest('.font-picker__option');
    if (option && option.closest('.font-picker')) {
      const picker = option.closest('.font-picker');
      const targetId = picker?.dataset.target;
      if (targetId) {
        const targetInput = document.getElementById(targetId);
        if (targetInput) targetInput.value = option.dataset.font || '';
        updateFontPickerSelection(targetId, option.dataset.font || '');
        picker.classList.remove('is-open');
      }
      return;
    }

    if (!event.target.closest('.font-picker')) {
      closeAllFontPickers();
    }
  });

  updateFontPickerSelection('brand-heading-font', brandHeadingFontInput?.value || '');
  updateFontPickerSelection('brand-body-font', brandBodyFontInput?.value || '');
}

if (brandBtn && brandModal) {
  brandBtn.addEventListener('click', async () => {
console.log('Brand Brain clicked');
    const user = await getCurrentUser();
    console.log('Current user:', user);
    const userIsPro = await isPro(user);
    console.log('User is Pro:', userIsPro);
    if (!userIsPro) {
      console.log('Showing upgrade modal');
      showUpgradeModal();
      return;
    }
    await Promise.all([refreshBrandKit(), refreshBrandBrain()]);
    console.log('Opening brand modal');
    openBrandModal();
  });
}
if (brandCancelBtn) {
  brandCancelBtn.addEventListener('click', () => {
    closeBrandModal();
  });
}
if (brandSaveBtn) {
  brandSaveBtn.addEventListener('click', async () => {
    const userId = await getCurrentUser();
    if (!userId) {
      alert('Please sign in to save Brand Brain.');
      return;
    }
    const text = brandText ? brandText.value.trim() : '';
    if (!text) {
      if (brandStatus) brandStatus.textContent = 'Please paste some brand text.';
      return;
    }
    try {
      brandSaveBtn.disabled = true;
      brandSaveBtn.textContent = 'Saving...';
      const resp = await fetch('/api/brand/ingest', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId, text }),
      });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error || 'Failed to save brand');
      if (brandStatus) {
        brandStatus.textContent = `✓ Brand Brain updated (${data.chunks} chunks). Future generations will match your voice.`;
        brandStatus.classList.add('success');
      }
      currentBrandText = text;
      persistBrandBrainLocal(text, userId);
      brandProfileLoaded = true;
      setTimeout(() => { closeBrandModal(); if (brandStatus) { brandStatus.textContent=''; brandStatus.classList.remove('success'); } }, 1500);
    } catch (e) {
      if (brandStatus) brandStatus.textContent = `Error: ${e.message}`;
    } finally {
      brandSaveBtn.disabled = false;
      brandSaveBtn.textContent = 'Save to Brand Brain';
    }
  });
}
if (brandKitSaveBtn) {
  brandKitSaveBtn.addEventListener('click', (event) => {
    event.preventDefault();
    handleBrandKitSave();
  });
}
if (brandLogoInput) {
  brandLogoInput.addEventListener('change', handleBrandLogoUpload);
}
if (brandLogoClearBtn) {
  brandLogoClearBtn.addEventListener('click', (event) => {
    event.preventDefault();
    clearBrandLogoPreview();
  });
}

const createCard = (post) => {
  const entries = Array.isArray(post.multiPosts) && post.multiPosts.length ? post.multiPosts : [post];
  const primary = entries[0] || post;
  const dayValue = typeof post.day === 'number' ? post.day : (primary.day || '');
  const card = document.createElement('article');
  card.className = 'calendar-card';
  card.dataset.pillar = primary.pillar || '';
  card.dataset.day = dayValue != null ? String(dayValue) : '';
  const resolvedCalendarId =
    primary.calendar_day_id ||
    primary.calendarDayId ||
    primary.id ||
    null;
  if (resolvedCalendarId) {
    card.dataset.calendarDayId = String(resolvedCalendarId);
  }
  if (isPosted(dayValue)) card.classList.add('posted');

  const dayEl = document.createElement('div');
  dayEl.className = 'calendar-card__day';
  dayEl.textContent = String(dayValue).padStart(2, '0');

  const entriesWrap = document.createElement('div');
  entriesWrap.className = 'calendar-card__entries';
  if (entries.length > 1) entriesWrap.classList.add('calendar-card__entries--multi');

  entries.forEach((entry, idx) => entriesWrap.appendChild(buildEntry(entry, idx)));

  card.append(dayEl, entriesWrap);
  return card;

  function buildEntry(entry, idx) {
    const entryEl = document.createElement('div');
    entryEl.className = 'calendar-card__entry';
    entryEl.dataset.entryIndex = String(idx);
    entryEl.dataset.day = dayValue != null ? String(dayValue) : '';

    if (entries.length > 1) {
      const badge = document.createElement('div');
      badge.className = 'calendar-card__entry-badge';
      badge.textContent = `Post ${idx + 1}`;
      entryEl.appendChild(badge);
    }

    const {
      idea,
      title,
      type,
      caption,
      description,
      hashtags,
      format,
      cta,
      pillar,
      storyPrompt,
      designNotes,
      repurpose,
      analytics,
      engagementScripts,
      engagementScript,
      promoSlot,
      videoScript,
      weeklyPromo,
    } = entry;
    const entryDay = typeof entry.day === 'number' ? entry.day : dayValue;

    if (!card.dataset.pillar && pillar) {
      card.dataset.pillar = pillar;
    }

    const ideaEl = document.createElement('h3');
    ideaEl.className = 'calendar-card__title';
    ideaEl.textContent = idea || title || '';

    const typeEl = document.createElement('span');
    typeEl.className = 'calendar-card__type';
    typeEl.textContent = type ? type.charAt(0).toUpperCase() + type.slice(1) : '';

    const captionRow = document.createElement('div');
    captionRow.className = 'calendar-card__caption-row';
    const captionEl = document.createElement('p');
    captionEl.className = 'calendar-card__caption';
    captionEl.textContent = caption || description || '';
    const captionCopyBtn = document.createElement('button');
    captionCopyBtn.type = 'button';
    captionCopyBtn.className = 'detail-copy-btn caption-copy-btn';
    captionCopyBtn.setAttribute('aria-label', 'Copy caption');
    captionCopyBtn.innerHTML = `<svg class="detail-copy-icon" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6">
      <path d="M6 7.5V4.5C6 3.39543 6.89543 2.5 8 2.5H14C15.1046 2.5 16 3.39543 16 4.5V12.5C16 13.6046 15.1046 14.5 14 14.5H11"/>
      <rect x="4" y="5.5" width="8" height="10" rx="2"/>
    </svg>`;
    captionCopyBtn.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(caption || description || '');
        captionCopyBtn.classList.add('copied');
        setTimeout(() => captionCopyBtn.classList.remove('copied'), 800);
      } catch (e) {}
    });
    captionRow.append(captionEl, captionCopyBtn);

    const hashtagsEl = document.createElement('div');
    hashtagsEl.className = 'calendar-card__hashtags';
    if (Array.isArray(hashtags)) {
      hashtagsEl.textContent = hashtags.map((h) => (h.startsWith('#') ? h : `#${h}`)).join(' ');
    } else if (typeof hashtags === 'string') {
      hashtagsEl.textContent = hashtags;
    }

    const createDetailRow = (label, value, className) => {
      if (!value) return null;
      const row = document.createElement('div');
      row.className = `${className} calendar-card__detail-row`;
      const header = document.createElement('div');
      header.className = 'detail-row__top';
      const labelEl = document.createElement('strong');
      labelEl.textContent = `${label}:`;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'detail-copy-btn';
      btn.setAttribute('aria-label', `Copy ${label}`);
      btn.innerHTML = `<svg class="detail-copy-icon" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6">
        <path d="M6 7.5V4.5C6 3.39543 6.89543 2.5 8 2.5H14C15.1046 2.5 16 3.39543 16 4.5V12.5C16 13.6046 15.1046 14.5 14 14.5H11"/>
        <rect x="4" y="5.5" width="8" height="10" rx="2"/>
      </svg>`;
      btn.addEventListener('click', async () => {
        try {
        await navigator.clipboard.writeText(value);
        btn.classList.add('copied');
        setTimeout(() => btn.classList.remove('copied'), 800);
      } catch (e) {}
      });
      header.append(labelEl, btn);
      const textEl = document.createElement('span');
      textEl.className = 'detail-text';
      textEl.textContent = value;
      row.append(header, textEl);
      return row;
    };
    const buildLinkedAssetsRow = (entryData) => {
      if (true) return null; // hide calendar-surface AI assets
      const assets = Array.isArray(entryData?.assets) ? entryData.assets : [];
      if (!assets.length) return null;
      const container = document.createElement('div');
      container.className = 'calendar-card__assets calendar-card__detail-row';
      const header = document.createElement('div');
      header.className = 'detail-row__top';
      const labelEl = document.createElement('strong');
      labelEl.textContent = assets.length > 1 ? 'AI Assets' : 'AI Asset';
      header.append(labelEl);
      container.appendChild(header);
      const grid = document.createElement('div');
      grid.className = 'calendar-card__asset-grid';
      assets.forEach((asset) => {
        const card = document.createElement('div');
        card.className = 'calendar-card__asset-card';
        const preview = document.createElement('div');
        preview.className = 'calendar-card__asset-preview';
        const descriptor = buildAssetPreviewDescriptor(asset);
        if (descriptor.kind === 'carousel' && descriptor.slides?.length) {
          preview.innerHTML = buildCarouselSliderHtml(descriptor.slides, { context: 'calendar' });
        } else if (descriptor.kind === 'image' && descriptor.url) {
          const img = document.createElement('img');
          img.src = descriptor.url;
          img.alt = asset.title || 'AI asset preview';
          img.loading = 'lazy';
          preview.appendChild(img);
        } else if (descriptor.kind === 'video' && descriptor.url) {
          const video = document.createElement('video');
          video.src = descriptor.url;
          video.controls = true;
          video.playsInline = true;
          video.preload = 'metadata';
          preview.appendChild(video);
        } else {
          const text = document.createElement('div');
          text.className = 'calendar-card__asset-preview-text';
          text.textContent = descriptor.text || asset.previewText || asset.typeLabel || 'AI asset ready';
          preview.appendChild(text);
        }
        card.appendChild(preview);
        const meta = document.createElement('div');
        meta.className = 'calendar-card__asset-meta';
        const typeEl = document.createElement('strong');
        typeEl.textContent = asset.typeLabel || asset.title || 'AI Asset';
        meta.appendChild(typeEl);
        if (asset.status === 'rendering' || asset.status === 'queued') {
          const renderingStatus = document.createElement('span');
          renderingStatus.className = 'calendar-card__asset-status calendar-card__asset-status--rendering';
          renderingStatus.textContent = 'Rendering…';
          meta.appendChild(renderingStatus);
        } else if (asset.status === 'failed') {
          const failedStatus = document.createElement('span');
          failedStatus.className = 'calendar-card__asset-status calendar-card__asset-status--failed';
          failedStatus.textContent = 'Failed';
          meta.appendChild(failedStatus);
        }
        if (asset.title) {
          const titleLine = document.createElement('span');
          titleLine.textContent = asset.title;
          meta.appendChild(titleLine);
        }
        if (asset.caption) {
          const captionLine = document.createElement('p');
          captionLine.textContent = asset.caption;
          meta.appendChild(captionLine);
        }
        if (asset.day || entryData?.day) {
          const badge = document.createElement('span');
          badge.className = 'calendar-card__asset-badge';
          const assetDay = asset.day || entryData?.day;
          badge.textContent = assetDay ? `Linked to Day ${String(assetDay).padStart(2, '0')}` : 'Linked to calendar';
          meta.appendChild(badge);
        }
        const slideChips = buildSlideChipRowHtml(asset.slides, 'calendar');
        if (slideChips) {
          meta.insertAdjacentHTML('beforeend', slideChips);
        }
        card.appendChild(meta);
        const actions = document.createElement('div');
        actions.className = 'calendar-card__asset-actions';
        const assetSnapshot = encodeURIComponent(
          JSON.stringify({
            ...asset,
            previewInlineUrl: asset.previewInlineUrl || '',
          })
        );
        if (asset.designUrl || asset.id) {
          const viewLink = document.createElement('button');
          viewLink.type = 'button';
          viewLink.className = 'calendar-card__asset-btn ghost calendar-card__asset-btn--view';
          viewLink.textContent = 'View/Edit';
          viewLink.dataset.designUrl = asset.designUrl || `/design.html?asset=${asset.id}`;
          viewLink.dataset.asset = assetSnapshot;
          actions.appendChild(viewLink);
        }
        if (asset.status === 'failed') {
          const failedNote = document.createElement('span');
          failedNote.className = 'calendar-card__asset-note';
          failedNote.textContent = 'Rendering failed. Try again in Design Lab.';
          actions.appendChild(failedNote);
        }
        if (!((asset.status === 'rendering' || asset.status === 'queued') && !asset.downloadUrl)) {
          const downloadLabel = Array.isArray(asset.slides) && asset.slides.length ? 'Download ZIP' : 'Download';
          const downloadBtn = document.createElement('button');
          downloadBtn.type = 'button';
          downloadBtn.className = 'calendar-card__asset-btn calendar-card__asset-btn--download';
          downloadBtn.textContent = downloadLabel;
          downloadBtn.dataset.asset = assetSnapshot;
          actions.appendChild(downloadBtn);
        }
        card.appendChild(actions);
        grid.appendChild(card);
      });
      container.appendChild(grid);
      return container;
    };

    const formatEl = createDetailRow('Format', format, 'calendar-card__format');
    const ctaEl = createDetailRow('CTA', cta, 'calendar-card__cta');

    const storyPromptText = storyPrompt || '';
    const storyPromptEl = storyPromptText ? createDetailRow('Story Prompt', storyPromptText, 'calendar-card__story') : null;

    const designNotesText = designNotes || '';
    const designNotesEl = designNotesText ? createDetailRow('Design Notes', designNotesText, 'calendar-card__design') : null;

    const repurposeText = repurpose ? (Array.isArray(repurpose) ? repurpose.join(' • ') : repurpose) : '';
    const repurposeEl = repurposeText ? createDetailRow('Repurpose', repurposeText, 'calendar-card__repurpose') : null;

    const analyticsText = analytics ? (Array.isArray(analytics) ? analytics.join(', ') : analytics) : '';
    const analyticsEl = analyticsText ? createDetailRow('Analytics', analyticsText, 'calendar-card__analytics') : null;

    let engagementText = '';
    if (engagementScripts && (engagementScripts.commentReply || engagementScripts.dmReply)) {
      const parts = [];
      if (engagementScripts.commentReply) parts.push(`Comment: ${engagementScripts.commentReply}`);
      if (engagementScripts.dmReply) parts.push(`DM: ${engagementScripts.dmReply}`);
      engagementText = parts.join(' | ');
    } else if (engagementScript) {
      engagementText = engagementScript;
    }
    const engagementEl = engagementText ? createDetailRow('Engagement', engagementText, 'calendar-card__engagement') : null;

    const promoSlotEl = promoSlot
      ? (() => {
          const node = document.createElement('div');
          node.className = 'calendar-card__promo';
          node.innerHTML = `<strong>Weekly Promo Slot:</strong> Yes`;
          return node;
        })()
      : null;

    const weeklyPromoEl = weeklyPromo ? createDetailRow('Promo', weeklyPromo, 'calendar-card__weekly-promo') : null;

    const videoScriptText =
      videoScript && (videoScript.hook || videoScript.body || videoScript.cta)
        ? [videoScript.hook && `Hook: ${videoScript.hook}`, videoScript.body && `Body: ${videoScript.body}`, videoScript.cta && `CTA: ${videoScript.cta}`]
            .filter(Boolean)
            .join(' | ')
        : '';
    const videoScriptEl = videoScriptText ? createDetailRow(format === 'Reel' ? 'Reel Script' : 'Video Script', videoScriptText, 'calendar-card__video') : null;

    const variantText =
      entry.variants && (entry.variants.igCaption || entry.variants.tiktokCaption || entry.variants.linkedinCaption)
        ? [
            entry.variants.igCaption && `Instagram: ${entry.variants.igCaption}`,
            entry.variants.tiktokCaption && `TikTok: ${entry.variants.tiktokCaption}`,
            entry.variants.linkedinCaption && `LinkedIn: ${entry.variants.linkedinCaption}`,
          ]
            .filter(Boolean)
            .join(' | ')
        : '';
    const variantsEl = variantText ? createDetailRow('Platform Variants', variantText, 'calendar-card__variants') : null;
    const assetsEl = null; // Calendar asset cards hidden

    const actionsEl = document.createElement('div');
    actionsEl.className = 'calendar-card__actions';
    const makeBtn = (label) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'calendar-card__action ghost';
      b.style.fontSize = '0.8rem';
      b.style.padding = '0.3rem 0.6rem';
      b.textContent = label;
      return b;
    };
    const attachProAction = (button, handler) => {
      if (!button || typeof handler !== 'function') return null;
      button.classList.remove('ghost');
      button.classList.add('pro-gradient-btn');
      button.addEventListener('click', async (event) => {
        event.preventDefault();
        const user = await getCurrentUser();
        const userIsPro = await isPro(user);
        if (!userIsPro) {
          showUpgradeModal();
          return;
        }
        try {
          await handler(event);
        } catch (err) {
          console.error('Pro action error', err);
        }
      });
      return button;
    };
    const btnCopyFull = makeBtn('Copy Full');
    const btnDownloadDoc = makeBtn('Download');
    const captionBtn = null;

    const fullTextParts = [];
    const dayLabel = `Day ${String(entryDay).padStart(2, '0')}${entries.length > 1 ? ` • Post ${idx + 1}` : ''}`;
    fullTextParts.push(dayLabel);
    if (idea || title) fullTextParts.push(`Idea: ${idea || title}`);
    if (type) fullTextParts.push(`Type: ${type}`);
    if (caption) fullTextParts.push(`Caption: ${caption}`);
    if (Array.isArray(hashtags) && hashtags.length) {
      fullTextParts.push(`Hashtags: ${hashtags.map((h) => (h.startsWith('#') ? h : `#${h}`)).join(' ')}`);
    } else if (typeof hashtags === 'string' && hashtags.trim()) {
      fullTextParts.push(`Hashtags: ${hashtags}`);
    }
    if (format) fullTextParts.push(`Format: ${format}`);
    if (cta) fullTextParts.push(`CTA: ${cta}`);
    if (storyPrompt) fullTextParts.push(`Story Prompt: ${storyPrompt}`);
    if (designNotes) fullTextParts.push(`Design Notes: ${designNotes}`);
    if (repurpose && Array.isArray(repurpose) && repurpose.length) fullTextParts.push(`Repurpose: ${repurpose.join(' • ')}`);
    if (analytics && Array.isArray(analytics) && analytics.length) fullTextParts.push(`Analytics: ${analytics.join(', ')}`);
    if (promoSlot) fullTextParts.push(`Weekly Promo Slot: Yes`);
    if (weeklyPromo) fullTextParts.push(`Promo: ${weeklyPromo}`);
    if (videoScript && (videoScript.hook || videoScript.body || videoScript.cta)) {
      const scriptLines = [];
      if (videoScript.hook) scriptLines.push(`Hook: ${videoScript.hook}`);
      if (videoScript.body) scriptLines.push(`Body: ${videoScript.body}`);
      if (videoScript.cta) scriptLines.push(`CTA: ${videoScript.cta}`);
      fullTextParts.push(`Reel Script:\n${scriptLines.join('\n')}`);
    }
    if (engagementScripts && (engagementScripts.commentReply || engagementScripts.dmReply)) {
      if (engagementScripts.commentReply) fullTextParts.push(`Engagement Comment: ${engagementScripts.commentReply}`);
      if (engagementScripts.dmReply) fullTextParts.push(`Engagement DM: ${engagementScripts.dmReply}`);
    }
    if (entry.variants) {
      if (entry.variants.igCaption) fullTextParts.push(`Instagram Variant: ${entry.variants.igCaption}`);
      if (entry.variants.tiktokCaption) fullTextParts.push(`TikTok Variant: ${entry.variants.tiktokCaption}`);
      if (entry.variants.linkedinCaption) fullTextParts.push(`LinkedIn Variant: ${entry.variants.linkedinCaption}`);
    }
    if (cachedUserIsPro && entry.captionVariations) {
      if (entry.captionVariations.casual) fullTextParts.push(`Casual Caption: ${entry.captionVariations.casual}`);
      if (entry.captionVariations.professional) fullTextParts.push(`Professional Caption: ${entry.captionVariations.professional}`);
      if (entry.captionVariations.witty) fullTextParts.push(`Witty Caption: ${entry.captionVariations.witty}`);
    }
    if (cachedUserIsPro && entry.hashtagSets) {
      if (entry.hashtagSets.broad) fullTextParts.push(`Broad Hashtags: ${(entry.hashtagSets.broad || []).join(' ')}`);
      if (entry.hashtagSets.niche) fullTextParts.push(`Niche/Local Hashtags: ${(entry.hashtagSets.niche || []).join(' ')}`);
    }
    if (cachedUserIsPro && entry.suggestedAudio) fullTextParts.push(`Suggested Audio: ${entry.suggestedAudio}`);
    if (cachedUserIsPro && entry.postingTimeTip) fullTextParts.push(`Posting Time Tip: ${entry.postingTimeTip}`);
    if (cachedUserIsPro && entry.storyPromptExpanded) fullTextParts.push(`Story Prompt+: ${entry.storyPromptExpanded}`);
    if (cachedUserIsPro && entry.followUpIdea) fullTextParts.push(`Follow-up Idea: ${entry.followUpIdea}`);
    const fullText = fullTextParts.join('\n\n');

    btnCopyFull.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(fullText);
        btnCopyFull.textContent = 'Copied!';
        setTimeout(() => (btnCopyFull.textContent = 'Copy Full'), 1000);
      } catch (e) {}
    });

    attachProAction(btnDownloadDoc, async () => {
      try {
        const JSZipLib = await ensureZip().catch(() => null);
        if (!JSZipLib) {
          alert('Failed to load Zip library. Please try again.');
          return;
        }
        const zip = new JSZipLib();
        const folderName = `post-day-${String(entryDay).padStart(2, '0')}-post-${idx + 1}-${slugify(idea || title || 'post')}`;
        const folder = zip.folder(folderName);
        const html = buildPostHTML(entry);
        folder.file('post.html', html);
        const blob = await zip.generateAsync({ type: 'blob' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `${folderName}.zip`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
      } catch (e) {}
    });

    if (btnCopyFull) actionsEl.append(btnCopyFull);
    if (btnDownloadDoc) actionsEl.appendChild(btnDownloadDoc);
    const regenBtn = makeBtn('Regenerate');
    attachProAction(regenBtn, () => handleRegenerateDay(entry, entryDay, regenBtn));
    actionsEl.appendChild(regenBtn);

    if (entry.variants) {
      // variant captions still show in detail rows; copy buttons removed
    }

    const proDetailNodes = [];
    if (cachedUserIsPro && entry.captionVariations) {
      const parts = [];
      if (entry.captionVariations.casual) parts.push(`Casual: ${entry.captionVariations.casual}`);
      if (entry.captionVariations.professional) parts.push(`Professional: ${entry.captionVariations.professional}`);
      if (entry.captionVariations.witty) parts.push(`Witty: ${entry.captionVariations.witty}`);
      const text = parts.join(' | ');
      if (text) proDetailNodes.push(createDetailRow('Caption variations', text, 'calendar-card__caption-variations'));
    }
    if (cachedUserIsPro && entry.hashtagSets) {
      const parts = [];
      const broad = Array.isArray(entry.hashtagSets.broad) ? entry.hashtagSets.broad.join(' ') : entry.hashtagSets.broad;
      const niche = Array.isArray(entry.hashtagSets.niche) ? entry.hashtagSets.niche.join(' ') : entry.hashtagSets.niche;
      if (broad) parts.push(`Broad: ${broad}`);
      if (niche) parts.push(`Niche/local: ${niche}`);
      const text = parts.join(' | ');
      if (text) proDetailNodes.push(createDetailRow('Hashtag sets', text, 'calendar-card__hashtag-sets'));
    }
    if (cachedUserIsPro && entry.suggestedAudio) {
      proDetailNodes.push(createDetailRow('Suggested audio', entry.suggestedAudio, 'calendar-card__audio'));
    }
    if (cachedUserIsPro && entry.postingTimeTip) {
      proDetailNodes.push(createDetailRow('Posting time tip', entry.postingTimeTip, 'calendar-card__posting-tip'));
    }
    if (cachedUserIsPro && entry.storyPromptExpanded) {
      proDetailNodes.push(createDetailRow('Story prompt+', entry.storyPromptExpanded, 'calendar-card__story-extended'));
    }
    if (cachedUserIsPro && entry.followUpIdea) {
      proDetailNodes.push(createDetailRow('Follow-up idea', entry.followUpIdea, 'calendar-card__followup'));
    }

    const details = document.createElement('details');
    const summary = document.createElement('summary');
    summary.textContent = 'Details';
    const detailsBody = document.createElement('div');
    detailsBody.className = 'details-body';
    [
      hashtagsEl,
      formatEl,
      ctaEl,
      storyPromptEl,
      designNotesEl,
      repurposeEl,
      analyticsEl,
      engagementEl,
      promoSlotEl,
      weeklyPromoEl,
      videoScriptEl,
      variantsEl,
      assetsEl,
      ...proDetailNodes,
      actionsEl,
    ].filter(Boolean).forEach((node) => detailsBody.appendChild(node));
    details.append(summary, detailsBody);

    entryEl.append(ideaEl, typeEl, captionRow, details);
    return entryEl;
  }
};

async function handleRegenerateDay(entry, entryDay, triggerEl) {
  const targetDay = Number(typeof entryDay === 'number' ? entryDay : entry?.day);
  const button = triggerEl || null;
  if (!targetDay || !entry) {
    alert('Unable to determine which day to regenerate. Please try again.');
    return;
  }
  const nicheStyle = (currentNiche || nicheInput?.value || '').trim() || 'content creator';
  const originalLabel = button ? button.textContent : '';
  const payloadPost = JSON.parse(JSON.stringify(entry || {}));
  delete payloadPost.multiPosts;
  try {
    if (button) {
      button.disabled = true;
      button.textContent = 'Regenerating…';
    }
    const currentUser = await getCurrentUser();
    let parsed = null;
    if (regenDaySupported) {
      const resp = await fetch('/api/regen-day', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          day: targetDay,
          nicheStyle,
          post: payloadPost,
          userId: currentUser || undefined,
        }),
      });
      if (resp.status === 404) {
        regenDaySupported = false;
      } else {
        parsed = await resp.json().catch(() => ({}));
        if (!resp.ok) {
          throw new Error(parsed.error || 'Failed to regenerate this day');
        }
      }
    }
    if (!parsed) {
      const fallback = await regenerateDayFallback({
        day: targetDay,
        nicheStyle,
        currentUser,
        cache: payloadPost,
      });
      parsed = { post: fallback };
    }
    if (!parsed || !parsed.post) throw new Error('No post returned. Please try again.');
    const newPost = parsed.post;
    let replaced = false;
    currentCalendar = currentCalendar.map((p) => {
      if (!replaced && p === entry) {
        replaced = true;
        return newPost;
      }
      if (!replaced && Number(p.day) === targetDay && entry !== p) {
        replaced = true;
        return newPost;
      }
      return p;
    });
    if (!replaced) {
      currentCalendar = [...currentCalendar, newPost];
    }
    renderCards(currentCalendar);
    persistCurrentCalendarState();
    syncCalendarUIAfterDataChange();
    await ensurePlatformVariantsForCurrentCalendar('regen');
  } catch (err) {
    console.error('Regenerate day failed:', err);
    alert(err.message || 'Failed to regenerate this day.');
  } finally {
    if (button) {
      button.disabled = false;
      button.textContent = originalLabel || 'Regenerate';
    }
  }
}

async function triggerCalendarAssetGeneration(entry, entryDay, triggerButton, options = {}) {
  const { type = 'story', suppressRedirect = false } = options;
  const resolvedDay = Number(typeof entryDay === 'number' ? entryDay : entry?.day);
  if (!resolvedDay) {
    showDesignError('Pick a calendar day first', 'Select a post and try again.');
    throw new Error('Missing calendar day');
  }
  if (designAssetsApiDisabled) {
    alert('Design pipeline is not available in this environment.');
    throw new Error('Design pipeline disabled');
  }
  const payloadPost = { ...(entry || {}) };
  const triggerButtonText = triggerButton ? triggerButton.textContent : null;
  if (triggerButton) {
    triggerButton.disabled = true;
    triggerButton.textContent = 'Queued…';
  }
  const payload = {
    type,
    calendarDayId: entry?.calendar_day_id || entry?.calendarDayId || `day-${String(resolvedDay).padStart(2, '0')}`,
    day: resolvedDay,
    linkedDay: resolvedDay,
    title: entry?.title || entry?.idea || '',
    subtitle: entry?.subtitle || entry?.caption || '',
    cta: entry?.cta || '',
    prompt: entry?.prompt || '',
    tone: entry?.tone || '',
    campaign: entry?.campaign || '',
    month: entry?.month || '',
    backgroundImageUrl: entry?.backgroundImageUrl || entry?.heroImage || '',
    logoUrl: entry?.brand?.logoUrl || '',
    brandVoice: entry?.brandVoice || '',
    brand_color: entry?.brand_color || entry?.brand?.primaryColor || entry?.brand?.accentColor || '',
  };
  try {
    const response = await fetchWithAuth('/api/design-assets', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (response.status === 501) {
      designAssetsApiDisabled = true;
      throw new Error('Design pipeline is not available in this environment.');
    }
    if (!response.ok) {
      const detail = await response.json().catch(() => ({}));
      const message = detail?.error || `Design API error ${response.status}`;
      throw new Error(message);
    }
    const result = await response.json();
    const placeholder = {
      id: result.id,
      assetType: type,
      typeLabel: formatAssetTypeLabel(type),
      title: payload.title,
      linkedDay: resolvedDay,
      day: resolvedDay,
      status: result.status || 'rendering',
      previewText: 'Rendering in Placid…',
      designUrl: `/design.html?asset=${encodeURIComponent(result.id)}`,
      origin: 'remote',
      createdAt: new Date().toISOString(),
      calendarDayId: payload.calendarDayId,
      data: { type },
    };
    mergeDesignAsset(placeholder);
    pendingAssetDetailId = result.id;
    highlightDesignAssetId = result.id;
    showDesignSuccess(`${formatAssetTypeLabel(type)} queued in Design Lab.`);
    if (!suppressRedirect) {
      setTimeout(() => {
        window.location.href = `/design.html?asset=${encodeURIComponent(result.id)}`;
      }, 600);
    }
    return result;
  } catch (error) {
    console.error('Calendar asset generation failed', error);
    showDesignError('Unable to generate asset', error.message || 'Try again soon.');
    throw error;
  } finally {
    if (triggerButton) {
      triggerButton.disabled = false;
      triggerButton.textContent = triggerButtonText || 'Generate Asset';
    }
  }
}

async function regenerateDayFallback({ day, nicheStyle, currentUser, cache }) {
  const resp = await fetch('/api/generate-calendar', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      nicheStyle,
      days: 1,
      startDay: day,
      userId: currentUser || undefined,
    }),
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok || !data.posts || !data.posts.length) {
    throw new Error(data.error || 'Failed to regenerate day (fallback)');
  }
  const fallbackPost = data.posts[0];
  fallbackPost.day = day;
  if (cache && cache.pillar && !fallbackPost.pillar) fallbackPost.pillar = cache.pillar;
  return fallbackPost;
}

let currentCalendar = []; // Store the current calendar data
let currentCalendarId = null; // Supabase calendars.id for the loaded calendar (if any)
let currentNiche = ""; // Store the niche for the current calendar
let regenDaySupported = true;

function extractCalendarId(record) {
  if (!record || typeof record !== 'object') return null;
  const rawId = record.id ?? record.calendar_id ?? record.calendarId ?? null;
  if (rawId === null || typeof rawId === 'undefined') return null;
  const normalized = String(rawId).trim();
  return normalized ? normalized : null;
}

function updateCalendarToolbarState() {
  if (downloadCalendarFolderBtn) {
    const hasCalendar = Array.isArray(currentCalendar) && currentCalendar.length > 0;
    downloadCalendarFolderBtn.disabled = !hasCalendar;
    downloadCalendarFolderBtn.setAttribute('aria-disabled', hasCalendar ? 'false' : 'true');
  }
}

function setCurrentCalendarId(id) {
  const normalized =
    typeof id === 'string'
      ? id.trim()
      : id
      ? String(id).trim()
      : null;
  currentCalendarId = normalized || null;
  console.log('[Promptly] Current calendar id set', { id: currentCalendarId });
  updateCalendarToolbarState();
}

updateCalendarToolbarState();

function revealCalendarActionButtons() {
  const buttons = [
    saveBtn,
    exportBtn,
    exportCsvBtn,
    exportIcsBtn,
    downloadZipBtn,
    copyAllCaptionsBtn,
    copyAllFullBtn,
    exportVariantsCsvBtn,
    downloadVariantsZipBtn,
    downloadCalendarFolderBtn,
    deleteCalendarBtn,
  ];
  buttons.forEach((btn) => {
    if (btn) btn.style.display = 'inline-block';
  });
}

function syncHubControls() {
  if (!hubDaySelect) return;
  if (!Array.isArray(currentCalendar) || !currentCalendar.length) {
    hubDaySelect.innerHTML = '';
    return;
  }
  hubDaySelect.innerHTML = currentCalendar
    .map((p, idx) => `<option value="${idx}">Day ${String(p.day).padStart(2, '0')}</option>`)
    .join('');
  const nextIdx = findNextUnposted(0);
  hubIndex = Math.max(0, Math.min(currentCalendar.length - 1, nextIdx));
  hubDaySelect.value = String(hubIndex);
}

function syncCalendarUIAfterDataChange(options = {}) {
  revealCalendarActionButtons();
  updateCalendarToolbarState();
  syncHubControls();
  if (hub) renderPublishHub();
  updateTabs();
  if (options.scrollToCalendar && calendarSection) {
    setTimeout(() => {
      calendarSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 150);
  }
}

function persistCurrentCalendarState() {
  if (typeof localStorage === 'undefined' || calendarStorageDisabled) return;
  const key = getScopedStorageKey(CALENDAR_STORAGE_PREFIX);
  if (!key) return;
  if (!Array.isArray(currentCalendar) || !currentCalendar.length) {
    localStorage.removeItem(key);
    return;
  }
  try {
    const payload = {
      posts: currentCalendar.map(prunePostForStorage),
      niche: currentNiche || nicheInput?.value || '',
      savedAt: new Date().toISOString(),
      postFrequency: currentPostFrequency || 1,
    };
    localStorage.setItem(key, JSON.stringify(payload));
  } catch (err) {
    console.warn('Unable to persist calendar', err);
    if (err && err.name === 'QuotaExceededError') {
      calendarStorageDisabled = true;
    }
  }
}

function hydrateCalendarFromStorage(force = false) {
  if (typeof localStorage === 'undefined') return false;
  if (!force && Array.isArray(currentCalendar) && currentCalendar.length) return false;
  const key = getScopedStorageKey(CALENDAR_STORAGE_PREFIX);
  if (!key) return false;
  try {
    const raw = localStorage.getItem(key);
    if (!raw) {
      if (force) {
        currentCalendar = [];
        renderCards(currentCalendar);
        updateTabs();
        setCurrentCalendarId(null);
      }
      return false;
    }
    const data = JSON.parse(raw);
    if (!data || !Array.isArray(data.posts) || !data.posts.length) return false;
    currentCalendar = data.posts;
    const storedNiche = typeof data.niche === 'string' ? data.niche.trim() : '';
    if (storedNiche) {
      currentNiche = storedNiche;
      if (nicheInput) nicheInput.value = storedNiche;
    }
    setCurrentCalendarId(null);
    renderCards(currentCalendar);
    syncCalendarUIAfterDataChange();
    return true;
  } catch (err) {
    console.warn('Unable to hydrate calendar', err);
    return false;
  }
}

const renderCards = (subset) => {
  if (!grid) return;
  grid.innerHTML = "";
  const freq = Math.max(currentPostFrequency || 1, 1);
  if (freq <= 1) {
    subset.forEach((post) => grid.appendChild(createCard(post)));
    return;
  }
  const grouped = new Map();
  let fallbackIndex = 0;
  subset.forEach((post) => {
    const dayKey = typeof post.day === 'number' ? post.day : Math.floor(fallbackIndex / freq) + 1;
    fallbackIndex += 1;
    if (!grouped.has(dayKey)) grouped.set(dayKey, []);
    grouped.get(dayKey).push(post);
  });
  Array.from(grouped.entries())
    .sort(([a], [b]) => Number(a) - Number(b))
    .forEach(([dayKey, posts]) => {
      const merged = { ...posts[0], day: dayKey, multiPosts: posts };
      grid.appendChild(createCard(merged));
    });
};

function updatePostFrequencyUI() {
  if (!postFrequencySelect) return;
  const stored = getPostFrequency();
  currentPostFrequency = stored;
  postFrequencySelect.value = String(stored);
  if (postFrequencyDisplay) postFrequencyDisplay.textContent = `${stored}x`;
  renderCards(currentCalendar);
}

updatePostFrequencyUI();

// Filter dropdown functionality
let currentFilter = 'all';

const applyFilter = (filter) => {
  currentFilter = filter;
  
  // Update dropdown items active state
  filterDropdownItems.forEach((item) => {
    if (item.dataset.filter === filter) {
      item.classList.add('active');
    } else {
      item.classList.remove('active');
    }
  });

  // Update button label
  const filterText = filter === 'all' ? 'All pillars' : filter;
  if (pillarFilterLabel) pillarFilterLabel.textContent = filterText;

  // Apply filter to calendar
  if (filter === 'all') {
    renderCards(currentCalendar);
  } else {
    renderCards(currentCalendar.filter((post) => post.pillar === filter));
  }

  // Close dropdown
  if (pillarFilterMenu) pillarFilterMenu.style.display = 'none';
  if (pillarFilterBtn) pillarFilterBtn.setAttribute('aria-expanded', 'false');
};

// Toggle dropdown
if (pillarFilterBtn && pillarFilterMenu) {
  pillarFilterBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const isOpen = pillarFilterMenu.style.display === 'block';
    pillarFilterMenu.style.display = isOpen ? 'none' : 'block';
    pillarFilterBtn.setAttribute('aria-expanded', String(!isOpen));
  });

  // Handle dropdown item clicks
  filterDropdownItems.forEach((item) => {
    item.addEventListener('click', (e) => {
      e.stopPropagation();
      applyFilter(item.dataset.filter);
    });
  });

  // Close dropdown when clicking outside
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.filter-dropdown')) {
      pillarFilterMenu.style.display = 'none';
      pillarFilterBtn.setAttribute('aria-expanded', 'false');
    }
  });

  console.log("✓ Filter dropdown initialized");
} else {
  if (calendarSection) {
    console.warn('Filter controls unavailable; skipping pillar dropdown setup.');
  }
}

// Start with empty grid (no pre-made posts)
try {
  currentPostFrequency = getPostFrequency();
  renderCards([]);
  console.log("✓ Initial render complete");
  updateTabs();
} catch (err) {
  console.error("❌ Error rendering initial cards:", err);
}

document.addEventListener('DOMContentLoaded', () => {
  bindCalendarGenerateAssetClicks();
  document.querySelectorAll('[data-action="close-generate-asset-modal"]').forEach((btn) => {
    btn.addEventListener('click', () => closeGenerateAssetModal());
  });
  const confirmBtn = document.getElementById('confirm-generate-asset-button');
  if (confirmBtn) {
    confirmBtn.addEventListener('click', async () => {
      if (!pendingAssetGeneration) {
        closeGenerateAssetModal();
        return;
      }
      const selected = document.querySelector('input[name="asset-type"]:checked');
      const type = selected ? selected.value : 'story';
      const originalText = confirmBtn.textContent;
      confirmBtn.disabled = true;
      confirmBtn.textContent = 'Generating asset...';
      confirmBtn.setAttribute('aria-busy', 'true');
      try {
        const assetId = await createDesignAssetFromCalendar(pendingAssetGeneration, type);
        closeGenerateAssetModal();
        if (assetId) {
          window.location.href = `/design.html?asset=${encodeURIComponent(assetId)}`;
        } else {
          window.location.href = `/design.html`;
        }
      } catch (err) {
        console.error('Calendar asset generation failed', err);
        alert('Unable to generate this asset right now. Please try again.');
      } finally {
        confirmBtn.disabled = false;
        confirmBtn.textContent = originalText;
        confirmBtn.removeAttribute('aria-busy');
      }
    });
  }
  const assetTypeInputs = document.querySelectorAll('.asset-type-pill input[name="asset-type"]');
  const syncAssetTypePills = () => {
    document.querySelectorAll('.asset-type-pill').forEach((label) => label.classList.remove('is-selected'));
    const checked = document.querySelector('.asset-type-pill input[name="asset-type"]:checked');
    if (checked) {
      checked.closest('.asset-type-pill')?.classList.add('is-selected');
    }
  };
  assetTypeInputs.forEach((input) => {
    input.addEventListener('change', syncAssetTypePills);
  });
  syncAssetTypePills();
  document.querySelectorAll('[data-action="close-asset-editor-modal"]').forEach((btn) => {
    btn.addEventListener('click', () => closeAssetEditorModal());
  });
  if (assetEditorSaveButton) {
    assetEditorSaveButton.addEventListener('click', () => handleAssetEditorSave());
  }
  if (assetEditorRegenerateButton) {
    assetEditorRegenerateButton.addEventListener('click', () => handleAssetEditorRegenerate());
  }
  if (assetEditorDownloadButton) {
    assetEditorDownloadButton.addEventListener('click', () => handleAssetEditorDownload());
  }
});

function clearCalendarUI() {
  console.log('[Promptly] clearCalendarUI()');
  currentCalendar = [];
  currentNiche = '';
  setCurrentCalendarId(null);
  renderCards(currentCalendar);
  applyFilter("all");
  syncHubControls();
  if (hub) renderPublishHub();
  updateTabs();
  persistCurrentCalendarState();
}

const hydratedFromStorage = hydrateCalendarFromStorage();
if (hydratedFromStorage) ensurePlatformVariantsForCurrentCalendar('hydrate');

// Check if there's a calendar to load from library
const loadCalendarData = sessionStorage.getItem("promptly_load_calendar");
if (loadCalendarData && loadCalendarData !== 'undefined') {
  try {
    const cal = JSON.parse(loadCalendarData);
    // Ensure every post has a videoScript object
    let missingCount = 0;
    let posts = Array.isArray(cal.posts) ? cal.posts.map(post => {
      if (!post.videoScript || typeof post.videoScript !== 'object') {
        missingCount++;
        return { ...post, videoScript: { hook: '', body: '', cta: '' } };
      }
      return post;
    }) : [];
    if (missingCount > 0) {
      console.warn(`⚠️ Fixed ${missingCount} posts missing videoScript (from library/load). All posts now have a Reel Script.`);
    }
    currentCalendar = posts;
    setCurrentCalendarId(extractCalendarId(cal));
    const loadedNiche = typeof cal.nicheStyle === 'string' ? cal.nicheStyle.trim() : '';
    currentNiche = loadedNiche;
    if (nicheInput) nicheInput.value = loadedNiche || '';
    renderCards(currentCalendar);
    applyFilter("all");
    syncCalendarUIAfterDataChange();
    persistCurrentCalendarState();
    ensurePlatformVariantsForCurrentCalendar('library');
    sessionStorage.removeItem("promptly_load_calendar");
  } catch (err) {
    console.error("Failed to load calendar:", err);
  }
}

// helper: create a safe slug for filenames
const slugify = (s = "") =>
  String(s)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "")
    .slice(0, 40);

const proInteractivePrompts = [
  'Add a poll asking “Facial or peel?” plus a slider for “Glow level”.',
  'Use a quiz sticker to vote on favourite result + emoji slider for confidence level.',
  'Turn the story into a “This or That” sequence with a DM me button.',
  'Collect audience input with a “Ask me anything about today’s tip” box.',
  'Use a countdown sticker leading into tomorrow’s teaser.'
];

const proFollowUpIdeas = [
  'Follow up with a testimonial carousel from a recent client.',
  'Share a short Reel showing the before/after from this concept.',
  'Post a static quote graphic summarizing key data from today’s drop.',
  'Go live to answer the top questions sparked by this post.',
  'Send a newsletter recap that embeds today’s main CTA.'
];

const trendingTikTokAudios = [
  { title: 'Not Like Us', artist: 'Kendrick Lamar', usage: 'high-energy glow-up reveals and punchy before/afters' },
  { title: 'Birds of a Feather', artist: 'Billie Eilish', usage: 'softer transformation stories + community moments' },
  { title: 'GATA ONLY', artist: 'Flo Milli', usage: 'quick jump cuts or sassier myth-busting clips' },
  { title: 'Espresso (sped up)', artist: 'Sabrina Carpenter', usage: 'day-in-the-life facials + POV walkthroughs' },
  { title: 'Skinny', artist: 'Halsey', usage: 'confidence POV audio for skincare pep talks' }
];

const trendingInstagramAudios = [
  { title: 'Good Luck, Babe!', artist: 'Chappell Roan', usage: 'bold hook for promo CTA slides' },
  { title: 'Austin (Boots Stop Workin’)', artist: 'Dasha', usage: 'text overlays about routines or service stacks' },
  { title: 'Tucson', artist: 'Khalid', usage: 'slow-pan treatment rooms or ingredient spotlights' },
  { title: 'Million Dollar Baby', artist: 'Tommy Richman', usage: 'jump-cut reels showing quick transformations' },
  { title: '360', artist: 'Charli XCX', usage: 'carousel teasers and motion graphic carousels' }
];

const describeTrendingAudio = (index = 0) => {
  const now = new Date();
  const monthYear = new Intl.DateTimeFormat('en', { month: 'long', year: 'numeric' }).format(now);
  const tikTokPick = pickCycled(trendingTikTokAudios, index);
  const igPick = pickCycled(trendingInstagramAudios, index + 1);
  const tikTokText = tikTokPick
    ? `TikTok — “${tikTokPick.title}” by ${tikTokPick.artist} (perfect for ${tikTokPick.usage}).`
    : '';
  const igText = igPick
    ? `Instagram Reels — “${igPick.title}” by ${igPick.artist} (great for ${igPick.usage}).`
    : '';
  return `Trending now (${monthYear}): ${tikTokText} ${igText}`.trim();
};

const proPostingTips = [
  'Post weekday afternoons to catch students between classes.',
  'Aim for early morning drops to reach execs before meetings.',
  'Share on Saturday evenings when lifestyle audiences scroll longer.',
  'Publish mid-week around lunch for the best B2B engagement.',
  'Queue it for Sunday nights when planning-minded followers tune in.'
];


const capitalizeSentence = (text = '') => {
  if (!text) return '';
  return text.charAt(0).toUpperCase() + text.slice(1);
};

const formatHashtag = (tag = '') => {
  const clean = tag.replace(/[^a-z0-9#]/gi, '');
  if (!clean) return '';
  return clean.startsWith('#') ? clean : `#${clean}`;
};

const buildNicheTag = (nicheStyle = '') => {
  const words = (nicheStyle || 'Promptly').split(/\s+/).filter(Boolean).slice(0, 3);
  const cleaned = words.map(w => capitalizeSentence(w.replace(/[^a-z0-9]/gi, ''))).join('');
  return cleaned || 'Promptly';
};

const pickCycled = (items, index = 0, offset = 0) => {
  if (!items.length) return '';
  const idx = Math.abs(index + offset) % items.length;
  return items[idx];
};

const enrichPostWithProFields = (post, index, nicheStyle = '') => {
  const baseCaption = (post.caption || post.idea || 'Share today’s win.').trim();
  const nicheTag = buildNicheTag(nicheStyle);
  const hashtagArray = Array.isArray(post.hashtags) ? post.hashtags.map(formatHashtag).filter(Boolean) : [];
  const broadSet = hashtagArray.length ? hashtagArray.slice(0, 6) : ['#ContentPlan', '#Storytelling', '#CreatorJourney'];
  const nicheSetBase = [
    `#${nicheTag}`,
    `#${nicheTag}Life`,
    `#${nicheTag}Studio`,
    `#${nicheTag}Stories`
  ];

  const captionVariations = {
    casual: `${baseCaption.replace(/[.!?]+$/, '')}! Drop your best question in the comments`,
    professional: `Let’s address the big question: ${capitalizeSentence(baseCaption)} Our team is ready with evidence-backed answers.`,
    witty: `Plot twist: ${baseCaption.replace(/[.!?]$/, '')}. Ask away and we’ll spill the tea (and the serums).`
  };

  const visualSlug = slugify(post.idea || nicheStyle || 'promptly').slice(0, 8) || 'promptly';
  const interactive = pickCycled(proInteractivePrompts, index);

  return {
    ...post,
    captionVariations,
    hashtagSets: {
      broad: broadSet,
      niche: nicheSetBase
    },
    suggestedAudio: describeTrendingAudio(index),
    postingTimeTip: pickCycled(proPostingTips, index),
    storyPromptExpanded: post.storyPrompt
      ? `${post.storyPrompt} ${interactive}`
      : interactive,
    followUpIdea: pickCycled(proFollowUpIdeas, index)
  };
};

const stripProFields = (post) => {
  const clone = { ...post };
  delete clone.captionVariations;
  delete clone.hashtagSets;
  delete clone.suggestedAudio;
  delete clone.postingTimeTip;
  delete clone.visualTemplate;
  delete clone.storyPromptExpanded;
  delete clone.followUpIdea;
  return clone;
};

const validateNiche = (val) => {
  if (!val || !val.trim()) return { ok: false, msg: "Please enter a niche or style." };
  if (val.trim().length < 2) return { ok: false, msg: "Please provide at least 2 characters." };
  if (val.trim().length > 60) return { ok: false, msg: "Please keep it under 60 characters." };
  // disallow only punctuation
  if (/^[^a-zA-Z0-9]+$/.test(val)) return { ok: false, msg: "Please include letters or numbers in the niche." };
  return { ok: true };
};

if (nicheInput) {
  nicheInput.addEventListener("input", () => {
    const { ok, msg } = validateNiche(nicheInput.value);
    nicheInput.classList.toggle("invalid", !ok);
    if (feedbackEl) {
      feedbackEl.textContent = ok ? "" : msg;
      feedbackEl.classList.toggle("success", ok);
    }
  });
}

// Helpers to toggle spinner and button text
const btnSpinner = generateBtn ? generateBtn.querySelector('.spinner') : null;
const btnText = generateBtn ? generateBtn.querySelector('.btn-text') : null;
const progressBar = document.getElementById('generation-progress');
const progressFill = document.getElementById('progress-fill');
const progressText = document.getElementById('progress-text');

// Ensure JSZip is available (fallback loader if CDN didn't attach)
let __zipLoaderPromise = null;
function loadExternalScript(src){
  return new Promise((resolve, reject)=>{
    const s = document.createElement('script');
    s.src = src;
    s.async = true;
    s.onload = ()=> resolve();
    s.onerror = ()=> reject(new Error('Failed to load '+src));
    document.head.appendChild(s);
  });
}
async function ensureZip(){
  if (window.JSZip) return window.JSZip;
  if (!__zipLoaderPromise){
    __zipLoaderPromise = (async ()=>{
      const cdns = [
        'https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js',
        'https://unpkg.com/jszip@3.10.1/dist/jszip.min.js'
      ];
      for (const u of cdns){
        try { await loadExternalScript(u); if (window.JSZip) break; } catch(e){}
      }
      if (!window.JSZip) throw new Error('Zip library failed to load');
      return window.JSZip;
    })();
  }
  return __zipLoaderPromise;
}

function showGeneratingState() {
  if (generateBtn) generateBtn.disabled = true;
  if (btnSpinner) btnSpinner.style.display = 'inline-block';
  if (btnText) btnText.textContent = 'Creating calendar with AI...';
  if (progressBar) progressBar.style.display = 'flex';
  if (progressFill) progressFill.style.width = '0%';
  if (progressText) progressText.textContent = 'Preparing your calendar...';
}

function hideGeneratingState(originalText) {
  if (generateBtn) generateBtn.disabled = false;
  if (btnSpinner) btnSpinner.style.display = 'none';
  if (btnText) btnText.textContent = originalText || 'Generate Calendar';
  if (progressBar) progressBar.style.display = 'none';
  if (progressFill) progressFill.style.width = '0%';
}

// Export button handler
if (exportBtn) {
  exportBtn.addEventListener("click", async () => {
    console.log('Export clicked');
    const user = await getCurrentUser();
    console.log('Current user:', user);
    const userIsPro = await isPro(user);
    console.log('User is Pro:', userIsPro);
    if (!userIsPro) {
      console.log('Showing upgrade modal');
      showUpgradeModal();
      return;
    }
    
    const niche = nicheInput ? nicheInput.value.trim() : "";
    if (!currentCalendar || currentCalendar.length === 0) {
      alert("No calendar to export. Generate a calendar first.");
      return;
    }
    downloadCalendarAsJSON(currentCalendar, niche);
    if (feedbackEl) {
      feedbackEl.textContent = "Calendar exported — check your downloads folder.";
      feedbackEl.classList.add("success");
      setTimeout(() => {
        if (feedbackEl) {
          feedbackEl.textContent = "";
          feedbackEl.classList.remove("success");
        }
      }, 2500);
    }
  });
}

// Export CSV button handler
if (exportCsvBtn) {
  exportCsvBtn.addEventListener('click', async () => {
    const user = await getCurrentUser();
    const userIsPro = await isPro(user);
    // Gate: Pro feature
    if (!userIsPro) {
      showUpgradeModal();
      return;
    }
    
    const niche = nicheInput ? nicheInput.value.trim() : '';
    if (!currentCalendar || currentCalendar.length === 0) {
      alert('No calendar to export. Generate a calendar first.');
      return;
    }
    const rows = buildCsvRows(currentCalendar);
    const csv = toCsv(rows.headers, rows.rows);
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `30-day-content-${slugify(niche)}.csv`;
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
    if (feedbackEl) {
      feedbackEl.textContent = 'CSV exported — ready for schedulers (Buffer/Hootsuite).';
      feedbackEl.classList.add('success');
      setTimeout(()=>{ if (feedbackEl){ feedbackEl.textContent=''; feedbackEl.classList.remove('success'); } }, 2500);
    }
  });
}

// Export ICS (calendar reminders)
if (exportIcsBtn) {
  exportIcsBtn.addEventListener('click', async () => {
    const user = await getCurrentUser();
    const userIsPro = await isPro(user);
    // Gate: Pro feature
    if (!userIsPro) {
      showUpgradeModal();
      return;
    }
    
    if (!currentCalendar || currentCalendar.length === 0) {
      alert('No calendar to export. Generate a calendar first.');
      return;
    }
    const ics = buildICS(currentCalendar);
    const blob = new Blob([ics], { type: 'text/calendar;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `content-reminders.ics`;
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
    if (feedbackEl) { feedbackEl.textContent = 'ICS exported — add it to your calendar.'; feedbackEl.classList.add('success'); setTimeout(()=>{ if (feedbackEl){ feedbackEl.textContent=''; feedbackEl.classList.remove('success'); } }, 2500);}    
  });
}

// ZIP export
if (downloadZipBtn) {
  downloadZipBtn.addEventListener('click', async () => {
    const user = await getCurrentUser();
    const userIsPro = await isPro(user);
    // Gate: Pro feature
    if (!userIsPro) {
      showUpgradeModal();
      return;
    }
    
    if (!currentCalendar || currentCalendar.length === 0) {
      alert('No calendar to export. Generate a calendar first.');
      return;
    }
  const JSZipLib = await ensureZip().catch(()=>null);
  if (!JSZipLib) { alert('Failed to load Zip library. Please check your connection and try again.'); return; }
  const niche = nicheInput ? nicheInput.value.trim() : '';
  const zip = new JSZipLib();
    const rows = buildCsvRows(currentCalendar);
    const csv = toCsv(rows.headers, rows.rows);
    const calendarObj = { metadata: { nicheStyle: niche, generatedAt: new Date().toISOString() }, posts: currentCalendar };
    zip.file('calendar.json', JSON.stringify(calendarObj, null, 2));
    zip.file('calendar.csv', csv);
    currentCalendar.forEach((p, idx) => {
      const hashtags = Array.isArray(p.hashtags) ? p.hashtags.map(h=>h.startsWith('#')?h:'#'+h).join(' ') : (p.hashtags||'');
      const combined = [p.caption||'', hashtags||'', p.cta?`CTA: ${p.cta}`:''].filter(Boolean).join('\n\n');
      const base = `day-${String(p.day||idx+1).padStart(2,'0')}`;
      zip.file(`${base}.txt`, combined);
      zip.file(`${base}.json`, JSON.stringify(p, null, 2));
    });
    const blob = await zip.generateAsync({ type: 'blob' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = `content-bundle-${slugify(niche)}.zip`; document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
    if (feedbackEl) { feedbackEl.textContent = 'ZIP downloaded — includes per-day files and CSV.'; feedbackEl.classList.add('success'); setTimeout(()=>{ if (feedbackEl){ feedbackEl.textContent=''; feedbackEl.classList.remove('success'); } }, 2500);}    
  });
}

// Bulk copy
if (copyAllCaptionsBtn) {
  copyAllCaptionsBtn.addEventListener('click', async ()=>{
    if (!currentCalendar || currentCalendar.length === 0) return;
    const text = currentCalendar.map(p=>`Day ${String(p.day).padStart(2,'0')}: ${p.caption||''}`).join('\n\n');
    try { await navigator.clipboard.writeText(text); copyAllCaptionsBtn.textContent='Copied!'; setTimeout(()=>copyAllCaptionsBtn.textContent='Copy All Captions', 1000);} catch(e){}
  });
}
if (copyAllFullBtn) {
  copyAllFullBtn.addEventListener('click', async ()=>{
    if (!currentCalendar || currentCalendar.length === 0) return;
    const text = currentCalendar.map(p=>{
      const tags = Array.isArray(p.hashtags)? p.hashtags.map(h=>h.startsWith('#')?h:'#'+h).join(' ') : (p.hashtags||'');
      return `Day ${String(p.day).padStart(2,'0')}:\n${p.caption||''}\n\n${tags}\n\n${p.cta?`CTA: ${p.cta}`:''}`.trim();
    }).join('\n\n---\n\n');
    try { await navigator.clipboard.writeText(text); copyAllFullBtn.textContent='Copied!'; setTimeout(()=>copyAllFullBtn.textContent='Copy All Full', 1000);} catch(e){}
  });
}

async function generateVariantsForPosts(posts, { nicheStyle = '', userId, userIsPro } = {}) {
  if (!Array.isArray(posts) || posts.length === 0) return posts;
  const resolvedUserId = userId || activeUserEmail || (await getCurrentUser());
  if (!resolvedUserId) return posts;
  let resolvedIsPro;
  if (typeof userIsPro === 'boolean') {
    resolvedIsPro = userIsPro;
  } else if (typeof cachedUserIsPro === 'boolean') {
    resolvedIsPro = cachedUserIsPro;
  } else {
    resolvedIsPro = await isPro(resolvedUserId);
  }
  if (!resolvedIsPro) return posts;

  const chunkSize = 15;
  let merged = posts.map((post) => ({ ...post }));
  for (let i = 0; i < merged.length; i += chunkSize) {
    const chunk = merged.slice(i, i + chunkSize);
    if (!chunk.length) continue;
    const resp = await fetch('/api/generate-variants', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        posts: chunk,
        nicheStyle,
        userId: resolvedUserId,
      }),
    });
    const body = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      const error = new Error(body.error || 'Variant generation failed');
      error.status = resp.status;
      throw error;
    }
    const variantEntries = Array.isArray(body.variants) ? body.variants : [];
    const byDay = new Map(variantEntries.map((entry) => [entry.day, entry.variants]));
    merged = merged.map((post) => (byDay.has(post.day) ? { ...post, variants: byDay.get(post.day) } : post));
  }

  return merged;
}

async function ensurePlatformVariantsForCurrentCalendar(reason = 'auto') {
  if (platformVariantSyncPromise) return platformVariantSyncPromise;
  if (!Array.isArray(currentCalendar) || !currentCalendar.length) return;
  const userId = activeUserEmail || (await getCurrentUser());
  if (!userId) return;
  const userIsPro = typeof cachedUserIsPro === 'boolean' ? cachedUserIsPro : await isPro(userId);
  if (!userIsPro) return;
  const needsVariants = currentCalendar.some((post) => {
    const variants = post?.variants;
    if (!variants) return true;
    return !Object.keys(variants).length;
  });
  if (!needsVariants) return;

  const shouldShowFeedback = !!feedbackEl && reason !== 'manual';
  const statusMessage =
    reason === 'regen'
      ? 'Updating platform variants for this post...'
      : 'Adding platform variants for your calendar...';
  if (shouldShowFeedback) {
    feedbackEl.textContent = statusMessage;
    feedbackEl.classList.remove('error');
    feedbackEl.classList.remove('success');
  }

  const runner = async () => {
    const merged = await generateVariantsForPosts(currentCalendar, {
      nicheStyle: nicheInput?.value || currentNiche || '',
      userId,
      userIsPro,
    });
    currentCalendar = merged;
    if (currentFilter === 'all') {
      renderCards(currentCalendar);
    } else {
      applyFilter(currentFilter);
    }
    persistCurrentCalendarState();
    syncCalendarUIAfterDataChange();
    if (shouldShowFeedback) {
      const successMessage = 'Platform variants added for your calendar.';
      feedbackEl.textContent = successMessage;
      feedbackEl.classList.add('success');
      setTimeout(() => {
        if (feedbackEl && feedbackEl.textContent === successMessage) {
          feedbackEl.textContent = '';
          feedbackEl.classList.remove('success');
        }
      }, 3000);
    }
  };

  platformVariantSyncPromise = runner()
    .catch((error) => {
      console.error('Platform variant sync failed:', error);
      if (shouldShowFeedback) {
        feedbackEl.textContent = `Variant error: ${error.message || 'Unable to add platform variants.'}`;
        feedbackEl.classList.remove('success');
      }
    })
    .finally(() => {
      platformVariantSyncPromise = null;
    });

  return platformVariantSyncPromise;
}

// Variants CSV export
if (exportVariantsCsvBtn) {
  exportVariantsCsvBtn.addEventListener('click', ()=>{
    if (!currentCalendar || currentCalendar.length===0) { alert('Generate calendar first.'); return; }
    const headers = ['Day','Platform','Caption'];
    const rows = [];
    currentCalendar.forEach(p=>{
      if (p.variants){
        if (p.variants.igCaption) rows.push([p.day,'Instagram',p.variants.igCaption]);
        if (p.variants.tiktokCaption) rows.push([p.day,'TikTok',p.variants.tiktokCaption]);
        if (p.variants.linkedinCaption) rows.push([p.day,'LinkedIn',p.variants.linkedinCaption]);
      }
    });
    if (rows.length===0) { alert('No variants yet. Click Generate Platform Variants first.'); return; }
    const csv = toCsv(headers, rows);
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href=url; a.download='calendar-variants.csv'; document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
  });
}

// Variants ZIP export
if (downloadVariantsZipBtn) {
  downloadVariantsZipBtn.addEventListener('click', async ()=>{
    const user = await getCurrentUser();
    const userIsPro = await isPro(user);
    if (!userIsPro) {
      showUpgradeModal();
      return;
    }
    
    if (!currentCalendar || currentCalendar.length===0) { alert('Generate calendar first.'); return; }
  const JSZipLib = await ensureZip().catch(()=>null);
  if (!JSZipLib) { alert('Failed to load Zip library. Please check your connection and try again.'); return; }
  const zip = new JSZipLib();
    currentCalendar.forEach((p, idx)=>{
      if (!p.variants) return;
      const base = `day-${String(p.day||idx+1).padStart(2,'0')}`;
      if (p.variants.igCaption) zip.file(`${base}-instagram.txt`, p.variants.igCaption);
      if (p.variants.tiktokCaption) zip.file(`${base}-tiktok.txt`, p.variants.tiktokCaption);
      if (p.variants.linkedinCaption) zip.file(`${base}-linkedin.txt`, p.variants.linkedinCaption);
    });
    const blob = await zip.generateAsync({ type: 'blob' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href=url; a.download='variant-assets.zip'; document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
  });
}

// Download Calendar Folder (30 HTML files)
if (downloadCalendarFolderBtn) {
  downloadCalendarFolderBtn.addEventListener('click', async ()=>{
    const user = await getCurrentUser();
    const userIsPro = await isPro(user);
    // Gate: Pro feature
    if (!userIsPro) {
      showUpgradeModal();
      return;
    }
    
    if (!currentCalendar || currentCalendar.length===0) { alert('Generate calendar first.'); return; }
    const JSZipLib = await ensureZip().catch(()=>null);
    if (!JSZipLib) { alert('Failed to load Zip library. Please check your connection and try again.'); return; }
    
    const zip = new JSZipLib();
    const folderName = `calendar-${slugify(currentNiche || 'posts')}`;
    const folder = zip.folder(folderName);
    
    // Create 30 individual HTML files
    currentCalendar.forEach((post) => {
      const day = post.day || '';
      const title = post.idea || post.title || '';
      const fileName = `day-${String(day).padStart(2,'0')}-${slugify(title || 'post')}.html`;
      const html = buildPostHTML(post);
      folder.file(fileName, html);
    });
    
    const blob = await zip.generateAsync({ type: 'blob' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${folderName}.zip`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  });
}

// (renderPublishHub defined later with navigation/posted state)

function buildICS(posts){
  const lines = ['BEGIN:VCALENDAR','VERSION:2.0','PRODID:-//Promptly//Content Studio//EN'];
  const schedule = suggestSchedule(posts);
  posts.forEach((p, idx)=>{
    const dt = schedule[idx];
    if (!dt) return;
    // Convert "YYYY-MM-DD HH:mm" into UTC-ish floating (no tz handling for simplicity)
    const [date, time] = dt.split(' ');
    const [Y,M,D] = date.split('-');
    const [h,m] = time.split(':');
    const dtstart = `${Y}${M}${D}T${h}${m}00`;
    // 30-minute default duration
    const endDate = new Date(`${Y}-${M}-${D}T${h}:${m}:00`);
    endDate.setMinutes(endDate.getMinutes()+30);
    const y2=endDate.getFullYear(); const m2=String(endDate.getMonth()+1).padStart(2,'0'); const d2=String(endDate.getDate()).padStart(2,'0'); const h2=String(endDate.getHours()).padStart(2,'0'); const mi2=String(endDate.getMinutes()).padStart(2,'0');
    const dtend = `${y2}${m2}${d2}T${h2}${mi2}00`;
    const uid = `post-${Y}${M}${D}-${p.day}@promptly`;
    const summary = (p.idea || `${p.pillar||''} post`).replace(/\r?\n/g,' ').slice(0,60);
    const tags = Array.isArray(p.hashtags)? p.hashtags.map(h=>h.startsWith('#')?h:'#'+h).join(' ') : (p.hashtags||'');
    const desc = [p.caption||'', tags||'', p.cta?`CTA: ${p.cta}`:''].filter(Boolean).join('\\n\\n');
    lines.push('BEGIN:VEVENT');
    lines.push(`UID:${uid}`);
    lines.push(`DTSTART:${dtstart}`);
    lines.push(`DTEND:${dtend}`);
    lines.push(`SUMMARY:${summary}`);
    lines.push(`DESCRIPTION:${desc}`);
    lines.push('END:VEVENT');
  });
  lines.push('END:VCALENDAR');
  return lines.join('\r\n');
}

function buildCsvRows(posts){
  const headers = ['Day','ScheduledAt','Pillar','Type','Format','Idea','Caption','Hashtags','CTA','WeeklyPromo','CombinedText'];
  const schedule = suggestSchedule(posts);
  const rows = posts.map((p, idx)=>{
    const hashtags = Array.isArray(p.hashtags) ? p.hashtags.map(h=>h.startsWith('#')?h:'#'+h).join(' ') : (p.hashtags||'');
    const combined = [p.caption||'', hashtags||'', p.cta?`CTA: ${p.cta}`:''].filter(Boolean).join('\n\n');
    return [p.day||idx+1, schedule[idx]||'', p.pillar||'', p.type||'', p.format||'', p.idea||'', (p.caption||'').replace(/\s+/g,' ').trim(), hashtags, p.cta||'', p.weeklyPromo||'', combined.replace(/\r?\n/g,' \u21B5 ')];
  });
  return { headers, rows };
}

function toCsv(headers, rows){
  const esc = (v)=>{
    const s = String(v==null? '': v);
    if (s.includes(',') || s.includes('"') || s.includes('\n')) {
      return '"' + s.replace(/"/g,'""') + '"';
    }
    return s;
  };
  return [headers.join(','), ...rows.map(r=>r.map(esc).join(','))].join('\n');
}

function suggestSchedule(posts){
  const base = new Date();
  base.setHours(0,0,0,0);
  // start tomorrow
  base.setDate(base.getDate()+1);
  const timeByPillar = {
    'Education': '09:00',
    'Social Proof': '12:00',
    'Promotion': '19:00',
    'Lifestyle': '10:00',
  };
  return posts.map((p, i)=>{
    const d = new Date(base);
    d.setDate(base.getDate() + i);
    const t = timeByPillar[p.pillar] || '11:00';
    const [hh,mm] = t.split(':').map(Number);
    d.setHours(hh, mm, 0, 0);
    // format ISO-like local string YYYY-MM-DD HH:mm
    const yyyy = d.getFullYear();
    const mm2 = String(d.getMonth()+1).padStart(2,'0');
    const dd2 = String(d.getDate()).padStart(2,'0');
    const hh2 = String(d.getHours()).padStart(2,'0');
    const mi2 = String(d.getMinutes()).padStart(2,'0');
    return `${yyyy}-${mm2}-${dd2} ${hh2}:${mi2}`;
  });
}

// Escape HTML helper for safe document export
function escapeHtml(s){
  return String(s==null?'':s)
    .replace(/&/g,'&amp;')
    .replace(/</g,'&lt;')
    .replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;')
    .replace(/'/g,'&#39;');
}

// Build a professional-looking standalone HTML for a single post
function buildPostHTML(post){
  const day = post.day || '';
  const title = post.idea || post.title || '';
  const pillar = post.pillar || '';
  const type = post.type || '';
  const format = post.format || '';
  const caption = post.caption || '';
  const hashtags = Array.isArray(post.hashtags)? post.hashtags.map(h=>h.startsWith('#')?h:'#'+h).join(' ') : (post.hashtags||'');
  const cta = post.cta || '';
  const storyPrompt = post.storyPrompt || '';
  const designNotes = post.designNotes || '';
  const repurpose = Array.isArray(post.repurpose)? post.repurpose : (post.repurpose? [post.repurpose] : []);
  const analytics = Array.isArray(post.analytics)? post.analytics : (post.analytics? [post.analytics] : []);
  const weeklyPromo = post.weeklyPromo || '';
  const promoSlot = !!post.promoSlot;
  const vs = post.videoScript || {};
  const engage = post.engagementScripts || {};
  const nl2br = (s)=> escapeHtml(s).replace(/\n/g,'<br/>');
  const videoLabel = format === 'Reel' ? 'Reel Script' : 'Reel Script (can repurpose as Reel)';

  // Build a single calendar card markup mirroring the in-app component
  const detailBlocks = [
    hashtags ? `<div class="calendar-card__hashtags">${escapeHtml(hashtags)}</div>` : '',
    format ? `<span class="calendar-card__format">Format: ${escapeHtml(format)}</span>` : '',
    cta ? `<span class="calendar-card__cta">CTA: ${escapeHtml(cta)}</span>` : '',
    storyPrompt ? `<div class="calendar-card__story"><strong>Story Prompt:</strong> ${nl2br(storyPrompt)}</div>` : '',
    designNotes ? `<div class="calendar-card__design"><strong>Design Notes:</strong> ${nl2br(designNotes)}</div>` : '',
    repurpose.length ? `<div class="calendar-card__repurpose"><strong>Repurpose:</strong> ${escapeHtml(repurpose.join(' • '))}</div>` : '',
    analytics.length ? `<div class="calendar-card__analytics"><strong>Analytics:</strong> ${escapeHtml(analytics.join(', '))}</div>` : '',
    (engage.commentReply||engage.dmReply) ? `<div class="calendar-card__engagement"><strong>Engagement Scripts</strong>${engage.commentReply?`<div><em>Comment:</em> ${escapeHtml(engage.commentReply)}</div>`:''}${engage.dmReply?`<div><em>DM:</em> ${escapeHtml(engage.dmReply)}</div>`:''}</div>` : '',
    (promoSlot||weeklyPromo) ? `<div class="calendar-card__promo"><strong>Weekly Promo Slot:</strong> ${weeklyPromo?escapeHtml(weeklyPromo):'Yes'}</div>` : '',
    (vs.hook||vs.body||vs.cta) ? `<div class="calendar-card__video"><strong>${videoLabel}</strong>${vs.hook?`<div><em>Hook:</em> ${escapeHtml(vs.hook)}</div>`:''}${vs.body?`<div><em>Body:</em> ${nl2br(vs.body)}</div>`:''}${vs.cta?`<div><em>CTA:</em> ${escapeHtml(vs.cta)}</div>`:''}</div>` : '',
    (post.variants && (post.variants.igCaption || post.variants.tiktokCaption || post.variants.linkedinCaption))
      ? `<div class="calendar-card__variants">`
        + `${post.variants.igCaption?`<div><em>Instagram:</em> ${escapeHtml(post.variants.igCaption)}</div>`:''}`
        + `${post.variants.tiktokCaption?`<div><em>TikTok:</em> ${escapeHtml(post.variants.tiktokCaption)}</div>`:''}`
        + `${post.variants.linkedinCaption?`<div><em>LinkedIn:</em> ${escapeHtml(post.variants.linkedinCaption)}</div>`:''}`
        + `</div>`
      : ''
  ];

  if (Array.isArray(post.assets) && post.assets.length) {
    const assetCards = post.assets
      .map((asset) => {
        const descriptor = buildAssetPreviewDescriptor(asset);
        let previewHtml = '';
        if (descriptor.kind === 'carousel' && descriptor.slides?.length) {
          previewHtml = buildCarouselSliderHtml(descriptor.slides, { context: 'calendar' });
        } else if (descriptor.kind === 'image' && descriptor.url) {
          previewHtml = `<img src="${escapeHtml(descriptor.url)}" alt="${escapeHtml(asset.title || 'AI asset preview')}" />`;
        } else if (descriptor.kind === 'video' && descriptor.url) {
          previewHtml = `<video src="${escapeHtml(descriptor.url)}" controls playsinline preload="metadata"></video>`;
        } else {
          previewHtml = `<div class="calendar-card__asset-preview-text">${escapeHtml(descriptor.text || asset.previewText || '')}</div>`;
        }
        const downloadUrl = escapeHtml(asset.bundleUrl || asset.downloadUrl || asset.url || '#');
        const designUrl = escapeHtml(asset.designUrl || '#');
        const assetSnapshot = encodeURIComponent(JSON.stringify({
          ...asset,
          previewInlineUrl: asset.previewInlineUrl || '',
        }));
        const captionText = asset.caption ? `<p>${escapeHtml(asset.caption)}</p>` : '';
        const slideChipsHtml = buildSlideChipRowHtml(asset.slides, 'calendar');
        const downloadLabel = Array.isArray(asset.slides) && asset.slides.length ? 'Download ZIP' : 'Download';
        return `
          <div class="calendar-card__asset-card">
            <div class="calendar-card__asset-preview">${previewHtml}</div>
            <div class="calendar-card__asset-meta">
              <strong>${escapeHtml(asset.typeLabel || asset.title || 'AI Asset')}</strong>
              ${asset.title ? `<span>${escapeHtml(asset.title)}</span>` : ''}
              ${captionText}
              ${asset.day ? `<span class="calendar-card__asset-badge">Linked to Day ${String(asset.day).padStart(2, '0')}</span>` : ''}
              ${slideChipsHtml}
            </div>
            <div class="calendar-card__asset-actions">
              <a class="calendar-card__asset-btn" href="${downloadUrl}" target="_blank" rel="noopener" download>${downloadLabel}</a>
              <button type="button" class="calendar-card__asset-btn ghost calendar-card__asset-btn--view" data-design-url="${designUrl}" data-asset="${assetSnapshot}">View/Edit</button>
            </div>
          </div>
        `;
      })
      .join('');
    detailBlocks.push(`<div class="calendar-card__assets"><strong>AI Assets</strong><div class="calendar-card__asset-grid">${assetCards}</div></div>`);
  }

  if (post.captionVariations) {
    detailBlocks.push(
      `<div class="calendar-card__caption-variations"><strong>Caption variations</strong>`
      + `${post.captionVariations.casual ? `<div><em>Casual:</em> ${escapeHtml(post.captionVariations.casual)}</div>` : ''}`
      + `${post.captionVariations.professional ? `<div><em>Professional:</em> ${escapeHtml(post.captionVariations.professional)}</div>` : ''}`
      + `${post.captionVariations.witty ? `<div><em>Witty:</em> ${escapeHtml(post.captionVariations.witty)}</div>` : ''}`
      + `</div>`
    );
  }
  if (post.hashtagSets) {
    const broad = Array.isArray(post.hashtagSets.broad) ? post.hashtagSets.broad.join(' ') : '';
    const niche = Array.isArray(post.hashtagSets.niche) ? post.hashtagSets.niche.join(' ') : '';
    detailBlocks.push(
      `<div class="calendar-card__hashtag-sets"><strong>Hashtag sets</strong>`
      + `${broad ? `<div><em>Broad:</em> ${escapeHtml(broad)}</div>` : ''}`
      + `${niche ? `<div><em>Niche/local:</em> ${escapeHtml(niche)}</div>` : ''}`
      + `</div>`
    );
  }
  if (post.suggestedAudio) {
    detailBlocks.push(`<div class="calendar-card__audio"><strong>Suggested audio</strong><div>${escapeHtml(post.suggestedAudio)}</div></div>`);
  }
  if (post.postingTimeTip) {
    detailBlocks.push(`<div class="calendar-card__posting-tip"><strong>Posting time tip</strong><div>${escapeHtml(post.postingTimeTip)}</div></div>`);
  }
  if (post.storyPromptExpanded) {
    detailBlocks.push(`<div class="calendar-card__story-extended"><strong>Story prompt+</strong> ${escapeHtml(post.storyPromptExpanded)}</div>`);
  }
  if (post.followUpIdea) {
    detailBlocks.push(`<div class="calendar-card__followup"><strong>Follow-up idea</strong> ${escapeHtml(post.followUpIdea)}</div>`);
  }

  const detailsBlocks = detailBlocks.filter(Boolean).join('');

  const cardHTML = `
    <article class="calendar-card" data-pillar="${escapeHtml(pillar)}">
      <div class="calendar-card__day">${String(day).padStart(2,'0')}</div>
      <h3 class="calendar-card__title">${escapeHtml(title)}</h3>
      ${type?`<span class="calendar-card__type">${escapeHtml(type.charAt(0).toUpperCase()+type.slice(1))}</span>`:''}
      <p class="calendar-card__caption">${nl2br(caption)}</p>
      <details>
        <summary>Details</summary>
        <div class="details-body">${detailsBlocks}</div>
      </details>
    </article>
  `;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Day ${String(day).padStart(2,'0')} — ${escapeHtml(title)}</title>
  <style>
    :root {
      color-scheme: light dark;
      --bg: #0c0c0c;
      --card: rgba(28, 28, 34, 0.84);
      --card-border: rgba(255, 255, 255, 0.08);
      --text-primary: #f5f6f8;
      --text-secondary: rgba(245, 246, 248, 0.72);
      --accent: #7f5af0;
      --accent-soft: rgba(127, 90, 240, 0.14);
      --accent-strong: rgba(127, 90, 240, 0.32);
    }
    * { box-sizing: border-box; }
    html, body { margin: 0; }
    body {
      min-height: 100vh;
      display: grid;
      place-items: center;
      padding: 24px;
      background: radial-gradient(circle at top left, #171717, #050505 50%);
      color: var(--text-primary);
      font: 16px/1.6 Inter, -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, sans-serif;
    }
    .container { width: min(920px, 92vw); margin: 0 auto; }
    .brand { color: var(--text-secondary); font-size: 0.9rem; margin-bottom: 0.5rem; }
    .calendar-card {
      background: var(--card);
      border-radius: 18px;
      padding: 1.5rem;
      border: 1px solid var(--card-border);
      display: flex;
      flex-direction: column;
      gap: 1rem;
      position: relative;
      isolation: isolate;
      box-shadow: 0 24px 36px rgba(0, 0, 0, 0.25);
    }
    .calendar-card::after {
      content: attr(data-pillar);
      position: absolute;
      top: 1.25rem;
      right: 1.25rem;
      font-size: 0.75rem;
      font-weight: 600;
      letter-spacing: 0.12em;
      text-transform: uppercase;
      padding: 0.25rem 0.75rem;
      border-radius: 999px;
      background: rgba(255, 255, 255, 0.06);
      color: rgba(255, 255, 255, 0.7);
    }
    .calendar-card__day { font-size: 3rem; font-weight: 700; letter-spacing: -0.04em; color: rgba(255, 255, 255, 0.18); }
    .calendar-card__title { font-size: 1.15rem; margin: 0; }
    .calendar-card__type { display: inline-block; background: rgba(127, 90, 240, 0.13); color: #7f5af0; font-size: 0.85rem; font-weight: 600; border-radius: 6px; padding: 0.15em 0.7em; margin-bottom: 0.5rem; margin-top: 0.25rem; }
    .calendar-card__caption { margin: 0.5rem 0 0.25rem; color: var(--text-secondary); font-size: 1.01rem; line-height: 1.6; font-weight: 500; }
    .calendar-card__hashtags { color: #2cb1bc; font-size: 0.97rem; margin: 0.25rem 0; font-weight: 600; }
    .calendar-card__format { display: inline-block; background: rgba(44, 177, 188, 0.13); color: #2cb1bc; font-size: 0.85rem; font-weight: 600; border-radius: 6px; padding: 0.15em 0.7em; margin: 0.25rem 0 0.5rem; }
    .calendar-card__cta { display: block; margin-top: 0.5rem; font-weight: 600; color: #7f5af0; font-size: 0.97rem; }
    .calendar-card__weekly-promo, .calendar-card__video, .calendar-card__repurpose, .calendar-card__design, .calendar-card__analytics, .calendar-card__story, .calendar-card__engagement, .calendar-card__variants { font-size: 0.95rem; color: var(--text-secondary); margin-top: 0.25rem; }
    .calendar-card__caption-variations, .calendar-card__hashtag-sets, .calendar-card__audio, .calendar-card__posting-tip, .calendar-card__visual, .calendar-card__story-extended, .calendar-card__followup { font-size: 0.95rem; color: var(--text-secondary); margin-top: 0.25rem; }
    .calendar-card__caption-variations em, .calendar-card__hashtag-sets em, .calendar-card__engagement em, .calendar-card__video em { font-style: normal; color: rgba(245, 246, 248, 0.9); font-weight: 600; }
    .calendar-card__visual a { color: #7f5af0; text-decoration: none; font-weight: 600; }
    .calendar-card__visual a:hover { text-decoration: underline; }
    .calendar-card__assets { background: rgba(255,255,255,0.04); padding: 0.6rem; border-radius: 8px; }
    .calendar-card__assets strong { display: block; margin-bottom: 0.35rem; }
    .calendar-card__asset-chips { display: flex; flex-wrap: wrap; gap: 0.35rem; }
    .calendar-card__asset-chip { display: inline-flex; align-items: center; border-radius: 999px; border: 1px solid rgba(127,90,240,0.35); padding: 0.2rem 0.85rem; font-size: 0.85rem; color: #7f5af0; text-decoration: none; }
    .calendar-card__asset-chip:hover { border-color: rgba(127,90,240,0.7); }
    details { margin-top: 0.5rem; }
    details > summary { cursor: pointer; color: var(--text-primary); font-weight: 600; background: rgba(255,255,255,0.05); border: 1px solid var(--card-border); border-radius: 8px; padding: 0.4rem 0.6rem; width: fit-content; transition: all 0.2s ease; }
    details[open] > summary { background: var(--accent-soft); border-color: var(--accent-strong); }
    .details-body { margin-top: 0.5rem; display: grid; gap: 0.35rem; }
    footer { text-align: center; color: rgba(255,255,255,0.45); font-size: 0.9rem; margin-top: 1rem; }
  </style>
  </head>
  <body>
    <div class="container">
      <div class="brand">Promptly • Post export</div>
      ${cardHTML}
      <footer>Looks just like on Promptly. Tip: File → Print or Save as PDF.</footer>
    </div>
  </body>
</html>`;
}

// Save Calendar button handler
if (saveBtn) {
  saveBtn.addEventListener("click", async () => {
    const currentUser = await getCurrentUser();
    
    // Gate: Pro feature
    const userIsPro = await isPro(currentUser);
    if (!userIsPro) {
      showUpgradeModal();
      if (feedbackEl) {
        feedbackEl.textContent = "Save to Library is a Pro feature. Upgrade to save unlimited calendars!";
        feedbackEl.style.color = 'var(--accent)';
      }
      return;
    }
    
    const niche = nicheInput ? nicheInput.value.trim() : "";
    if (!currentCalendar || currentCalendar.length === 0) {
      alert("No calendar to save. Generate a calendar first.");
      return;
    }
    
    const calendarData = {
      nicheStyle: niche,
      posts: currentCalendar,
      generatedAt: new Date().toISOString(),
      generatedByAI: true,
    };
    
  // Save to user's calendars
    if (!currentUser) {
      alert("You must be logged in to save calendars.");
      return;
    }
    
    try {
      const savedRecord = await saveUserCalendar(currentUser, calendarData);
      setCurrentCalendarId(extractCalendarId(savedRecord));
      if (feedbackEl) {
        feedbackEl.textContent = `✓ Calendar saved for "${niche}"`;
        feedbackEl.classList.add("success");
        setTimeout(() => {
          if (feedbackEl) {
            feedbackEl.textContent = "";
            feedbackEl.classList.remove("success");
          }
        }, 2500);
      }
    } catch (error) {
      console.error('saveUserCalendar failed', error);
      alert(error?.message || "Failed to save calendar. Please try again.");
    }
  });
}

function bindDeleteCalendarButton() {
  const deleteButton = deleteCalendarBtn || document.getElementById('delete-calendar-button');
  if (!deleteButton) {
    return;
  }
  console.log('[Promptly] Binding Delete Calendar button handler.');
  deleteButton.style.outline = '2px solid rgba(255, 255, 255, 0.4)';
  deleteButton.style.zIndex = '50';
  deleteButton.style.position = 'relative';
  deleteButton.addEventListener('click', async () => {
    console.log('[Promptly] Delete Calendar clicked', { currentCalendarId });
    const confirmed = window.confirm('Delete this calendar from the page? This will clear all days from view.');
    if (!confirmed) return;
    const originalLabel = deleteButton.textContent;
    deleteButton.textContent = 'Deleting…';
    deleteButton.disabled = true;
    const idToDelete = currentCalendarId;
    clearCalendarUI();
    await deleteCalendarByIdIfPossible(idToDelete);
    if (feedbackEl) {
      feedbackEl.textContent = 'Calendar cleared from the page.';
      feedbackEl.classList.remove('success');
      setTimeout(() => {
        if (feedbackEl && feedbackEl.textContent === 'Calendar cleared from the page.') {
          feedbackEl.textContent = '';
        }
      }, 2500);
    }
    deleteButton.textContent = originalLabel || 'Delete Calendar';
    deleteButton.disabled = false;
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', bindDeleteCalendarButton);
} else {
  bindDeleteCalendarButton();
}

const DEFAULT_IDEA_TEXT = 'Engaging post idea';
const DEFAULT_CAPTION_TEXT = 'Quick tip that helps you today.\nSave this for later.';
const DEFAULT_STORY_PROMPT_TEXT = "Share behind-the-scenes of today's work.";

const POST_SLOT_ANGLES = [
  {
    name: 'Story spotlight',
    buildIdea: (base) => `Story spotlight: ${base}`,
    buildCaption: (base, cta) => `Story spotlight: ${base}. A real client walked in feeling stuck—we tweaked one move and the shift was wild. Ready for your own version? ${cta}`,
    buildStoryPrompt: (base) => `Record a 30-second selfie story describing how ${base} played out for a real person. Highlight their before, the pivot, and the win.`,
    designNotes: 'Use warm, candid footage plus on-screen captions that hit the turning point.',
    repurpose: ['Story clip → Reel remix', 'Quote the testimonial in a carousel'],
    analytics: ['Saves', 'Shares'],
    buildVideoScript: (base, cta) => ({
      hook: `What happened when we doubled down on ${base}?`,
      body: '1) Introduce the person\n2) Show the “aha” moment\n3) Reveal the result with a number.',
      cta,
    }),
    buildEngagementScripts: (base, cta) => ({
      commentReply: `Appreciate you checking out this story! Want the behind-the-scenes playbook for ${base.toLowerCase()}?`,
      dmReply: `I can map out how ${base.toLowerCase()} would look for you—want me to send the cheatsheet?`,
    }),
  },
  {
    name: 'Proof drop',
    buildIdea: (base) => `Proof drop: ${base}`,
    buildCaption: (base, cta) => `Proof drop: ${base}. Screenshot a metric, testimonial, or before/after that shows the transformation. Spell out the levers you pulled and invite them to replicate it. ${cta}`,
    buildStoryPrompt: (base) => `Film a voiceover scrolling through proof that ${base} works—circle the metric and narrate what changed.`,
    designNotes: 'Bold numeric typography, tight crop on stats, branded highlight color.',
    repurpose: ['Stat graphic → LinkedIn post', 'Metric → Email teaser'],
    analytics: ['Profile visits', 'Click-throughs'],
    buildVideoScript: (base, cta) => ({
      hook: `Need receipts that ${base} delivers?`,
      body: 'Walk through the numbers, then call out exactly what triggered the spike.',
      cta,
    }),
    buildEngagementScripts: (base) => ({
      commentReply: `Wild, right? If you want to know how ${base.toLowerCase()} works in your setup, ask away.`,
      dmReply: `Happy to unpack that proof point in DMs—want me to send the 3-step breakdown?`,
    }),
  },
  {
    name: 'Myth bust',
    buildIdea: (base) => `Myth busting: ${base}`,
    buildCaption: (base, cta) => `Myth busting time: people still believe the wrong thing about ${base}. Call out the myth, stack your truth with one vivid example, and end with an empowering action step. ${cta}`,
    buildStoryPrompt: (base) => `Record a quick myth-vs-truth reel pointing straight at the camera. Say “Myth:” then flip to “Here’s the truth about ${base}.”`,
    designNotes: 'Split-screen or text overlay that literally says “Myth” and “Truth.”',
    repurpose: ['Myth vs Truth carousel', 'Save as FAQ highlight'],
    analytics: ['Comments', 'Shares'],
    buildVideoScript: (base, cta) => ({
      hook: `Myth: ${base}. Truth: let me show you.`,
      body: 'Call out the belief, explain why it fails, and gift them the new habit.',
      cta,
    }),
    buildEngagementScripts: () => ({
      commentReply: 'Thanks for chiming in! Drop the next myth you hear all the time and I’ll break it down.',
      dmReply: 'If you’re running into that myth in real time, shoot me the context—I’ll help you counter it.',
    }),
  },
  {
    name: 'Community question',
    buildIdea: (base) => `Community question: ${base}`,
    buildCaption: (base) => `Community question: ${base}. Give your own POV first, then explicitly ask followers to share their routines, wins, or hurdles. Spotlight a few in Stories to keep the loop going.`,
    buildStoryPrompt: (base) => `Film yourself asking the question about ${base}, then stitch replies throughout the day.`,
    designNotes: 'Use a simple text-on-gradient background or selfie clip with captions + poll stickers.',
    repurpose: ['Turn answers into a roundup post', 'Collect quotes for newsletter'],
    analytics: ['Comments', 'DMs'],
    buildVideoScript: (base) => ({
      hook: `Real talk: how are you approaching ${base}?`,
      body: 'Share your stance, then ask them to weigh in with a specific emoji or keyword.',
      cta: 'Drop your answer in the comments—best one gets a shoutout.',
    }),
    buildEngagementScripts: () => ({
      commentReply: 'Love this perspective—mind if I feature it in Stories?',
      dmReply: 'Got it! I’ll share a couple bonus tips that expand on your take.',
    }),
  },
  {
    name: 'Mini training',
    buildIdea: (base) => `Mini training: ${base}`,
    buildCaption: (base, cta) => `Mini training: ${base}. Lay out a 3-step checklist: the setup, the action, the win they should expect. Encourage followers to screenshot it, try it tonight, then tell you how it went. ${cta}`,
    buildStoryPrompt: (base) => `Screen-record or slide through a whiteboard as you outline the 3 steps for ${base}.`,
    designNotes: 'Use numbered typography, punchy verbs, and arrows that show progression.',
    repurpose: ['Checklist → PDF lead magnet', 'Turn each step into a Story panel'],
    analytics: ['Saves', 'Replies'],
    buildVideoScript: (base, cta) => ({
      hook: `Here’s your 3-step plan for ${base}.`,
      body: 'Step 1: set the stage. Step 2: show the action. Step 3: reveal the payoff.',
      cta,
    }),
    buildEngagementScripts: (base) => ({
      commentReply: `Let me know when you run through those steps for ${base.toLowerCase()}—I’ll help troubleshoot.`,
      dmReply: 'Shoot me your screenshot and I’ll personalize the next move.',
    }),
  },
  {
    name: 'Offer reminder',
    buildIdea: (base) => `Offer reminder: ${base}`,
    buildCaption: (base, cta) => `Offer reminder: tie ${base} back to the program, product, or slot you have open. Spell out exactly who it helps, what they get, and why this week is the best time to jump in. ${cta}`,
    buildStoryPrompt: (base) => `Record a clip from your workspace or client area inviting them to claim the ${base}-style result.`,
    designNotes: 'Show a behind-the-scenes moment plus bold CTA button on screen.',
    repurpose: ['Turn into an email CTA', 'Use as pinned Story highlight'],
    analytics: ['Profile visits', 'Link clicks'],
    buildVideoScript: (base, cta) => ({
      hook: `Spots open for people who want ${base}.`,
      body: 'Explain what’s included, sprinkle urgency, and mention proof.',
      cta,
    }),
    buildEngagementScripts: (base, cta) => ({
      commentReply: `Just sent over details for ${base.toLowerCase()}—want me to hold a slot for you?`,
      dmReply: `Here’s the mini application for ${base.toLowerCase()}. I’ll keep an eye out for your name!`,
    }),
  },
  {
    name: 'Trend radar',
    buildIdea: (base) => `Trend radar: ${base}`,
    buildCaption: (base, cta) => `Trend radar: ${base}. Flag what’s changing this month, spell out how it impacts your audience, and recommend a micro-shift they can make today. ${cta}`,
    buildStoryPrompt: (base) => `Film a quick “trend desk” explainer: headline, why it matters, what you’re advising.`,
    designNotes: 'News-style lower thirds, ticker-inspired typography, animated arrows.',
    repurpose: ['Trend note → Newsletter opener', 'Trend clip → LinkedIn post'],
    analytics: ['Shares', 'Profile visits'],
    buildVideoScript: (base, cta) => ({
      hook: `If ${base} is on your radar, here’s what to watch:`,
      body: '1) Name the shift\n2) Show who it affects\n3) Give them a move to make',
      cta,
    }),
    buildEngagementScripts: (base) => ({
      commentReply: `Appreciate you keeping tabs on ${base.toLowerCase()} too—what signals are you seeing?`,
      dmReply: `Want a custom read on how ${base.toLowerCase()} will hit your brand? Shoot me your niche and I’ll riff.`,
    }),
  },
  {
    name: 'Swipe file',
    buildIdea: (base) => `Swipe file: ${base}`,
    buildCaption: (base, cta) => `Swipe file drop: ${base}. Outline the exact template, line-by-line, and invite followers to screenshot + tag you when they try it. ${cta}`,
    buildStoryPrompt: (base) => `Share a “copy this” walkthrough: point to each line of the swipe file while narrating how to personalize it.`,
    designNotes: 'Use cursor highlights, note-style backgrounds, or Notion-style cards.',
    repurpose: ['Swipe → PDF lead magnet', 'Swipe → Carousel frames'],
    analytics: ['Saves', 'Replies'],
    buildVideoScript: (base, cta) => ({
      hook: `Steal this ${base} swipe in 3 lines.`,
      body: 'Line 1: pattern interrupt\nLine 2: promise\nLine 3: CTA',
      cta,
    }),
    buildEngagementScripts: (base) => ({
      commentReply: `Tag me when you plug this ${base.toLowerCase()} swipe into your content—I’ll amplify my favorites.`,
      dmReply: `Send me your version and I’ll tweak the hook for you.`,
    }),
  },
  {
    name: 'Build in public',
    buildIdea: (base) => `Build in public: ${base}`,
    buildCaption: (base, cta) => `Build-in-public check-in: show where ${base} is today, what broke, and the one experiment you’re running next. Transparently sharing the messy middle builds trust. ${cta}`,
    buildStoryPrompt: (base) => `Record a short vlog clip walking through the “in-progress” dashboard tied to ${base}.`,
    designNotes: 'B-roll of dashboards/whiteboards, handwritten annotations, quick status labels.',
    repurpose: ['Turn into blog progress log', 'Clip into YouTube Short'],
    analytics: ['Profile visits', 'DMs'],
    buildVideoScript: (base, cta) => ({
      hook: `Building ${base} in public: here’s today’s update.`,
      body: 'Current status → friction point → next micro-step.',
      cta,
    }),
    buildEngagementScripts: (base) => ({
      commentReply: `If you’re building ${base.toLowerCase()} too, let’s trade notes—what stage are you in?`,
      dmReply: `Want to compare dashboards? I’ll send a Loom break-down.`,
    }),
  },
  {
    name: 'Hot take',
    buildIdea: (base) => `Hot take: ${base}`,
    buildCaption: (base, cta) => `Hot take: ${base}. Lead with the spicy belief, back it with one data point or story, then give the “if you disagree, try this” olive branch. ${cta}`,
    buildStoryPrompt: (base) => `Shoot a dramatic opener (zoom-in, clap, snap) before dropping the hot take about ${base}.`,
    designNotes: 'Bold gradient background, motion blur text, reaction emojis.',
    repurpose: ['Turn into Twitter thread', 'Use as debate poll in Stories'],
    analytics: ['Comments', 'Shares'],
    buildVideoScript: (base, cta) => ({
      hook: `Hot take: you’re doing ${base} wrong.`,
      body: 'Explain the belief, cite proof, offer alternative.',
      cta,
    }),
    buildEngagementScripts: (base) => ({
      commentReply: `Spicy! Drop your counterpoint—I’ll pin the best argument.`,
      dmReply: `Totally cool if you disagree. Want me to send the full breakdown behind this take?`,
    }),
  },
  {
    name: 'FAQ clinic',
    buildIdea: (base) => `FAQ clinic: ${base}`,
    buildCaption: (base, cta) => `FAQ clinic: answer the question you see nonstop about ${base}. Give the short version, the nuance, and a quick diagnostic so people know what bucket they’re in. ${cta}`,
    buildStoryPrompt: (base) => `Use question stickers to collect the FAQs about ${base}, then stitch your answers.`,
    designNotes: 'Clean Q&A cards, subtle borders, typewriter question text.',
    repurpose: ['Compile into FAQ highlight', 'Turn into blog Q&A'],
    analytics: ['Replies', 'Profile visits'],
    buildVideoScript: (base, cta) => ({
      hook: `${base}? Here’s the real answer.`,
      body: 'State the question → bust assumptions → recommend next step.',
      cta,
    }),
    buildEngagementScripts: (base) => ({
      commentReply: `Got another ${base.toLowerCase()} question? Drop it and I’ll tackle it next.`,
      dmReply: `I’ll send the long-form answer plus links—just say “FAQ me.”`,
    }),
  },
  {
    name: 'Client spotlight',
    buildIdea: (base) => `Client spotlight: ${base}`,
    buildCaption: (base, cta) => `Client spotlight: highlight one person who implemented ${base} and narrate their before/after. Tag them if they’re cool with it and share the exact prompt you gave them. ${cta}`,
    buildStoryPrompt: (base) => `Record a short montage of the client’s win with captions describing the ${base} approach.`,
    designNotes: 'Use testimonial card overlays, signature colors, and a hero photo.',
    repurpose: ['Turn into case study PDF', 'Send as sales follow-up asset'],
    analytics: ['Saves', 'Link clicks'],
    buildVideoScript: (base, cta) => ({
      hook: `Client spotlight: how ${base} changed their week.`,
      body: 'Introduce the client → describe pain → show the win + data.',
      cta,
    }),
    buildEngagementScripts: (base, cta) => ({
      commentReply: `Want the same ${base.toLowerCase()} result? I’ll send you the starter checklist.`,
      dmReply: `Happy to intro you to this client if you’re curious—tap me and I’ll connect you.`,
    }),
  },
];

const UNIQUE_TOPIC_BLUEPRINTS = [
  {
    name: 'Aftercare blueprint',
    idea: (subject, helpers) => `Aftercare blueprint: 72 hours after ${subject}`,
    caption: (subject, helpers) => `Glow insurance for ${subject}: here’s the 24-hour, 48-hour, and 72-hour checklist that keeps results locked in. Save it, tape it to your mirror, and tag us when you follow through. ${helpers.cta}`,
    storyPrompt: (subject) => `Film your top three aftercare must-haves after ${subject} and label when to use them.`,
    designNotes: 'Flat lay of products with annotated arrows and timestamps.',
    repurpose: ['Turn into printable checklist', 'Add to automated SMS follow-up'],
    analytics: ['Saves', 'Replies'],
    buildVideoScript: (subject, helpers) => ({
      hook: `Stop sabotaging ${subject} with weak aftercare.`,
      body: 'Show the kit • explain why each step matters • highlight one common mistake.',
      cta: helpers.cta,
    }),
    buildEngagementScripts: (subject) => ({
      commentReply: `Need me to text you this ${subject} aftercare plan? Drop “REMIND” below.`,
      dmReply: `Send me a selfie after your ${subject} tomorrow and I’ll double-check healing for you.`,
    }),
  },
  {
    name: 'Event countdown',
    idea: (subject, helpers) => `${helpers.title} countdown: when to book before a big event`,
    caption: (subject, helpers) => `VIP timeline alert: here’s exactly when to schedule ${subject} if you’re prepping for a wedding, shoot, or party. Screenshot the 5-day countdown and share it with your group chat. ${helpers.cta}`,
    storyPrompt: () => 'Create a vertical timeline graphic and narrate each milestone.',
    designNotes: 'Use timeline layout with dates and checkmarks.',
    repurpose: ['Send to bridal leads', 'Turn into pinned Story highlight'],
    analytics: ['Saves', 'Shares'],
    buildVideoScript: (subject, helpers) => ({
      hook: `Booking ${subject} before an event? Do this.`,
      body: 'Day -7: prep • Day -3: treatment • Day -1: aftercare drill.',
      cta: helpers.cta,
    }),
    buildEngagementScripts: () => ({
      commentReply: 'Tell me your event date and I’ll pop the ideal appointment windows in your DMs.',
      dmReply: 'Drop the date + vibe and I’ll send a personalized countdown.',
    }),
  },
  {
    name: 'Ingredient face-off',
    idea: (subject, helpers) => `Ingredient face-off inside ${subject}`,
    caption: (subject, helpers) => `Two MVP ingredients power this ${subject}. Let’s compare what each one does, who it’s best for, and how to know when you need it. ${helpers.cta}`,
    storyPrompt: () => 'Film a side-by-side reel labeling each ingredient’s benefit.',
    designNotes: 'Split-screen ingredient cards with icons.',
    repurpose: ['Turn into carousel explainer', 'Convert to email mini-lesson'],
    analytics: ['Saves', 'Comments'],
    buildVideoScript: (subject, helpers) => ({
      hook: `Ingredient showdown inside your ${subject}.`,
      body: 'Highlight ingredient A • highlight ingredient B • explain the combo magic.',
      cta: helpers.cta,
    }),
    buildEngagementScripts: (subject) => ({
      commentReply: `Curious which ${subject} ingredient you need? Tell me your skin goal and I’ll answer.`,
      dmReply: `Shoot me a photo of the products you already use—I’ll tell you if they pair with this ${subject}.`,
    }),
  },
  {
    name: 'Membership spotlight',
    idea: (subject, helpers) => `Membership perks for consistent ${subject}`,
    caption: (subject, helpers) => `If you love ${subject}, the membership pays for itself. Here’s what weekly/biweekly visits unlock, the surprise perks, and the accountability you didn’t know you needed. ${helpers.cta}`,
    storyPrompt: () => 'Record a walkthrough of the member portal or welcome kit.',
    designNotes: 'Use card stack visuals with perk highlights.',
    repurpose: ['Turn into sales page section', 'Include in onboarding email'],
    analytics: ['Profile visits', 'Link clicks'],
    buildVideoScript: (subject, helpers) => ({
      hook: `Membership math for ${subject}: let’s break it down.`,
      body: 'Cost vs value, bonus perks, and who it’s perfect for.',
      cta: helpers.cta,
    }),
    buildEngagementScripts: () => ({
      commentReply: 'Want me to run the numbers based on your routine? Drop “membership” and I’ll DM you.',
      dmReply: 'I’ll send over the full perk stack plus current openings—just say the word.',
    }),
  },
  {
    name: 'Seasonal switch-up',
    idea: (subject, helpers) => `Seasonal switch-up: how ${subject} changes`,
    caption: (subject, helpers) => `Seasons change, so should your ${subject}. Here’s how we tweak exfoliation, hydration, and LED time when temps swing. ${helpers.cta}`,
    storyPrompt: () => 'Film B-roll of seasonal props (sun hat vs cozy scarf) and overlay tips.',
    designNotes: 'Use split seasonal palette with icons.',
    repurpose: ['Update blog seasonal guide', 'Send as quarterly reminder'],
    analytics: ['Shares', 'Replies'],
    buildVideoScript: (subject, helpers) => ({
      hook: `Your ${subject} in winter vs summer.`,
      body: 'Call out the mistakes • show your tweak • invite them to book the seasonal plan.',
      cta: helpers.cta,
    }),
    buildEngagementScripts: (subject) => ({
      commentReply: `What climate are you in? I’ll tailor the ${subject} switch-up for you.`,
      dmReply: `Send me your current routine—I’ll highlight what to pause until spring.`,
    }),
  },
  {
    name: 'At-home vs pro',
    idea: (subject, helpers) => `At-home vs pro results with ${subject}`,
    caption: (subject, helpers) => `DIY can be cute, but here’s what only a pro ${subject} delivers. Outline the at-home steps we still love, then show the pro-only benefits. ${helpers.cta}`,
    storyPrompt: () => 'Split screen reel: home routine on one side, pro tools on the other.',
    designNotes: 'Use checklists + “pro only” stamps.',
    repurpose: ['Turn into lead magnet', 'Use as FAQ reply'],
    analytics: ['Saves', 'Profile visits'],
    buildVideoScript: (subject, helpers) => ({
      hook: `Can you DIY ${subject}?`,
      body: 'List what’s safe at home • list what’s better in-studio • call to action.',
      cta: helpers.cta,
    }),
    buildEngagementScripts: (subject) => ({
      commentReply: `Curious if your at-home tools play nice with ${subject}? Tell me the brand.`,
      dmReply: `Send me your cart screenshot and I’ll give a thumbs up/down.`,
    }),
  },
  {
    name: 'Add-on stack',
    idea: (subject, helpers) => `Add-on stack: level up your ${subject}`,
    caption: (subject, helpers) => `Want your ${subject} to hit harder? Stack it with these two add-ons. Share the price, time, and who each combo is perfect for. ${helpers.cta}`,
    storyPrompt: () => 'Record a “choose your own adventure” Stories poll with add-on combos.',
    designNotes: 'Use flow-chart arrows showing combinations.',
    repurpose: ['Bundle into sales deck', 'Upsell via email'],
    analytics: ['Upsells', 'Replies'],
    buildVideoScript: (subject, helpers) => ({
      hook: `The add-on stack that makes ${subject} unstoppable.`,
      body: 'Add-on 1 reason • Add-on 2 reason • real client reaction.',
      cta: helpers.cta,
    }),
    buildEngagementScripts: (subject) => ({
      commentReply: `Tell me your goal and I’ll recommend the perfect ${subject} stack.`,
      dmReply: `I’ll hold a spot for the combo you want—just drop your preferred day.`,
    }),
  },
  {
    name: 'Pricing clarity',
    idea: (subject, helpers) => `Pricing clarity: where your ${subject} investment goes`,
    caption: (subject, helpers) => `Here’s what you pay for with ${subject}: sterile tools, licensed pros, medical-grade serums, and the follow-up plan. Transparency builds trust, so let’s show the receipt. ${helpers.cta}`,
    storyPrompt: () => 'Film a reel labeling each cost bucket on-screen.',
    designNotes: 'Receipt-style typography with highlighted lines.',
    repurpose: ['Embed on pricing page', 'Send during sales consults'],
    analytics: ['Profile visits', 'Link clicks'],
    buildVideoScript: (subject, helpers) => ({
      hook: `Ever wonder why ${subject} costs what it does?`,
      body: 'Line-item the investment • show what corners you refuse to cut.',
      cta: helpers.cta,
    }),
    buildEngagementScripts: () => ({
      commentReply: 'Have a budget? Tell me and I’ll map what we can achieve inside it.',
      dmReply: 'I’ll send financing + membership options—just DM “pricing.”',
    }),
  },
  {
    name: 'Mistake audit',
    idea: (subject, helpers) => `Mistakes we fix before ${subject}`,
    caption: (subject, helpers) => `I see the same three mistakes right before ${subject}: wrong cleanser, skipping SPF, and sleeping on silk. Call them out, show how you correct them, and invite followers to audit themselves. ${helpers.cta}`,
    storyPrompt: () => 'Create a carousel: “Did you do this?” → “Here’s the fix.”',
    designNotes: 'Use bold red “fix this” banners.',
    repurpose: ['Use as onboarding PDF', 'Share in welcome email'],
    analytics: ['Comments', 'Saves'],
    buildVideoScript: (subject, helpers) => ({
      hook: `Don’t book ${subject} until you stop doing this.`,
      body: 'Mistake • consequence • quick fix.',
      cta: helpers.cta,
    }),
    buildEngagementScripts: () => ({
      commentReply: 'Confess your pre-appointment habits and I’ll doctor them up.',
      dmReply: 'Send me your routine and I’ll flag what to pause before we treat you.',
    }),
  },
  {
    name: 'Audience pivot',
    idea: (subject, helpers) => `${helpers.title} for first-timers`,
    caption: (subject, helpers) => `Teens, men, and first-timers ask if ${subject} is “for them.” Answer with empathy: explain sensations, prep, and confidence boosts. ${helpers.cta}`,
    storyPrompt: () => 'Interview a first-time client about how it actually felt.',
    designNotes: 'Use approachable, friendly typography and candid photography.',
    repurpose: ['Feature on FAQ page', 'Create pinned TikTok'],
    analytics: ['Follows', 'DMs'],
    buildVideoScript: (subject, helpers) => ({
      hook: `First ${subject}? Here’s what to expect.`,
      body: 'Walk through arrival • treatment • aftercare.',
      cta: helpers.cta,
    }),
    buildEngagementScripts: () => ({
      commentReply: 'If it’s your first time, tell me your biggest worry—I’ll answer it publicly.',
      dmReply: 'Drop me a “newbie” DM and I’ll voice-note the full rundown.',
    }),
  },
  {
    name: 'Tool + tech spotlight',
    idea: (subject, helpers) => `Tool spotlight inside ${subject}`,
    caption: (subject, helpers) => `Let’s geek out over the tech that powers ${subject}. Break down how the tool works, safety checks you run, and the sensation clients actually feel. ${helpers.cta}`,
    storyPrompt: () => 'Film a close-up of the tool in action with narration.',
    designNotes: 'Use blueprint lines, arrows, and specs.',
    repurpose: ['Add to diagnostic landing page', 'Send as “meet the tech” email'],
    analytics: ['Profile visits', 'Shares'],
    buildVideoScript: (subject, helpers) => ({
      hook: `Meet the tech that makes ${subject} possible.`,
      body: 'Show the interface • show calibration • show real-time results.',
      cta: helpers.cta,
    }),
    buildEngagementScripts: () => ({
      commentReply: 'Got a gear question? I’m the nerd to ask.',
      dmReply: 'I’ll send you the full spec sheet plus why we chose this model.',
    }),
  },
  {
    name: 'Progress diary',
    idea: (subject, helpers) => `Progress diary: 3 visits of ${subject}`,
    caption: (subject, helpers) => `Document the journey: Visit 1 baseline, Visit 2 turning point, Visit 3 glow-up. People trust receipts, so show them the diary. ${helpers.cta}`,
    storyPrompt: () => 'Compile voice memos or quick clips after each visit.',
    designNotes: 'Scrapbook layout with Polaroid frames.',
    repurpose: ['Turn into blog case study', 'Use as nurture email arc'],
    analytics: ['Saves', 'Link clicks'],
    buildVideoScript: (subject, helpers) => ({
      hook: `What 3 ${subject} visits look like.`,
      body: 'Baseline clip • mid-way clip • final reveal.',
      cta: helpers.cta,
    }),
    buildEngagementScripts: () => ({
      commentReply: 'Want me to document your journey too? Say “diary me.”',
      dmReply: 'I’ll send the consent form + how we keep your footage cute.',
    }),
  },
];
const UNIQUE_SUFFIXES = [
  'Remix',
  'Deep Dive',
  'Blueprint',
  'Hot Seat',
  'Playbook',
  'Office Hours',
  'Pulse Check',
  'Lightning Lesson',
  'Creator POV',
  'Swipe This',
];

function mergeUnique(list, additions) {
  const base = Array.isArray(list) ? [...list] : (list ? [list] : []);
  (additions || []).forEach((item) => {
    if (item && !base.includes(item)) base.push(item);
  });
  return base;
}

function applySlotAngle(post, angle, slotNumber) {
  if (!angle) return;
  const baseIdea = (post.idea || DEFAULT_IDEA_TEXT).trim();
  const cta = post.cta || 'DM us to book today';
  if (angle.buildIdea) post.idea = angle.buildIdea(baseIdea, slotNumber);
  if (angle.buildCaption) post.caption = angle.buildCaption(baseIdea, cta, post.caption);
  if (angle.buildStoryPrompt) post.storyPrompt = angle.buildStoryPrompt(baseIdea);
  if (angle.designNotes) post.designNotes = angle.designNotes;
  if (angle.repurpose) post.repurpose = mergeUnique(post.repurpose, angle.repurpose);
  if (angle.analytics) post.analytics = mergeUnique(post.analytics, angle.analytics);
  if (angle.buildVideoScript) {
    const video = angle.buildVideoScript(baseIdea, cta);
    post.videoScript = { ...(post.videoScript || {}), ...video };
  }
  const engagement = angle.buildEngagementScripts ? angle.buildEngagementScripts(baseIdea, cta) : null;
  if (engagement) {
    post.engagementScripts = {
      commentReply: engagement.commentReply || (post.engagementScripts?.commentReply ?? ''),
      dmReply: engagement.dmReply || (post.engagementScripts?.dmReply ?? ''),
    };
  }
}

const TOPIC_STOPWORDS = new Set([
  'the','and','for','with','that','this','your','from','have','just','about','only','they','them','into','their','ours','you','our','are','was','were','than','then','when','what','ever','everyone','older','people','glowing','skin','glow','make','like','want','need','more','less','very','much','also','after','before','even'
]);

function extractKeyword(text = '') {
  const tokens = (text || '').toLowerCase().match(/[a-z0-9]+/g) || [];
  for (const token of tokens) {
    if (token.length > 3 && !TOPIC_STOPWORDS.has(token)) return token;
  }
  return 'your service';
}

function toTitleCase(str = '') {
  return str.replace(/\w\S*/g, (txt) => txt.charAt(0).toUpperCase() + txt.slice(1));
}

function applyTopicBlueprint(post, blueprint, keyword, slotNumber) {
  if (!blueprint) return;
  const normalized = (keyword || 'your service').replace(/\s+/g, ' ').trim();
  const helpers = {
    cta: post.cta || 'DM us to book today',
    slotNumber,
    title: toTitleCase(normalized),
  };
  if (blueprint.idea) post.idea = blueprint.idea(normalized, helpers);
  if (blueprint.caption) post.caption = blueprint.caption(normalized, helpers);
  if (blueprint.storyPrompt) post.storyPrompt = blueprint.storyPrompt(normalized, helpers);
  if (blueprint.designNotes) post.designNotes = blueprint.designNotes;
  if (blueprint.pillar) post.pillar = blueprint.pillar;
  if (blueprint.cta) post.cta = typeof blueprint.cta === 'function' ? blueprint.cta(normalized, helpers) : blueprint.cta;
  if (blueprint.repurpose) post.repurpose = mergeUnique(post.repurpose, blueprint.repurpose);
  if (blueprint.analytics) post.analytics = mergeUnique(post.analytics, blueprint.analytics);
  if (blueprint.buildVideoScript) {
    const video = blueprint.buildVideoScript(normalized, helpers);
    post.videoScript = { ...(post.videoScript || {}), ...video };
  }
  const engagement = blueprint.buildEngagementScripts ? blueprint.buildEngagementScripts(normalized, helpers) : null;
  if (engagement) {
    post.engagementScripts = {
      commentReply: engagement.commentReply || (post.engagementScripts?.commentReply ?? ''),
      dmReply: engagement.dmReply || (post.engagementScripts?.dmReply ?? ''),
    };
  }
}

function applyVariantByIndex(post, index, keyword) {
  if (index < POST_SLOT_ANGLES.length) {
    applySlotAngle(post, POST_SLOT_ANGLES[index], (post.slot || 0) + index);
    return true;
  }
  const blueprintIndex = index - POST_SLOT_ANGLES.length;
  if (blueprintIndex < UNIQUE_TOPIC_BLUEPRINTS.length) {
    applyTopicBlueprint(post, UNIQUE_TOPIC_BLUEPRINTS[blueprintIndex], keyword, (post.slot || 0) + index);
    return true;
  }
  return false;
}

function normalizeSignature(text = '') {
  return text.trim().toLowerCase().replace(/\s+/g, ' ');
}

function isGenericPost(post) {
  const idea = normalizeSignature(post.idea || '');
  const caption = normalizeSignature(post.caption || '');
  const story = normalizeSignature(post.storyPrompt || '');
  return (
    !idea ||
    idea === normalizeSignature(DEFAULT_IDEA_TEXT) ||
    !caption ||
    caption === normalizeSignature(DEFAULT_CAPTION_TEXT) ||
    story === normalizeSignature(DEFAULT_STORY_PROMPT_TEXT)
  );
}

function ensureUniqueDailyPosts(posts, frequency) {
  if (!Array.isArray(posts) || posts.length === 0) return posts;
  const maxAngles = POST_SLOT_ANGLES.length;
  const groups = new Map();
  posts.forEach((post, idx) => {
    const dayKey = typeof post.day === 'number' ? post.day : Math.floor(idx / Math.max(frequency || 1, 1)) + 1;
    if (!groups.has(dayKey)) groups.set(dayKey, []);
    groups.get(dayKey).push(post);
  });
  groups.forEach((dayPosts) => {
    const seen = new Set();
    dayPosts.forEach((post, slotIdx) => {
      const key = `${normalizeSignature(post.idea || '')}|${normalizeSignature(post.caption || '')}`;
      const needsAngle = isGenericPost(post) || seen.has(key);
      if (needsAngle) {
        const angle = POST_SLOT_ANGLES[slotIdx % maxAngles];
        applySlotAngle(post, angle, slotIdx + 1);
      }
      const updatedKey = `${normalizeSignature(post.idea || '')}|${normalizeSignature(post.caption || '')}`;
      seen.add(updatedKey);
    });
  });
  return posts;
}

function makePostSignature(post) {
  return `${normalizeSignature(post.idea || post.title || '')}|${normalizeSignature(post.caption || '')}`;
}

function ensureGlobalVariety(posts) {
  if (!Array.isArray(posts)) return posts;
  const baseCounts = new Map();
  const finalKeys = new Set();
  posts.forEach((post) => {
    const baseKey = makePostSignature(post);
    const seen = baseCounts.get(baseKey) || 0;
    const keyword = extractKeyword(post.idea || post.title || post.caption || '');
    const needsRewrite = isGenericPost(post) || seen > 0;
    if (needsRewrite) {
      const handled = applyVariantByIndex(post, seen, keyword);
      if (!handled) {
        const suffix = UNIQUE_SUFFIXES[(seen - POST_SLOT_ANGLES.length) % UNIQUE_SUFFIXES.length];
        post.idea = `${post.idea} (${suffix})`;
        post.caption = `${post.caption}\n\n${suffix}: screenshot this so you remember it later.`;
      }
    }
    baseCounts.set(baseKey, seen + 1);
    let finalKey = makePostSignature(post);
    let guard = 0;
    while (finalKeys.has(finalKey) && guard < UNIQUE_TOPIC_BLUEPRINTS.length) {
      guard++;
      const adjusted = applyVariantByIndex(post, seen + guard, keyword);
      if (!adjusted) break;
      finalKey = makePostSignature(post);
    }
    if (finalKeys.has(finalKey)) {
      const suffix = UNIQUE_SUFFIXES[(finalKeys.size + guard) % UNIQUE_SUFFIXES.length];
      post.idea = `${post.idea} (${suffix})`;
      post.caption = `${post.caption}\n\n${suffix}: screenshot this so you remember it later.`;
      finalKey = makePostSignature(post);
    }
    finalKeys.add(finalKey);
  });
  return posts;
}

// Normalize a post to guarantee all required fields exist
function normalizePost(p, idx = 0, startDay = 1) {
  const out = {
    day: typeof p.day === 'number' ? p.day : (startDay + idx),
    idea: p.idea || p.title || DEFAULT_IDEA_TEXT,
    type: p.type || 'educational',
    caption: p.caption || DEFAULT_CAPTION_TEXT,
    hashtags: Array.isArray(p.hashtags) ? p.hashtags : (p.hashtags ? String(p.hashtags).split(/\s+|,\s*/).filter(Boolean) : ['marketing','content','tips','learn','growth','brand']),
    format: p.format || 'Reel',
    cta: p.cta || 'DM us to book today',
    pillar: p.pillar || 'Education',
    storyPrompt: p.storyPrompt || DEFAULT_STORY_PROMPT_TEXT,
    designNotes: p.designNotes || 'Clean layout, bold headline, brand colors.',
    repurpose: Array.isArray(p.repurpose) && p.repurpose.length ? p.repurpose : (p.repurpose ? [p.repurpose] : ['Reel -> Carousel (3 slides)','Caption -> Story (2 frames)']),
    analytics: Array.isArray(p.analytics) && p.analytics.length ? p.analytics : (p.analytics ? [p.analytics] : ['Reach','Saves']),
    engagementScripts: p.engagementScripts || { commentReply: 'Appreciate you! Want our menu?', dmReply: 'Starts at $99. Want me to book you this week?' },
    promoSlot: typeof p.promoSlot === 'boolean' ? p.promoSlot : !!p.weeklyPromo,
    weeklyPromo: typeof p.weeklyPromo === 'string' ? (p.promoSlot ? p.weeklyPromo : '') : '',
    videoScript: p.videoScript || { hook: 'Stop scrolling—quick tip', body: 'Show result • Explain 1 step • Tease benefit', cta: 'DM us to grab your spot' },
    variants: p.variants || undefined,
  };
  // Back-compat: if old single engagementScript field exists, map into engagementScripts.commentReply
  if (!out.engagementScripts) out.engagementScripts = { commentReply: '', dmReply: '' };
  if (!out.engagementScripts.commentReply && p.engagementScript) out.engagementScripts.commentReply = p.engagementScript;
  if (!out.engagementScripts.dmReply) out.engagementScripts.dmReply = out.engagementScripts.dmReply || '';
  // Ensure hashtags have # prefix for display purposes later
  out.hashtags = Array.isArray(out.hashtags) ? out.hashtags : [];
  return { ...p, ...out };
}

// OpenAI API integration (via backend proxy)
async function generateCalendarWithAI(nicheStyle, postsPerDay = 1) {
  console.log(" generateCalendarWithAI called with:", nicheStyle);
  
  try {
    const currentUserEmail = await getCurrentUser();
    const userIsPro = currentUserEmail ? await isPro(currentUserEmail) : false;
    const normalizedFrequency = Math.max(parseInt(postsPerDay, 10) || 1, 1);
    const batchSize = 5;
    const totalDays = 30;
    const totalPosts = totalDays * normalizedFrequency;
    const totalBatches = Math.ceil(totalPosts / batchSize);
    let completedBatches = 0;
    
    // Helper to fetch one batch
    const fetchBatch = async (batchIndex) => {
      const remaining = totalPosts - batchIndex * batchSize;
      const requestSize = Math.min(batchSize, remaining);
      const startDay = Math.floor((batchIndex * batchSize) / normalizedFrequency) + 1;
      console.log(` Requesting batch ${batchIndex + 1}/${totalBatches} (days ${startDay}-${startDay + batchSize - 1})`);
      
      const response = await fetch("/api/generate-calendar", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ 
          nicheStyle, 
          userId: getCurrentUser() || undefined, 
          days: requestSize, 
          startDay,
          postsPerDay: normalizedFrequency
        })
      });
      
      if (!response.ok) {
        let detail = '';
        try {
          detail = await response.text();
        } catch (_) {}
        const parsedDetail = (() => {
          try {
            return detail ? JSON.parse(detail) : null;
          } catch {
            return null;
          }
        })();
        const hint = parsedDetail?.error || detail || response.statusText;
        throw new Error(`API error: ${hint}`);
      }
      
      const data = await response.json();
      let batchPosts = Array.isArray(data.posts) ? data.posts : [];

      // Update progress UI as each batch completes
      completedBatches++;
      const btn = document.getElementById('generate-calendar');
      const textSpan = btn?.querySelector('.btn-text');
      const pFill = document.getElementById('progress-fill');
      const pText = document.getElementById('progress-text');
      
      const progress = Math.min(completedBatches * batchSize, totalPosts);
      const percent = Math.round((progress / totalPosts) * 100);
      
      if (textSpan) textSpan.textContent = `Generating... (${progress}/${totalPosts} posts)`;
      if (pFill) pFill.style.width = `${percent}%`;
      if (pText) pText.textContent = `${progress} of ${totalPosts} posts created (${percent}%)`;

      if (userIsPro && batchPosts.length) {
        try {
          batchPosts = await generateVariantsForPosts(batchPosts, {
            nicheStyle,
            userId: currentUserEmail,
            userIsPro: true,
          });
        } catch (variantErr) {
          console.warn('Variant generation failed for batch', batchIndex + 1, variantErr);
        }
      }

      console.log(` Batch ${batchIndex + 1} complete`);
      return { batchIndex, posts: batchPosts };
    };
    
    // Fire all 6 batches in parallel for maximum speed (~30 seconds)
    console.log(" Requesting all batches in parallel...");
    const batchPromises = Array.from({ length: totalBatches }, (_, i) => fetchBatch(i));
    const results = await Promise.all(batchPromises);
    
    // Sort by batch index and flatten
    let allPosts = results
      .sort((a, b) => a.batchIndex - b.batchIndex)
      .flatMap(r => r.posts);

    // Normalize every post to guarantee required fields
    const normalized = allPosts.map((p, i) => normalizePost(p, i, 1)).slice(0, totalPosts);
    // Simple integrity check
    const bad = normalized.filter(p => !p.videoScript || !p.caption || !p.hashtags || !Array.isArray(p.hashtags) || !p.storyPrompt || !p.designNotes || !p.engagementScripts);
    if (bad.length) {
      console.warn(`⚠️ Client normalization filled missing fields on ${bad.length} posts.`);
    }
    allPosts = normalized.map((post, idx) => {
      const dayIndex = Math.floor(idx / normalizedFrequency) + 1;
      const slot = (idx % normalizedFrequency) + 1;
      return { ...post, day: dayIndex, slot };
    });

    if (normalizedFrequency > 1) {
      allPosts = ensureUniqueDailyPosts(allPosts, normalizedFrequency);
    }
    allPosts = ensureGlobalVariety(allPosts);

    if (userIsPro) {
      allPosts = allPosts.map((post, idx) => enrichPostWithProFields(post, idx, nicheStyle));
    } else {
      allPosts = allPosts.map((post) => stripProFields(post));
    }

    console.log(" All batches complete, total posts:", allPosts.length);
    return allPosts;
  } catch (err) {
    console.error(" generateCalendarWithAI error:", err);
    console.error(" Error details:", { message: err.message, stack: err.stack });
    throw err;
  }
}
function downloadCalendarAsJSON(calendar, nicheStyle) {
  const metadata = {
    nicheStyle: nicheStyle,
    generatedAt: new Date().toISOString(),
    generatedByAI: true,
  };

  const payloadObj = {
    metadata,
    posts: calendar,
  };

  const payload = JSON.stringify(payloadObj, null, 2);
  const blob = new Blob([payload], { type: "application/json" });
  const url = URL.createObjectURL(blob);

  const safeName = `30-day-content-calendar-${slugify(nicheStyle)}.json`;

  const a = document.createElement("a");
  a.href = url;
  a.download = safeName;
  document.body.appendChild(a);
  a.click();
  a.remove();

  URL.revokeObjectURL(url);
}

// Track calendar generations per month for free users
function getGenerationCount() {
  const user = getCurrentUser();
  if (!user) return 0;
  const key = `promptly_gen_count_${user}`;
  const stored = localStorage.getItem(key);
  if (!stored) return 0;
  const data = JSON.parse(stored);
  const now = new Date();
  const storedMonth = new Date(data.month);
  // Reset if different month
  if (now.getMonth() !== storedMonth.getMonth() || now.getFullYear() !== storedMonth.getFullYear()) {
    return 0;
  }
  return data.count || 0;
}

function incrementGenerationCount() {
  const user = getCurrentUser();
  if (!user) return;
  const key = `promptly_gen_count_${user}`;
  const now = new Date();
  localStorage.setItem(key, JSON.stringify({
    month: now.toISOString(),
    count: getGenerationCount() + 1
  }));
}

async function canGenerate() {
  return true;
}

if (generateBtn) {
  generateBtn.addEventListener("click", async () => {
    const niche = nicheInput ? nicheInput.value.trim() : "";
    console.log(" Generate clicked, niche:", niche);
    
    const { ok, msg } = validateNiche(niche);
    console.log(" Validation result:", { ok, msg });
    
    if (!ok) {
      // show validation feedback and focus
      console.log("❌ Validation failed:", msg);
      if (feedbackEl) feedbackEl.textContent = msg;
      if (nicheInput) {
        nicheInput.classList.add("invalid");
        nicheInput.focus();
      }
      return;
    }

    // Check generation limit for free users
    if (!(await canGenerate())) {
      showUpgradeModal();
      if (feedbackEl) {
        feedbackEl.textContent = " You've reached your free calendar limit for this month. Upgrade to Pro for unlimited calendars!";
        feedbackEl.style.color = 'var(--accent)';
      }
      return;
    }

    const originalText = btnText ? btnText.textContent : (generateBtn ? generateBtn.textContent : 'Generate Calendar');
    // proceed with AI generation and display
    try {
      console.log(" Starting AI generation for:", niche);
      showGeneratingState();
      if (feedbackEl) feedbackEl.textContent = "";
      console.log(" Calling API with niche:", niche);

      // Call OpenAI to generate calendar
      const postsPerDay = getPostFrequency();
      currentPostFrequency = postsPerDay;
      const aiGeneratedPosts = await generateCalendarWithAI(niche, postsPerDay);
      console.log(" Received posts:", aiGeneratedPosts);
      
      // Increment generation count for free users
      incrementGenerationCount();
      
      // Store the calendar and render it
      currentCalendar = aiGeneratedPosts;
      setCurrentCalendarId(null);
      currentNiche = niche;
      renderCards(currentCalendar);
      applyFilter("all");

      hideGeneratingState(originalText);
      activeTab = 'plan';
      syncCalendarUIAfterDataChange({ scrollToCalendar: true });
      persistCurrentCalendarState();
      
      if (feedbackEl) {
        feedbackEl.textContent = `✓ Calendar created for "${niche}" · ${getPostFrequency()} posts/day`;
        feedbackEl.classList.add("success");
        setTimeout(() => {
          if (feedbackEl) {
            feedbackEl.textContent = "";
            feedbackEl.classList.remove("success");
          }
        }, 3000);
      }
    } catch (err) {
      console.error("❌ Failed to generate calendar:", err);
      console.error("❌ Error message:", err.message);
      console.error("❌ Full error:", err);
      hideGeneratingState('Try Again');
      if (feedbackEl) {
        feedbackEl.textContent = `Error: ${err.message || 'Unknown error'}`;
        feedbackEl.classList.remove("success");
      }
      setTimeout(() => {
        hideGeneratingState(originalText);
        if (feedbackEl) feedbackEl.textContent = "";
      }, 4000);
    } finally {
      // ensure disabled state cleared (hideGeneratingState already handles it in happy/error flows)
      if (generateBtn && !btnText) generateBtn.disabled = false;
    }
  });
} else if (calendarSection) {
  console.error("❌ Generate button not found - this is why Generate Calendar doesn't work");
}

// Final diagnostic
console.log("\n=== Event Listener Summary ===");
console.log("✓ Script.js loaded successfully");
if (generateBtn) console.log("✓ Generate button has event listener");
if (saveBtn) console.log("✓ Save button has event listener");
if (exportBtn) console.log("✓ Export button has event listener");
if (signOutBtn) console.log("✓ Sign out button has event listener");

console.log("All buttons are ready to use!");
initSidebar();

// Tabs behavior
if (tabPlan) tabPlan.addEventListener('click', ()=>{ activeTab='plan'; updateTabs(); });
if (tabPublish) tabPublish.addEventListener('click', ()=>{ activeTab='publish'; updateTabs(); });

// Compact mode toggle
if (toggleCompactBtn && calendarSection) {
  toggleCompactBtn.addEventListener('click', ()=>{
    isCompact = !isCompact;
    calendarSection.classList.toggle('compact', isCompact);
    toggleCompactBtn.textContent = isCompact ? 'Full view' : 'Compact mode';
  });
}

if (proNavLinks.length) {
  proNavLinks.forEach((link) => {
    link.addEventListener('click', async (event) => {
      const allowed = await requireProAccess();
      if (!allowed) {
        event.preventDefault();
        showUpgradeModal();
      }
    });
  });
}

// Empty state CTA
if (hubEmptyGenBtn) {
  hubEmptyGenBtn.addEventListener('click', ()=>{
    activeTab = 'plan';
    updateTabs();
    if (nicheInput) nicheInput.focus();
  });
}

// Design Lab events
if (designEmptyGoCalendarBtn) {
  designEmptyGoCalendarBtn.addEventListener('click', () => {
    window.location.href = '/';
  });
}
if (designEmptyClearFiltersBtn) {
  designEmptyClearFiltersBtn.addEventListener('click', () => {
    clearDesignFilters();
  });
}
if (designCloseBtn) designCloseBtn.addEventListener('click', closeDesignModal);
if (designCancelBtn) designCancelBtn.addEventListener('click', closeDesignModal);
if (designTemplateSelect) {
  renderDesignTemplateOptions(activeTemplateId);
  designTemplateSelect.addEventListener('change', (event) => {
    const templateId = event.target.value;
    if (templateId) {
      applyDesignTemplateSelection(templateId);
    } else {
      clearDesignTemplateSelection();
    }
    renderDesignLivePreview();
  });
}
if (designTemplateClearBtn) {
  designTemplateClearBtn.addEventListener('click', (event) => {
    event.preventDefault();
    clearDesignTemplateSelection();
    if (designTemplateSelect) designTemplateSelect.focus();
    renderDesignLivePreview();
  });
}
if (designUseLastTemplateBtn) {
  designUseLastTemplateBtn.addEventListener('click', () => {
    const lastId = getLastTemplateId();
    if (lastId) {
      applyDesignTemplateSelection(lastId);
      renderDesignLivePreview();
    }
  });
}
if (assetDetailUseLastTemplateBtn) {
  assetDetailUseLastTemplateBtn.addEventListener('click', () => {
    const lastId = getLastTemplateId();
    if (!lastId) return;
    populateAssetDetailTemplateOptions(lastId);
  });
}
if (designNotesToggle && designNotesPanel) {
  designNotesToggle.addEventListener('click', () => {
    const isOpen = designNotesPanel.classList.contains('is-open');
    setDesignNotesCollapsed(isOpen);
  });
  setDesignNotesCollapsed(true);
}
if (designNotesInput) {
  designNotesInput.addEventListener('input', () => {
    if (designNotesInput.value.trim()) {
      setDesignNotesCollapsed(false);
    } else {
      setDesignNotesCollapsed(true);
    }
  });
}
if (designViewGridBtn) {
  designViewGridBtn.addEventListener('click', () => applyDesignViewMode('grid'));
}
if (designViewListBtn) {
  designViewListBtn.addEventListener('click', () => applyDesignViewMode('list'));
}
if (designModal) {
  designModal.addEventListener('click', (event) => {
    if (event.target === designModal) closeDesignModal();
  });
}
if (designAssetTypeInput) {
  designAssetTypeInput.addEventListener('change', () => {
    renderDesignLivePreview();
    renderDesignTemplateGallery();
  });
}
if (designToneInput) {
  designToneInput.addEventListener('change', renderDesignLivePreview);
}
if (designNotesInput) {
  designNotesInput.addEventListener('input', renderDesignLivePreview);
}
if (designForm) designForm.addEventListener('submit', handleDesignFormSubmit);
if (designFilterType) {
  designFilterType.addEventListener('change', (event) => {
    designFilterState.type = event.target.value || 'all';
    renderDesignAssets();
  });
}
if (designFilterDay) {
  designFilterDay.addEventListener('change', (event) => {
    designFilterState.day = event.target.value || 'all';
    renderDesignAssets();
  });
}
if (designFilterCampaign) {
  designFilterCampaign.addEventListener('change', (event) => {
    designFilterState.campaign = event.target.value || 'all';
    renderDesignAssets();
  });
}
if (designFilterMonth) {
  designFilterMonth.addEventListener('change', (event) => {
    designFilterState.month = event.target.value || 'all';
    renderDesignAssets();
  });
}
if (designFilterTone) {
  designFilterTone.addEventListener('change', (event) => {
    designFilterState.tone = event.target.value || 'all';
    renderDesignAssets();
  });
}
if (designFilterSearchInput) {
  designFilterSearchInput.addEventListener('input', (event) => {
    designFilterState.search = (event.target.value || '').trim().toLowerCase();
    renderDesignAssets();
  });
}
if (designWorkspaceEnabled && designEditorForm) {
  designEditorForm.addEventListener('submit', (event) => event.preventDefault());
}
if (designWorkspaceEnabled && designEditorTitleInput) {
  designEditorTitleInput.addEventListener('input', (event) => updateSelectedAssetField('title', event.target.value));
}
if (designWorkspaceEnabled && designEditorStatusSelect) {
  designEditorStatusSelect.addEventListener('change', (event) => updateSelectedAssetField('status', event.target.value));
}
if (designWorkspaceEnabled && designEditorTypeSelect) {
  designEditorTypeSelect.addEventListener('change', (event) => updateSelectedAssetField('assetType', event.target.value));
}
if (designWorkspaceEnabled && designEditorDaySelect) {
  designEditorDaySelect.addEventListener('change', (event) => updateSelectedAssetField('linkedDay', event.target.value));
}
if (designWorkspaceEnabled && designEditorToneInput) {
  designEditorToneInput.addEventListener('input', (event) => updateSelectedAssetField('tone', event.target.value));
}
if (designWorkspaceEnabled && designEditorCampaignInput) {
  designEditorCampaignInput.addEventListener('input', (event) => updateSelectedAssetField('campaign', event.target.value));
}
if (designWorkspaceEnabled && designEditorMonthSelect) {
  designEditorMonthSelect.addEventListener('change', (event) => updateSelectedAssetField('monthLabel', event.target.value));
}
if (designWorkspaceEnabled && designEditorPromptInput) {
  designEditorPromptInput.addEventListener('input', (event) => updateSelectedAssetField('prompt', event.target.value));
}
if (designWorkspaceEnabled && designEditorStoryCopyInput) {
  designEditorStoryCopyInput.addEventListener('input', (event) => updateSelectedAssetDataField('story_copy', event.target.value));
}
if (designWorkspaceEnabled) {
  Object.entries(designEditorCarouselSlideInputs).forEach(([key, input]) => {
    if (!input) return;
    input.addEventListener('input', (event) => updateSelectedAssetDataField(`slides.${key}`, event.target.value));
  });
}
if (designWorkspaceEnabled && designEditorSaveBtn) {
  designEditorSaveBtn.addEventListener('click', () => {
    showDesignSuccess('Changes saved.');
    setTimeout(() => clearDesignFeedback(), 1500);
  });
}
if (designWorkspaceEnabled && designEditorDuplicateBtn) {
  designEditorDuplicateBtn.addEventListener('click', duplicateFocusedAsset);
}
if (designWorkspaceEnabled && designEditorDeleteBtn) {
  designEditorDeleteBtn.addEventListener('click', deleteFocusedAsset);
}
if (designGrid) {
  designGrid.addEventListener('click', async (event) => {
    const actionTarget = event.target instanceof Element ? event.target : event.target?.parentElement;
    const actionBtn = actionTarget?.closest('[data-asset-action]');
    if (actionBtn) {
      const assetId = String(actionBtn.dataset.assetId ?? '').trim();
      if (!assetId) return;
      const asset = designAssets.find((item) => String(item.id) === assetId);
      if (!asset) return;
      const action = actionBtn.dataset.assetAction;
      event.preventDefault();
      if (action === 'edit') {
        openDesignAssetDetail(asset);
      } else if (action === 'download') {
        handleDesignAssetDownload(asset);
      } else if (action === 'copy') {
        try {
          await navigator.clipboard.writeText(asset.brief || asset.previewText || asset.title || '');
          actionBtn.textContent = 'Copied!';
          setTimeout(() => (actionBtn.textContent = 'Copy Brief'), 1000);
        } catch (err) {
          console.warn('Unable to copy brief', err);
        }
      } else if (action === 'template') {
        await handleDesignTemplateSave(asset);
      } else if (action === 'delete') {
        deleteDesignAsset(asset, actionBtn.dataset.assetDay);
      }
      return;
    }
    const card = event.target.closest('[data-design-asset-id]');
    if (card) {
      const clickedCheckbox = event.target instanceof HTMLInputElement && event.target.type === 'checkbox';
      const withinCheckboxLabel =
        !clickedCheckbox && event.target.closest('label')?.querySelector('input[type="checkbox"]');
      if (!clickedCheckbox && !withinCheckboxLabel) {
        const assetId = card.dataset.designAssetId || '';
        if (assetId) setDesignFocusedAsset(assetId);
        const asset = assetId ? getDesignAssetById(assetId) : null;
        if (asset) {
          openAssetEditorModal(asset);
        }
      }
    }
  });

  designGrid.addEventListener('dragstart', (event) => {
    const card = event.target.closest('.design-asset');
    if (!card) return;
    draggedDesignAssetId = String(card.dataset.assetId ?? '').trim();
    if (!draggedDesignAssetId) {
      draggedDesignAssetId = null;
      return;
    }
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', draggedDesignAssetId);
  });

  designGrid.addEventListener('dragend', () => {
    draggedDesignAssetId = null;
    clearDesignDragHighlights();
  });

  designGrid.addEventListener('dragover', (event) => {
    if (!draggedDesignAssetId) return;
    const target = event.target.closest('.design-asset');
    if (!target) return;
    const targetId = String(target.dataset.assetId ?? '').trim();
    if (!targetId || targetId === draggedDesignAssetId) return;
    event.preventDefault();
    const rect = target.getBoundingClientRect();
    const insertBefore = event.clientY < rect.top + rect.height / 2;
    clearDesignDragHighlights();
    target.classList.add(insertBefore ? 'drag-over-top' : 'drag-over-bottom');
    target.dataset.dropPosition = insertBefore ? 'top' : 'bottom';
  });

  designGrid.addEventListener('dragleave', (event) => {
    const card = event.target.closest('.design-asset');
    if (card && !event.currentTarget.contains(event.relatedTarget)) {
      clearDesignDragHighlights();
    }
  });

  designGrid.addEventListener('drop', (event) => {
    if (!draggedDesignAssetId) return;
    const target = event.target.closest('.design-asset');
    if (!target) return;
    const targetId = String(target.dataset.assetId ?? '').trim();
    if (!targetId || targetId === draggedDesignAssetId) return;
    event.preventDefault();
    const insertBefore = target.dataset.dropPosition !== 'bottom';
    reorderDesignAssets(draggedDesignAssetId, targetId, insertBefore);
    draggedDesignAssetId = null;
    clearDesignDragHighlights();
  });

  designGrid.addEventListener('change', (event) => {
    const actionTarget = event.target instanceof Element ? event.target : event.target?.parentElement;
    const checkbox = actionTarget?.closest('input[data-asset-select]');
    if (checkbox) {
      const id = String(checkbox.dataset.assetSelect ?? '').trim();
      toggleDesignAssetSelection(id, checkbox.checked);
      return;
    }
  });

  designGrid.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    if (event.target instanceof HTMLInputElement && event.target.type === 'checkbox') return;
    const card = event.target.closest('[data-design-asset-id]');
    if (card) {
      event.preventDefault();
      const assetId = card.dataset.designAssetId || '';
      if (assetId) setDesignFocusedAsset(assetId);
    }
  });
}

if (designExportSelectedBtn) {
  designExportSelectedBtn.addEventListener('click', handleDesignExportSelected);
}

if (designRegenerateSelectedBtn) {
  designRegenerateSelectedBtn.addEventListener('click', handleDesignRegenerateSelected);
}

if (assetDetailCloseBtn) {
  assetDetailCloseBtn.addEventListener('click', closeDesignAssetDetail);
}
if (assetDetailModal) {
  assetDetailModal.addEventListener('click', (event) => {
    if (event.target === assetDetailModal) closeDesignAssetDetail();
  });
}
if (assetDetailForm) {
  assetDetailForm.addEventListener('submit', handleAssetDetailSave);
}
if (assetDetailUndoBtn) {
  assetDetailUndoBtn.addEventListener('click', () => {
    if (!activeAssetDetailId) return;
    const asset = designAssets.find((item) => String(item.id) === String(activeAssetDetailId));
    if (!asset || !asset.originalSnapshot) return;
    Object.assign(asset, JSON.parse(JSON.stringify(asset.originalSnapshot)));
    persistDesignAssetsToStorage();
    linkAssetToCalendarPost(asset);
    renderDesignAssets();
    openDesignAssetDetail(asset);
    showDesignSuccess('Reverted to original asset.');
  });
}
if (assetDetailRegenerateBtn) {
  assetDetailRegenerateBtn.addEventListener('click', async () => {
    if (!activeAssetDetailId) return;
    const asset = designAssets.find((item) => String(item.id) === String(activeAssetDetailId));
    if (!asset) return;
    const userId = activeUserEmail || (await getCurrentUser());
    if (!userId) {
      alert('Sign in to regenerate assets.');
      return;
    }
    const originalLabel = assetDetailRegenerateBtn.textContent;
    assetDetailRegenerateBtn.disabled = true;
    assetDetailRegenerateBtn.textContent = 'Regenerating…';
    try {
      await regenerateSingleDesignAsset(asset);
      const updated = designAssets.find((item) => String(item.id) === String(activeAssetDetailId));
      if (updated) {
        await ensureAssetInlinePreview(updated);
        renderAssetDetailPreview(updated);
      }
    } catch (err) {
      showDesignError('Unable to regenerate asset', err?.message || 'Try again soon.');
    } finally {
      assetDetailRegenerateBtn.disabled = false;
      assetDetailRegenerateBtn.textContent = originalLabel || 'Regenerate';
    }
  });
}
if (assetDetailCancelBtn) {
  assetDetailCancelBtn.addEventListener('click', (event) => {
    event.preventDefault();
    closeDesignAssetDetail();
  });
}

if (assetDetailNotesToggle) {
  assetDetailNotesToggle.addEventListener('click', () => {
    const isCurrentlyOpen = assetDetailNotesPanel?.classList.contains('is-open');
    setAssetDetailNotesCollapsed(isCurrentlyOpen);
  });
}

const assetDetailPreviewInputs = [assetDetailHeadline, assetDetailCaption, assetDetailCta];
assetDetailPreviewInputs.forEach((input) => {
  if (!input) return;
  input.addEventListener('input', () => {
    refreshAssetDetailPreviewFromForm(true);
  });
});

if (assetDetailNotes) {
  assetDetailNotes.addEventListener('input', () => {
    if (assetDetailNotesPanel?.classList.contains('is-open')) {
      assetDetailNotesPanel.style.maxHeight = `${assetDetailNotesPanel.scrollHeight}px`;
    }
    refreshAssetDetailPreviewFromForm(true);
  });
}

function handleCalendarAssetDownload(encoded) {
  try {
    const payload = JSON.parse(decodeURIComponent(encoded));
    handleDesignAssetDownload(payload);
  } catch (err) {
    console.warn('Unable to download calendar asset', err);
  }
}

if (grid) {
  grid.addEventListener('click', (event) => {
    const downloadBtn = event.target.closest('.calendar-card__asset-btn--download');
    if (downloadBtn) {
      event.preventDefault();
      const encodedAsset = downloadBtn.dataset.asset || '';
      if (encodedAsset) {
        handleCalendarAssetDownload(encodedAsset);
      }
      return;
    }
    const viewBtn = event.target.closest('.calendar-card__asset-btn--view');
    if (!viewBtn) return;
    event.preventDefault();
    const encoded = viewBtn.dataset.asset || '';
    if (encoded) {
      try {
        sessionStorage.setItem('promptly_focus_asset', encoded);
      } catch (err) {
        console.warn('Unable to cache focus asset', err);
      }
    }
    const targetUrl = viewBtn.dataset.designUrl || '/design.html';
    window.location.href = targetUrl;
  });
}

// Publish Hub controls
if (hubPrevBtn) {
  hubPrevBtn.addEventListener('click', ()=>{
    hubIndex = Math.max(0, hubIndex-1);
    if (hubDaySelect) hubDaySelect.value = String(hubIndex);
    renderPublishHub();
  });
}
if (hubNextBtn) {
  hubNextBtn.addEventListener('click', ()=>{
    hubIndex = Math.min(currentCalendar.length-1, hubIndex+1);
    if (hubDaySelect) hubDaySelect.value = String(hubIndex);
    renderPublishHub();
  });
}
if (hubDaySelect) {
  hubDaySelect.addEventListener('change', ()=>{
    hubIndex = Number(hubDaySelect.value||0);
    renderPublishHub();
  });
}
if (hubMarkBtn) {
  hubMarkBtn.addEventListener('click', ()=>{
    const post = currentCalendar[hubIndex];
    if (!post) return;
    const wasPosted = isPosted(post.day);
    setPosted(post.day, !wasPosted);
    // Re-render cards and hub
    renderCards(currentCalendar);
    // Auto-advance to next unposted if just marked posted
    if (!wasPosted) {
      const nextIdx = findNextUnposted(hubIndex+1);
      hubIndex = nextIdx;
      if (hubDaySelect) hubDaySelect.value = String(hubIndex);
    }
    renderPublishHub();
  });
}

function renderPublishHub(){
  if (!hub || !hubNext || !hubAfter) return;
  const posts = currentCalendar || [];
  if (posts.length === 0) { hub.style.display='none'; return; }
  const idxNext = Math.min(Math.max(0, hubIndex), posts.length-1);
  const idxAfter = Math.min(idxNext+1, posts.length-1);
  // Update progress
  if (hubProgress){ const p = countPosted(); hubProgress.textContent = `${p.done}/${p.total} posted`; }
  const render = (container, post, label)=>{
    container.innerHTML = '';
    if (!post) return;
    const title = document.createElement('h3');
    const titleText = document.createTextNode(`${label}: Day ${String(post.day).padStart(2,'0')} — ${post.idea || ''}`);
    title.appendChild(titleText);
    if (isPosted(post.day)) {
      const badge = document.createElement('span');
      badge.className = 'badge-posted';
      badge.textContent = 'Posted';
      title.appendChild(badge);
    }
    const meta = document.createElement('div'); meta.className='meta'; meta.textContent = `${post.pillar || ''} • ${post.format || ''}`;
    const text = document.createElement('div');
    const tags = Array.isArray(post.hashtags)? post.hashtags.map(h=>h.startsWith('#')?h:'#'+h).join(' ') : (post.hashtags||'');
    text.innerHTML = `<div>${(post.caption||'').replace(/\n/g,'<br/>')}</div>${tags?`<div style="margin-top:0.3rem;color:var(--text-secondary)">${tags}</div>`:''}`;
    const actions = document.createElement('div'); actions.className='actions';
    const mk = (label)=>{ const b=document.createElement('button'); b.className='ghost'; b.textContent=label; b.style.fontSize='0.8rem'; b.style.padding='0.3rem 0.6rem'; return b; };
    // Build full text with all card content
    const fullTextParts = [];
    fullTextParts.push(`Day ${String(post.day).padStart(2,'0')}`);
    if (post.idea) fullTextParts.push(`Idea: ${post.idea}`);
    if (post.type) fullTextParts.push(`Type: ${post.type}`);
    if (post.caption) fullTextParts.push(`Caption: ${post.caption}`);
    if (tags) fullTextParts.push(`Hashtags: ${tags}`);
    if (post.format) fullTextParts.push(`Format: ${post.format}`);
    if (post.cta) fullTextParts.push(`CTA: ${post.cta}`);
    if (post.storyPrompt) fullTextParts.push(`Story Prompt: ${post.storyPrompt}`);
    if (post.designNotes) fullTextParts.push(`Design Notes: ${post.designNotes}`);
    if (post.repurpose && Array.isArray(post.repurpose) && post.repurpose.length) fullTextParts.push(`Repurpose: ${post.repurpose.join(' • ')}`);
    if (post.analytics && Array.isArray(post.analytics) && post.analytics.length) fullTextParts.push(`Analytics: ${post.analytics.join(', ')}`);
    if (post.promoSlot) fullTextParts.push(`Weekly Promo Slot: Yes`);
    if (post.weeklyPromo) fullTextParts.push(`Promo: ${post.weeklyPromo}`);
    if (post.videoScript && (post.videoScript.hook || post.videoScript.body || post.videoScript.cta)) {
      const scriptLines = [];
      if (post.videoScript.hook) scriptLines.push(`Hook: ${post.videoScript.hook}`);
      if (post.videoScript.body) scriptLines.push(`Body: ${post.videoScript.body}`);
      if (post.videoScript.cta) scriptLines.push(`CTA: ${post.videoScript.cta}`);
      fullTextParts.push(`Reel Script:\n${scriptLines.join('\n')}`);
    }
    if (post.engagementScripts && (post.engagementScripts.commentReply || post.engagementScripts.dmReply)) {
      if (post.engagementScripts.commentReply) fullTextParts.push(`Engagement Comment: ${post.engagementScripts.commentReply}`);
      if (post.engagementScripts.dmReply) fullTextParts.push(`Engagement DM: ${post.engagementScripts.dmReply}`);
    }
    if (post.variants) {
      if (post.variants.igCaption) fullTextParts.push(`Instagram Variant: ${post.variants.igCaption}`);
      if (post.variants.tiktokCaption) fullTextParts.push(`TikTok Variant: ${post.variants.tiktokCaption}`);
      if (post.variants.linkedinCaption) fullTextParts.push(`LinkedIn Variant: ${post.variants.linkedinCaption}`);
    }
    const fullText = fullTextParts.join('\n\n');
    const bCopyFull = mk('Copy Full'); bCopyFull.addEventListener('click', async ()=>{ try { await navigator.clipboard.writeText(fullText); bCopyFull.textContent='Copied!'; setTimeout(()=>bCopyFull.textContent='Copy Full', 1000);} catch(e){} });
    actions.appendChild(bCopyFull);
    if (post.variants){
      // variant copy buttons removed
    }
    const variantsDiv = document.createElement('div'); variantsDiv.className='variants';
    if (post.variants){
      const items=[];
      if (post.variants.igCaption) items.push(`<div><em>Instagram:</em> ${post.variants.igCaption}</div>`);
      if (post.variants.tiktokCaption) items.push(`<div><em>TikTok:</em> ${post.variants.tiktokCaption}</div>`);
      if (post.variants.linkedinCaption) items.push(`<div><em>LinkedIn:</em> ${post.variants.linkedinCaption}</div>`);
      variantsDiv.innerHTML = items.join('');
    }
    container.append(title, meta, text, actions, variantsDiv);
  };
  render(hubNext, posts[idxNext], 'Next');
  render(hubAfter, posts[idxAfter], 'After');
  if (hubMarkBtn) hubMarkBtn.textContent = isPosted(posts[idxNext].day) ? 'Unmark Posted' : 'Mark as Posted';
}

// Skip to next unposted control
if (hubSkipBtn) {
  hubSkipBtn.addEventListener('click', ()=>{
    if (!currentCalendar || currentCalendar.length===0) return;
    const nextIdx = findNextUnposted(hubIndex+1);
    hubIndex = nextIdx;
    if (hubDaySelect) hubDaySelect.value = String(hubIndex);
    renderPublishHub();
  });
}
if (hubSkipPrevBtn) {
  hubSkipPrevBtn.addEventListener('click', ()=>{
    if (!currentCalendar || currentCalendar.length===0) return;
    const prevIdx = findPrevUnposted(hubIndex-1);
    hubIndex = prevIdx;
    if (hubDaySelect) hubDaySelect.value = String(hubIndex);
    renderPublishHub();
  });
}
function buildDesignPdfBlob(asset, payload) {
    const lines = [
      `Promptly AI Asset`,
      `Title: ${asset.title || 'AI Asset'}`,
      `Day: ${asset.day ? `Day ${String(asset.day).padStart(2, '0')}` : 'Unassigned'}`,
      `Type: ${asset.typeLabel || formatAssetTypeLabel(payload.assetType)}`,
      `Tone: ${payload.tone || 'Brand default'}`,
      `Notes: ${payload.notes || 'None provided'}`,
      `Preview: ${asset.previewText || 'Ready-to-use design prompts'}`,
    ];
    if (payload.brandKitSummary) {
      lines.push(`Brand Design: ${payload.brandKitSummary}`);
    }
    const content = pdfBuildText(lines);
    const pdf = [
      '%PDF-1.4',
      '1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj',
      '2 0 obj << /Type /Pages /Count 1 /Kids [3 0 R] >> endobj',
      '3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >> endobj',
      `4 0 obj << /Length ${content.length} >> stream`,
      content,
      'endstream endobj',
      '5 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj',
      'xref',
      '0 6',
      '0000000000 65535 f ',
      '0000000010 00000 n ',
      '0000000063 00000 n ',
      '0000000114 00000 n ',
      '0000000215 00000 n ',
      '0000000344 00000 n ',
      'trailer << /Size 6 /Root 1 0 R >>',
      'startxref',
      String(370 + content.length),
      '%%EOF',
    ].join('\n');
    return new Blob([pdf], { type: 'application/pdf' });
  }

function pdfBuildText(lines) {
    const escaped = lines.map((line) => escapePdfText(line));
    const ops = escaped
      .map((line, idx) => {
        const prefix = idx === 0 ? 'BT /F1 12 Tf 60 760 Td' : '0 -16 Td';
        return `${idx === 0 ? prefix : prefix}\n(${line}) Tj`;
      })
      .join('\n');
    return `${ops}\nET`;
  }

function escapePdfText(text) {
    return String(text || '').replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
  }
function sanitizeAssetForStorage(asset = {}) {
  return {
    id: asset.id,
    day: asset.day || asset.linkedDay || null,
    linkedDay: asset.linkedDay || asset.day || null,
    calendarDayId: asset.calendarDayId || '',
    title: asset.title || '',
    typeLabel: asset.typeLabel || '',
    assetType: asset.assetType || '',
    tone: asset.tone || '',
    notes: asset.notes || '',
    status: asset.status || '',
    downloadUrl: asset.downloadUrl || '',
    designUrl: asset.designUrl || '',
    templateId: asset.templateId || null,
    templateLabel: asset.templateLabel || null,
    caption: asset.caption || '',
    cta: asset.cta || '',
    campaign: asset.campaign || '',
    previewText: asset.previewText || '',
    previewType: asset.previewType || '',
    previewInlineUrl: asset.previewInlineUrl || '',
    previewUrl: asset.previewUrl || '',
    createdAt: asset.createdAt || new Date().toISOString(),
    brief: asset.brief || '',
    primaryColor: asset.primaryColor || '',
    secondaryColor: asset.secondaryColor || '',
    headingFont: asset.headingFont || '',
    bodyFont: asset.bodyFont || '',
    lastEdited: asset.lastEdited || '',
    concept: asset.concept || '',
    bundleUrl: asset.bundleUrl || '',
    cloudinaryPublicId: asset.cloudinaryPublicId || '',
    cloudinaryUrl: asset.cloudinaryUrl || asset.image_url || '',
    image_url: asset.image_url || asset.cloudinaryUrl || '',
    origin: asset.origin || 'local',
    data: asset.data || null,
    slides: sanitizeSlidesForStorage(asset.slides),
  };
}

function sanitizeSlidesForStorage(slides = []) {
  return normalizeSlides(slides).map((slide) => ({
    id: slide.id,
    label: slide.label,
    role: slide.role,
    slideNumber: slide.slideNumber,
    platform: slide.platform,
    aspectRatio: slide.aspectRatio,
    width: slide.width || null,
    height: slide.height || null,
    downloadUrl: slide.downloadUrl || '',
    previewUrl: slide.previewUrl || '',
  }));
}
if (designSection && (!calendarSection || !hub)) {
  activeTab = 'design';
  designSection.style.display = 'flex';
  designSection.style.opacity = '1';
}
const TEMPLATE_CATEGORY_MAP = {
  'social-graphic': 'Quotes & Tips',
  'carousel-template': 'Case Studies',
  'carousel': 'Case Studies',
  'story-template': 'Behind-the-Scenes',
  'story': 'Behind-the-Scenes',
};

function createTemplateThumbnail(text, palette = ['#7f5af0', '#2cb1bc']) {
  const [from, to] = palette;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="240" height="320">
    <defs>
      <linearGradient id="grad" x1="0%" y1="0%" x2="100%" y2="100%">
        <stop offset="0%" stop-color="${from}" />
        <stop offset="100%" stop-color="${to}" />
      </linearGradient>
    </defs>
    <rect width="240" height="320" rx="24" fill="url(#grad)" />
    <text x="50%" y="55%" text-anchor="middle" fill="#ffffff" font-family="Inter, sans-serif" font-size="20" font-weight="600">${text}</text>
  </svg>`;
  return `data:image/svg+xml;base64,${btoa(svg)}`;
}

const BUILT_IN_TEMPLATES = [
  {
    id: 'preset_quote_card',
    label: 'Quote Spark',
    assetType: 'story',
    tone: 'elegant',
    notes: 'Centered quote overlay with drop shadow, quote icon, and author line.',
    previewText: '“Signature Quote”',
    previewInlineUrl: createTemplateThumbnail('Quote Spark', ['#141726', '#5a4ff0']),
    category: 'Quotes & Tips',
    tags: ['quote', 'minimal'],
    recommendedFor: ['story'],
  },
  {
    id: 'preset_testimonial',
    label: 'Testimonial Glow',
    assetType: 'story',
    tone: 'playful',
    notes: 'Avatar + quote + star rating, gradient background, pill CTA.',
    previewText: 'Testimonial',
    previewInlineUrl: createTemplateThumbnail('Testimonial', ['#ff8ba7', '#ffc3a0']),
    category: 'Testimonials',
    tags: ['testimonial', 'bold'],
    recommendedFor: ['story'],
  },
  {
    id: 'preset_promo_banner',
    label: 'Promo Countdown',
    assetType: 'story',
    tone: 'bold',
    notes: 'Big numeric countdown, gradient border, button CTA.',
    previewText: 'Promo Banner',
    previewInlineUrl: createTemplateThumbnail('Promo', ['#ff5f6d', '#ffc371']),
    category: 'Promos',
    tags: ['promo', 'cta'],
    recommendedFor: ['story'],
  },
  {
    id: 'preset_case_study',
    label: 'Case Study Carousel',
    assetType: 'carousel',
    tone: 'minimal',
    notes: 'Slide 1: hook. Slide 2: problem. Slide 3: process. Slide 4: result.',
    previewText: 'Case Study',
    previewInlineUrl: createTemplateThumbnail('Case Study', ['#0f2027', '#203a43']),
    category: 'Case Studies',
    tags: ['carousel', 'case study'],
    recommendedFor: ['carousel'],
  },
  {
    id: 'preset_story_bts',
    label: 'Behind-the-Scenes Story',
    assetType: 'story',
    tone: 'playful',
    notes: 'Top hook text, photo slot, sticker CTA, bottom caption overlay.',
    previewText: 'Story BTS',
    previewInlineUrl: createTemplateThumbnail('Story BTS', ['#f7971e', '#ffd200']),
    category: 'Behind-the-Scenes',
    tags: ['story', 'bts'],
    recommendedFor: ['story'],
  },
];
const BUILT_IN_TEMPLATE_IDS = new Set(BUILT_IN_TEMPLATES.map((tpl) => String(tpl.id)));

function setCarouselSlide(slider, nextIndex = 0) {
  if (!slider) return;
  const slides = slider.querySelectorAll('.design-slider__slide');
  if (!slides.length) return;
  const dots = slider.querySelectorAll('.design-slider__dot');
  const total = slides.length;
  let index = Number(nextIndex);
  if (!Number.isFinite(index)) index = 0;
  if (index < 0) index = total - 1;
  if (index >= total) index = 0;
  slider.dataset.activeIndex = String(index);
  slides.forEach((slide, idx) => slide.classList.toggle('is-active', idx === index));
  dots.forEach((dot, idx) => dot.classList.toggle('is-active', idx === index));
}

function advanceCarouselSlide(slider, delta) {
  if (!slider) return;
  const current = Number(slider.dataset.activeIndex || 0) || 0;
  setCarouselSlide(slider, current + delta);
}

document.addEventListener('click', (event) => {
  const navBtn = event.target.closest('[data-carousel-nav]');
  if (navBtn) {
    event.preventDefault();
    const slider = navBtn.closest('[data-carousel-slider]');
    if (slider) {
      const delta = navBtn.dataset.carouselNav === 'prev' ? -1 : 1;
      advanceCarouselSlide(slider, delta);
    }
  }
  const dotBtn = event.target.closest('[data-carousel-dot]');
  if (dotBtn) {
    event.preventDefault();
    const slider = dotBtn.closest('[data-carousel-slider]');
    if (slider) {
      const targetIndex = Number(dotBtn.dataset.carouselDot || 0) || 0;
      setCarouselSlide(slider, targetIndex);
    }
  }
});
