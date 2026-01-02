// Supabase client configuration
// Use CDN version since we can't serve node_modules files easily
export const SUPABASE_URL = 'https://ejxkzsfruykvgeouymfy.supabase.co';
export const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVqeGt6c2ZydXlrdmdlb3V5bWZ5Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjMzMjE5ODgsImV4cCI6MjA3ODg5Nzk4OH0.KSH6xO3bPv9aK36zGZKCtnNCa1z7xI_H-VKx5ZRaTOE';

let _client = null;

export function getSupabaseClient() {
  if (_client) return _client;
  const sb = globalThis.supabase || window.supabase;
  if (!sb) {
    throw new Error('Supabase CDN not loaded');
  }
  _client = sb.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  return _client;
}
