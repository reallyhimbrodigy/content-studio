import { getCurrentUser, saveUserCalendar, signOut as storeSignOut, getUserTier, setUserTier, isPro } from './user-store.js';

const grid = document.getElementById("calendar-grid");
  const pillarFilterBtn = document.getElementById("pillar-filter-btn");
  const pillarFilterMenu = document.getElementById("pillar-filter-menu");
  const pillarFilterLabel = document.getElementById("pillar-filter-label");
  const filterDropdownItems = document.querySelectorAll(".filter-dropdown-item");
  const userEmailEl = document.getElementById("user-email");
  const userTierBadge = document.getElementById("user-tier-badge");
  const signOutBtn = document.getElementById("sign-out-btn");
  const tabLibrary = document.getElementById("tab-library");
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
  const exportIcsBtn = document.getElementById('export-ics');
  const downloadZipBtn = document.getElementById('download-zip');
  const copyAllCaptionsBtn = document.getElementById('copy-all-captions');
  const copyAllFullBtn = document.getElementById('copy-all-full');
  const genVariantsBtn = document.getElementById('gen-variants');
  const exportVariantsCsvBtn = document.getElementById('export-variants-csv');
  const downloadVariantsZipBtn = document.getElementById('download-variants-zip');
  const downloadCalendarFolderBtn = document.getElementById('download-calendar-folder');
  const hub = document.getElementById('publish-hub');
  const hubNext = document.getElementById('hub-next');
  const hubAfter = document.getElementById('hub-after');
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

  // Posted state per user+niche
  let hubIndex = 0; // 0-based index into currentCalendar
  let activeTab = 'plan';
  let isCompact = false;
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
    const hasCalendar = currentCalendar && currentCalendar.length > 0;
    // Toggle classes
    if (tabPlan) tabPlan.classList.toggle('active', activeTab==='plan');
    if (tabPublish) tabPublish.classList.toggle('active', activeTab==='publish');
    if (tabPlan) tabPlan.setAttribute('aria-pressed', String(activeTab==='plan'));
    if (tabPublish) tabPublish.setAttribute('aria-pressed', String(activeTab==='publish'));
    // Show/hide sections with fade
    if (activeTab==='plan') {
      // Fade out hub, fade in calendar
      if (hub.style.display !== 'none') {
        hub.style.opacity = '0';
        setTimeout(() => { hub.style.display = 'none'; }, 200);
      }
      calendarSection.style.display = '';
      requestAnimationFrame(() => { calendarSection.style.opacity = '1'; });
    } else {
      // Fade out calendar, fade in hub
      calendarSection.style.opacity = '0';
      setTimeout(() => { calendarSection.style.display = 'none'; }, 200);
      hub.style.display = '';
      requestAnimationFrame(() => { hub.style.opacity = '1'; });
      // Show empty state if no calendar
      if (!hasCalendar) {
        if (hubEmpty) hubEmpty.style.display = '';
        if (hubGrid) hubGrid.style.display = 'none';
      } else {
        if (hubEmpty) hubEmpty.style.display = 'none';
        if (hubGrid) hubGrid.style.display = '';
      }
    }
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
  console.log("tabLibrary:", tabLibrary ? "✓ found" : "✗ MISSING");
  console.log("signOutBtn:", signOutBtn ? "✓ found" : "✗ MISSING");
  console.log("brandBtn:", brandBtn ? "✓ found" : "✗ MISSING");

// Show/hide nav based on auth state
(async () => {
  const currentUser = await getCurrentUser();
  const publicNav = document.getElementById('public-nav');
  const userMenu = document.getElementById('user-menu');
  
  console.log('Auth check - currentUser:', currentUser);
  console.log('publicNav element:', publicNav);
  console.log('userMenu element:', userMenu);
  
  if (currentUser) {
    // User is logged in - show profile menu
    console.log('✓ User logged in:', currentUser);
    if (publicNav) publicNav.style.display = 'none';
    if (userMenu) {
      userMenu.style.display = 'block';
      console.log('✓ User menu displayed');
    }
    
    // Populate user email
    if (userEmailEl) {
      userEmailEl.textContent = currentUser;
      console.log('✓ Email set:', currentUser);
    }
    
    // Show Pro badge if applicable
    const userIsPro = await isPro(currentUser);
    console.log('User is Pro:', userIsPro);
    
    const userProBadge = document.getElementById('user-pro-badge');
    if (userProBadge && userIsPro) {
      userProBadge.style.display = 'inline-block';
      console.log('✓ Pro badge shown');
    }
  } else {
    // User is not logged in - show public nav
    console.log('✗ No user logged in - showing public nav');
    if (publicNav) {
      publicNav.style.display = 'flex';
      console.log('✓ Public nav displayed');
    }
    if (userMenu) userMenu.style.display = 'none';
  }
})();

// Profile dropdown toggle
const profileTrigger = document.getElementById('profile-trigger');
const profileMenu = document.getElementById('profile-menu');
const profileDropdown = document.getElementById('profile-dropdown');

if (profileTrigger && profileMenu) {
  profileTrigger.addEventListener('click', (e) => {
    e.stopPropagation();
    const isOpen = profileMenu.style.display === 'block';
    profileMenu.style.display = isOpen ? 'none' : 'block';
    profileTrigger.setAttribute('aria-expanded', String(!isOpen));
  });

  // Close dropdown when clicking outside
  document.addEventListener('click', (e) => {
    const clickedInsideDropdown = profileDropdown && profileDropdown.contains(e.target);
    const clickedSignOut = e.target.id === 'sign-out-btn' || e.target.closest('#sign-out-btn');
    
    console.log('Document click handler:', {
      target: e.target,
      targetId: e.target.id,
      clickedInsideDropdown,
      clickedSignOut,
      menuVisible: profileMenu.style.display === 'block'
    });
    
    // Don't close if clicked sign-out button - let its handler run
    if (clickedSignOut) {
      console.log('Detected sign-out click, returning early');
      return;
    }
    
    // Close if clicked outside dropdown
    if (!clickedInsideDropdown && profileMenu.style.display === 'block') {
      console.log('Closing dropdown - clicked outside');
      profileMenu.style.display = 'none';
      profileTrigger.setAttribute('aria-expanded', 'false');
    }
  });
}

// Sign-out handler - use mousedown to fire before click handlers
setTimeout(() => {
  const signOutButton = document.getElementById('sign-out-btn');
  console.log('Looking for sign-out button:', signOutButton);
  
  if (signOutButton) {
    console.log('✓ Sign-out button found, attaching mousedown handler');
    
    signOutButton.addEventListener('mousedown', async (e) => {
      console.log('🔴 SIGN OUT MOUSEDOWN!');
      
      e.preventDefault();
      e.stopPropagation();
      
      // Close the dropdown
      const menu = document.getElementById('profile-menu');
      if (menu) menu.style.display = 'none';
      
      try {
        console.log('Calling storeSignOut...');
        await storeSignOut();
        console.log('✓ Signed out successfully, redirecting...');
        window.location.href = '/auth.html';
      } catch (error) {
        console.error('❌ Sign-out error:', error);
        alert('Error signing out: ' + error.message);
      }
    });
    
    // Prevent click event from firing at all
    signOutButton.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
    });
    
    console.log('✓ Sign-out handler attached successfully');
  } else {
    console.error('❌ Sign-out button not found!');
  }
}, 500);

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
  upgradeBtn.addEventListener('click', () => {
    // Open Stripe Payment Link in a new, clean tab to avoid any page-script interference
  // Force English locale to avoid dynamic import issues (Cannot find module './en') on some setups
  const url = 'https://buy.stripe.com/5kQ5kE3Qw1G8aWoe5Cgbm00?locale=en';
    try {
      const win = window.open(url, '_blank', 'noopener,noreferrer');
      if (!win) {
        // Popup blocked: fall back to same-tab navigation
        window.location.href = url;
      } else {
        // Close the upgrade modal if it’s open
        if (typeof hideUpgradeModal === 'function') hideUpgradeModal();
      }
    } catch (e) {
      // Absolute fallback
      window.location.href = url;
    }
  });
}

// Export function for other parts of the app to trigger upgrade modal
window.showUpgradeModal = showUpgradeModal;

// Library tab handler
if (tabLibrary) {
  tabLibrary.addEventListener("click", () => {
    console.log("Library tab clicked");
    window.location.href = "/library.html";
  });
} else {
  console.error("❌ Library tab not found - this could prevent navigation");
}

// Brand Brain modal handlers
function openBrandModal() {
  if (brandModal) brandModal.style.display = 'grid';
}
function closeBrandModal() {
  if (brandModal) brandModal.style.display = 'none';
}

if (brandBtn && brandModal) {
  brandBtn.addEventListener('click', async () => {
    console.log('🧠 Brand Brain clicked');
    const user = await getCurrentUser();
    console.log('🧠 Current user:', user);
    const userIsPro = await isPro(user);
    console.log('🧠 User is Pro:', userIsPro);
    if (!userIsPro) {
      console.log('🧠 Showing upgrade modal');
      showUpgradeModal();
      return;
    }
    console.log('🧠 Opening brand modal');
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
    const userId = getCurrentUser();
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
      setTimeout(() => { closeBrandModal(); if (brandStatus) { brandStatus.textContent=''; brandStatus.classList.remove('success'); } }, 1500);
    } catch (e) {
      if (brandStatus) brandStatus.textContent = `Error: ${e.message}`;
    } finally {
      brandSaveBtn.disabled = false;
      brandSaveBtn.textContent = 'Save to Brand Brain';
    }
  });
}

const createCard = (post) => {
  const { day, idea, type, caption, hashtags, format, cta, pillar, storyPrompt, designNotes, repurpose, analytics, engagementScript, promoSlot, videoScript, weeklyPromo } = post;
  const card = document.createElement("article");
  card.className = "calendar-card";
  card.dataset.pillar = pillar || "";
  if (isPosted(day)) card.classList.add('posted');

  const dayEl = document.createElement("div");
  dayEl.className = "calendar-card__day";
  dayEl.textContent = String(day).padStart(2, "0");

  const ideaEl = document.createElement("h3");
  ideaEl.className = "calendar-card__title";
  ideaEl.textContent = idea || post.title || "";

  const typeEl = document.createElement("span");
  typeEl.className = "calendar-card__type";
  typeEl.textContent = type ? type.charAt(0).toUpperCase() + type.slice(1) : "";

  const captionEl = document.createElement("p");
  captionEl.className = "calendar-card__caption";
  captionEl.textContent = caption || post.description || "";

  const hashtagsEl = document.createElement("div");
  hashtagsEl.className = "calendar-card__hashtags";
  if (Array.isArray(hashtags)) {
    hashtagsEl.textContent = hashtags.map(h => (h.startsWith('#') ? h : `#${h}`)).join(' ');
  } else if (typeof hashtags === 'string') {
    hashtagsEl.textContent = hashtags;
  }

  const formatEl = document.createElement("span");
  formatEl.className = "calendar-card__format";
  formatEl.textContent = format ? `Format: ${format}` : "";

  const ctaEl = document.createElement("span");
  ctaEl.className = "calendar-card__cta";
  ctaEl.textContent = cta ? `CTA: ${cta}` : "";

  // New MVP pack fields
  const storyPromptEl = document.createElement("div");
  storyPromptEl.className = "calendar-card__story";
  if (storyPrompt) storyPromptEl.innerHTML = `<strong>Story Prompt:</strong> ${storyPrompt}`;

  const designNotesEl = document.createElement("div");
  designNotesEl.className = "calendar-card__design";
  if (designNotes) designNotesEl.innerHTML = `<strong>Design Notes:</strong> ${designNotes}`;

  const repurposeEl = document.createElement("div");
  repurposeEl.className = "calendar-card__repurpose";
  if (repurpose) {
    const text = Array.isArray(repurpose) ? repurpose.join(' • ') : repurpose;
    repurposeEl.innerHTML = `<strong>Repurpose:</strong> ${text}`;
  }

  const analyticsEl = document.createElement("div");
  analyticsEl.className = "calendar-card__analytics";
  if (analytics) {
    const text = Array.isArray(analytics) ? analytics.join(', ') : analytics;
    analyticsEl.innerHTML = `<strong>Analytics:</strong> ${text}`;
  }

  const engagementEl = document.createElement("div");
  engagementEl.className = "calendar-card__engagement";
  if (post.engagementScripts && (post.engagementScripts.commentReply || post.engagementScripts.dmReply)) {
    const list = [];
    if (post.engagementScripts.commentReply) list.push(`<div><em>Comment:</em> ${post.engagementScripts.commentReply}</div>`);
    if (post.engagementScripts.dmReply) list.push(`<div><em>DM:</em> ${post.engagementScripts.dmReply}</div>`);
    engagementEl.innerHTML = `<strong>Engagement Scripts</strong>${list.join('')}`;
  } else if (engagementScript) {
    engagementEl.innerHTML = `<strong>Engagement Script:</strong> ${engagementScript}`;
  }

  const promoSlotEl = document.createElement("div");
  promoSlotEl.className = "calendar-card__promo";
  if (promoSlot) promoSlotEl.innerHTML = `<strong>Weekly Promo Slot:</strong> Yes`;

  const weeklyPromoEl = document.createElement("div");
  weeklyPromoEl.className = "calendar-card__weekly-promo";
  if (weeklyPromo) weeklyPromoEl.innerHTML = `<strong>Promo:</strong> ${weeklyPromo}`;

  const videoScriptEl = document.createElement("div");
  videoScriptEl.className = "calendar-card__video";
  if (videoScript && (videoScript.hook || videoScript.body || videoScript.cta)) {
    const hook = videoScript.hook ? `<div><em>Hook:</em> ${videoScript.hook}</div>` : '';
    const body = videoScript.body ? `<div><em>Body:</em> ${videoScript.body}</div>` : '';
    const vcta = videoScript.cta ? `<div><em>CTA:</em> ${videoScript.cta}</div>` : '';
     const label = format === 'Reel' ? 'Reel Script' : 'Reel Script (can repurpose as Reel)';
     videoScriptEl.innerHTML = `<strong>${label}</strong>${hook}${body}${vcta}`;
  }

  // Platform variants (if available)
  const variantsEl = document.createElement('div');
  variantsEl.className = 'calendar-card__variants';
  if (post.variants && (post.variants.igCaption || post.variants.tiktokCaption || post.variants.linkedinCaption)) {
    const parts = [];
    if (post.variants.igCaption) parts.push(`<div><em>Instagram:</em> ${post.variants.igCaption}</div>`);
    if (post.variants.tiktokCaption) parts.push(`<div><em>TikTok:</em> ${post.variants.tiktokCaption}</div>`);
    if (post.variants.linkedinCaption) parts.push(`<div><em>LinkedIn:</em> ${post.variants.linkedinCaption}</div>`);
    variantsEl.innerHTML = `<strong>Platform Variants</strong>${parts.join('')}`;
  }

  // Action buttons for done-for-you workflow
  const actionsEl = document.createElement('div');
  actionsEl.className = 'calendar-card__actions';
  const makeBtn = (label) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'ghost';
    b.style.fontSize = '0.8rem';
    b.style.padding = '0.3rem 0.6rem';
    b.textContent = label;
    return b;
  };
  const btnCopyCaption = makeBtn('Copy Caption');
  const btnCopyFull = makeBtn('Copy Full');
  const btnDownloadDoc = makeBtn('Download');

  // Compose all card content for full copy
  const fullTextParts = [];
  fullTextParts.push(`Day ${String(day).padStart(2,'0')}`);
  if (idea) fullTextParts.push(`Idea: ${idea}`);
  if (type) fullTextParts.push(`Type: ${type}`);
  if (caption) fullTextParts.push(`Caption: ${caption}`);
  if (Array.isArray(hashtags) && hashtags.length) fullTextParts.push(`Hashtags: ${hashtags.map(h=>h.startsWith('#')?h:`#${h}`).join(' ')}`);
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

  btnCopyFull.addEventListener('click', async ()=>{ try { await navigator.clipboard.writeText(fullText); btnCopyFull.textContent='Copied!'; setTimeout(()=>btnCopyFull.textContent='Copy Full',1000);} catch(e){} });
  btnDownloadDoc.addEventListener('click', async ()=>{
    const user = await getCurrentUser();
    const userIsPro = await isPro(user);
    // Gate: Pro feature
    if (!userIsPro) {
      showUpgradeModal();
      return;
    }
    
    try {
      const JSZipLib = await ensureZip().catch(()=>null);
      if (!JSZipLib) { alert('Failed to load Zip library. Please try again.'); return; }
      const zip = new JSZipLib();
      const folderName = `post-day-${String(day).padStart(2,'0')}-${slugify(idea || title || 'post')}`;
      const folder = zip.folder(folderName);
      const html = buildPostHTML(post);
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
    } catch(e) {}
  });
  actionsEl.append(btnCopyFull);
  actionsEl.appendChild(btnDownloadDoc);

  // Variant copy shortcuts
  if (post.variants) {
    if (post.variants.igCaption) {
      const b = makeBtn('Copy IG');
      b.addEventListener('click', async ()=>{ try { await navigator.clipboard.writeText(post.variants.igCaption); b.textContent='Copied!'; setTimeout(()=>b.textContent='Copy IG',1000);} catch(e){} });
      actionsEl.appendChild(b);
    }
    if (post.variants.tiktokCaption) {
      const b = makeBtn('Copy TikTok');
      b.addEventListener('click', async ()=>{ try { await navigator.clipboard.writeText(post.variants.tiktokCaption); b.textContent='Copied!'; setTimeout(()=>b.textContent='Copy TikTok',1000);} catch(e){} });
      actionsEl.appendChild(b);
    }
    if (post.variants.linkedinCaption) {
      const b = makeBtn('Copy LinkedIn');
      b.addEventListener('click', async ()=>{ try { await navigator.clipboard.writeText(post.variants.linkedinCaption); b.textContent='Copied!'; setTimeout(()=>b.textContent='Copy LinkedIn',1000);} catch(e){} });
      actionsEl.appendChild(b);
    }
  }

  // Collapse secondary details to reduce visual clutter
  const details = document.createElement('details');
  const summary = document.createElement('summary'); summary.textContent = 'Details';
  const detailsBody = document.createElement('div'); detailsBody.className = 'details-body';
  detailsBody.append(
    hashtagsEl, formatEl, ctaEl,
    storyPromptEl, designNotesEl, repurposeEl, analyticsEl, engagementEl,
    promoSlotEl, weeklyPromoEl, videoScriptEl, variantsEl, actionsEl
  );
  details.append(summary, detailsBody);

  // Layout: essentials visible, everything else tucked into details
  card.append(
    dayEl, ideaEl, typeEl, captionEl, details
  );
  return card;
};

let currentCalendar = []; // Store the current calendar data
let currentNiche = ""; // Store the niche for the current calendar

const renderCards = (subset) => {
  grid.innerHTML = "";
  subset.forEach((post) => grid.appendChild(createCard(post)));
};

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
  pillarFilterLabel.textContent = filterText;

  // Apply filter to calendar
  if (filter === 'all') {
    renderCards(currentCalendar);
  } else {
    renderCards(currentCalendar.filter((post) => post.pillar === filter));
  }

  // Close dropdown
  pillarFilterMenu.style.display = 'none';
  pillarFilterBtn.setAttribute('aria-expanded', 'false');
};

// Toggle dropdown
pillarFilterBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  const isOpen = pillarFilterMenu.style.display === 'block';
  pillarFilterMenu.style.display = isOpen ? 'none' : 'block';
  pillarFilterBtn.setAttribute('aria-expanded', !isOpen);
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

// Start with empty grid (no pre-made posts)
try {
  renderCards([]);
  console.log("✓ Initial render complete");
  updateTabs();
} catch (err) {
  console.error("❌ Error rendering initial cards:", err);
}

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
    currentNiche = cal.nicheStyle;
    nicheInput.value = currentNiche;
    renderCards(currentCalendar);
    applyFilter("all");
    // Initialize hub controls
    if (hubDaySelect) {
      hubDaySelect.innerHTML = currentCalendar.map((p, idx)=>`<option value="${idx}">Day ${String(p.day).padStart(2,'0')}</option>`).join('');
    }
    hubIndex = findNextUnposted(0);
    if (hubDaySelect) hubDaySelect.value = String(hubIndex);
  if (hub) { renderPublishHub(); }
  updateTabs();
    if (saveBtn) saveBtn.style.display = "inline-block";
    if (exportBtn) exportBtn.style.display = "inline-block";
    if (exportCsvBtn) exportCsvBtn.style.display = 'inline-block';
    if (exportIcsBtn) exportIcsBtn.style.display = 'inline-block';
    if (downloadZipBtn) downloadZipBtn.style.display = 'inline-block';
    if (copyAllCaptionsBtn) copyAllCaptionsBtn.style.display = 'inline-block';
    if (copyAllFullBtn) copyAllFullBtn.style.display = 'inline-block';
  if (genVariantsBtn) genVariantsBtn.style.display = 'inline-block';
  if (saveBtn) saveBtn.style.display = 'inline-block';
  if (exportVariantsCsvBtn) exportVariantsCsvBtn.style.display = 'inline-block';
  if (downloadVariantsZipBtn) downloadVariantsZipBtn.style.display = 'inline-block';
  if (downloadCalendarFolderBtn) downloadCalendarFolderBtn.style.display = 'inline-block';
  if (hub) { renderPublishHub(); hub.style.display='block'; }
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
    console.log('📦 Export clicked');
    const user = await getCurrentUser();
    console.log('📦 Current user:', user);
    const userIsPro = await isPro(user);
    console.log('📦 User is Pro:', userIsPro);
    if (!userIsPro) {
      console.log('📦 Showing upgrade modal');
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

// Generate platform variants
if (genVariantsBtn) {
  genVariantsBtn.addEventListener('click', async ()=>{
    const user = await getCurrentUser();
    const userIsPro = await isPro(user);
    // Gate: Pro feature
    if (!userIsPro) {
      showUpgradeModal();
      return;
    }
    
    if (!currentCalendar || currentCalendar.length === 0) { alert('Generate a calendar first.'); return; }
    genVariantsBtn.disabled = true; const original = genVariantsBtn.textContent; genVariantsBtn.textContent = 'Generating…';
    try {
      const batches = [currentCalendar.slice(0,15), currentCalendar.slice(15)];
      let merged = [...currentCalendar];
      for (const chunk of batches) {
        if (chunk.length === 0) continue;
        const resp = await fetch('/api/generate-variants', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ posts: chunk, nicheStyle: nicheInput?.value || '', userId: getCurrentUser() || undefined })
        });
        if (!resp.ok) { const e = await resp.json().catch(()=>({})); throw new Error(e.error || 'Variant generation failed'); }
        const data = await resp.json();
        const byDay = new Map((data.variants||[]).map(v=>[v.day, v.variants]));
        merged = merged.map(p=> byDay.has(p.day) ? { ...p, variants: byDay.get(p.day) } : p);
      }
      currentCalendar = merged;
      renderCards(currentCalendar);
      applyFilter('all');
      if (feedbackEl) { feedbackEl.textContent = '✓ Platform variants added to each card.'; feedbackEl.classList.add('success'); setTimeout(()=>{ if (feedbackEl){ feedbackEl.textContent=''; feedbackEl.classList.remove('success'); } }, 2500);}    
    } catch (e) {
      if (feedbackEl) { feedbackEl.textContent = `Error: ${e.message}`; feedbackEl.classList.remove('success'); }
    } finally {
      genVariantsBtn.disabled = false; genVariantsBtn.textContent = original;
    }
  });
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
  const detailsBlocks = [
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
  ].filter(Boolean).join('');

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
    .calendar-card__engagement em, .calendar-card__video em { font-style: normal; color: rgba(245, 246, 248, 0.9); font-weight: 600; }
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
        feedbackEl.textContent = "🔒 Save to Library is a Pro feature. Upgrade to save unlimited calendars!";
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
    
    // Reuse the saveUserCalendar function from auth.js
    saveUserCalendar(currentUser, calendarData);
    
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
  });
}

// OpenAI API integration (via backend proxy)
async function generateCalendarWithAI(nicheStyle) {
  console.log("🟡 generateCalendarWithAI called with:", nicheStyle);
  
  try {
    const batchSize = 5;
    const totalBatches = 6; // 30 posts / 5 per batch
    let completedBatches = 0;
    
    // Helper to fetch one batch
    const fetchBatch = async (batchIndex) => {
      const startDay = batchIndex * batchSize + 1;
      console.log(`🟡 Requesting batch ${batchIndex + 1}/${totalBatches} (days ${startDay}-${startDay + batchSize - 1})`);
      
      const response = await fetch("/api/generate-calendar", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ 
          nicheStyle, 
          userId: getCurrentUser() || undefined, 
          days: batchSize, 
          startDay: startDay
        })
      });
      
      if (!response.ok) {
        const error = await response.json().catch(() => ({}));
        throw new Error(error.error || `API error: ${response.statusText}`);
      }
      
      const data = await response.json();
      const batchPosts = Array.isArray(data.posts) ? data.posts : [];
      
      // Update progress UI as each batch completes
      completedBatches++;
      const btn = document.getElementById('generate-calendar');
      const textSpan = btn?.querySelector('.btn-text');
      const pFill = document.getElementById('progress-fill');
      const pText = document.getElementById('progress-text');
      
      const progress = completedBatches * batchSize;
      const total = 30;
      const percent = Math.round((completedBatches / totalBatches) * 100);
      
      if (textSpan) textSpan.textContent = `Generating... (${progress}/${total} posts)`;
      if (pFill) pFill.style.width = `${percent}%`;
      if (pText) pText.textContent = `${progress} of ${total} posts created (${percent}%)`;
      
      console.log(`🟢 Batch ${batchIndex + 1} complete`);
      return { batchIndex, posts: batchPosts };
    };
    
    // Fire all 6 batches in parallel for maximum speed (~30 seconds)
    console.log("🟡 Requesting all batches in parallel...");
    const batchPromises = Array.from({ length: totalBatches }, (_, i) => fetchBatch(i));
    const results = await Promise.all(batchPromises);
    
    // Sort by batch index and flatten
    let allPosts = results
      .sort((a, b) => a.batchIndex - b.batchIndex)
      .flatMap(r => r.posts);

    // Ensure every post has a videoScript object
    let missingCount = 0;
    allPosts = allPosts.map(post => {
      if (!post.videoScript || typeof post.videoScript !== 'object') {
        missingCount++;
        return { ...post, videoScript: { hook: '', body: '', cta: '' } };
      }
      return post;
    });
    if (missingCount > 0) {
      console.warn(`⚠️ Fixed ${missingCount} posts missing videoScript. All posts now have a Reel Script.`);
    }

    console.log("🟢 All batches complete, total posts:", allPosts.length);
    return allPosts;
  } catch (err) {
    console.error("🔴 generateCalendarWithAI error:", err);
    console.error("🔴 Error details:", { message: err.message, stack: err.stack });
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
  const user = await getCurrentUser();
  if (!user) return false;
  const pro = await isPro(user);
  if (pro) return true; // Pro users have unlimited
  return getGenerationCount() < 1; // Free users get 1 per month
}

if (generateBtn) {
  generateBtn.addEventListener("click", async () => {
    const niche = nicheInput ? nicheInput.value.trim() : "";
    console.log("🔵 Generate clicked, niche:", niche);
    
    const { ok, msg } = validateNiche(niche);
    console.log("🔵 Validation result:", { ok, msg });
    
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
        feedbackEl.textContent = "🔒 You've reached your free calendar limit for this month. Upgrade to Pro for unlimited calendars!";
        feedbackEl.style.color = 'var(--accent)';
      }
      return;
    }

    // proceed with AI generation and display
    try {
      console.log("🟢 Starting AI generation for:", niche);
      const originalText = btnText ? btnText.textContent : (generateBtn ? generateBtn.textContent : 'Generate Calendar');
      showGeneratingState();
      if (feedbackEl) feedbackEl.textContent = "";
      console.log("🟢 Calling API with niche:", niche);

      // Call OpenAI to generate calendar
      const aiGeneratedPosts = await generateCalendarWithAI(niche);
      console.log("🟢 Received posts:", aiGeneratedPosts);
      
      // Increment generation count for free users
      incrementGenerationCount();
      
      // Store the calendar and render it
      currentCalendar = aiGeneratedPosts;
      currentNiche = niche;
      renderCards(currentCalendar);
      applyFilter("all");

  hideGeneratingState(originalText);
      
      // Show save and export buttons
      if (saveBtn) saveBtn.style.display = "inline-block";
      if (exportBtn) exportBtn.style.display = "inline-block";
  if (exportCsvBtn) exportCsvBtn.style.display = 'inline-block';
  if (exportIcsBtn) exportIcsBtn.style.display = 'inline-block';
  if (downloadZipBtn) downloadZipBtn.style.display = 'inline-block';
  if (copyAllCaptionsBtn) copyAllCaptionsBtn.style.display = 'inline-block';
  if (copyAllFullBtn) copyAllFullBtn.style.display = 'inline-block';
  if (genVariantsBtn) genVariantsBtn.style.display = 'inline-block';
  if (saveBtn) saveBtn.style.display = 'inline-block';
      if (exportVariantsCsvBtn) exportVariantsCsvBtn.style.display = 'inline-block';
      if (downloadVariantsZipBtn) downloadVariantsZipBtn.style.display = 'inline-block';
      if (downloadCalendarFolderBtn) downloadCalendarFolderBtn.style.display = 'inline-block';
      // initialize hub controls
      if (hubDaySelect) {
        hubDaySelect.innerHTML = currentCalendar.map((p, idx)=>`<option value="${idx}">Day ${String(p.day).padStart(2,'0')}</option>`).join('');
      }
      hubIndex = findNextUnposted(0);
      if (hubDaySelect) hubDaySelect.value = String(hubIndex);
      if (hub) { renderPublishHub(); }
      
      // Make sure we stay on the plan tab after generation
      activeTab = 'plan';
      updateTabs();
      
      if (feedbackEl) {
        feedbackEl.textContent = `✓ Calendar created for "${niche}"`;
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
} else {
  console.error("❌ Generate button not found - this is why Generate Calendar doesn't work");
}

// Final diagnostic
console.log("\n=== Event Listener Summary ===");
console.log("✓ Script.js loaded successfully");
if (generateBtn) console.log("✓ Generate button has event listener");
if (saveBtn) console.log("✓ Save button has event listener");
if (exportBtn) console.log("✓ Export button has event listener");
if (tabLibrary) console.log("✓ Library tab has event listener");
if (signOutBtn) console.log("✓ Sign out button has event listener");

console.log("All buttons are ready to use!");

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

// Empty state CTA
if (hubEmptyGenBtn) {
  hubEmptyGenBtn.addEventListener('click', ()=>{
    activeTab = 'plan';
    updateTabs();
    if (nicheInput) nicheInput.focus();
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
      if (post.variants.igCaption){ const b=mk('Copy IG'); b.addEventListener('click', async ()=>{ try { await navigator.clipboard.writeText(post.variants.igCaption); b.textContent='Copied!'; setTimeout(()=>b.textContent='Copy IG',1000);} catch(e){} }); actions.appendChild(b); }
      if (post.variants.tiktokCaption){ const b=mk('Copy TikTok'); b.addEventListener('click', async ()=>{ try { await navigator.clipboard.writeText(post.variants.tiktokCaption); b.textContent='Copied!'; setTimeout(()=>b.textContent='Copy TikTok',1000);} catch(e){} }); actions.appendChild(b); }
      if (post.variants.linkedinCaption){ const b=mk('Copy LinkedIn'); b.addEventListener('click', async ()=>{ try { await navigator.clipboard.writeText(post.variants.linkedinCaption); b.textContent='Copied!'; setTimeout(()=>b.textContent='Copy LinkedIn',1000);} catch(e){} }); actions.appendChild(b); }
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

