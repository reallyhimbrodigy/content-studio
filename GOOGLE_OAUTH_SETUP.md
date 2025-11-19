# Google OAuth Setup Guide

Your app already has Google OAuth code implemented. You just need to configure it in Supabase and Google Cloud Console.

## Step 1: Set up Google Cloud Console

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Create a new project or select an existing one
3. Navigate to **APIs & Services** → **Credentials**
4. Click **Create Credentials** → **OAuth 2.0 Client IDs**
5. If prompted, configure the OAuth consent screen:
   - Choose **External** (for testing) or **Internal** (if you have a workspace)
   - Fill in:
     - App name: `Promptly`
     - User support email: your email
     - Developer contact: your email
   - Click **Save and Continue**
   - Skip adding scopes (or add email and profile)
   - Add test users if in testing mode
   - Click **Save and Continue**

6. Back at **Create OAuth client ID**:
   - Application type: **Web application**
   - Name: `Promptly Web Client`
   - Authorized JavaScript origins:
     ```
     http://localhost:8000
     https://yourdomain.com
     ```
   - Authorized redirect URIs (CRITICAL - get these from Supabase):
     ```
     https://<your-project-ref>.supabase.co/auth/v1/callback
     http://localhost:54321/auth/v1/callback (for local Supabase dev)
     ```

7. Click **Create**
8. Copy the **Client ID** and **Client Secret**

## Step 2: Configure Supabase

1. Go to your [Supabase Dashboard](https://app.supabase.com/)
2. Select your project
3. Go to **Authentication** → **Providers**
4. Find **Google** and enable it
5. Paste your Google **Client ID** and **Client Secret**
6. Copy the **Callback URL** shown (looks like: `https://YOUR-PROJECT.supabase.co/auth/v1/callback`)
7. Click **Save**

## Step 3: Update Google Cloud Console Redirect URIs

1. Go back to Google Cloud Console → **Credentials**
2. Click on your OAuth 2.0 Client ID
3. Under **Authorized redirect URIs**, add the exact callback URL from Supabase:
   ```
   https://<your-project-ref>.supabase.co/auth/v1/callback
   ```
4. For local development, also add:
   ```
   http://localhost:8000
   http://localhost:54321/auth/v1/callback
   ```
5. Click **Save**

## Step 4: Test

1. Restart your app if needed
2. Go to `http://localhost:8000/auth.html`
3. Click **Continue with Google**
4. You should be redirected to Google sign-in
5. After signing in, you'll be redirected back to your app

## Troubleshooting

### "redirect_uri_mismatch" error
- The redirect URI in Google Cloud Console must EXACTLY match the callback URL from Supabase
- Check for trailing slashes, http vs https, etc.

### "Access blocked" error
- Make sure your app is in testing mode and you've added yourself as a test user
- Or publish your OAuth consent screen

### "Invalid client" error
- Double-check the Client ID and Client Secret in Supabase match Google Cloud Console

### Still not working?
- Check browser console for errors
- Check Supabase logs in Dashboard → Logs
- Make sure cookies are enabled
- Try in an incognito window to rule out cache issues

## Important URLs

- **Google Cloud Console**: https://console.cloud.google.com/
- **Supabase Dashboard**: https://app.supabase.com/
- Your Supabase callback URL: `https://<your-project-ref>.supabase.co/auth/v1/callback`

## Current Implementation

The code in `auth.js` already handles Google OAuth:

```javascript
googleAuthBtn.addEventListener('click', async () => {
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
  }
});
```

This redirects users to Google, then back to your home page (`/`) after successful authentication.
