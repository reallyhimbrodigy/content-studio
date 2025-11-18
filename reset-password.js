import { getSupabaseClient } from './supabase-client.js';

const resetPasswordForm = document.getElementById('reset-password-form');
const newPasswordInput = document.getElementById('new-password');
const confirmPasswordInput = document.getElementById('confirm-password');
const resetBtn = document.getElementById('reset-btn');
const resetFeedbackEl = document.getElementById('reset-feedback');
const togglePasswordBtn = document.getElementById('toggle-password-visibility');
const eyeIcon = document.getElementById('eye-icon');
const eyeOffIcon = document.getElementById('eye-off-icon');

// Password visibility toggle
if (togglePasswordBtn) {
  togglePasswordBtn.addEventListener('click', () => {
    const isPassword = newPasswordInput.type === 'password';
    newPasswordInput.type = isPassword ? 'text' : 'password';
    eyeIcon.style.display = isPassword ? 'none' : 'block';
    eyeOffIcon.style.display = isPassword ? 'block' : 'none';
  });
}

// Handle password reset form submission
if (resetPasswordForm) {
  resetPasswordForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    
    const newPassword = newPasswordInput.value.trim();
    const confirmPassword = confirmPasswordInput.value.trim();
    
    // Validate passwords match
    if (newPassword !== confirmPassword) {
      resetFeedbackEl.textContent = 'Passwords do not match';
      resetFeedbackEl.className = 'auth-feedback error';
      return;
    }
    
    // Validate password length
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
      
      const supabase = await getSupabaseClient();
      
      // Update the user's password
      const { data, error } = await supabase.auth.updateUser({
        password: newPassword
      });
      
      if (error) {
        throw error;
      }
      
      resetFeedbackEl.textContent = 'Password reset successful! Redirecting...';
      resetFeedbackEl.className = 'auth-feedback success';
      
      // Redirect to main app after successful reset
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

// Check if user has a valid session on page load
(async () => {
  try {
    const supabase = await getSupabaseClient();
    const { data: { session }, error } = await supabase.auth.getSession();
    
    if (error) {
      console.error('Session check error:', error);
      resetFeedbackEl.textContent = 'Invalid or expired reset link. Please request a new password reset.';
      resetFeedbackEl.className = 'auth-feedback error';
      resetBtn.disabled = true;
      return;
    }
    
    if (!session) {
      resetFeedbackEl.textContent = 'Invalid or expired reset link. Please request a new password reset.';
      resetFeedbackEl.className = 'auth-feedback error';
      resetBtn.disabled = true;
    }
  } catch (error) {
    console.error('Initialization error:', error);
  }
})();
