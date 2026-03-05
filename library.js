import { getCurrentUser, getUserEdits, deleteUserEdit, supabase } from './user-store.js';
import { initTheme } from './theme.js';

initTheme();

const SIDEBAR_STORAGE_KEY = 'promptly_sidebar_collapsed';

const appLayout = document.querySelector('.app-layout');
const appSidebar = document.getElementById('app-sidebar');
const sidebarToggle = document.getElementById('sidebar-toggle');
const sidebarBackdrop = document.getElementById('sidebar-backdrop');

const userEmailEl = document.getElementById('user-email');
const signOutBtn = document.getElementById('sign-out-btn');
const profileTrigger = document.getElementById('profile-trigger');
const profileMenu = document.getElementById('profile-menu');
const profileInitial = document.getElementById('profile-initial');
const profileDisplayName = document.getElementById('profile-display-name');
const profileDisplayEmail = document.getElementById('profile-display-email');
const billingBadge = document.getElementById('billing-badge');
const manageBillingBtn = document.getElementById('manage-billing-btn');

const accountManageBillingBtn = document.getElementById('acct-manage-billing-btn');

const editsGrid = document.getElementById('edits-grid');
const libraryEmpty = document.getElementById('library-empty');
const libraryCount = document.getElementById('library-count');

let currentUserEmail = null;
let currentUserId = null;

function escapeHtml(value) {
  const div = document.createElement('div');
  div.textContent = String(value ?? '');
  return div.innerHTML;
}

function applySidebarState(collapsed) {
  if (!appSidebar) return;
  appSidebar.classList.toggle('collapsed', collapsed);
  if (appLayout) appLayout.classList.toggle('sidebar-collapsed', collapsed);
  if (sidebarToggle) sidebarToggle.setAttribute('aria-expanded', String(!collapsed));
  try {
    localStorage.setItem(SIDEBAR_STORAGE_KEY, collapsed ? '1' : '0');
  } catch (_) {}

  const isMobile = window.matchMedia('(max-width: 768px)').matches;
  if (sidebarBackdrop) {
    sidebarBackdrop.classList.toggle('visible', !collapsed && isMobile);
  }
  document.body.classList.toggle('sidebar-open', !collapsed && isMobile);
}

function initSidebarToggle() {
  if (!appSidebar || !sidebarToggle) return;

  let collapsed = true;
  try {
    const stored = localStorage.getItem(SIDEBAR_STORAGE_KEY);
    if (stored === null) {
      localStorage.setItem(SIDEBAR_STORAGE_KEY, '1');
      collapsed = true;
    } else {
      collapsed = stored === '1';
    }
  } catch (_) {}

  applySidebarState(collapsed);

  sidebarToggle.addEventListener('click', (event) => {
    event.preventDefault();
    const next = !appLayout?.classList.contains('sidebar-collapsed');
    applySidebarState(next);
  });

  if (sidebarBackdrop) {
    sidebarBackdrop.addEventListener('click', () => applySidebarState(true));
  }
}

function closeProfileMenu() {
  if (profileMenu) profileMenu.style.display = 'none';
  if (profileTrigger) profileTrigger.setAttribute('aria-expanded', 'false');
}

function toggleProfileMenu() {
  if (!profileMenu || !profileTrigger) return;
  const isOpen = profileMenu.style.display === 'block';
  if (isOpen) {
    closeProfileMenu();
  } else {
    profileMenu.style.display = 'block';
    profileTrigger.setAttribute('aria-expanded', 'true');
  }
}

function initProfileMenu() {
  if (profileTrigger) {
    profileTrigger.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      toggleProfileMenu();
    });
  }

  if (profileMenu) {
    profileMenu.addEventListener('click', (event) => event.stopPropagation());
  }

  document.addEventListener('click', (event) => {
    if (!profileMenu || !profileTrigger) return;
    if (profileTrigger.contains(event.target)) return;
    closeProfileMenu();
  });
}

async function openAccountModal() {
  closeProfileMenu();

  const modal = document.getElementById('account-modal');
  if (!modal) return;

  const sb = window.supabaseClient || window.supabase;
  if (!sb || !sb.auth) {
    console.error('[account] Supabase client not available');
    return;
  }
  let user = null;
  try {
    const { data } = await sb.auth.getUser();
    user = data?.user || null;
  } catch (e) {
    console.error('[account] Failed to get user:', e);
  }
  if (!user) return;

  window.__currentUser = user;

  const avatarUrl = user.user_metadata?.avatar_url || '';
  const userName = user.user_metadata?.full_name || user.email?.split('@')[0] || '';
  const avatarWrapper = document.getElementById('acct-avatar-trigger');
  if (avatarWrapper) {
    const existingImg = avatarWrapper.querySelector('.acct-avatar-img');
    const existingFallback = avatarWrapper.querySelector('.acct-avatar-fallback');

    if (avatarUrl) {
      if (existingImg) {
        existingImg.src = avatarUrl;
      } else if (existingFallback) {
        const img = document.createElement('img');
        img.src = avatarUrl;
        img.alt = 'Avatar';
        img.className = 'acct-avatar-img';
        img.id = 'acct-avatar-img';
        existingFallback.replaceWith(img);
      }
    } else {
      if (existingImg) {
        const fallback = document.createElement('span');
        fallback.className = 'acct-avatar-fallback';
        fallback.id = 'acct-avatar-fallback';
        fallback.textContent = getAccountInitials(userName || user.email);
        existingImg.replaceWith(fallback);
      } else if (existingFallback) {
        existingFallback.textContent = getAccountInitials(userName || user.email);
      }
    }
  }

  const nameInput = document.getElementById('acct-name-input');
  const emailInput = document.getElementById('acct-email-input');
  if (nameInput) nameInput.value = userName;
  if (emailInput) emailInput.value = user.email || '';

  // Fetch tier from profiles table (source of truth)
  let isUserPro = false;
  try {
    if (sb && user) {
      const { data: profileRow } = await sb
        .from('profiles')
        .select('tier')
        .eq('id', user.id)
        .single();
      if (profileRow) {
        isUserPro = String(profileRow.tier || '').toLowerCase() === 'pro';
      }
    }
  } catch (e) {
    console.warn('[account] Could not fetch tier:', e);
  }

  const planStatus = document.getElementById('account-plan-status');
  const billingBtn = document.getElementById('acct-manage-billing-btn');
  if (planStatus) {
    planStatus.textContent = isUserPro ? 'Pro' : 'Free';
    planStatus.className = 'acct-plan-badge' + (isUserPro ? ' acct-plan-pro' : '');
  }
  if (billingBtn) billingBtn.style.display = isUserPro ? 'inline-flex' : 'none';
  if (manageBillingBtn) manageBillingBtn.style.display = isUserPro ? 'flex' : 'none';
  if (billingBadge) billingBadge.style.display = isUserPro ? 'inline-flex' : 'none';

  modal.style.display = 'flex';
  modal.hidden = false;
  modal.setAttribute('aria-hidden', 'false');
  requestAnimationFrame(() => modal.classList.add('acct-modal-visible'));
}

function closeAccountModal() {
  const modal = document.getElementById('account-modal');
  if (!modal) return;
  modal.classList.remove('acct-modal-visible');
  setTimeout(() => {
    modal.style.display = 'none';
    modal.hidden = true;
    modal.setAttribute('aria-hidden', 'true');
  }, 200);
}

function getAccountInitials(str) {
  if (!str) return '?';
  const parts = str.split(/[\s@]+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return str.charAt(0).toUpperCase();
}

function initAccountModal() {
  const accountOverviewActionBtn = document.getElementById('account-overview-btn');
  if (accountOverviewActionBtn) {
    accountOverviewActionBtn.addEventListener('click', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      await openAccountModal();
    });
  }

  const passwordSettingsActionBtn = document.getElementById('password-settings-btn');
  if (passwordSettingsActionBtn) {
    passwordSettingsActionBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      closeProfileMenu();
      window.location.href = '/reset-password.html';
    });
  }

  const accountCloseActionBtn = document.getElementById('account-close-btn');
  if (accountCloseActionBtn) {
    accountCloseActionBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      closeAccountModal();
    });
  }

  const accountModalEl = document.getElementById('account-modal');
  if (accountModalEl) {
    accountModalEl.addEventListener('click', (e) => {
      if (e.target === accountModalEl) closeAccountModal();
    });
  }

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeAccountModal();
  });

  const avatarTrigger = document.getElementById('acct-avatar-trigger');
  const avatarInput = document.getElementById('acct-avatar-input');
  if (avatarTrigger && avatarInput) {
    avatarTrigger.addEventListener('click', () => avatarInput.click());
    avatarInput.addEventListener('change', async (e) => {
      const file = e.target.files?.[0];
      if (!file) return;
      if (file.size > 20 * 1024 * 1024) {
        alert('Image must be under 20MB');
        return;
      }
      try {
        avatarTrigger.classList.add('acct-avatar-uploading');
        const sb = window.supabaseClient || window.supabase;
        if (!sb || !sb.auth) {
          alert('Not signed in');
          return;
        }
        const user = (await sb.auth.getUser())?.data?.user;
        if (!user) {
          alert('Not signed in');
          return;
        }
        const ext = file.name.split('.').pop() || 'jpg';
        const filePath = `${user.id}.${ext}`;
        const { error: uploadError } = await sb.storage.from('avatars').upload(filePath, file, { upsert: true });
        if (uploadError) throw uploadError;
        const { data: urlData } = sb.storage.from('avatars').getPublicUrl(filePath);
        const publicUrl = `${urlData?.publicUrl}?t=${Date.now()}`;
        await sb.auth.updateUser({ data: { avatar_url: publicUrl } });
        const existing = avatarTrigger.querySelector('.acct-avatar-img') || avatarTrigger.querySelector('.acct-avatar-fallback');
        if (existing) {
          const img = document.createElement('img');
          img.src = publicUrl;
          img.alt = 'Avatar';
          img.className = 'acct-avatar-img';
          img.id = 'acct-avatar-img';
          existing.replaceWith(img);
        }

        // Update profile dropdown avatar
        const profileAvatarInner = document.querySelector('.profile-avatar-inner');
        if (profileAvatarInner) {
          let profileAvatarImg = profileAvatarInner.querySelector('.profile-avatar-img');
          if (profileAvatarImg) {
            profileAvatarImg.src = publicUrl;
          } else {
            profileAvatarImg = document.createElement('img');
            profileAvatarImg.src = publicUrl;
            profileAvatarImg.alt = 'Avatar';
            profileAvatarImg.id = 'profile-avatar-img';
            profileAvatarImg.className = 'profile-avatar-img';
            profileAvatarImg.style.cssText = 'width:100%;height:100%;object-fit:cover;border-radius:50%;display:block;';
            profileAvatarInner.appendChild(profileAvatarImg);
          }
          if (profileInitial) profileInitial.style.display = 'none';
        }
      } catch (err) {
        console.error('[account] Avatar upload failed:', err);
        alert('Failed to upload avatar.');
      } finally {
        avatarTrigger.classList.remove('acct-avatar-uploading');
        avatarInput.value = '';
      }
    });
  }

  const saveNameBtn = document.getElementById('acct-save-name-btn');
  if (saveNameBtn) {
    saveNameBtn.addEventListener('click', async () => {
      const nameInput = document.getElementById('acct-name-input');
      const newName = (nameInput?.value || '').trim();
      if (!newName || newName.length > 32) {
        alert('Name must be 1-32 characters');
        return;
      }
      saveNameBtn.textContent = 'Saving...';
      saveNameBtn.disabled = true;
      try {
        const sb = window.supabaseClient || window.supabase;
        if (!sb || !sb.auth) {
          alert('Failed to update name.');
          saveNameBtn.textContent = 'Save Changes';
          saveNameBtn.disabled = false;
          return;
        }
        const { error } = await sb.auth.updateUser({ data: { full_name: newName } });
        if (error) throw error;
        saveNameBtn.textContent = 'Saved!';
        if (profileDisplayName) profileDisplayName.textContent = newName;
        if (profileInitial) {
          profileInitial.textContent = newName.charAt(0).toUpperCase();
          const hasAvatar = document.querySelector('.profile-avatar-inner .profile-avatar-img');
          if (hasAvatar) profileInitial.style.display = 'none';
        }
        setTimeout(() => {
          saveNameBtn.textContent = 'Save Changes';
          saveNameBtn.disabled = false;
        }, 1500);
      } catch (err) {
        console.error('[account] Name update failed:', err);
        alert('Failed to update name.');
        saveNameBtn.textContent = 'Save Changes';
        saveNameBtn.disabled = false;
      }
    });
  }

  const saveEmailBtn = document.getElementById('acct-save-email-btn');
  if (saveEmailBtn) {
    saveEmailBtn.addEventListener('click', async () => {
      const emailInput = document.getElementById('acct-email-input');
      const newEmail = (emailInput?.value || '').trim();
      if (!newEmail || !newEmail.includes('@')) {
        alert('Please enter a valid email');
        return;
      }
      saveEmailBtn.textContent = 'Saving...';
      saveEmailBtn.disabled = true;
      try {
        const sb = window.supabaseClient || window.supabase;
        if (!sb || !sb.auth) {
          alert('Failed to update email.');
          saveEmailBtn.textContent = 'Save Changes';
          saveEmailBtn.disabled = false;
          return;
        }
        const { error } = await sb.auth.updateUser({ email: newEmail });
        if (error) throw error;
        saveEmailBtn.textContent = 'Check inbox';
        if (profileDisplayEmail) profileDisplayEmail.textContent = newEmail;
        setTimeout(() => {
          saveEmailBtn.textContent = 'Save Changes';
          saveEmailBtn.disabled = false;
        }, 3000);
      } catch (err) {
        console.error('[account] Email update failed:', err);
        alert('Failed to update email.');
        saveEmailBtn.textContent = 'Save Changes';
        saveEmailBtn.disabled = false;
      }
    });
  }

  if (accountManageBillingBtn) {
    accountManageBillingBtn.addEventListener('click', () => {
      if (typeof handleManageBilling === 'function') {
        handleManageBilling();
      }
    });
  }
}

async function handleManageBilling(event) {
  if (event?.preventDefault) event.preventDefault();
  try {
    const resp = await fetch('/api/billing/portal', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ returnUrl: window.location.href, email: currentUserEmail || '' }),
    });
    const data = await resp.json().catch(() => ({}));
    if (resp.ok && data?.url) {
      window.location.href = data.url;
      return;
    }
    alert(data?.error || 'Billing portal is not configured yet.');
  } catch (_) {
    alert('Billing portal unavailable. Please try again later.');
  }
}

window.handleSignOut = async function handleSignOut() {
  const { signOut } = await import('./user-store.js');
  await signOut();
  localStorage.removeItem('promptly_current_user');
  window.location.href = '/auth.html';
};

async function ensureAuth() {
  try {
    const { data: { session }, error } = await supabase.auth.getSession();
    if (error || !session?.user) {
      window.location.replace('/auth.html');
      return null;
    }
    return session.user;
  } catch (_err) {
    window.location.replace('/auth.html');
    return null;
  }
}

function statusLabel(status) {
  if (status === 'completed') return 'Completed';
  if (status === 'processing') return 'Processing';
  if (status === 'failed') return 'Failed';
  return 'Queued';
}

function formatDate(value) {
  const date = value ? new Date(value) : null;
  if (!date || Number.isNaN(date.getTime())) return 'Unknown date';
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function renderEditCard(edit) {
  const vibe = String(edit?.vibe_input || 'No description');
  const truncatedVibe = vibe.length > 80 ? `${vibe.slice(0, 80)}...` : vibe;
  const status = String(edit?.status || 'queued').toLowerCase();
  const downloadBtn = status === 'completed' && edit?.result_url
    ? `<a href="${escapeHtml(edit.result_url)}" class="edit-action-download" download>Download</a>`
    : '';

  return `
    <article class="edit-card">
      <span class="edit-card-status ${escapeHtml(status)}">${escapeHtml(statusLabel(status))}</span>
      <div class="edit-card-vibe">${escapeHtml(truncatedVibe)}</div>
      <div class="edit-card-date">${escapeHtml(formatDate(edit?.created_at))}</div>
      <div class="edit-card-actions">
        ${downloadBtn}
        <button type="button" class="edit-action-delete" data-edit-id="${escapeHtml(edit?.id || '')}">Delete</button>
      </div>
    </article>
  `;
}

async function loadEdits() {
  if (!currentUserId) return;

  const edits = await getUserEdits(currentUserId);

  if (!editsGrid || !libraryEmpty || !libraryCount) return;

  if (!edits || edits.length === 0) {
    editsGrid.style.display = 'none';
    libraryEmpty.style.display = 'block';
    libraryCount.textContent = 'No edits yet';
    editsGrid.innerHTML = '';
    return;
  }

  libraryEmpty.style.display = 'none';
  editsGrid.style.display = 'grid';
  libraryCount.textContent = `${edits.length} edit${edits.length === 1 ? '' : 's'}`;
  editsGrid.innerHTML = edits.map(renderEditCard).join('');
}

function initEditActions() {
  if (!editsGrid) return;

  editsGrid.addEventListener('click', async (event) => {
    const button = event.target.closest('.edit-action-delete');
    if (!button) return;

    const editId = String(button.dataset.editId || '').trim();
    if (!editId) return;

    const confirmed = window.confirm('Delete this edit?');
    if (!confirmed) return;

    const success = await deleteUserEdit(editId);
    if (success) {
      await loadEdits();
      return;
    }

    alert('Failed to delete edit. Please try again.');
  });
}

async function hydrateUser() {
  currentUserEmail = await getCurrentUser();
  if (userEmailEl) userEmailEl.textContent = currentUserEmail || '';

  const sb = window.supabaseClient || window.supabase;
  let authUser = null;
  if (sb?.auth?.getUser) {
    try {
      const { data } = await sb.auth.getUser();
      authUser = data?.user || null;
    } catch (_) {}
  }

  const profileName = authUser?.user_metadata?.full_name
    || (currentUserEmail ? currentUserEmail.split('@')[0] : 'User');
  const initial = (profileName || currentUserEmail || 'P').trim().charAt(0) || 'P';
  if (profileInitial) profileInitial.textContent = initial.toUpperCase();
  if (profileDisplayName) {
    profileDisplayName.textContent = profileName;
  }
  if (profileDisplayEmail) {
    profileDisplayEmail.textContent = currentUserEmail || '';
  }

  // Show avatar image if available
  const avatarUrl = authUser?.user_metadata?.avatar_url || authUser?.user_metadata?.picture || '';
  const avatarInner = document.querySelector('.profile-avatar-inner');
  if (avatarInner) {
    const existing = avatarInner.querySelector('.profile-avatar-img');
    if (avatarUrl) {
      if (existing) {
        existing.src = avatarUrl;
      } else {
        const avatarImg = document.createElement('img');
        avatarImg.src = avatarUrl;
        avatarImg.alt = 'Avatar';
        avatarImg.id = 'profile-avatar-img';
        avatarImg.className = 'profile-avatar-img';
        avatarImg.style.cssText = 'width:100%;height:100%;object-fit:cover;border-radius:50%;display:block;';
        avatarInner.appendChild(avatarImg);
      }
      if (profileInitial) profileInitial.style.display = 'none';
    } else {
      if (existing) existing.remove();
      if (profileInitial) profileInitial.style.display = '';
    }
  }

  let userIsPro = false;
  try {
    if (sb?.from) {
      const user = authUser;
      if (user?.id) {
        const { data: profileRow, error: profileError } = await sb
          .from('profiles')
          .select('tier')
          .eq('id', user.id)
          .single();
        if (!profileError && profileRow) {
          userIsPro = String(profileRow.tier || 'free').toLowerCase() === 'pro';
        }
      }
    }
  } catch (e) {
    console.warn('[profile] Could not fetch tier:', e);
  }

  if (billingBadge) billingBadge.style.display = userIsPro ? 'inline-flex' : 'none';
  if (manageBillingBtn) {
    manageBillingBtn.style.display = userIsPro ? 'flex' : 'none';
    if (userIsPro && !manageBillingBtn.dataset.bound) {
      manageBillingBtn.dataset.bound = '1';
      manageBillingBtn.addEventListener('click', handleManageBilling);
    }
  }
}

async function initLibraryPage() {
  const authUser = await ensureAuth();
  if (!authUser) return;

  currentUserId = authUser.id;
  document.body.classList.remove('auth-pending');

  initSidebarToggle();
  initProfileMenu();
  initAccountModal();
  initEditActions();

  await hydrateUser();
  await loadEdits();
}

document.addEventListener('click', (event) => {
  const btn = event.target?.closest?.('#sign-out-btn');
  if (!btn) return;
  event.preventDefault();
  window.handleSignOut();
});

if (signOutBtn) {
  signOutBtn.addEventListener('click', (event) => {
    event.preventDefault();
    window.handleSignOut();
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initLibraryPage);
} else {
  initLibraryPage();
}
