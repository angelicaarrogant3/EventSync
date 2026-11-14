-- =====================================================================
-- Migration 007: Event images (poster/banner) + Supabase Storage bucket
-- Safe, repeatable migration that preserves existing events.
-- =====================================================================

-- 1. Add nullable image columns to public.events
alter table public.events add column if not exists image_path text;
alter table public.events add column if not exists image_updated_at timestamptz;

-- 2. Recreate event_stats view so it includes the new columns
drop view if exists public.event_stats;
create view public.event_stats as
select e.*,
       (select count(*) from public.attendance a where a.event_id = e.id)::int as attended_count
from public.events e
where e.status = 'published' or public.is_admin();
grant select on public.event_stats to authenticated;

-- 3. Update trg_log_events() to log image upload, replace, and remove
create or replace function public.trg_log_events()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  non_image_changed boolean;
begin
  if tg_op = 'INSERT' then
    perform public.log_activity('event.created', 'event', new.id::text,
      jsonb_build_object('title', new.title, 'status', new.status));
    return new;
  elsif tg_op = 'UPDATE' then
    if (to_jsonb(new) - 'registered_count') = (to_jsonb(old) - 'registered_count') then
      return new;
    end if;

    if new.image_path is distinct from old.image_path or new.image_updated_at is distinct from old.image_updated_at then
      if old.image_path is null and new.image_path is not null then
        perform public.log_activity('event.image_uploaded', 'event', new.id::text,
          jsonb_build_object('title', new.title, 'image_path', new.image_path));
      elsif old.image_path is not null and new.image_path is not null then
        perform public.log_activity('event.image_replaced', 'event', new.id::text,
          jsonb_build_object('title', new.title, 'image_path', new.image_path));
      elsif old.image_path is not null and new.image_path is null then
        perform public.log_activity('event.image_removed', 'event', new.id::text,
          jsonb_build_object('title', new.title));
      end if;
    end if;

    non_image_changed := (to_jsonb(new) - 'registered_count' - 'image_path' - 'image_updated_at')
                         is distinct from
                         (to_jsonb(old) - 'registered_count' - 'image_path' - 'image_updated_at');

    if non_image_changed then
      perform public.log_activity(
        case when new.status is distinct from old.status then 'event.status_' || new.status else 'event.updated' end,
        'event', new.id::text, jsonb_build_object('title', new.title, 'status', new.status));
    end if;
    return new;
  else
    perform public.log_activity('event.deleted', 'event', old.id::text, jsonb_build_object('title', old.title));
    return old;
  end if;
end $$;

-- 4. Public upcoming events RPC for landing page (published & open/upcoming only, no PII)
create or replace function public.public_upcoming_events(p_limit int default 6)
returns table (
  id uuid,
  title text,
  description text,
  venue text,
  starts_at timestamptz,
  ends_at timestamptz,
  registration_deadline timestamptz,
  capacity int,
  registered_count int,
  image_path text,
  image_updated_at timestamptz
)
language sql stable security definer set search_path = public as $$
  select e.id, e.title, e.description, e.venue, e.starts_at, e.ends_at,
         e.registration_deadline, e.capacity, e.registered_count,
         e.image_path, e.image_updated_at
  from public.events e
  where e.status = 'published'
    and e.ends_at >= now()
  order by e.starts_at asc
  limit greatest(1, least(coalesce(p_limit, 6), 24));
$$;
grant execute on function public.public_upcoming_events(int) to anon, authenticated;

-- 5. Supabase Storage bucket for event images (5 MB limit, JPEG/PNG/WebP only)
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('event-images', 'event-images', true, 5242880, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do update
  set public = excluded.public,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- Storage RLS policies on storage.objects
drop policy if exists event_images_public_read on storage.objects;
create policy event_images_public_read
  on storage.objects for select to anon, authenticated
  using (bucket_id = 'event-images');

drop policy if exists event_images_admin_insert on storage.objects;
create policy event_images_admin_insert
  on storage.objects for insert to authenticated
  with check (bucket_id = 'event-images' and public.is_admin());

drop policy if exists event_images_admin_update on storage.objects;
create policy event_images_admin_update
  on storage.objects for update to authenticated
  using (bucket_id = 'event-images' and public.is_admin())
  with check (bucket_id = 'event-images' and public.is_admin());

drop policy if exists event_images_admin_delete on storage.objects;
create policy event_images_admin_delete
  on storage.objects for delete to authenticated
  using (bucket_id = 'event-images' and public.is_admin());

notify pgrst, 'reload schema';
