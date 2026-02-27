import { getCurrentUser, getUserEdits, deleteUserEdit, isPro, supabase } from './user-store.js';
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
const userTierBadge = document.getElementById('user-tier-badge');
const manageBillingBtn = document.getElementById('manage-billing-btn');
const accountOverviewBtn = document.getElementById('account-overview-btn');
const passwordSettingsBtn = document.getElementById('password-settings-btn');

const accountModal = document.getElementById('account-modal');
const accountCloseBtn = document.getElementById('accountSettingsClose');
const accountEmailDisplay = document.getElementById('account-email-display');
const accountEmailCopyBtn = document.getElementById('account-email-copy');
const accountPasswordManageBtn = document.getElementById('account-password-manage');
const accountPlanStatusEl = document.getElementById('account-plan-status');

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

async function loadAccountModalData() {
  if (accountEmailDisplay) {
    accountEmailDisplay.textContent = currentUserEmail || 'Not signed in';
  }

  let tier = 'free';
  try {
    const userIsPro = currentUserEmail ? await isPro(currentUserEmail) : false;
    tier = userIsPro ? 'pro' : 'free';
  } catch (_) {}

  if (accountPlanStatusEl) {
    accountPlanStatusEl.textContent = tier === 'pro' ? 'Promptly Pro' : 'Free';
  }
}

async function openAccountModal() {
  if (!accountModal) return;
  accountModal.removeAttribute('hidden');
  accountModal.style.display = 'flex';
  accountModal.setAttribute('aria-hidden', 'false');
  document.body.classList.add('modal-open');
  closeProfileMenu();
  await loadAccountModalData();
}

function closeAccountModal() {
  if (!accountModal) return;
  accountModal.style.display = 'none';
  accountModal.setAttribute('hidden', '');
  accountModal.setAttribute('aria-hidden', 'true');
  document.body.classList.remove('modal-open');
}

function initAccountModal() {
  if (accountOverviewBtn) {
    accountOverviewBtn.addEventListener('click', async (event) => {
      event.preventDefault();
      event.stopPropagation();
      await openAccountModal();
    });
  }

  if (passwordSettingsBtn) {
    passwordSettingsBtn.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      closeProfileMenu();
      window.location.href = '/reset-password.html';
    });
  }

  if (accountCloseBtn) {
    accountCloseBtn.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      closeAccountModal();
    });
  }

  if (accountModal) {
    accountModal.addEventListener('click', (event) => {
      if (event.target === accountModal) closeAccountModal();
    });
  }

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeAccountModal();
  });

  if (accountEmailCopyBtn) {
    accountEmailCopyBtn.addEventListener('click', async (event) => {
      event.preventDefault();
      const value = accountEmailDisplay?.textContent?.trim();
      if (!value) return;
      try {
        await navigator.clipboard.writeText(value);
      } catch (_) {}
    });
  }

  if (accountPasswordManageBtn) {
    accountPasswordManageBtn.addEventListener('click', (event) => {
      event.preventDefault();
      window.location.href = '/reset-password.html';
    });
  }
}

async function handleManageBilling(event) {
  event.preventDefault();
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

  if (profileInitial && currentUserEmail) {
    const initial = currentUserEmail.trim().charAt(0) || 'P';
    profileInitial.textContent = initial.toUpperCase();
  }

  try {
    const userIsPro = currentUserEmail ? await isPro(currentUserEmail) : false;
    if (userTierBadge) {
      userTierBadge.textContent = 'PRO';
      userTierBadge.style.display = userIsPro ? 'inline-block' : 'none';
    }
    if (manageBillingBtn) {
      manageBillingBtn.style.display = userIsPro ? 'inline-block' : 'none';
      if (userIsPro && !manageBillingBtn.dataset.bound) {
        manageBillingBtn.dataset.bound = '1';
        manageBillingBtn.addEventListener('click', handleManageBilling);
      }
    }
  } catch (_) {}
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
