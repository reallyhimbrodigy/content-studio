import { getCurrentUser } from './user-store.js';

async function hideSignedInLinks() {
  try {
    const currentUser = await getCurrentUser();
    if (!currentUser) return;
    document.querySelectorAll('[data-hide-when-authenticated]').forEach((el) => {
      el.remove();
    });
  } catch (error) {
    console.warn('auth-visibility: unable to determine user state', error);
  }
}

hideSignedInLinks();
