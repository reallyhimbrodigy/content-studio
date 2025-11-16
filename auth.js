import { signUp, signIn, getCurrentUser } from './user-store.js';

// Auth modal UI bindings. Storage helpers are provided by `user-store.js`.
const emailInput = document.getElementById("email");
  const passwordInput = document.getElementById("password");
  const authBtn = document.getElementById("auth-btn");
  const toggleBtn = document.getElementById("toggle-mode");
  const authForm = document.getElementById("auth-form");
  const authFeedbackEl = document.getElementById("auth-feedback");
  const pwToggle = document.getElementById("toggle-password-visibility");

  let isSignUp = true;

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
        if (authBtn) authBtn.textContent = isSignUp ? "Sign Up" : "Sign In";
        toggleBtn.textContent = isSignUp ? "Sign In" : "Sign Up";
        if (authFeedbackEl) authFeedbackEl.textContent = "";
      });
    } else {
      console.warn('auth.js: toggle button not found');
    }

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

        const result = isSignUp ? signUp(email, password) : signIn(email, password);
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

// If user is already logged in, redirect to app
if (getCurrentUser()) {
  // If we're on auth page, redirect. On other pages this will noop.
  if (window.location.pathname !== '/') {
    window.location.href = "/";
  }
}
