// Supabase client configuration
// Use CDN version since we can't serve node_modules files easily
export const SUPABASE_URL = 'https://ejxkzsfruykvgeouymfy.supabase.co';
export const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVqeGt6c2ZydXlrdmdlb3V5bWZ5Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjMzMjE5ODgsImV4cCI6MjA3ODg5Nzk4OH0.KSH6xO3bPv9aK36zGZKCtnNCa1z7xI_H-VKx5ZRaTOE';

// Lazy initialization to ensure CDN is loaded
let _supabase = null;

export function getSupabaseClient() {
  if (!_supabase) {
    const supabaseGlobal = globalThis.supabase;
    if (!supabaseGlobal) {
      console.error(
        '⚠️ Supabase CDN not loaded. Make sure <script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"></script> is in <head>'
      );
      throw new Error('Supabase CDN not loaded');
    }
    const { createClient } = supabaseGlobal;
    _supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  }
  return _supabase;
}

// Export a proxy that lazily initializes
export const supabase = new Proxy({}, {
  get(target, prop) {
    const client = getSupabaseClient();
    const value = client[prop];
    return typeof value === 'function' ? value.bind(client) : value;
  }
});
