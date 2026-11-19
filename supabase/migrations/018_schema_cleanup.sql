-- =====================================================================
-- Migration 018: Schema Cleanup
--   - Drop unused profiles.phone column (superseded by contact_number)
--   - Drop unused events.signatory_1_* and signatory_2_* columns
--     (signatures are baked into uploaded certificate designs)
--   - Add CHECK (ends_at > starts_at) constraint on public.events
-- Safe, repeatable migration; preserves all active data and tests.
-- =====================================================================

-- 1. Recreate event_stats without the dropped signatory columns
drop view if exists public.event_stats;
create view public.event_stats as
select e.id, e.title, e.description, e.venue, e.starts_at, e.ends_at,
       e.registration_opens_at, e.registration_deadline,
       e.early_grace_minutes, e.late_grace_minutes, e.late_after_minutes,
       e.allow_early_test_attendance, e.capacity, e.registered_count, e.status,
       e.image_path, e.image_updated_at,
       case when public.is_admin() or (public.is_organizer() and e.created_by = auth.uid()) then e.feedback_url else null end as feedback_url,
       (e.feedback_url is not null) as has_feedback_url,
       e.feedback_audience, e.feedback_opened_early,
       e.allowed_schools, e.allowed_programs, e.allowed_year_levels,
       e.certificates_enabled, e.certificate_template_id, e.organizing_office,
       e.created_by, e.created_at,
       (select count(*) from public.attendance a
         where a.event_id = e.id and not a.voided and not a.is_test)::int as attended_count,
       (select count(*) from public.attendance a
         where a.event_id = e.id and not a.voided and a.is_test)::int as test_attended_count,
       (select count(*) from public.attendance a
         where a.event_id = e.id and a.voided)::int as voided_count,
       (select count(*) from public.certificates c
         where c.event_id = e.id and c.status = 'valid')::int as certificates_issued_count
from public.events e
where e.status = 'published' or public.is_admin() or (public.is_organizer() and e.created_by = auth.uid());
grant select on public.event_stats to authenticated;

-- 2. Update issue_my_certificate so it does not reference dropped signatory columns
create or replace function public.issue_my_certificate(
  p_event_id uuid,
  p_now      timestamptz default now()
)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  uid   uuid := auth.uid();
  ev    public.events;
  reg   public.registrations;
  att   public.attendance;
  prof  public.profiles;
  tpl   public.certificate_templates;
  cert  public.certificates;
  org_p public.profiles;
  v_code text;
  v_date_str text;
  v_office text;
  v_snap jsonb;
begin
  if uid is null then raise exception 'Not authenticated'; end if;

  select * into ev from public.events where id = p_event_id;
  if not found then raise exception 'Event not found'; end if;

  select * into prof from public.profiles where id = uid;
  if not found then raise exception 'Profile not found'; end if;

  if ev.created_by = uid and prof.role = 'organizer' then
    raise exception 'Organizers cannot receive an attendee certificate for their own event';
  end if;

  select * into cert from public.certificates where user_id = uid and event_id = p_event_id for update;
  if found then
    if cert.status = 'revoked' then
      raise exception 'This certificate has been revoked (%). Contact an administrator.', coalesce(cert.revoke_reason, 'no reason specified');
    end if;
    return to_jsonb(cert);
  end if;

  if not ev.certificates_enabled then
    raise exception 'Certificates are not enabled for this event';
  end if;

  if ev.status = 'cancelled' then
    raise exception 'This event was cancelled';
  end if;

  if coalesce(p_now, now()) <= ev.ends_at then
    raise exception 'Certificates become available after the event ends on %.', public.fmt_manila(ev.ends_at);
  end if;

  select * into reg from public.registrations
   where event_id = p_event_id and user_id = uid and status = 'registered'
   for update;
  if not found then
    raise exception 'You do not have an active registration for this event';
  end if;

  select * into att from public.attendance
   where registration_id = reg.id and not voided and not is_test;
  if not found then
    raise exception 'No valid attendance record found for this event';
  end if;

  if ev.certificate_template_id is not null then
    select * into tpl from public.certificate_templates where id = ev.certificate_template_id;
  end if;
  if tpl.id is null then
    select * into tpl from public.certificate_templates where id = '00000000-0000-0000-0000-00000000ce01'::uuid;
  end if;

  select * into org_p from public.profiles where id = ev.created_by;
  v_code := public.generate_certificate_code(coalesce(p_now, now()));
  v_date_str := public.fmt_event_date_range(ev.starts_at, ev.ends_at);
  v_office := coalesce(nullif(btrim(ev.organizing_office), ''), org_p.department, 'BiPSU Main Campus');

  v_snap := jsonb_build_object(
    'template_id', tpl.id,
    'template_name', tpl.name,
    'template_version', tpl.version,
    'file_path', tpl.file_path,
    'mime_type', tpl.mime_type,
    'width', tpl.width,
    'height', tpl.height,
    'fields', tpl.layout,
    'values', jsonb_build_object(
      'participant_name', coalesce(nullif(btrim(prof.full_name), ''), prof.email),
      'event_name', ev.title,
      'event_date', v_date_str,
      'venue', ev.venue,
      'organizing_office', v_office,
      'program', coalesce(prof.program, prof.course, ''),
      'school', coalesce(prof.department, ''),
      'year_level', case when prof.year_level is not null then 'Year ' || prof.year_level::text else '' end,
      'section', coalesce(prof.section, ''),
      'issue_date', trim(to_char(coalesce(p_now, now()) at time zone 'Asia/Manila', 'Mon FMDD, YYYY')),
      'signatory_1_name', coalesce(org_p.full_name, 'Event Organizer'),
      'signatory_1_title', 'Event Organizer',
      'signatory_2_name', 'EventSync Verification',
      'signatory_2_title', 'BiPSU Main Campus',
      'certificate_id', v_code,
      'qr_code', v_code
    )
  );

  insert into public.certificates (
    certificate_code, user_id, event_id, template_id, template_version,
    layout_snapshot, issued_at, status,
    name_at_issuance, event_name_at_issuance, event_date_at_issuance
  )
  values (
    v_code, uid, p_event_id, tpl.id, tpl.version,
    v_snap, coalesce(p_now, now()), 'valid',
    coalesce(nullif(btrim(prof.full_name), ''), prof.email),
    ev.title,
    v_date_str
  )
  on conflict (user_id, event_id) do update
    set user_id = excluded.user_id
  returning * into cert;

  perform public.log_activity(
    'certificate.issued', 'certificate', cert.id::text,
    jsonb_build_object('certificate_code', cert.certificate_code, 'event_id', p_event_id, 'user_id', uid)
  );

  return to_jsonb(cert);
end $$;

-- 3. Drop unused columns from public.events and public.profiles
alter table public.events drop column if exists signatory_1_name;
alter table public.events drop column if exists signatory_1_title;
alter table public.events drop column if exists signatory_1_sig_path;
alter table public.events drop column if exists signatory_2_name;
alter table public.events drop column if exists signatory_2_title;
alter table public.events drop column if exists signatory_2_sig_path;

alter table public.profiles drop column if exists phone;

-- Re-apply clean column-level UPDATE grant on public.profiles (without dropped phone column)
revoke update on public.profiles from authenticated;
grant update (full_name, contact_number, member_type, department, program, major, course, program_needs_update, year_level, section) on public.profiles to authenticated;

-- 4. Add ends_at > starts_at CHECK constraint on public.events
do $$ begin
  alter table public.events drop constraint if exists events_ends_after_starts_check;
  alter table public.events add constraint events_ends_after_starts_check check (ends_at > starts_at);
end $$;

notify pgrst, 'reload schema';
