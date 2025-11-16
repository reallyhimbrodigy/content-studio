# Promptly Content Studio – Quick Start Guide

## ✅ Status: All Systems Operational

Your app is **fully functional**. The backend, API, and all buttons work end-to-end.

---

## 🚀 Getting Started (3 steps)

### Step 1: Open the app
```
Open your browser and go to:
http://localhost:8000
```

**If you see the auth page** (email/password form) → continue to Step 2
**If you see an error** → scroll to "Troubleshooting" below

### Step 2: Create an account or sign in
- **To sign up:** Enter any email and password, click "Sign Up"
- **To sign in:** If you already have an account, click "Sign In", then enter your credentials
- **Note:** Accounts are stored locally in your browser (localStorage)

### Step 3: Generate your first calendar
1. Type a niche or style in the input box, e.g.:
   - "sustainable fashion influencers"
   - "vegan fitness coaches"
   - "indie game developers"
   - "AI productivity experts"
2. Click the **"Generate Calendar"** button
3. Wait ~5 seconds for the calendar to generate (it calls OpenAI)
4. View your 30-day content calendar with daily ideas sequenced for authority → community → conversion

---

## 🎯 Available Features

Once you've signed in and generated a calendar:

| Feature | What it does |
|---------|-------------|
| **All Pillars / Authority / Community / Conversion** | Filter calendar by pillar (audience strategy) |
| **Save Calendar** | Save your generated calendar to your library (persisted in browser) |
| **Export as JSON** | Download your calendar as a JSON file for use elsewhere |
| **Library** | View all your saved calendars, load them, or delete them |
| **Sign Out** | Log out and return to the auth page |

---

## ⚙️ Troubleshooting

### Issue: "Nothing appears" or "Buttons don't work"

**Solution A: Clear your browser cache**
1. Open DevTools (F12 or Cmd+Shift+I)
2. Right-click the refresh button → "Empty cache and hard refresh"
3. Reload the page

**Solution B: Use a private/incognito window**
- Open a new private window and visit `http://localhost:8000`
- This bypasses all cached data

**Solution C: Check the server is running**
```bash
# In a terminal, run:
curl -sS http://localhost:8000/ | head -5
```
If you see HTML, the server is running. If you see "connection refused", restart it:
```bash
npm start
```

### Issue: "Generate button doesn't work after I click it"

**Check the browser console for errors:**
1. Open DevTools (F12)
2. Go to the **Console** tab
3. Try Generate again and look for red error messages
4. Common errors:
   - "nicheStyle required" → Make sure you typed something in the input
   - "CORS error" → This shouldn't happen (CORS is enabled on the server)
   - "Failed to fetch" → Server is not running

### Issue: "I signed up but then got redirected back to auth"

**This is normal!** You may have signed up, but your session might have expired or cookies/localStorage got cleared. Just sign up again or sign in.

---

## 🔐 API Key Status

Your OpenAI API key is set and the server is using it. If you see warnings about "OPENAI_API_KEY not set" in the server logs, that's from old processes. Verify:

```bash
# Check if the key is loaded (will show length, not the actual key):
bash -lc 'source ~/.zshenv && printf "Key length: %d\n" ${#OPENAI_API_KEY}'
```

---

## 📁 File Structure

```
.
├── index.html              # Main app (redirects to /auth.html if not logged in)
├── auth.html               # Sign up / Sign in page
├── library.html            # View saved calendars
├── script.js               # Main app logic (Generate, Save, Export, filters)
├── auth.js                 # Auth system (localStorage-based)
├── styles.css              # App styling
├── server.js               # Node.js backend (static file server + OpenAI proxy)
├── posts.js                # Sample posts (not used currently)
└── assets/                 # Logo and icons
    ├── promptly-logo.svg
    ├── promptly-logo.png
    └── promptly-icon.svg
```

---

## 🧪 Verification

Run this to verify everything is working:

```bash
node test-app.js
```

You should see:
```
✅ ALL TESTS PASSED!
  • Server is running on http://localhost:8000
  • Auth page is accessible at /auth.html
  • API endpoint /api/generate-calendar is working
  • OpenAI integration is functional
```

---

## 💡 Tips & Tricks

- **Generate multiple calendars:** Each niche gets its own entry in your library
- **Export for sharing:** Download as JSON and send to teammates
- **Filters are persistent:** They stay active while you view a calendar, but reset when you generate a new one
- **Keyboard shortcut:** You can press Enter in the niche input to generate (if the button is focused)

---

## 🆘 Still not working?

Try these in order:

1. **Check server is running:**
   ```bash
   pgrep -f "node server.js" && echo "Server is running" || echo "Server is NOT running"
   ```

2. **Check no port conflicts:**
   ```bash
   lsof -n -iTCP:8000 -sTCP:LISTEN
   ```

3. **Restart the server:**
   ```bash
   pkill -f "node server.js"
   sleep 1
   cd /Users/zaclibman/content-studio
   npm start
   ```

4. **Check API key is set:**
   ```bash
   bash -lc 'source ~/.zshenv && [ -n "$OPENAI_API_KEY" ] && echo "API key is set" || echo "API key NOT set"'
   ```

---

## 📞 Need Help?

If something still doesn't work:
- Open DevTools Console (F12) and paste any error messages
- Check the terminal where you ran `npm start` for server-side errors
- Verify your OPENAI_API_KEY is correctly set

---

**Ready to generate your first calendar? Open `http://localhost:8000` and sign up!** 🚀
