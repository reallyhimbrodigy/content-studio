import { signUp, signIn, getCurrentUser, signOut, resetPassword, supabase } from './user-store.js';
import { initTheme } from './theme.js';

// Apply theme on page load
initTheme();

const isProdHost = () => {
  const host = window.location.hostname;
  return window.location.protocol === 'https:' && (host === 'usepromptly.app' || host === 'www.usepromptly.app');
};

const analyticsEnabled = isProdHost();
const analyticsDebug =
  analyticsEnabled &&
  new URLSearchParams(window.location.search || '').get('analytics_debug') === '1';

const getAnalyticsPath = () => `${window.location.pathname}${window.location.search}${window.location.hash || ''}`;

const emitAnalytics = window.emitPromptlyAnalytics || ((eventName, payload = {}) => {
  if (!analyticsEnabled) return;
  const detail = {
    event: eventName,
    path: getAnalyticsPath(),
    title: document.title,
    ...payload,
    ts: Date.now(),
  };
  window.dispatchEvent(new CustomEvent('promptly_analytics', { detail }));
  if (analyticsDebug) console.info('[PromptlyAnalytics]', eventName, detail);
});

window.emitPromptlyAnalytics = emitAnalytics;

const initAnalyticsPageviews = () => {
  if (!analyticsEnabled || window.__promptlyAnalyticsPageviews) return;
  window.__promptlyAnalyticsPageviews = true;
  let lastPath = getAnalyticsPath();
  emitAnalytics('pageview', { path: lastPath, title: document.title, referrer: document.referrer || '' });
  const handleRouteChange = () => {
    const nextPath = getAnalyticsPath();
    if (nextPath === lastPath) return;
    const referrer = lastPath;
    lastPath = nextPath;
    emitAnalytics('virtual_pageview', { path: nextPath, title: document.title, referrer });
  };
  const wrapHistory = (method) => {
    if (!history[method] || history[method].__promptlyWrapped) return;
    const original = history[method];
    const wrapped = function (...args) {
      const result = original.apply(this, args);
      handleRouteChange();
      return result;
    };
    wrapped.__promptlyWrapped = true;
    history[method] = wrapped;
  };
  wrapHistory('pushState');
  wrapHistory('replaceState');
  window.addEventListener('popstate', handleRouteChange);
  window.addEventListener('hashchange', handleRouteChange);
};

const initFrustrationSignals = () => {
  if (!analyticsEnabled || window.__promptlyAnalyticsFrustration) return;
  window.__promptlyAnalyticsFrustration = true;
  const getTargetSelector = (el) => {
    if (!el || !el.tagName) return '';
    if (el.dataset?.analytics) return `[data-analytics="${el.dataset.analytics}"]`;
    if (el.id) return `#${el.id}`;
    const className = typeof el.className === 'string' ? el.className.trim() : '';
    if (className) {
      const short = className.split(/\s+/).slice(0, 2).join('.');
      return `${el.tagName.toLowerCase()}.${short}`;
    }
    return el.tagName.toLowerCase();
  };
  const isInteractive = (el) => {
    if (!el || el.nodeType !== 1) return false;
    const selector = 'a,button,input,select,textarea,summary,[role="button"],[data-analytics],label';
    if (el.matches(selector) || el.closest(selector)) return true;
    if (typeof el.onclick === 'function') return true;
    const tabindex = el.getAttribute?.('tabindex');
    return tabindex === '0';
  };
  let rageClicks = [];
  let lastRageEmit = 0;
  document.addEventListener('click', (event) => {
    const now = Date.now();
    const x = typeof event.clientX === 'number' ? event.clientX : 0;
    const y = typeof event.clientY === 'number' ? event.clientY : 0;
    rageClicks = rageClicks.filter((c) => now - c.ts <= 2000);
    rageClicks.push({ ts: now, x, y });
    const nearby = rageClicks.filter((c) => Math.hypot(c.x - x, c.y - y) <= 40);
    if (nearby.length >= 5 && now - lastRageEmit > 2000) {
      lastRageEmit = now;
      rageClicks = [];
      emitAnalytics('rage_click', { x, y, targetSelector: getTargetSelector(event.target) });
    }
    const target = event.target;
    if (!isInteractive(target)) {
      const startHref = window.location.href;
      const startActive = document.activeElement;
      setTimeout(() => {
        if (window.location.href !== startHref) return;
        if (document.activeElement && document.activeElement !== startActive) return;
        emitAnalytics('dead_click', {
          targetTag: target?.tagName?.toLowerCase() || '',
          targetSelector: getTargetSelector(target),
        });
      }, 350);
    }
  });

  window.addEventListener('error', (event) => {
    emitAnalytics('js_error', {
      message: event.message || 'Script error',
      source: event.filename || '',
      lineno: event.lineno || 0,
      colno: event.colno || 0,
      stack: event.error?.stack || '',
    });
  });

  window.addEventListener('unhandledrejection', (event) => {
    const reason = event.reason;
    emitAnalytics('js_error', {
      message: reason?.message || String(reason || 'Unhandled rejection'),
      stack: reason?.stack || '',
      source: 'unhandledrejection',
      lineno: 0,
      colno: 0,
    });
  });
};

initAnalyticsPageviews();
initFrustrationSignals();

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
  const termsConsent = document.getElementById('terms-consent');
  const termsCheckbox = document.getElementById('terms-checkbox');
  const passwordStrength = document.getElementById('password-strength');
  const authBtnText = document.getElementById('auth-btn-text');
  const authBtnSpinner = document.getElementById('auth-btn-spinner');
  const googleAuthBtn = document.getElementById('google-auth-btn');
  const footerYear = document.getElementById('auth-footer-year');
  if (footerYear) footerYear.textContent = new Date().getFullYear();

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
    bars.forEach((bar) => {
      bar.style.background = 'color-mix(in srgb, var(--text-primary) 12%, transparent)';
    });
    
    if (password.length === 0) {
      strengthText.textContent = '';
      return;
    }
    
    const colors = [
      'color-mix(in srgb, var(--accent) 45%, transparent)',
      'color-mix(in srgb, var(--accent) 60%, transparent)',
      'color-mix(in srgb, var(--accent) 75%, transparent)',
      'color-mix(in srgb, var(--accent) 95%, transparent)'
    ];
    const labels = ['Weak password', 'Fair password', 'Good password', 'Strong password'];
    
    for (let i = 0; i < strength; i++) {
      bars[i].style.background = colors[strength - 1];
    }
    
    strengthText.textContent = labels[strength - 1] || 'Too short';
    strengthText.style.color = colors[strength - 1] || 'var(--text-secondary)';
  };

  const applyModeUI = () => {
    if (authBtnText) authBtnText.textContent = isSignUp ? 'Sign Up' : 'Sign In';
    if (toggleBtn) toggleBtn.textContent = isSignUp ? 'Sign In' : 'Sign Up';
    if (authFeedbackEl) authFeedbackEl.textContent = '';
    // Show "Forgot password?" only in Sign In mode
    if (forgotPasswordLink) forgotPasswordLink.style.display = isSignUp ? 'none' : 'block';
    // Show terms agreement and password strength only in Sign Up mode
    if (termsConsent) termsConsent.style.display = isSignUp ? 'block' : 'none';
    if (termsCheckbox) {
      termsCheckbox.required = isSignUp;
      if (!isSignUp) termsCheckbox.checked = false;
    }
    if (passwordStrength) passwordStrength.style.display = isSignUp ? 'block' : 'none';
    if (isSignUp && passwordInput) updatePasswordStrength();
  };

  // If this script is loaded on a page without the auth form (e.g., index.html),
  // skip binding to avoid errors.
  if (!authForm) {
    // nothing to do on non-auth pages
    console.log('auth.js: auth form not present on this page — skipping auth bindings');
    (async () => {
      try {
        const user = await getCurrentUser();
        const landingPaths = ['/', '/index.html'];
        if (user && landingPaths.includes(window.location.pathname)) {
          window.location.href = '/editor';
        }
      } catch (err) {
        console.error('auth.js: landing redirect check failed', err);
      }
    })();
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
        
        if (isSignUp) {
          emitAnalytics('signup_start');
        }
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
          if (isSignUp) {
            emitAnalytics('signup_complete');
          }
          try { sessionStorage.setItem('promptly_show_app', '1'); } catch (_) {}
          // Prefer a same-origin ?next= path (e.g. /review sends next=/review so
          // sign-in returns there). Guard against open-redirect: must be a local
          // path ("/..."), never a protocol-relative ("//host") or absolute URL.
          const nextDest = (() => {
            try {
              const n = new URLSearchParams(window.location.search || '').get('next') || '';
              if (n.startsWith('/') && !n.startsWith('//')) return n;
            } catch {}
            return '/editor';
          })();
          // Verify session is established before redirecting
          const verifyAndRedirect = async () => {
            try {
              const user = await getCurrentUser();
              if (user) {
                window.location.href = nextDest;
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
          const { error } = await supabase.auth.signInWithOAuth({
            provider: 'google',
            options: {
              redirectTo: `${window.location.origin}/editor`
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
