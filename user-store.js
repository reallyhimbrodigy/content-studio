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

export async function getCurrentUserDetails() {
  try {
    const { data: { user }, error } = await supabase.auth.getUser();
    if (error) throw error;
    return user || null;
  } catch (error) {
    console.error('getCurrentUserDetails error:', error);
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
