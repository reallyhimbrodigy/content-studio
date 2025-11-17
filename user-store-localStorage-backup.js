// Lightweight user & calendar storage helpers (pure data layer).
// Included on pages that need access to user/calendar storage.

const USERS_KEY = "promptly_users";
const CURRENT_USER_KEY = "promptly_current_user";
const CALENDARS_KEY = "promptly_calendars";
const USER_TIER_KEY = "promptly_user_tier"; // Store subscription tier

export function getAllUsers() {
  const stored = localStorage.getItem(USERS_KEY);
  return stored ? JSON.parse(stored) : {};
}

export function getCurrentUser() {
  return localStorage.getItem(CURRENT_USER_KEY);
}

export function setCurrentUser(email) {
  localStorage.setItem(CURRENT_USER_KEY, email);
}

export function signUp(email, password) {
  const users = getAllUsers();
  if (users[email]) return { ok: false, msg: "User already exists" };
  users[email] = { email, passwordHash: btoa(password) };
  localStorage.setItem(USERS_KEY, JSON.stringify(users));
  setCurrentUser(email);
  // New users start on free tier
  setUserTier(email, 'free');
  return { ok: true, msg: "Signed up successfully" };
}

export function signIn(email, password) {
  const users = getAllUsers();
  if (!users[email]) return { ok: false, msg: "User not found" };
  if (users[email].passwordHash !== btoa(password)) return { ok: false, msg: "Incorrect password" };
  setCurrentUser(email);
  return { ok: true, msg: "Signed in successfully" };
}

export function signOut() {
  localStorage.removeItem(CURRENT_USER_KEY);
}

export function getUserCalendars(email) {
  const stored = localStorage.getItem(CALENDARS_KEY);
  const allCalendars = stored ? JSON.parse(stored) : {};
  return allCalendars[email] || [];
}

export function saveUserCalendar(email, calendar) {
  const stored = localStorage.getItem(CALENDARS_KEY);
  const allCalendars = stored ? JSON.parse(stored) : {};
  if (!allCalendars[email]) allCalendars[email] = [];

  if (!calendar.id) calendar.id = Date.now() + Math.random();
  if (!calendar.savedAt) calendar.savedAt = new Date().toISOString();

  allCalendars[email].push(calendar);
  localStorage.setItem(CALENDARS_KEY, JSON.stringify(allCalendars));
  return calendar;
}

// Subscription tier management
export function getUserTier(email) {
  const stored = localStorage.getItem(USER_TIER_KEY);
  const tiers = stored ? JSON.parse(stored) : {};
  return tiers[email] || 'free'; // Default to free tier
}

export function setUserTier(email, tier) {
  const stored = localStorage.getItem(USER_TIER_KEY);
  const tiers = stored ? JSON.parse(stored) : {};
  tiers[email] = tier; // 'free' or 'pro'
  localStorage.setItem(USER_TIER_KEY, JSON.stringify(tiers));
}

export function isPro(email) {
  return getUserTier(email || getCurrentUser()) === 'pro';
}
