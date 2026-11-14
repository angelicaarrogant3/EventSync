-- =====================================================================
-- Migration 006: Public aggregate landing stats (counts ONLY - no PII)
-- =====================================================================
create or replace function public.public_landing_stats()
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'events_count',     (select count(*)::int from public.events where status = 'published'),
    'registered_count', (select count(*)::int from public.registrations where status = 'registered'),
    'checkins_today',   (select count(*)::int from public.attendance where (checked_in_at at time zone 'Asia/Manila')::date = (now() at time zone 'Asia/Manila')::date)
  );
$$;

grant execute on function public.public_landing_stats() to anon, authenticated;
notify pgrst, 'reload schema';
