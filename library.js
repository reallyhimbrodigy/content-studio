import { getCurrentUser, isPro, supabase } from './user-store.js';
import { initTheme } from './theme.js';

// Apply theme on page load
initTheme();

// JSZip loader
let __zipLoaderPromise = null;

function loadExternalScript(src) {
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = src;
    script.onload = resolve;
    script.onerror = reject;
    document.head.appendChild(script);
  });
}

async function ensureZip() {
  if (window.JSZip) return window.JSZip;
  if (!__zipLoaderPromise) {
    __zipLoaderPromise = (async () => {
      const cdns = [
        'https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js',
        'https://unpkg.com/jszip@3.10.1/dist/jszip.min.js'
      ];
      for (const u of cdns) {
        try {
          await loadExternalScript(u);
          if (window.JSZip) break;
        } catch (e) {}
      }
      if (!window.JSZip) throw new Error('Zip library failed to load');
      return window.JSZip;
    })();
  }
  return __zipLoaderPromise;
}

// Helper functions
function slugify(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')
    .slice(0, 80);
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function buildPostHTML(post) {
  const day = post.day || '';
  const title = post.idea || post.title || '';
  const type = post.type || '';
  const caption = post.caption || '';
  const pillar = post.pillar || '';
  const format = post.format || '';
  const cta = post.cta || '';
  const storyPrompt = post.storyPrompt || '';
  const designNotes = post.designNotes || '';
  const repurpose = Array.isArray(post.repurpose) ? post.repurpose : [];
  const analytics = Array.isArray(post.analytics) ? post.analytics : (post.analytics ? [post.analytics] : []);
  const weeklyPromo = post.weeklyPromo || '';
  const promoSlot = !!post.promoSlot;
  const vs = post.videoScript || {};
  const engage = post.engagementScripts || {};
  const hashtags = Array.isArray(post.hashtags) 
    ? post.hashtags.map(h => h.startsWith('#') ? h : '#' + h).join(' ')
    : (post.hashtags || '');
  
  const LIBRARY_AUDIO_LIMIT = 6;
  const formatPlatformLabel = (platform = '') => {
    const normalized = (platform || 'mixed').toLowerCase();
    if (normalized.includes('tiktok')) return 'TikTok';
    if (normalized.includes('instagram')) return 'Instagram Reels';
    if (normalized === 'mixed') return 'Trending audio';
    return platform.charAt(0).toUpperCase() + platform.slice(1);
  };
  const renderSuggestedAudioBlock = (items = []) => {
    const entries = Array.isArray(items) ? items.slice(0, LIBRARY_AUDIO_LIMIT) : [];
    const listItems = entries.length
      ? entries
          .map((item) => {
            const title = item.title || 'Untitled';
            const creator = item.creator || 'Unknown creator';
            const hint = item.usageHint || 'Usage hint pending.';
            return `<div class="calendar-card__audio-item"><span class="calendar-card__audio-item-heading">${escapeHtml(formatPlatformLabel(item.platform))} · ${escapeHtml(title)} — ${escapeHtml(creator)}</span><span class="calendar-card__audio-item-hint">${escapeHtml(hint)}</span></div>`;
          })
          .join('')
      : `<div class="calendar-card__audio-empty">No suggested audio yet.</div>`;
    return `<div class="calendar-card__audio"><strong>Suggested audio</strong><div class="calendar-card__audio-list">${listItems}</div></div>`;
  };
  const nl2br = (s) => escapeHtml(s).replace(/\n/g, '<br/>');
  const videoLabel = format === 'Reel' ? 'Reel Script' : 'Reel Script (can repurpose as Reel)';

  const detailBlocks = [
    hashtags ? `<div class="calendar-card__hashtags">${escapeHtml(hashtags)}</div>` : '',
    format ? `<span class="calendar-card__format">Format: ${escapeHtml(format)}</span>` : '',
    cta ? `<span class="calendar-card__cta">CTA: ${escapeHtml(cta)}</span>` : '',
    storyPrompt ? `<div class="calendar-card__story"><strong>Story Prompt:</strong> ${nl2br(storyPrompt)}</div>` : '',
    designNotes ? `<div class="calendar-card__design"><strong>Design Notes:</strong> ${nl2br(designNotes)}</div>` : '',
    repurpose.length ? `<div class="calendar-card__repurpose"><strong>Repurpose:</strong> ${escapeHtml(repurpose.join(' • '))}</div>` : '',
    analytics.length ? `<div class="calendar-card__analytics"><strong>Analytics:</strong> ${escapeHtml(analytics.join(', '))}</div>` : '',
    (engage.commentReply || engage.dmReply) ? `<div class="calendar-card__engagement"><strong>Engagement Scripts</strong>${engage.commentReply ? `<div><em>Comment:</em> ${escapeHtml(engage.commentReply)}</div>` : ''}${engage.dmReply ? `<div><em>DM:</em> ${escapeHtml(engage.dmReply)}</div>` : ''}</div>` : '',
    (promoSlot || weeklyPromo) ? `<div class="calendar-card__promo"><strong>Weekly Promo Slot:</strong> ${weeklyPromo ? escapeHtml(weeklyPromo) : 'Yes'}</div>` : '',
    (vs.hook || vs.body || vs.cta) ? `<div class="calendar-card__video"><strong>${videoLabel}</strong>${vs.hook ? `<div><em>Hook:</em> ${escapeHtml(vs.hook)}</div>` : ''}${vs.body ? `<div><em>Body:</em> ${nl2br(vs.body)}</div>` : ''}${vs.cta ? `<div><em>CTA:</em> ${escapeHtml(vs.cta)}</div>` : ''}</div>` : '',
    (post.variants && (post.variants.igCaption || post.variants.tiktokCaption || post.variants.linkedinCaption))
      ? `<div class="calendar-card__variants">`
        + `${post.variants.igCaption ? `<div><em>Instagram:</em> ${escapeHtml(post.variants.igCaption)}</div>` : ''}`
        + `${post.variants.tiktokCaption ? `<div><em>TikTok:</em> ${escapeHtml(post.variants.tiktokCaption)}</div>` : ''}`
        + `${post.variants.linkedinCaption ? `<div><em>LinkedIn:</em> ${escapeHtml(post.variants.linkedinCaption)}</div>` : ''}`
        + `</div>`
      : ''
  ];

  if (isLibraryUserPro && post.captionVariations) {
    detailBlocks.push(
      `<div class="calendar-card__caption-variations"><strong>Caption variations</strong>`
      + `${post.captionVariations.casual ? `<div><em>Casual:</em> ${escapeHtml(post.captionVariations.casual)}</div>` : ''}`
      + `${post.captionVariations.professional ? `<div><em>Professional:</em> ${escapeHtml(post.captionVariations.professional)}</div>` : ''}`
      + `${post.captionVariations.witty ? `<div><em>Witty:</em> ${escapeHtml(post.captionVariations.witty)}</div>` : ''}`
      + `</div>`
    );
  }
  if (isLibraryUserPro && post.hashtagSets) {
    const broad = Array.isArray(post.hashtagSets.broad) ? post.hashtagSets.broad.join(' ') : '';
    const niche = Array.isArray(post.hashtagSets.niche) ? post.hashtagSets.niche.join(' ') : '';
    detailBlocks.push(
      `<div class="calendar-card__hashtag-sets"><strong>Hashtag sets</strong>`
      + `${broad ? `<div><em>Broad:</em> ${escapeHtml(broad)}</div>` : ''}`
      + `${niche ? `<div><em>Niche/local:</em> ${escapeHtml(niche)}</div>` : ''}`
      + `</div>`
    );
  }
  if (isLibraryUserPro) {
    detailBlocks.push(renderSuggestedAudioBlock(post.suggestedAudioItems));
  }
  if (isLibraryUserPro && post.postingTimeTip) {
    detailBlocks.push(`<div class="calendar-card__posting-tip"><strong>Posting time tip</strong><div>${escapeHtml(post.postingTimeTip)}</div></div>`);
  }
  if (isLibraryUserPro && post.visualTemplate && post.visualTemplate.url) {
    detailBlocks.push(`<div class="calendar-card__visual"><strong>Visual template</strong><div><a href="${escapeHtml(post.visualTemplate.url)}" target="_blank" rel="noreferrer noopener">${escapeHtml(post.visualTemplate.label || 'Open template')}</a></div></div>`);
  }
  if (isLibraryUserPro && post.storyPromptExpanded) {
    detailBlocks.push(`<div class="calendar-card__story-extended"><strong>Story prompt+</strong> ${escapeHtml(post.storyPromptExpanded)}</div>`);
  }
  if (isLibraryUserPro && post.followUpIdea) {
    detailBlocks.push(`<div class="calendar-card__followup"><strong>Follow-up idea</strong> ${escapeHtml(post.followUpIdea)}</div>`);
  }
  if (Array.isArray(post.assets) && post.assets.length) {
    const chips = post.assets
      .map((asset) => {
        const label = escapeHtml(asset.typeLabel || asset.title || 'View');
        const url = escapeHtml(asset.downloadUrl || asset.url || '#');
        return `<a class="calendar-card__asset-chip" href="${url}" target="_blank" rel="noopener">${label}</a>`;
      })
      .join('');
    detailBlocks.push(`<div class="calendar-card__assets"><strong>AI Assets</strong><div class="calendar-card__asset-chips">${chips}</div></div>`);
  }

  const detailsHTML = detailBlocks.filter(Boolean).join('');

  const cardHTML = `
    <article class="calendar-card" data-pillar="${escapeHtml(pillar)}">
      <div class="calendar-card__day">${String(day).padStart(2, '0')}</div>
      <h3 class="calendar-card__title">${escapeHtml(title)}</h3>
      ${type ? `<span class="calendar-card__type">${escapeHtml(type.charAt(0).toUpperCase() + type.slice(1))}</span>` : ''}
      <p class="calendar-card__caption">${nl2br(caption)}</p>
      <details>
        <summary>Full Details</summary>
        <div class="calendar-card__details">${detailsHTML}</div>
      </details>
    </article>
  `;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1.0"/>
  <title>Day ${String(day).padStart(2, '0')} - ${escapeHtml(title)}</title>
  <style>
    *{margin:0;padding:0;box-sizing:border-box}
    body{font-family:'Inter',system-ui,sans-serif;background:#0a0e27;color:#e2e8f0;padding:2rem;line-height:1.6}
    .calendar-card{background:#16213e;border-radius:18px;padding:1.5rem;border:1px solid rgba(255,255,255,0.1);max-width:600px;margin:0 auto;box-shadow:0 24px 36px rgba(0,0,0,0.25);position:relative}
    .calendar-card::after{content:attr(data-pillar);position:absolute;top:1.25rem;right:1.25rem;font-size:0.75rem;font-weight:600;letter-spacing:0.12em;text-transform:uppercase;padding:0.25rem 0.75rem;border-radius:999px;background:rgba(127,90,240,0.15);color:#7f5af0}
    .calendar-card__day{font-size:3rem;font-weight:700;color:#7f5af0;line-height:1;margin-bottom:0.5rem}
    .calendar-card__title{font-size:1.25rem;font-weight:600;color:#e2e8f0;margin-bottom:0.5rem}
    .calendar-card__type{display:inline-block;background:rgba(44,177,188,0.15);color:#2cb1bc;font-size:0.8rem;padding:0.25rem 0.75rem;border-radius:999px;margin-bottom:0.75rem}
    .calendar-card__caption{color:#94a3b8;margin-bottom:1rem;white-space:pre-wrap}
    details{margin-top:1rem}
    summary{cursor:pointer;color:#7f5af0;font-weight:600;padding:0.5rem 0;user-select:none}
    summary:hover{color:#9d7ff5}
    .calendar-card__details{padding-top:1rem;display:flex;flex-direction:column;gap:1rem}
    .calendar-card__details>div,.calendar-card__details>span{background:rgba(255,255,255,0.05);padding:0.75rem;border-radius:8px;font-size:0.9rem}
    .calendar-card__caption-variations,.calendar-card__hashtag-sets,.calendar-card__audio,.calendar-card__posting-tip,.calendar-card__visual,.calendar-card__story-extended,.calendar-card__followup{font-size:0.9rem;color:#c7d2fe}
    .calendar-card__caption-variations em,.calendar-card__hashtag-sets em{color:#7f5af0;font-style:normal;font-weight:600}
    .calendar-card__visual a{color:#7f5af0;text-decoration:none;font-weight:600}
    .calendar-card__visual a:hover{text-decoration:underline}
    .calendar-card__assets{background:rgba(255,255,255,0.04);padding:0.6rem;border-radius:8px}
    .calendar-card__assets strong{display:block;margin-bottom:0.35rem}
    .calendar-card__asset-chips{display:flex;flex-wrap:wrap;gap:0.35rem}
    .calendar-card__asset-chip{display:inline-flex;align-items:center;border-radius:999px;border:1px solid rgba(127,90,240,0.35);padding:0.2rem 0.85rem;font-size:0.85rem;color:#7f5af0;text-decoration:none}
    .calendar-card__asset-chip:hover{border-color:rgba(127,90,240,0.7)}
    .calendar-card__hashtags{color:#2cb1bc;font-size:0.9rem}
    .calendar-card__format,.calendar-card__cta{color:#94a3b8;font-size:0.85rem}
    strong{color:#e2e8f0;display:block;margin-bottom:0.5rem}
    em{color:#7f5af0;font-style:normal;font-weight:600}
  </style>
</head>
<body>${cardHTML}</body>
</html>`;
}

// Library page behavior (now async with Supabase)

/**
 * @typedef {Object} Calendar
 * @property {string} id
 * @property {string} title
 * @property {"draft"|"scheduled"|"published"} status
 * @property {string[]} platforms
 * @property {string} startDate
 * @property {string|null} endDate
 * @property {number} postsCount
 * @property {number} variantsCount
 * @property {string} updatedAt
 * @property {string} [createdAt]
 */

// TODO: Replace with real data from the backend once calendar APIs are available.
const LIBRARY_MOCK_CALENDARS = [
  {
    id: 'mock-001',
    title: 'Creator Launch Sprint',
    status: 'draft',
    platforms: ['IG', 'TikTok'],
    startDate: '2026-03-01T00:00:00Z',
    endDate: '2026-03-30T00:00:00Z',
    postsCount: 30,
    variantsCount: 90,
    updatedAt: '2026-03-24T14:45:00Z',
    createdAt: '2026-02-25T09:00:00Z'
  },
  {
    id: 'mock-002',
    title: 'Wellness Sprint Q2',
    status: 'scheduled',
    platforms: ['IG', 'YouTube Shorts', 'LinkedIn'],
    startDate: '2026-04-01T00:00:00Z',
    endDate: '2026-04-30T00:00:00Z',
    postsCount: 28,
    variantsCount: 72,
    updatedAt: '2026-03-20T12:20:00Z',
    createdAt: '2026-03-01T10:00:00Z'
  },
  {
    id: 'mock-003',
    title: 'Agency Evergreen Highlights',
    status: 'published',
    platforms: ['IG', 'TikTok', 'LinkedIn'],
    startDate: '2026-02-01T00:00:00Z',
    endDate: '2026-02-28T00:00:00Z',
    postsCount: 30,
    variantsCount: 85,
    updatedAt: '2026-02-28T18:15:00Z',
    createdAt: '2026-01-25T08:30:00Z'
  },
  {
    id: 'mock-004',
    title: 'Product Drop Countdown',
    status: 'scheduled',
    platforms: ['IG', 'TikTok'],
    startDate: '2026-05-05T00:00:00Z',
    endDate: null,
    postsCount: 20,
    variantsCount: 50,
    updatedAt: '2026-03-18T09:10:00Z',
    createdAt: '2026-03-05T11:00:00Z'
  },
  {
    id: 'mock-005',
    title: 'Community Building Flow',
    status: 'draft',
    platforms: ['IG', 'LinkedIn'],
    startDate: '2026-03-10T00:00:00Z',
    endDate: '2026-04-08T00:00:00Z',
    postsCount: 25,
    variantsCount: 60,
    updatedAt: '2026-03-17T16:30:00Z',
    createdAt: '2026-03-12T14:00:00Z'
  },
  {
    id: 'mock-006',
    title: 'Creator Partnerships Pack',
    status: 'published',
    platforms: ['TikTok', 'YouTube Shorts'],
    startDate: '2026-01-05T00:00:00Z',
    endDate: '2026-02-03T00:00:00Z',
    postsCount: 32,
    variantsCount: 88,
    updatedAt: '2026-02-03T11:05:00Z',
    createdAt: '2025-12-28T10:00:00Z'
  }
];

const userEmailEl = document.getElementById('user-email');
const signOutBtn = document.getElementById('sign-out-btn');
const profileTrigger = document.getElementById('profile-trigger');
const profileMenu = document.getElementById('profile-menu');
const profileInitial = document.getElementById('profile-initial');
const userTierBadge = document.getElementById('user-tier-badge');
const newCalendarBtn = document.getElementById('new-calendar-btn');
const manageBillingBtn = document.getElementById('manage-billing-btn');
// Upgrade modal elements (library page)
const upgradeModal = document.getElementById('upgrade-modal');
const upgradeClose = document.getElementById('upgrade-close');
const upgradeBtn = document.getElementById('upgrade-btn');
const brandBtn = document.getElementById('brand-brain-btn');
const calendarsList = document.getElementById('library-calendars-grid');
const calendarToolbar = document.getElementById('calendar-toolbar');
const calendarSearchInput = document.getElementById('calendar-search');
const calendarSortSelect = document.getElementById('calendar-sort');
const calendarFilterButtons = document.querySelectorAll('[data-calendar-filter]');
const calendarEmptyState = document.getElementById('library-empty-state');
const calendarEmptyCta = document.getElementById('calendar-empty-cta');

let currentUser = null;
let isLibraryUserPro = false;
let libraryCalendarData = [];
const calendarFilters = { search: '', status: 'all', sort: 'recent' };
const calendarRawLookup = new Map();

renderLibraryCalendars();

// Global sign-out handler (now async with Supabase)
window.handleSignOut = async function() {
  const { signOut } = await import('./user-store.js');
  await signOut();
  localStorage.removeItem('promptly_current_user'); // Legacy cleanup
  window.location.href = '/auth.html';
};

// Initialize user and check auth
(async () => {
  currentUser = await getCurrentUser();
  if (!currentUser) {
    window.location.href = '/auth.html';
    return;
  }

  if (userEmailEl) userEmailEl.textContent = currentUser;
  if (profileInitial && currentUser) {
    const initial = currentUser.trim().charAt(0) || 'P';
    profileInitial.textContent = initial.toUpperCase();
  }
  
  // Show PRO badge if applicable
  const userIsPro = await isPro(currentUser);
  isLibraryUserPro = userIsPro;
  if (userTierBadge && userIsPro) {
    userTierBadge.textContent = 'PRO';
    userTierBadge.style.display = 'inline-block';
  }
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
  
  // Load calendars after user is confirmed
  loadCalendars();
})();

// Upgrade modal handlers (library page)
function showUpgradeModal() {
  if (upgradeModal) upgradeModal.style.display = 'flex';
}
function hideUpgradeModal() {
  if (upgradeModal) upgradeModal.style.display = 'none';
}
if (upgradeClose) upgradeClose.addEventListener('click', hideUpgradeModal);
if (upgradeModal) {
  upgradeModal.addEventListener('click', (e) => { if (e.target === upgradeModal) hideUpgradeModal(); });
}
if (upgradeBtn) {
  upgradeBtn.addEventListener('click', async () => {
    const fallbackUrl = 'https://buy.stripe.com/5kQ5kE3Qw1G8aWoe5Cgbm00?locale=en';
    try {
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
      const win = window.open(fallbackUrl, '_blank', 'noopener,noreferrer');
      if (!win) { window.location.href = fallbackUrl; } else { hideUpgradeModal(); }
    } catch (_) { window.location.href = fallbackUrl; }
  });
}
// Expose for other handlers
window.showUpgradeModal = showUpgradeModal;

// Delegate clicks for robustness
document.addEventListener('click', (e) => {
  const btn = e.target && e.target.closest && e.target.closest('#sign-out-btn');
  if (btn) {
    e.preventDefault();
    window.handleSignOut();
  }
});

// Also attach direct listener if present
if (signOutBtn) {
  signOutBtn.addEventListener('click', (e) => {
    e.preventDefault();
    window.handleSignOut();
  });
}


function startNewCalendarFlow() {
  window.location.href = '/';
}

if (newCalendarBtn) {
  newCalendarBtn.addEventListener('click', startNewCalendarFlow);
}
if (calendarEmptyCta) {
  calendarEmptyCta.addEventListener('click', startNewCalendarFlow);
}

if (calendarSearchInput) {
  calendarSearchInput.addEventListener('input', (event) => {
    calendarFilters.search = String(event.target.value || '').trim().toLowerCase();
    renderLibraryCalendars();
  });
}

if (calendarSortSelect) {
  calendarSortSelect.addEventListener('change', (event) => {
    calendarFilters.sort = String(event.target.value || 'recent');
    renderLibraryCalendars();
  });
}

calendarFilterButtons.forEach((button) => {
  button.addEventListener('click', () => {
    const value = button.dataset.calendarFilter || 'all';
    calendarFilters.status = value;
    updateFilterActiveState();
    renderLibraryCalendars();
  });
});

async function loadCalendars() {
  const { getUserCalendars } = await import('./user-store.js');
  const userCalendars = await getUserCalendars(currentUser);
  calendarRawLookup.clear();

  if (!Array.isArray(userCalendars) || userCalendars.length === 0) {
    setLibraryCalendars([]);
    return;
  }

  const normalized = userCalendars.map((calendar, index) => {
    const normalizedEntry = normalizeCalendar(
      {
        id: calendar.id || `saved-${index}`,
        title: calendar.niche_style || calendar.nicheStyle || 'Untitled Calendar',
        status: calendar.status || 'draft',
        platforms: Array.isArray(calendar.platforms) && calendar.platforms.length ? calendar.platforms : inferPlatformsFromPosts(calendar.posts),
        startDate: calendar.start_date || calendar.rangeStart || calendar.created_at || new Date().toISOString(),
        endDate: calendar.end_date || calendar.rangeEnd || null,
        postsCount: Array.isArray(calendar.posts) ? calendar.posts.length : Number(calendar.postsCount || 0),
        variantsCount: typeof calendar.variantCount === 'number' ? calendar.variantCount : Math.max((Array.isArray(calendar.posts) ? calendar.posts.length : 0) * 3, 0),
        updatedAt: calendar.updated_at || calendar.saved_at || calendar.created_at || new Date().toISOString(),
        createdAt: calendar.created_at || calendar.saved_at || calendar.updated_at || new Date().toISOString()
      },
      { source: 'remote', raw: calendar }
    );
    calendarRawLookup.set(normalizedEntry.id, calendar);
    return normalizedEntry;
  });

  setLibraryCalendars(normalized);
}

function setLibraryCalendars(data) {
  libraryCalendarData = Array.isArray(data) ? data : [];
  renderLibraryCalendars();
}

function renderLibraryCalendars() {
  if (!calendarsList) return;
  const baseCount = libraryCalendarData.length;
  toggleToolbarDisabled(baseCount === 0);
  if (calendarEmptyState) calendarEmptyState.classList.toggle('is-visible', baseCount === 0);

  if (baseCount === 0) {
    calendarsList.innerHTML = '';
    calendarsList.style.display = 'none';
    if (calendarEmptyState) calendarEmptyState.style.display = '';
    return;
  }

  const filtered = getFilteredCalendars();
  if (!filtered.length) {
    calendarsList.innerHTML = `<div class="calendar-empty-results">No calendars match this view.</div>`;
    calendarsList.style.display = 'grid';
    if (calendarEmptyState) calendarEmptyState.style.display = 'none';
    return;
  }

  const cardsHtml = filtered.map(renderCalendarCard).join('');
  calendarsList.innerHTML = cardsHtml;
  calendarsList.style.display = 'grid';
  if (calendarEmptyState) calendarEmptyState.style.display = 'none';
  attachCalendarCardInteractions();
}

function getFilteredCalendars() {
  const search = (calendarFilters.search || '').toLowerCase();
  return [...libraryCalendarData]
    .filter((calendar) => {
      if (calendarFilters.status !== 'all' && calendar.status !== calendarFilters.status) return false;
      if (search && !calendar.title.toLowerCase().includes(search)) return false;
      return true;
    })
    .sort((a, b) => {
      if (calendarFilters.sort === 'alpha') {
        return a.title.localeCompare(b.title, undefined, { sensitivity: 'base' });
      }
      if (calendarFilters.sort === 'created') {
        return new Date(b.createdAt || b.startDate).getTime() - new Date(a.createdAt || a.startDate).getTime();
      }
      return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
    });
}

function renderCalendarCard(calendar) {
  const statusLabel = formatStatusLabel(calendar.status);
  const rangeLabel = formatCalendarRange(calendar);
  const updatedLabel = formatUpdatedAt(calendar.updatedAt);
  const platforms = (calendar.platforms || []).slice(0, 4);
  const platformChips = platforms
    .map((platform) => `<span class="calendar-card__platform-chip">${escapeHtml(platform)}</span>`)
    .join('');

  return `
    <article class="calendar-card" data-calendar-id="${escapeHtml(calendar.id)}" tabindex="0">
      <div class="calendar-card__meta">
        <span class="calendar-card__status calendar-card__status--${escapeHtml(calendar.status)}">${statusLabel}</span>
        <span>${updatedLabel}</span>
      </div>
      <h3>${escapeHtml(calendar.title)}</h3>
      <div class="calendar-card__platforms">${platformChips}</div>
      <p class="calendar-card__range">${rangeLabel}</p>
      <p class="calendar-card__metrics">Posts: ${calendar.postsCount} • Variants: ${calendar.variantsCount}</p>
      <div class="calendar-card__actions">
        <button type="button" class="primary" data-calendar-action="open" data-calendar-id="${escapeHtml(calendar.id)}">Open</button>
        <button type="button" class="delete-calendar-btn" data-calendar-action="delete" data-calendar-id="${escapeHtml(calendar.id)}">Delete</button>
        <button type="button" class="ghost" data-calendar-action="export" data-calendar-id="${escapeHtml(calendar.id)}">Export</button>
      </div>
    </article>
  `;
}

function attachCalendarCardInteractions() {
  if (!calendarsList) return;
  calendarsList.querySelectorAll('.calendar-card').forEach((card) => {
    const calendarId = card.getAttribute('data-calendar-id');
    card.addEventListener('click', (event) => {
      if (event.target.closest('button')) return;
      handleCalendarAction('open', calendarId);
    });
    card.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        handleCalendarAction('open', calendarId);
      }
    });
  });

  calendarsList.querySelectorAll('[data-calendar-action]').forEach((button) => {
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      const action = button.dataset.calendarAction;
      const calendarId = button.dataset.calendarId;
      handleCalendarAction(action, calendarId);
    });
  });
}

function handleCalendarAction(action = 'open', calendarId = '') {
  if (!calendarId) return;
  const record = libraryCalendarData.find((calendar) => calendar.id === calendarId);
  if (!record) return;
  const rawCalendar = calendarRawLookup.get(calendarId);

  if (record.source !== 'remote' || !rawCalendar) {
    alert('Save a calendar in Promptly to open, duplicate, or export from the Library.');
    return;
  }

  if (action === 'open') {
    sessionStorage.setItem('promptly_load_calendar', JSON.stringify(rawCalendar));
    window.location.href = '/';
  } else if (action === 'delete') {
    const confirmed = window.confirm('Delete this saved calendar? This cannot be undone.');
    if (!confirmed) return;
    deleteSavedCalendar(calendarId);
  } else if (action === 'export') {
    exportCalendarArchive(rawCalendar);
  }
}

async function deleteSavedCalendar(calendarId) {
  if (!calendarId) return;
  try {
    const { error } = await supabase.from('calendars').delete().eq('id', calendarId);
    if (error) throw error;
    await loadCalendars();
  } catch (err) {
    console.error('[Library] delete calendar failed', err);
    alert('Failed to delete calendar. Please try again.');
  }
}

async function exportCalendarArchive(calendar) {
  const userIsPro = await isPro(currentUser);
  if (!userIsPro) {
    showUpgradeModal();
    return;
  }
  const JSZipLib = await ensureZip().catch(() => null);
  if (!JSZipLib) {
    alert('Failed to load download library. Please check your connection and try again.');
    return;
  }
  const posts = Array.isArray(calendar.posts) ? calendar.posts : [];
  if (!posts.length) {
    alert('This calendar has no posts to export yet.');
    return;
  }
  const zip = new JSZipLib();
  const folderName = `calendar-${slugify(calendar.nicheStyle || calendar.niche_style || 'posts')}`;
  const folder = zip.folder(folderName);
  posts.forEach((post) => {
    const day = post.day || '';
    const title = post.idea || post.title || '';
    const fileName = `day-${String(day).padStart(2, '0')}-${slugify(title || 'post')}.html`;
    folder.file(fileName, buildPostHTML(post));
  });
  const blob = await zip.generateAsync({ type: 'blob' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `${folderName}.zip`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

function toggleToolbarDisabled(disabled) {
  if (calendarToolbar) calendarToolbar.classList.toggle('is-disabled', disabled);
  if (calendarSearchInput) calendarSearchInput.disabled = disabled;
  if (calendarSortSelect) calendarSortSelect.disabled = disabled;
  calendarFilterButtons.forEach((btn) => {
    btn.disabled = disabled;
  });
  if (!disabled) {
    updateFilterActiveState();
  }
}

function updateFilterActiveState() {
  calendarFilterButtons.forEach((btn) => {
    const value = btn.dataset.calendarFilter || 'all';
    const isSelected = value === calendarFilters.status && !btn.disabled;
    btn.classList.toggle('is-active', isSelected);
  });
}

function normalizeCalendar(calendar, { source = 'mock', raw = null } = {}) {
  const startDate = calendar.startDate || new Date().toISOString();
  const endDate = calendar.endDate ?? null;
  const updatedAt = calendar.updatedAt || startDate;
  const createdAt = calendar.createdAt || startDate;
  const platforms = Array.isArray(calendar.platforms) && calendar.platforms.length ? calendar.platforms : ['IG'];
  const generatedId = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `calendar-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return {
    id: String(calendar.id || generatedId),
    title: calendar.title || 'Untitled Calendar',
    status: (calendar.status || 'draft').toLowerCase(),
    platforms,
    startDate,
    endDate,
    postsCount: typeof calendar.postsCount === 'number' ? calendar.postsCount : 0,
    variantsCount: typeof calendar.variantsCount === 'number' ? calendar.variantsCount : 0,
    updatedAt,
    createdAt,
    source,
    raw
  };
}

function inferPlatformsFromPosts(posts) {
  if (!Array.isArray(posts) || !posts.length) return ['IG'];
  const platformSet = new Set();
  const sample = posts.slice(0, 10);
  sample.forEach((post) => {
    if (Array.isArray(post.platforms)) {
      post.platforms.forEach((p) => p && platformSet.add(p));
    } else if (typeof post.platform === 'string') {
      platformSet.add(post.platform);
    }
    if (post.variants) {
      Object.keys(post.variants).forEach((key) => {
        const normalized = key.toLowerCase();
        if (normalized.includes('ig') || normalized.includes('instagram')) platformSet.add('IG');
        if (normalized.includes('tiktok')) platformSet.add('TikTok');
        if (normalized.includes('linkedin')) platformSet.add('LinkedIn');
        if (normalized.includes('youtube')) platformSet.add('YouTube Shorts');
      });
    }
  });
  if (!platformSet.size) platformSet.add('IG');
  return Array.from(platformSet).slice(0, 4);
}

function formatCalendarRange(calendar) {
  const start = calendar.startDate ? new Date(calendar.startDate) : null;
  const end = calendar.endDate ? new Date(calendar.endDate) : null;
  if (start && end) {
    return `${formatDisplayDate(start)} – ${formatDisplayDate(end)}`;
  }
  if (start && !end) {
    return `${formatDisplayDate(start)} – Rolling 30 days`;
  }
  return 'Rolling 30 days';
}

function formatDisplayDate(date) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return '';
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

function formatUpdatedAt(value) {
  const date = value ? new Date(value) : null;
  if (!date || Number.isNaN(date.getTime())) return '';
  return `Updated ${date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`;
}

function formatStatusLabel(status) {
  const map = {
    draft: 'Draft',
    scheduled: 'Scheduled',
    published: 'Published'
  };
  return map[status] || 'Draft';
}

updateFilterActiveState();
