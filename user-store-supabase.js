// Supabase-powered user & calendar storage (replaces localStorage)
import { supabase } from './supabase-client.js';

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

// ============================================================================
// Authentication
// ============================================================================

export async function getCurrentUser() {
  try {
    const { data: { user }, error } = await supabase.auth.getUser();
    if (error) throw error;
    return user?.email || null;
  } catch (error) {
    console.error('getCurrentUser error:', error);
    return null;
  }
}

export async function getCurrentUserId() {
  try {
    const { data: { user }, error } = await supabase.auth.getUser();
    if (error) throw error;
    return user?.id || null;
  } catch (error) {
    console.error('getCurrentUserId error:', error);
    return null;
  }
}

export async function signUp(email, password) {
  try {
    const { data, error } = await supabase.auth.signUp({
      email,
      password,
    });
    
    if (error) throw error;
    
    // Profile is automatically created via database trigger
    return { ok: true, msg: "Signed up successfully! Check your email to confirm." };
  } catch (error) {
    console.error('signUp error:', error);
    return { ok: false, msg: error.message || "Sign up failed" };
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
  } catch (error) {
    console.error('signOut error:', error);
  }
}

// ============================================================================
// User Profile & Tier Management
// ============================================================================

export async function getUserTier(email) {
  try {
    const { response, data } = await fetchJsonWithAuth('/api/user/subscription', { method: 'GET' });
    if (!response.ok || data?.ok === false) return 'free';
    return normalizeTierLabel(data?.plan || data?.tier || 'free');
  } catch (error) {
    console.error('getUserTier error:', error);
    return 'free';
  }
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
    return { ok: true };
  } catch (error) {
    console.error('setUserTier error:', error);
    return { ok: false, msg: error.message };
  }
}

export async function isPro(email) {
  const tier = await getUserTier(email);
  return tier === 'pro';
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

export async function getUserEdits(userId) {
  try {
    const resolvedUserId = userId || await getCurrentUserId();
    if (!resolvedUserId) return [];

    const { data, error } = await supabase
      .from('video_jobs')
      .select('id, status, vibe_input, result_url, edit_recipe, created_at, completed_at, error_message')
      .eq('user_id', resolvedUserId)
      .in('status', ['completed', 'processing', 'queued', 'failed'])
      .order('created_at', { ascending: false });

    if (error) throw error;
    return data || [];
  } catch (error) {
    console.error('getUserEdits error:', error);
    return [];
  }
}

export async function deleteUserEdit(editId) {
  try {
    const userId = await getCurrentUserId();
    if (!userId) throw new Error('No user logged in');

    const { error } = await supabase
      .from('video_jobs')
      .delete()
      .eq('id', editId)
      .eq('user_id', userId);

    if (error) throw error;
    return true;
  } catch (error) {
    console.error('deleteUserEdit error:', error);
    return false;
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
