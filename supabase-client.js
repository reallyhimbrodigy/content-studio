// Supabase client configuration
import { createClient } from '@supabase/supabase-js';

// Hardcoded for now (browser-safe anon key - this is public)
const SUPABASE_URL = 'https://ejxkzsfruykvgeouymfy.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVqeGt6c2ZydXlrdmdlb3V5bWZ5Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjMzMjE5ODgsImV4cCI6MjA3ODg5Nzk4OH0.KSH6xO3bPv9aK36zGZKCtnNCa1z7xI_H-VKx5ZRaTOE';

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  console.warn('⚠️ Supabase credentials not configured.');
}

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
