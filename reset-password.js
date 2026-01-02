import { getSupabaseClient } from './supabase-client.js';
import { initTheme } from './theme.js';

document.addEventListener('DOMContentLoaded', () => {
  initTheme();

  const resetPasswordForm = document.getElementById('reset-password-form');
  const newPasswordInput = document.getElementById('new-password');
  const confirmPasswordInput = document.getElementById('confirm-password');
  const resetBtn = document.getElementById('reset-btn');
  const resetFeedbackEl = document.getElementById('reset-feedback');

  function initPasswordToggles() {
    const bindToggle = (btn, input) => {
      if (!btn || !input) return;
      btn.addEventListener('click', (event) => {
        event.preventDefault();
        const willShow = input.type === 'password';
        input.type = willShow ? 'text' : 'password';
        btn.setAttribute('aria-pressed', String(willShow));
        btn.setAttribute('aria-label', willShow ? 'Hide password' : 'Show password');
      });
    };

    const togglePasswordBtn = document.getElementById('toggle-password-visibility');
    const toggleConfirmBtn = document.getElementById('toggle-confirm-visibility');
    bindToggle(togglePasswordBtn, newPasswordInput);
    bindToggle(toggleConfirmBtn, confirmPasswordInput);
  }

  function showInitError(message, err) {
    if (err) {
      console.error('Reset password initialization error:', err);
    }
    if (resetFeedbackEl) {
      resetFeedbackEl.textContent = message;
      resetFeedbackEl.className = 'auth-feedback error';
    }
    if (resetBtn) resetBtn.disabled = true;
  }

  let supabase;
  try {
    supabase = getSupabaseClient();
  } catch (err) {
    showInitError('Unable to load password reset. Please refresh the page.', err);
    return;
  }

  initPasswordToggles();

  if (resetPasswordForm) {
    resetPasswordForm.addEventListener('submit', async (e) => {
      e.preventDefault();

      const newPassword = newPasswordInput.value.trim();
      const confirmPassword = confirmPasswordInput.value.trim();

      if (newPassword !== confirmPassword) {
        resetFeedbackEl.textContent = 'Passwords do not match';
        resetFeedbackEl.className = 'auth-feedback error';
        return;
      }

      if (newPassword.length < 6) {
        resetFeedbackEl.textContent = 'Password must be at least 6 characters';
        resetFeedbackEl.className = 'auth-feedback error';
        return;
      }

      try {
        resetBtn.textContent = 'Resetting...';
        resetBtn.disabled = true;
        resetFeedbackEl.textContent = '';
        resetFeedbackEl.className = 'auth-feedback';

        const { data, error } = await supabase.auth.updateUser({
          password: newPassword,
        });

        if (error) {
          throw error;
        }

        resetFeedbackEl.textContent = 'Password reset successful! Redirecting...';
        resetFeedbackEl.className = 'auth-feedback success';

        setTimeout(() => {
          window.location.href = '/';
        }, 2000);
      } catch (error) {
        console.error('Password reset error:', error);
        resetFeedbackEl.textContent = error.message || 'Failed to reset password. Please try again.';
        resetFeedbackEl.className = 'auth-feedback error';
        resetBtn.textContent = 'Reset Password';
        resetBtn.disabled = false;
      }
    });
  }

  (async () => {
    try {
      const { data: { session }, error } = await supabase.auth.getSession();

      if (error || !session) {
        resetFeedbackEl.textContent = 'Invalid or expired reset link. Please request a new password reset.';
        resetFeedbackEl.className = 'auth-feedback error';
        resetBtn.disabled = true;
      }
    } catch (error) {
      showInitError('Unable to verify reset link. Please refresh the page.', error);
    }
  })();
});
