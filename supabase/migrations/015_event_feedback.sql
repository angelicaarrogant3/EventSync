-- =====================================================================
-- Migration 015: Post-event Google Form Feedback
-- Safe, repeatable migration that preserves all existing events.
-- =====================================================================

-- 1. Add feedback columns to public.events
alter table public.events add column if not exists feedback_url text;
alter table public.events add column if not exists feedback_audience text not null default 'attended';
alter table public.events add column if not exists feedback_opened_early boolean not null default false;

do $$ begin
  alter table public.events drop constraint if exists events_feedback_audience_check;
  alter table public.events add constraint events_feedback_audience_check
    check (feedback_audience in ('attended', 'registered'));
end $$;

-- 2. Server-side Google Form URL validator trigger
create or replace function public.validate_event_feedback_url()
returns trigger language plpgsql set search_path = public as $$
declare
  s text := nullif(btrim(coalesce(new.feedback_url, '')), '');
  host_part text;
  path_part text;
begin
  if s is null then
    new.feedback_url := null;
    return new;
  end if;

  if char_length(s) > 500 then
    raise exception 'Feedback link must be at most 500 characters';
  end if;

  if s !~ '^https://' then
    raise exception 'Feedback link must start with https://';
  end if;

  -- Extract lowercase hostname and path cleanly (reject credentials, whitespace, look-alikes)
  if s ~ '\s' or s ~ '^https://[^/]*@' then
    raise exception 'Invalid Google Form link';
  end if;

  host_part := lower(regexp_replace(s, '^https://([^/:?#]+).*$', '\1'));
  path_part := regexp_replace(s, '^https://[^/?#]+', '');

  if host_part not in ('docs.google.com', 'forms.gle', 'forms.google.com') then
    raise exception 'Only Google Forms links (docs.google.com/forms, forms.gle, forms.google.com) are allowed';
  end if;

  if host_part = 'docs.google.com' and path_part !~ '^/forms/' then
    raise exception 'docs.google.com links must point to /forms/';
  end if;

  new.feedback_url := s;
  return new;
end $$;

drop trigger if exists trg_validate_event_feedback_url on public.events;
create trigger trg_validate_event_feedback_url
  before insert or update of feedback_url on public.events
  for each row execute function public.validate_event_feedback_url();

-- 3. Protect events.feedback_url from direct participant SELECT
revoke select on public.events from authenticated;
grant select (
  id, title, description, venue, starts_at, ends_at,
  registration_opens_at, registration_deadline,
  early_grace_minutes, late_grace_minutes, late_after_minutes,
  allow_early_test_attendance, capacity, registered_count, status,
  image_path, image_updated_at,
  feedback_audience, feedback_opened_early,
  created_by, created_at
) on public.events to authenticated;

-- Recreate event_stats so only admins see feedback_url; everyone else gets null
drop view if exists public.event_stats;
create view public.event_stats as
select e.id, e.title, e.description, e.venue, e.starts_at, e.ends_at,
       e.registration_opens_at, e.registration_deadline,
       e.early_grace_minutes, e.late_grace_minutes, e.late_after_minutes,
       e.allow_early_test_attendance, e.capacity, e.registered_count, e.status,
       e.image_path, e.image_updated_at,
       case when public.is_admin() then e.feedback_url else null end as feedback_url,
       (e.feedback_url is not null) as has_feedback_url,
       e.feedback_audience, e.feedback_opened_early,
       e.created_by, e.created_at,
       (select count(*) from public.attendance a
         where a.event_id = e.id and not a.voided and not a.is_test)::int as attended_count,
       (select count(*) from public.attendance a
         where a.event_id = e.id and not a.voided and a.is_test)::int as test_attended_count,
       (select count(*) from public.attendance a
         where a.event_id = e.id and a.voided)::int as voided_count
from public.events e
where e.status = 'published' or public.is_admin();
grant select on public.event_stats to authenticated;

-- 4. Participant RPC: returns caller's registrations with server-gated feedback visibility
create or replace function public.my_registrations(p_now timestamptz default now())
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  uid uuid := auth.uid();
  out jsonb;
begin
  if uid is null then raise exception 'Not authenticated'; end if;

  select coalesce(jsonb_agg(
    jsonb_build_object(
      'id', r.id,
      'event_id', r.event_id,
      'status', r.status,
      'qr_token', r.qr_token,
      'registered_at', r.registered_at,
      'events', jsonb_build_object(
        'id', e.id,
        'title', e.title,
        'venue', e.venue,
        'starts_at', e.starts_at,
        'ends_at', e.ends_at,
        'early_grace_minutes', e.early_grace_minutes,
        'late_grace_minutes', e.late_grace_minutes,
        'late_after_minutes', e.late_after_minutes,
        'status', e.status,
        'image_path', e.image_path,
        'image_updated_at', e.image_updated_at,
        'feedback_audience', e.feedback_audience,
        'feedback_opened_early', e.feedback_opened_early
      ),
      'attendance', case
        when a.id is not null and not a.voided and not a.is_test then
          jsonb_build_object('checked_in_at', a.checked_in_at, 'check_out_time', a.check_out_time)
        else null
      end,
      'feedback', (
        case
          when e.feedback_url is null or e.status = 'cancelled' or r.status <> 'registered' then
            jsonb_build_object('available', false, 'reason', 'unavailable')
          when p_now <= e.ends_at and not e.feedback_opened_early then
            jsonb_build_object('available', false, 'reason', 'not_ended')
          when e.feedback_audience = 'attended' and (a.id is null or a.voided or a.is_test) then
            jsonb_build_object('available', false, 'reason', 'attended_only')
          else
            jsonb_build_object('available', true, 'url', e.feedback_url, 'reason', 'eligible')
        end
      )
    ) order by r.registered_at desc
  ), '[]'::jsonb)
  into out
  from public.registrations r
  join public.events e on e.id = r.event_id
  left join public.attendance a on a.registration_id = r.id
  where r.user_id = uid;

  return out;
end $$;
grant execute on function public.my_registrations(timestamptz) to authenticated;

-- 5. Admin RPC: toggle feedback_opened_early
create or replace function public.admin_set_feedback_early(p_event_id uuid, p_open boolean)
returns void language plpgsql security definer set search_path = public as $$
declare ev public.events;
begin
  if not public.is_admin() then raise exception 'Admin only'; end if;
  update public.events set feedback_opened_early = coalesce(p_open, false) where id = p_event_id returning * into ev;
  if not found then raise exception 'Event not found'; end if;
  perform public.log_activity(
    case when ev.feedback_opened_early then 'event.feedback_opened_early' else 'event.feedback_closed_early' end,
    'event', p_event_id::text, jsonb_build_object('title', ev.title)
  );
end $$;
grant execute on function public.admin_set_feedback_early(uuid, boolean) to authenticated;

notify pgrst, 'reload schema';
