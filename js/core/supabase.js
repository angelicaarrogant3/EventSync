import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { CONFIG } from '/js/config.js';

export const configMissing =
  !CONFIG.SUPABASE_URL || CONFIG.SUPABASE_URL.includes('YOUR_') ||
  !CONFIG.SUPABASE_ANON_KEY || CONFIG.SUPABASE_ANON_KEY.includes('YOUR_');

export const supabase = createClient(
  configMissing ? 'https://placeholder.supabase.co' : CONFIG.SUPABASE_URL,
  configMissing ? 'placeholder' : CONFIG.SUPABASE_ANON_KEY,
  { auth: { persistSession: true, autoRefreshToken: true }, realtime: { params: { eventsPerSecond: 10 } } }
);
