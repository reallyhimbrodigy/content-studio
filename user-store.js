// Minimal auth module for the web sign-in pages (auth.js, reset-password.js).
//
// Restored 2026-07-13. The original 610-line user-store.js was deleted in b8888e8
// ("Remove web editor/library — mobile-only app") along with theme.js, which
// orphaned the web auth pages' ES-module imports: they 404'd, so auth.js never
// executed and the /review sign-in form showed the HTML-default "Sign Up" with
// dead handlers (the reported bug). This restores exactly the exports auth.js +
// reset-password.js consume, built on the current supabase-client.js, with the
// ORIGINAL return shapes preserved ({ ok, code, msg }) so auth.js works as written.
// The 600+ lines of web-editor-only helpers (calendars, edits, tiers) are NOT
// resurrected — the app is mobile-only; the web surface is just sign-in + /review.

import { supabase } from './supabase-client.js';

export { supabase };

/** Current signed-in user's email, or null. */
export async function getCurrentUser() {
  try {
    const { data, error } = await supabase.auth.getUser();
    if (error) return null;
    return data?.user?.email || null;
  } catch (error) {
    console.warn('getCurrentUser error:', error?.message || error);
    return null;
  }
}

export async function signUp(email, password) {
  try {
    // Already signed in? Treat as "exists" so the UI flips to Sign In.
    const { data: { session } } = await supabase.auth.getSession();
    if (session) {
      const currentEmail = session.user?.email;
      if (currentEmail && currentEmail.toLowerCase() === email.toLowerCase()) {
        return { ok: false, code: 'USER_EXISTS', msg: 'You are already signed in with this account.' };
      }
      return { ok: false, code: 'USER_EXISTS', msg: 'Please sign out of your current account first.' };
    }

    const { data, error } = await supabase.auth.signUp({
      email,
      password,
      options: { emailRedirectTo: window.location.origin },
    });

    if (error) {
      const msg = String(error.message || '').toLowerCase();
      if (msg.includes('already') || msg.includes('exists') || msg.includes('registered')) {
        return { ok: false, code: 'USER_EXISTS', msg: 'This email is already registered. Sign in now!' };
      }
      throw error;
    }

    // Supabase returns a user with no session (and no identities) for an existing
    // email, to prevent enumeration — detect that and treat it as "exists".
    if (data?.user && !data.session) {
      const hasIdentities = data.user.identities && data.user.identities.length > 0;
      if (!hasIdentities) {
        return { ok: false, code: 'USER_EXISTS', msg: 'This email is already registered. Sign in now!' };
      }
      return { ok: true, msg: 'Check your email to confirm your account!' };
    }

    return { ok: true, msg: 'Signed up successfully!' };
  } catch (error) {
    console.error('signUp error:', error);
    const msg = String(error?.message || '').toLowerCase();
    if (msg.includes('already') || msg.includes('exists') || msg.includes('registered')) {
      return { ok: false, code: 'USER_EXISTS', msg: 'This email is already registered. Sign in now!' };
    }
    return { ok: false, msg: error?.message || 'Sign up failed' };
  }
}

export async function signIn(email, password) {
  try {
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) throw error;
    return { ok: true, msg: 'Signed in successfully' };
  } catch (error) {
    console.error('signIn error:', error);
    return { ok: false, msg: error.message || 'Sign in failed' };
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
