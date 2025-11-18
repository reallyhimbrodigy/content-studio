import { signUp, signIn, getCurrentUser, signOut } from './user-store.js';

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

  const applyModeUI = () => {
    if (authBtn) authBtn.textContent = isSignUp ? 'Sign Up' : 'Sign In';
    if (toggleBtn) toggleBtn.textContent = isSignUp ? 'Sign In' : 'Sign Up';
    if (authFeedbackEl) authFeedbackEl.textContent = '';
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
        if (authBtn) authBtn.textContent = "...";
        
        const result = isSignUp ? await signUp(email, password) : await signIn(email, password);
        
        // Restore button text
        if (authBtn) authBtn.textContent = isSignUp ? "Sign Up" : "Sign In";
        
        // Handle "user already exists" by flipping to Sign In mode automatically
        if (!result.ok && result.code === 'USER_EXISTS') {
          if (authFeedbackEl) {
            authFeedbackEl.textContent = 'An account already exists for this email. Redirecting to Sign In…';
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
          setTimeout(() => {
            window.location.href = "/";
          }, 1000);
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
  }
