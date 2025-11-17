import { getCurrentUser, isPro } from './user-store.js';

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
  
  const nl2br = (s) => escapeHtml(s).replace(/\n/g, '<br/>');
  const videoLabel = format === 'Reel' ? 'Reel Script' : 'Reel Script (can repurpose as Reel)';

  const detailsBlocks = [
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
  ].filter(Boolean).join('');

  const cardHTML = `
    <article class="calendar-card" data-pillar="${escapeHtml(pillar)}">
      <div class="calendar-card__day">${String(day).padStart(2, '0')}</div>
      <h3 class="calendar-card__title">${escapeHtml(title)}</h3>
      ${type ? `<span class="calendar-card__type">${escapeHtml(type.charAt(0).toUpperCase() + type.slice(1))}</span>` : ''}
      <p class="calendar-card__caption">${nl2br(caption)}</p>
      <details>
        <summary>Full Details</summary>
        <div class="calendar-card__details">${detailsBlocks}</div>
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
const userEmailEl = document.getElementById('user-email');
const signOutBtn = document.getElementById('sign-out-btn');
const profileTrigger = document.getElementById('profile-trigger');
const profileMenu = document.getElementById('profile-menu');
const profileDropdown = document.getElementById('profile-dropdown');
const userTierBadge = document.getElementById('user-tier-badge');
const newCalendarBtn = document.getElementById('new-calendar-btn');
// Upgrade modal elements (library page)
const upgradeModal = document.getElementById('upgrade-modal');
const upgradeClose = document.getElementById('upgrade-close');
const upgradeBtn = document.getElementById('upgrade-btn');
const brandBtn = document.getElementById('brand-brain-btn');
const calendarsList = document.getElementById('calendars-list');

let currentUser = null;

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
  
  // Show PRO badge if applicable
  const userIsPro = await isPro(currentUser);
  if (userTierBadge && userIsPro) {
    userTierBadge.textContent = 'PRO';
    userTierBadge.style.display = 'inline-block';
  }
  
  // Show Pro badge in profile menu
  const userProBadge = document.getElementById('user-pro-badge');
  if (userProBadge && userIsPro) {
    userProBadge.style.display = 'inline-block';
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
  upgradeBtn.addEventListener('click', () => {
    const url = 'https://buy.stripe.com/5kQ5kE3Qw1G8aWoe5Cgbm00?locale=en';
    try {
      const win = window.open(url, '_blank', 'noopener,noreferrer');
      if (!win) { window.location.href = url; } else { hideUpgradeModal(); }
    } catch (_) { window.location.href = url; }
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

// Profile dropdown behavior (minimal version)
if (profileTrigger && profileMenu) {
  profileTrigger.addEventListener('click', (e) => {
    e.stopPropagation();
    const isOpen = profileMenu.style.display === 'block';
    profileMenu.style.display = isOpen ? 'none' : 'block';
    profileTrigger.setAttribute('aria-expanded', String(!isOpen));
  });
  document.addEventListener('click', (e) => {
    if (profileDropdown && !profileDropdown.contains(e.target)) {
      profileMenu.style.display = 'none';
      profileTrigger.setAttribute('aria-expanded', 'false');
    }
  });
}

if (newCalendarBtn) {
  newCalendarBtn.addEventListener('click', async () => {
    const userIsPro = await isPro(currentUser);
    if (!userIsPro) { showUpgradeModal(); return; }
    window.location.href = '/';
  });
}

// Brand Brain gating on library page
if (brandBtn) {
  brandBtn.addEventListener('click', async () => {
    const userIsPro = await isPro(currentUser);
    if (!userIsPro) { showUpgradeModal(); return; }
    // Pro users: navigate to home (Brand Brain lives on main page)
    window.location.href = '/';
  });
}

async function loadCalendars() {
  const { getUserCalendars } = await import('./user-store.js');
  const userCalendars = await getUserCalendars(currentUser);

  if (!calendarsList) return;
  calendarsList.innerHTML = '';

  if (userCalendars.length === 0) {
    calendarsList.innerHTML = `
      <div class="empty-state">
        <h3>No saved calendars yet</h3>
        <p>Generate your first calendar to get started!</p>
      </div>
    `;
    return;
  }

  userCalendars.forEach((cal, idx) => {
    const date = new Date(cal.saved_at || cal.updated_at || cal.created_at || Date.now());
    const dateStr = date.toLocaleDateString() + ' ' + date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const nicheTitle = cal.niche_style || cal.nicheStyle || 'Untitled';
    const posts = Array.isArray(cal.posts) ? cal.posts : [];

    const html = `
      <div class="calendar-item" data-id="${cal.id}">
        <div class="calendar-item-info">
          <h3>${nicheTitle}</h3>
          <p>${posts.length} posts • ${dateStr}</p>
        </div>
        <div class="calendar-item-actions">
          <button class="load-btn" data-idx="${idx}">Load & Edit</button>
          <button class="download-btn" data-idx="${idx}">Download</button>
          <button class="delete-btn" data-idx="${idx}">Delete</button>
        </div>
      </div>
    `;
    calendarsList.innerHTML += html;
  });

  document.querySelectorAll('.load-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const idx = btn.dataset.idx;
      sessionStorage.setItem('promptly_load_calendar', JSON.stringify(userCalendars[idx]));
      window.location.href = '/';
    });
  });

  document.querySelectorAll('.download-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const userIsPro = await isPro(currentUser);
      if (!userIsPro) { showUpgradeModal(); return; }
      const idx = btn.dataset.idx;
      const cal = userCalendars[idx];
      
      // Load JSZip library
      const JSZipLib = await ensureZip().catch(() => null);
      if (!JSZipLib) {
        alert('Failed to load download library. Please check your connection and try again.');
        return;
      }
      const zip = new JSZipLib();
      const folderName = `calendar-${slugify(cal.nicheStyle || 'posts')}`;
      const folder = zip.folder(folderName);
      
      // Create 30 individual HTML files
      cal.posts.forEach((post) => {
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
  });

  document.querySelectorAll('.delete-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const idx = btn.dataset.idx;
      const cal = userCalendars[idx];
      const title = cal.niche_style || cal.nicheStyle || 'Untitled';
      if (!cal?.id) { alert('Missing calendar id.'); return; }
      if (confirm(`Delete calendar "${title}"?`)) {
        const { deleteUserCalendar } = await import('./user-store.js');
        const res = await deleteUserCalendar(cal.id);
        if (!res.ok) {
          alert('Failed to delete calendar: ' + (res.msg || 'Unknown error'));
          return;
        }
        await loadCalendars();
      }
    });
  });
}

loadCalendars();
