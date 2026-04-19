#!/usr/bin/env node
/**
 * Build script — copies mobile app files to www/ for Capacitor local serving.
 * Rewrites relative API URLs to absolute production URLs.
 */
const fs = require('fs');
const path = require('path');

const PROD_URL = 'https://usepromptly.app';
const WWW = path.join(__dirname, '..', 'www');

// Ensure www directory exists
if (!fs.existsSync(WWW)) fs.mkdirSync(WWW, { recursive: true });

// 1. Copy and rewrite editor.html → www/index.html
let editor = fs.readFileSync(path.join(__dirname, '..', 'public', 'editor.html'), 'utf8');

// Rewrite relative API/SSE URLs to absolute
editor = editor.replace(/fetch\(['"]\/api\//g, `fetch('${PROD_URL}/api/`);
editor = editor.replace(/fetch\(`\/api\//g, `fetch(\`${PROD_URL}/api/`);
editor = editor.replace(/EventSource\(`\/api\//g, `EventSource(\`${PROD_URL}/api/`);
editor = editor.replace(/xhr\.open\('POST', '\/api\//g, `xhr.open('POST', '${PROD_URL}/api/`);
editor = editor.replace(/xhr\.open\('PUT', '\/api\//g, `xhr.open('PUT', '${PROD_URL}/api/`);
editor = editor.replace(/window\.location\.href\s*=\s*'\/auth\.html'/g, `window.location.href = '${PROD_URL}/auth.html'`);
editor = editor.replace(/window\.location\.href\s*=\s*'\/help\.html'/g, `window.location.href = '${PROD_URL}/help.html'`);
editor = editor.replace(/window\.location\.href\s*=\s*'\/reset-password\.html'/g, `window.location.href = '${PROD_URL}/reset-password.html'`);

// Rewrite CSS/JS asset links to absolute
editor = editor.replace(/href="\/css\//g, `href="${PROD_URL}/css/`);
editor = editor.replace(/src="\/components\//g, `src="${PROD_URL}/components/`);
editor = editor.replace(/src="\/js\//g, `src="${PROD_URL}/js/`);
editor = editor.replace(/src="\/sw-register/g, `src="${PROD_URL}/sw-register`);
editor = editor.replace(/src="\/pwa-install/g, `src="${PROD_URL}/pwa-install`);
editor = editor.replace(/src="assets\//g, `src="${PROD_URL}/assets/`);
editor = editor.replace(/src="\/assets\//g, `src="${PROD_URL}/assets/`);
editor = editor.replace(/href="styles\.css/g, `href="${PROD_URL}/styles.css`);
editor = editor.replace(/href="\/css\/theme\.css/g, `href="${PROD_URL}/css/theme.css`);
editor = editor.replace(/href="\/css\/sidebar\.css/g, `href="${PROD_URL}/css/sidebar.css`);
editor = editor.replace(/href="\/css\/mobile\.css/g, `href="${PROD_URL}/css/mobile.css`);
editor = editor.replace(/href="\/css\/mobile-chat\.css/g, `href="${PROD_URL}/css/mobile-chat.css`);

// Rewrite Supabase vendor script
editor = editor.replace(/src="assets\/vendor\/supabase\.js/g, `src="${PROD_URL}/assets/vendor/supabase.js`);

// Remove service worker and PWA scripts (not needed in native app)
editor = editor.replace(/<script src="[^"]*sw-register[^"]*"[^>]*><\/script>/g, '');
editor = editor.replace(/<script src="[^"]*pwa-install[^"]*"[^>]*><\/script>/g, '');

fs.writeFileSync(path.join(WWW, 'index.html'), editor);
console.log('✓ www/index.html built from editor.html');

// 2. Copy auth.html → www/auth.html (for login redirects)
if (fs.existsSync(path.join(__dirname, '..', 'auth.html'))) {
  let auth = fs.readFileSync(path.join(__dirname, '..', 'auth.html'), 'utf8');
  // Rewrite redirect after login
  auth = auth.replace(/window\.location\.href\s*=\s*'\/editor'/g, `window.location.href = 'index.html'`);
  auth = auth.replace(/href="\/css\/theme\.css/g, `href="${PROD_URL}/css/theme.css`);
  auth = auth.replace(/src="assets\/vendor\/supabase\.js/g, `src="${PROD_URL}/assets/vendor/supabase.js`);
  auth = auth.replace(/src="\.\/auth\.js/g, `src="${PROD_URL}/auth.js`);
  fs.writeFileSync(path.join(WWW, 'auth.html'), auth);
  console.log('✓ www/auth.html built');
}

console.log('\nBuild complete. Run: npx cap sync ios');
