import { signUp, signIn, getCurrentUser, signOut, resetPassword } from './user-store.js';
import { initTheme } from './theme.js';

// Apply theme on page load
initTheme();

// Handle sign-out redirect (e.g., /auth.html?signout=1)
(async () => {
  try {
    const params = new URLSearchParams(window.location.search || '');
    if (params.get('signout') === '1') {
      // Clear session (now async with Supabase)
      await signOut();
      // Also clear legacy key if any lingering
      try { localStorage.removeItem('promptly_current_user'); } catch {}
      // Remove the query param from the URL without reloading
      const url = new URL(window.location.href);
      url.searchParams.delete('signout');
      window.history.replaceState({}, '', url.pathname + (url.search ? '?' + url.search : ''));
    }
  } catch (e) {
    console.warn('auth.js: signout query handling failed', e);
  }
})();

// Auth modal UI bindings. Storage helpers are provided by `user-store.js`.
const emailInput = document.getElementById("email");
  const passwordInput = document.getElementById("password");
  const authBtn = document.getElementById("auth-btn");
  const toggleBtn = document.getElementById("toggle-mode");
  const authForm = document.getElementById("auth-form");
  const authFeedbackEl = document.getElementById("auth-feedback");
  const pwToggle = document.getElementById("toggle-password-visibility");

  let isSignUp = true;

  // Initialize mode from URL (?mode=login|signup)
  try {
    const params = new URLSearchParams(window.location.search || '');
    const mode = (params.get('mode') || '').toLowerCase();
    if (mode === 'login') isSignUp = false;
    if (mode === 'signup') isSignUp = true;
  } catch {}

  const forgotPasswordLink = document.getElementById('forgot-password-link');
  const forgotPasswordBtn = document.getElementById('forgot-password-btn');
  const termsAgreement = document.getElementById('terms-agreement');
  const passwordStrength = document.getElementById('password-strength');
  const authBtnText = document.getElementById('auth-btn-text');
  const authBtnSpinner = document.getElementById('auth-btn-spinner');
  const googleAuthBtn = document.getElementById('google-auth-btn');

  // Password strength checker
  const checkPasswordStrength = (password) => {
    let strength = 0;
    if (password.length >= 6) strength++;
    if (password.length >= 10) strength++;
    if (/[a-z]/.test(password) && /[A-Z]/.test(password)) strength++;
    if (/[0-9]/.test(password) && /[^a-zA-Z0-9]/.test(password)) strength++;
    
    return strength; // 0-4
  };

  const updatePasswordStrength = () => {
    if (!isSignUp || !passwordInput || !passwordStrength) return;
    
    const password = passwordInput.value;
    const strength = checkPasswordStrength(password);
    
    const bars = [
      document.getElementById('strength-bar-1'),
      document.getElementById('strength-bar-2'),
      document.getElementById('strength-bar-3'),
      document.getElementById('strength-bar-4')
    ];
    
    const strengthText = document.getElementById('strength-text');
    
    // Reset all bars
    bars.forEach(bar => bar.style.background = 'rgba(255, 255, 255, 0.1)');
    
    if (password.length === 0) {
      strengthText.textContent = '';
      return;
    }
    
    const colors = ['#ff7878', '#ffb347', '#ffd93d', '#6bcf7f'];
    const labels = ['Weak password', 'Fair password', 'Good password', 'Strong password'];
    
    for (let i = 0; i < strength; i++) {
      bars[i].style.background = colors[strength - 1];
    }
    
    strengthText.textContent = labels[strength - 1] || 'Too short';
    strengthText.style.color = colors[strength - 1] || '#ff7878';
  };

  const applyModeUI = () => {
    if (authBtnText) authBtnText.textContent = isSignUp ? 'Sign Up' : 'Sign In';
    if (toggleBtn) toggleBtn.textContent = isSignUp ? 'Sign In' : 'Sign Up';
    if (authFeedbackEl) authFeedbackEl.textContent = '';
    // Show "Forgot password?" only in Sign In mode
    if (forgotPasswordLink) forgotPasswordLink.style.display = isSignUp ? 'none' : 'block';
    // Show terms agreement and password strength only in Sign Up mode
    if (termsAgreement) termsAgreement.style.display = isSignUp ? 'block' : 'none';
    if (passwordStrength) passwordStrength.style.display = isSignUp ? 'block' : 'none';
    if (isSignUp && passwordInput) updatePasswordStrength();
  };

  // If this script is loaded on a page without the auth form (e.g., index.html),
  // skip binding to avoid errors.
  if (!authForm) {
    // nothing to do on non-auth pages
    console.log('auth.js: auth form not present on this page — skipping auth bindings');
  } else {
    // Guard element existence before attaching listeners
    if (toggleBtn) {
      toggleBtn.addEventListener("click", (e) => {
        e.preventDefault();
        isSignUp = !isSignUp;
        applyModeUI();
      });
    } else {
      console.warn('auth.js: toggle button not found');
    }

    // Apply initial mode UI
    applyModeUI();

    if (authForm) {
      authForm.addEventListener("submit", async (e) => {
        e.preventDefault();
        const email = emailInput ? emailInput.value.trim() : "";
        const password = passwordInput ? passwordInput.value.trim() : "";

        if (!email || !password) {
          if (authFeedbackEl) {
            authFeedbackEl.textContent = "Please fill in all fields";
            authFeedbackEl.className = "error";
          }
          return;
        }

        // Show loading state
        if (authBtnText) authBtnText.style.display = 'none';
        if (authBtnSpinner) authBtnSpinner.style.display = 'inline-block';
        if (authBtn) authBtn.disabled = true;
        
        const result = isSignUp ? await signUp(email, password) : await signIn(email, password);
        
        // Restore button text
        if (authBtnText) {
          authBtnText.style.display = 'inline';
          authBtnText.textContent = isSignUp ? 'Sign Up' : 'Sign In';
        }
        if (authBtnSpinner) authBtnSpinner.style.display = 'none';
        if (authBtn) authBtn.disabled = false;
        
        // Handle "user already exists" by flipping to Sign In mode automatically
        if (!result.ok && result.code === 'USER_EXISTS') {
          if (authFeedbackEl) {
            authFeedbackEl.textContent = result.msg; // Use the message from signUp
            authFeedbackEl.className = 'error';
          }
          // Switch UI to Sign In and keep the email filled in
          isSignUp = false;
          applyModeUI();
          // Focus password for a quicker sign-in
          if (passwordInput) passwordInput.focus();
          // Optionally update URL to reflect mode
          try {
            const url = new URL(window.location.href);
            url.searchParams.set('mode', 'login');
            window.history.replaceState({}, '', url.pathname + '?' + url.searchParams.toString());
          } catch {}
          return;
        }

        if (authFeedbackEl) {
          authFeedbackEl.textContent = result.msg;
          authFeedbackEl.className = result.ok ? "success" : "error";
        }

        if (result.ok) {
          // Verify session is established before redirecting
          const verifyAndRedirect = async () => {
            try {
              const user = await getCurrentUser();
              if (user) {
                window.location.href = "/";
              } else {
                // Session not ready yet, try again
                setTimeout(verifyAndRedirect, 300);
              }
            } catch (err) {
              console.error('Session verification error:', err);
              setTimeout(verifyAndRedirect, 300);
            }
          };
          // Start verification after a brief delay
          setTimeout(verifyAndRedirect, 500);
        }
      });
    }

    // Password visibility toggle
    if (pwToggle && passwordInput) {
      pwToggle.addEventListener('click', () => {
        const isHidden = passwordInput.type === 'password';
        passwordInput.type = isHidden ? 'text' : 'password';
        pwToggle.setAttribute('aria-pressed', String(isHidden));
        pwToggle.setAttribute('aria-label', isHidden ? 'Hide password' : 'Show password');
      });
    }

    // Password strength checker (only during sign up)
    if (passwordInput) {
      passwordInput.addEventListener('input', updatePasswordStrength);
    }

    // Google OAuth
    if (googleAuthBtn) {
      googleAuthBtn.addEventListener('click', async () => {
        try {
          const { getSupabaseClient } = await import('./supabase-client.js');
          const supabase = await getSupabaseClient();
          
          const { error } = await supabase.auth.signInWithOAuth({
            provider: 'google',
            options: {
              redirectTo: `${window.location.origin}/`
            }
          });
          
          if (error) {
            console.error('Google auth error:', error);
            if (authFeedbackEl) {
              authFeedbackEl.textContent = 'Failed to sign in with Google';
              authFeedbackEl.className = 'error';
            }
          }
        } catch (err) {
          console.error('Google auth setup error:', err);
          if (authFeedbackEl) {
            authFeedbackEl.textContent = 'Failed to initialize Google sign-in';
            authFeedbackEl.className = 'error';
          }
        }
      });
    }

    // Forgot password handler
    if (forgotPasswordBtn) {
      forgotPasswordBtn.addEventListener('click', async (e) => {
        e.preventDefault();
        const email = emailInput ? emailInput.value.trim() : '';
        if (!email) {
          if (authFeedbackEl) {
            authFeedbackEl.textContent = 'Please enter your email first';
            authFeedbackEl.className = 'error';
          }
          return;
        }
        if (forgotPasswordBtn) forgotPasswordBtn.textContent = '...';
        const result = await resetPassword(email);
        if (forgotPasswordBtn) forgotPasswordBtn.textContent = 'Forgot password?';
        if (authFeedbackEl) {
          authFeedbackEl.textContent = result.msg;
          authFeedbackEl.className = result.ok ? 'success' : 'error';
        }
      });
    }
  }
