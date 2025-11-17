# Supabase Setup Instructions

## 1. Create a Supabase Project

1. Go to [supabase.com](https://supabase.com) and sign in
2. Click "New Project"
3. Choose a name (e.g., "promptly-production")
4. Set a strong database password (save it securely)
5. Choose a region close to your users
6. Wait for the project to finish provisioning (~2 minutes)

## 2. Get Your Supabase Credentials

1. In your Supabase dashboard, go to **Settings** → **API**
2. Copy these two values:
   - **Project URL** (looks like `https://xxxxx.supabase.co`)
   - **anon public key** (a long JWT token)

## 3. Set Up the Database Schema

1. In your Supabase dashboard, go to **SQL Editor**
2. Click "New Query"
3. Copy the entire contents of `supabase-schema.sql` from this repo
4. Paste it into the SQL Editor
5. Click "Run" to execute the schema
6. Verify tables were created: Go to **Table Editor** and you should see:
   - `profiles` table
   - `calendars` table

## 4. Configure Environment Variables

### For Local Development (localhost:8000)

Create a `.env` file in the root of this repo:

```bash
OPENAI_API_KEY=your_openai_key_here
SUPABASE_URL=https://xxxxx.supabase.co
SUPABASE_ANON_KEY=your_anon_key_here
```

### For Production (Render.com)

1. Go to your Render dashboard
2. Open your `content-studio` service
3. Go to **Environment** tab
4. Add these environment variables:
   - `SUPABASE_URL` = `https://xxxxx.supabase.co`
   - `SUPABASE_ANON_KEY` = `your_anon_key_here`
5. Click "Save Changes" (this will trigger a redeploy)

## 5. Enable Email Authentication (Optional but Recommended)

By default, Supabase allows email/password signups without email confirmation.

To enable email confirmation:
1. Go to **Authentication** → **Settings**
2. Under "Email Auth", toggle **Enable email confirmations**
3. Configure your email provider (or use Supabase's built-in email service)

## 6. Test the Integration

1. Start your local server: `npm start`
2. Go to `http://localhost:8000/auth.html`
3. Sign up with a new email/password
4. Check Supabase dashboard → **Authentication** → **Users** to see the new user
5. Check **Table Editor** → **profiles** to see the auto-created profile
6. Generate a calendar and save it
7. Check **Table Editor** → **calendars** to see the saved calendar

## 7. Migration Notes

- **Old localStorage data will NOT be migrated automatically**
- Users will need to sign up again (or you can manually import data)
- Existing calendars in localStorage will remain in the browser but won't sync to the database

## Next Steps

After setup is complete:
- Update `user-store.js` to use Supabase auth and database
- Update `library.js` to fetch calendars from Supabase
- Add error handling for network issues
- Consider adding a sync indicator or loading states
