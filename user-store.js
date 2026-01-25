// Supabase-powered user & calendar storage (replaces localStorage)
import { supabase } from './supabase-client.js';
export { supabase };

const DEBUG =
  typeof window !== 'undefined' &&
  ['localhost', '127.0.0.1'].includes(window.location?.hostname || '');

const PROFILE_SETTINGS_COLUMN_FLAG_KEY = 'promptly_profile_settings_column_missing';
const PROFILE_SETTINGS_COLUMN_FLAG_TTL = 12 * 60 * 60 * 1000; // 12 hours
let profileSettingsColumnMissing = false;
let profileSettingsSyncDisabled = false;
try {
  const raw = localStorage.getItem(PROFILE_SETTINGS_COLUMN_FLAG_KEY);
  if (raw) {
    const parsed = JSON.parse(raw);
    if (parsed && parsed.timestamp && Date.now() - Number(parsed.timestamp) < PROFILE_SETTINGS_COLUMN_FLAG_TTL) {
      profileSettingsColumnMissing = true;
    } else {
      localStorage.removeItem(PROFILE_SETTINGS_COLUMN_FLAG_KEY);
    }
  }
} catch (_err) {
  // Ignore storage access issues (e.g., Safari private mode)
}

function isAuthSessionMissingError(error) {
  if (!error) return false;
  if (error.name === 'AuthSessionMissingError') return true;
  const msg = String(error.message || '').toLowerCase();
  return msg.includes('auth session missing');
}

function isAuthFetchError(error) {
  if (!error) return false;
  const name = String(error.name || '').toLowerCase();
  const msg = String(error.message || '').toLowerCase();
  return (
    name.includes('authretryablefetcherror') ||
    msg.includes('failed to fetch') ||
    msg.includes('err_socket_not_connected') ||
    msg.includes('err_timed_out') ||
    msg.includes('timed out') ||
    msg.includes('timeout') ||
    msg.includes('fetch')
  );
}

function isAuthAbortError(error) {
  if (!error) return false;
  const name = String(error.name || '').toLowerCase();
  const msg = String(error.message || '').toLowerCase();
  return name.includes('aborterror') || msg.includes('aborted');
}

let inflightAuthUserPromise = null; // Single-flight to prevent parallel auth fetches.
let lastKnownUserTier = null; // Preserve tier when auth is temporarily unresolved.
let inflightTierPromise = null;
let userTierResolved = false;

export const userStore = {
  tier: 'free',
};

async function fetchAuthUserSingleFlight() {
  if (inflightAuthUserPromise) return inflightAuthUserPromise;
  inflightAuthUserPromise = (async () => {
    const { data: { session }, error: sessionError } = await supabase.auth.getSession();
    if (sessionError) throw sessionError;
    if (!session) return null; // Avoid unnecessary /auth/v1/user when clearly logged out.
    if (session?.user) return session.user;
    const { data: { user }, error: userError } = await supabase.auth.getUser();
    if (userError) throw userError;
    return user || null;
  })();
  try {
    return await inflightAuthUserPromise;
  } finally {
    inflightAuthUserPromise = null;
  }
}

function markProfileSettingsColumnMissing() {
  profileSettingsColumnMissing = true;
  try {
    localStorage.setItem(
      PROFILE_SETTINGS_COLUMN_FLAG_KEY,
      JSON.stringify({ timestamp: Date.now() })
    );
  } catch (_err) {
    // Ignore storage failures
  }
}

function isProfileSettingsColumnMissing(error) {
  if (!error) return false;
  if (profileSettingsColumnMissing) return true;
  const code = String(error.code || '');
  const msg = String(error.message || '').toLowerCase();
  if (code === '42703' || msg.includes('profile_settings')) {
    markProfileSettingsColumnMissing();
    if (DEBUG) {
      console.warn('Supabase profiles.profile_settings column is missing. Apply the latest schema migration to enable synced profile preferences.');
    }
    return true;
  }
  return false;
}

async function getSupabaseAccessToken() {
  const { data: { session }, error } = await supabase.auth.getSession();
  if (error) throw error;
  return session?.access_token || null;
}

async function fetchJsonWithAuth(path, options = {}) {
  const token = await getSupabaseAccessToken();
  if (!token) {
    const err = new Error('Unauthorized');
    err.status = 401;
    throw err;
  }
  const headers = new Headers(options.headers || {});
  if (options.body && !(options.body instanceof FormData) && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }
  headers.set('Authorization', `Bearer ${token}`);
  const response = await fetch(path, { ...options, headers });
  let data = {};
  try {
    data = await response.json();
  } catch (_err) {
    data = {};
  }
  return { response, data };
}

function normalizeTierLabel(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return 'free';
  if (raw === 'paid' || raw === 'premium') return 'pro';
  return raw;
}

let authTierSyncBound = false;

// ============================================================================
// Authentication
// ============================================================================

export async function getCurrentUser() {
  try {
    const user = await fetchAuthUserSingleFlight();
    return user?.email || null;
  } catch (error) {
    if (isAuthAbortError(error)) {
      console.warn('getCurrentUser aborted (unexpected):', error);
      return null;
    }
    if (isAuthFetchError(error)) {
      console.warn('getCurrentUser network error:', error);
      return null;
    }
    if (!isAuthSessionMissingError(error)) {
      console.error('getCurrentUser error:', error);
    }
    return null;
  }
}

export async function getCurrentUserDetails() {
  try {
    const user = await fetchAuthUserSingleFlight();
    return user || null;
  } catch (error) {
    if (isAuthAbortError(error)) {
      console.warn('getCurrentUserDetails aborted (unexpected):', error);
      return null;
    }
    if (isAuthFetchError(error)) {
      console.warn('getCurrentUserDetails network error:', error);
      return null;
    }
    if (!isAuthSessionMissingError(error)) {
      console.error('getCurrentUserDetails error:', error);
    }
    return null;
  }
}

export async function getCurrentUserId() {
  try {
    const user = await fetchAuthUserSingleFlight();
    if (user?.id) {
      return user.id;
    }
    console.info('getCurrentUserId no active session');
    return null;
  } catch (error) {
    if (isAuthAbortError(error)) {
      console.warn('getCurrentUserId aborted by local signal (unexpected):', error);
      throw error;
    }
    if (isAuthFetchError(error)) {
      console.warn('getCurrentUserId network error:', error);
      throw error;
    }
    if (!isAuthSessionMissingError(error)) {
      console.error('getCurrentUserId error:', error);
      throw error;
    }
    console.info('getCurrentUserId no active session');
    return null;
  }
}

export async function signUp(email, password) {
  try {
    // Check if user is already logged in
    const { data: { session } } = await supabase.auth.getSession();
    if (session) {
      // User is already logged in - check if it's the same email
      const currentEmail = session.user?.email;
      if (currentEmail && currentEmail.toLowerCase() === email.toLowerCase()) {
        return { ok: false, code: 'USER_EXISTS', msg: 'You are already signed in with this account.' };
      } else {
        return { ok: false, code: 'USER_EXISTS', msg: 'Please sign out of your current account first.' };
      }
    }
    
    const { data, error } = await supabase.auth.signUp({
      email,
      password,
      options: {
        // Skip email confirmation for development
        emailRedirectTo: window.location.origin,
      }
    });
    
    if (error) {
      const msg = String(error.message || '').toLowerCase();
      // Normalize common "already exists" cases from Supabase/Auth
      const alreadyExists = msg.includes('already') || msg.includes('exists') || msg.includes('registered');
      if (alreadyExists) {
        return { ok: false, code: 'USER_EXISTS', msg: 'This email is already registered. Sign in now!' };
      }
      throw error;
    }
    
    // Supabase often returns success for existing users (with no session) to prevent email enumeration
    // We need to detect this case and treat it as "user exists"
    if (data?.user && !data.session) {
      // Check if this is actually an existing user by examining the user object
      // Supabase returns identities array only for existing users in some configs
      const hasIdentities = data.user.identities && data.user.identities.length > 0;
      
      // If no identities, it's likely an existing user (Supabase security feature)
      if (!hasIdentities) {
        return { ok: false, code: 'USER_EXISTS', msg: 'This email is already registered. Sign in now!' };
      }
      
      // Otherwise, email confirmation is genuinely required
      return { ok: true, msg: "Check your email to confirm your account!" };
    }
    
    // Profile is automatically created via database trigger
    return { ok: true, msg: "Signed up successfully!" };
  } catch (error) {
    console.error('signUp error:', error);
    const msg = String(error?.message || '').toLowerCase();
    if (msg.includes('already') || msg.includes('exists') || msg.includes('registered')) {
      return { ok: false, code: 'USER_EXISTS', msg: 'This email is already registered. Sign in now!' };
    }
    return { ok: false, msg: error?.message || "Sign up failed" };
  }
}

export async function signIn(email, password) {
  try {
    const { data, error } = await supabase.auth.signInWithPassword({
      email,
      password,
    });
    
    if (error) throw error;
    
    return { ok: true, msg: "Signed in successfully" };
  } catch (error) {
    console.error('signIn error:', error);
    return { ok: false, msg: error.message || "Sign in failed" };
  }
}

export async function signOut() {
  try {
    const { error } = await supabase.auth.signOut();
    if (error) throw error;
    lastKnownUserTier = null;
    userStore.tier = 'free';
    userTierResolved = false;
  } catch (error) {
    console.error('signOut error:', error);
  }
}

export async function resetPassword(email) {
  try {
    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: `${window.location.origin}/reset-password.html`,
    });
    if (error) throw error;
    return { ok: true, msg: 'Password reset email sent. Check your inbox.' };
  } catch (error) {
    console.error('resetPassword error:', error);
    return { ok: false, msg: error.message || 'Failed to send reset email' };
  }
}

// ============================================================================
// User Profile & Tier Management
// ============================================================================

function applyResolvedTier(tier) {
  const normalized = normalizeTierLabel(tier);
  userStore.tier = normalized;
  lastKnownUserTier = normalized;
  userTierResolved = true;
  return normalized;
}

export async function refreshUserTier({ force = false } = {}) {
  if (userTierResolved && !force) {
    return { ok: true, tier: userStore.tier, cached: true };
  }
  if (inflightTierPromise) return inflightTierPromise;
  inflightTierPromise = (async () => {
    try {
      const { response, data } = await fetchJsonWithAuth('/api/entitlements', { method: 'GET' });
      if (!response.ok || data?.ok === false) {
        if (response.status === 503 && data?.error === 'ENTITLEMENTS_UNAVAILABLE') {
          return { ok: false, unavailable: true, error: data?.error };
        }
        return { ok: false, error: data?.error || 'tier_fetch_failed' };
      }
      const tier = applyResolvedTier(data?.tier || 'free');
      return { ok: true, tier };
    } catch (error) {
      if (!isAuthSessionMissingError(error) && !isAuthFetchError(error)) {
        console.warn('refreshUserTier error:', error);
      }
      return { ok: false, error };
    } finally {
      inflightTierPromise = null;
    }
  })();
  return inflightTierPromise;
}

export async function getUserTier(_email) {
  if (lastKnownUserTier && userStore.tier !== lastKnownUserTier) {
    userStore.tier = lastKnownUserTier;
  }
  if (userTierResolved) {
    return userStore.tier;
  }
  const result = await refreshUserTier();
  if (result?.ok) {
    return userStore.tier;
  }
  return userStore.tier;
}

export async function setUserTier(email, tier) {
  try {
    const normalized = normalizeTierLabel(tier);
    const { response, data } = await fetchJsonWithAuth('/api/user/subscription', {
      method: 'POST',
      body: JSON.stringify({ tier: normalized }),
    });
    if (!response.ok || data?.ok === false) {
      return { ok: false, msg: data?.error || 'Failed to update plan' };
    }
    const resolved = normalizeTierLabel(data?.plan || data?.tier || normalized);
    return { ok: true, tier: resolved };
  } catch (error) {
    if (!isAuthSessionMissingError(error) && !isAuthFetchError(error)) {
      console.warn('setUserTier error:', error);
    }
    return { ok: false, msg: error.message };
  }
}

export async function isPro(email) {
  const tier = await getUserTier(email);
  return tier === 'pro';
}

if (typeof window !== 'undefined' && supabase?.auth?.onAuthStateChange && !authTierSyncBound) {
  authTierSyncBound = true;
  supabase.auth.onAuthStateChange((_event, session) => {
    if (session?.access_token) {
      refreshUserTier({ force: true });
      return;
    }
    lastKnownUserTier = null;
    userStore.tier = 'free';
    userTierResolved = false;
  });
}

export async function getProfilePreferences() {
  if (profileSettingsColumnMissing || profileSettingsSyncDisabled) return {};
  try {
    const { response, data } = await fetchJsonWithAuth('/api/profile/settings', { method: 'GET' });
    if (!response.ok || data?.ok === false) {
      if (response.status === 401) return {};
      if (response.status === 503 && data?.error === 'PROFILE_SETTINGS_SCHEMA_MISSING') {
        profileSettingsSyncDisabled = true;
        markProfileSettingsColumnMissing();
        return {};
      }
      return {};
    }
    const settings = data?.settings;
    if (!settings || typeof settings !== 'object') return {};
    return settings;
  } catch (error) {
    if (!isProfileSettingsColumnMissing(error)) {
      if (!isAuthSessionMissingError(error) && !isAuthFetchError(error)) {
        console.warn('getProfilePreferences error:', error);
      }
    }
    return {};
  }
}

export async function saveProfilePreferences(settings = {}) {
  if (profileSettingsColumnMissing || profileSettingsSyncDisabled) {
    return settings && typeof settings === 'object' ? settings : {};
  }
  try {
    const safeSettings = settings && typeof settings === 'object' ? settings : {};
    const { response, data } = await fetchJsonWithAuth('/api/profile/settings', {
      method: 'POST',
      body: JSON.stringify({ patch: safeSettings }),
    });
    if (!response.ok || data?.ok === false) {
      if (response.status === 401) return safeSettings;
      if (response.status === 503 && data?.error === 'PROFILE_SETTINGS_SCHEMA_MISSING') {
        profileSettingsSyncDisabled = true;
        markProfileSettingsColumnMissing();
        return safeSettings;
      }
      throw new Error(data?.error || 'profile_settings_update_failed');
    }
    return data?.settings || safeSettings;
  } catch (error) {
    if (isProfileSettingsColumnMissing(error)) {
      return settings && typeof settings === 'object' ? settings : {};
    }
    if (!isAuthSessionMissingError(error) && !isAuthFetchError(error)) {
      console.warn('saveProfilePreferences error:', error);
    }
    throw error;
  }
}

// ============================================================================
// Calendar Management
// ============================================================================

export async function getUserCalendars(email) {
  try {
    const userId = await getCurrentUserId();
    if (!userId) return [];
    
    const { data, error } = await supabase
      .from('calendars')
      .select('*')
      .eq('user_id', userId)
      .order('saved_at', { ascending: false });
    
    if (error) throw error;
    return data || [];
  } catch (error) {
    console.error('getUserCalendars error:', error);
    return [];
  }
}

export async function saveUserCalendar(email, calendar) {
  try {
    const userId = await getCurrentUserId();
    if (!userId) throw new Error('No user logged in');
    
    const { data, error } = await supabase
      .from('calendars')
      .insert({
        user_id: userId,
        niche_style: calendar.nicheStyle || calendar.niche || 'Untitled',
        posts: calendar.posts || calendar,
        saved_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .select()
      .single();
    
    if (error) throw error;
    return data;
  } catch (error) {
    console.error('saveUserCalendar error:', error);
    throw error;
  }
}

export async function deleteUserCalendar(calendarId) {
  try {
    const userId = await getCurrentUserId();
    if (!userId) throw new Error('No user logged in');
    
    const { error } = await supabase
      .from('calendars')
      .delete()
      .eq('id', calendarId)
      .eq('user_id', userId); // Extra security check
    
    if (error) throw error;
    return { ok: true };
  } catch (error) {
    console.error('deleteUserCalendar error:', error);
    return { ok: false, msg: error.message };
  }
}

// ============================================================================
// Legacy compatibility helpers (for gradual migration)
// ============================================================================

// For now, keep a synchronous fallback that returns null if not loaded
export function getCurrentUserSync() {
  // This will only work if auth state is already loaded
  console.warn('getCurrentUserSync is deprecated, use getCurrentUser() instead');
  return null;
}

export function getAllUsers() {
  console.warn('getAllUsers is not supported with Supabase');
  return {};
}

export function setCurrentUser(email) {
  console.warn('setCurrentUser is not needed with Supabase (handled automatically)');
}
