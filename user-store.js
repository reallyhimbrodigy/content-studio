// Supabase-powered user & calendar storage (replaces localStorage)
import { supabase } from './supabase-client.js';

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
        return { ok: false, code: 'USER_EXISTS', msg: 'An account already exists for this email. Please sign in.' };
      }
      throw error;
    }
    
    // Check if email confirmation is required
    if (data?.user && !data.session) {
      return { ok: true, msg: "Check your email to confirm your account!" };
    }
    
    // Profile is automatically created via database trigger
    return { ok: true, msg: "Signed up successfully!" };
  } catch (error) {
    console.error('signUp error:', error);
    const msg = String(error?.message || '').toLowerCase();
    if (msg.includes('already') || msg.includes('exists') || msg.includes('registered')) {
      return { ok: false, code: 'USER_EXISTS', msg: 'An account already exists for this email. Please sign in.' };
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
  } catch (error) {
    console.error('signOut error:', error);
  }
}

// ============================================================================
// User Profile & Tier Management
// ============================================================================

export async function getUserTier(email) {
  try {
    const userId = await getCurrentUserId();
    console.log('getUserTier - userId:', userId);
    if (!userId) return 'free';
    
    const { data, error } = await supabase
      .from('profiles')
      .select('tier')
      .eq('id', userId)
      .single();
    
    console.log('getUserTier - data:', data, 'error:', error);
    if (error) throw error;
    const tier = data?.tier || 'free';
    console.log('getUserTier - returning tier:', tier);
    return tier;
  } catch (error) {
    console.error('getUserTier error:', error);
    return 'free';
  }
}

export async function setUserTier(email, tier) {
  try {
    const userId = await getCurrentUserId();
    if (!userId) throw new Error('No user logged in');
    
    const { error } = await supabase
      .from('profiles')
      .update({ tier, updated_at: new Date().toISOString() })
      .eq('id', userId);
    
    if (error) throw error;
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
