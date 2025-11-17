// Supabase client configuration
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = import.meta.env?.VITE_SUPABASE_URL || process.env.SUPABASE_URL || '';
const SUPABASE_ANON_KEY = import.meta.env?.VITE_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY || '';

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  console.warn('⚠️ Supabase credentials not found. Set SUPABASE_URL and SUPABASE_ANON_KEY environment variables.');
}

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
