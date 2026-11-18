-- =====================================================================
-- Migration 016: Priority 1 Features
--   1. Event Organizer role ('organizer') + Role Requests queue (role_requests)
--   2. Self-scan prevention + Organizer own-event scoping
--   3. Event Eligibility Restrictions (allowed_schools, allowed_programs, allowed_year_levels)
-- Safe, repeatable migration; preserves all existing data and tests.
-- =====================================================================

-- 1. Expand profiles.role constraint to allow ('admin', 'organizer', 'user')
do $$ begin
  alter table public.profiles drop constraint if exists profiles_role_check;
  alter table public.profiles add constraint profiles_role_check
    check (role in ('admin', 'organizer', 'user'));
end $$;

create or replace function public.prevent_role_change()
returns trigger language plpgsql as $$
begin
  if new.role is distinct from old.role
     and auth.uid() is not null
     and coalesce(current_setting('eventsync.allow_role_change', true), '') <> '1' then
    raise exception 'Role cannot be changed from the client';
  end if;
  return new;
end $$;

create or replace function public.is_organizer()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid() and role = 'organizer' and status = 'active'
  );
$$;

create or replace function public.can_manage_event(p_event_id uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select public.is_admin() or exists (
    select 1 from public.events e
    where e.id = p_event_id and e.created_by = auth.uid() and public.is_organizer()
  );
$$;

-- 2. Role Requests table + RLS + RPCs
create table if not exists public.role_requests (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references public.profiles(id) on delete cascade,
  reason          text not null,
  planned_events  text not null,
  status          text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  reviewed_by     uuid references public.profiles(id) on delete set null,
  decision_reason text,
  created_at      timestamptz not null default now(),
  reviewed_at     timestamptz
);

create unique index if not exists idx_role_requests_one_pending
  on public.role_requests(user_id) where status = 'pending';

alter table public.role_requests enable row level security;

drop policy if exists role_requests_select on public.role_requests;
create policy role_requests_select on public.role_requests
  for select using (user_id = auth.uid() or public.is_admin());

grant select on public.role_requests to authenticated;

create or replace function public.request_organizer_role(
  p_reason         text,
  p_planned_events text
)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  uid  uuid := auth.uid();
  prof public.profiles;
  req  public.role_requests;
  v_reason  text := btrim(coalesce(p_reason, ''));
  v_planned text := btrim(coalesce(p_planned_events, ''));
begin
  if uid is null then raise exception 'Not authenticated'; end if;
  select * into prof from public.profiles where id = uid;
  if not found or prof.status <> 'active' then raise exception 'Active account required'; end if;
  if prof.role in ('organizer', 'admin') then
    raise exception 'Your account already has organizer or administrator privileges';
  end if;
  if coalesce(btrim(prof.full_name), '') = '' or coalesce(btrim(prof.school_id), '') = '' then
    raise exception 'Please complete your profile (full name and school ID) before requesting the organizer role';
  end if;
  if char_length(v_reason) < 5 then
    raise exception 'Please provide a brief reason for your request (at least 5 characters)';
  end if;
  if char_length(v_planned) < 3 then
    raise exception 'Please describe the events you plan to organize';
  end if;
  if exists (select 1 from public.role_requests where user_id = uid and status = 'pending') then
    raise exception 'You already have a pending organizer request';
  end if;

  insert into public.role_requests(user_id, reason, planned_events, status)
  values (uid, v_reason, v_planned, 'pending')
  returning * into req;

  perform public.log_activity(
    'role_request.submitted', 'role_request', req.id::text,
    jsonb_build_object('user_id', uid, 'email', prof.email, 'full_name', prof.full_name)
  );

  return to_jsonb(req);
end $$;
grant execute on function public.request_organizer_role(text, text) to authenticated;

create or replace function public.my_role_requests()
returns jsonb language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', r.id,
    'reason', r.reason,
    'planned_events', r.planned_events,
    'status', r.status,
    'decision_reason', r.decision_reason,
    'created_at', r.created_at,
    'reviewed_at', r.reviewed_at
  ) order by r.created_at desc), '[]'::jsonb)
  from public.role_requests r
  where r.user_id = auth.uid();
$$;
grant execute on function public.my_role_requests() to authenticated;

create or replace function public.admin_list_role_requests()
returns jsonb language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'Admin only'; end if;
  return (
    select coalesce(jsonb_agg(jsonb_build_object(
      'id', r.id,
      'user_id', r.user_id,
      'reason', r.reason,
      'planned_events', r.planned_events,
      'status', r.status,
      'decision_reason', r.decision_reason,
      'created_at', r.created_at,
      'reviewed_at', r.reviewed_at,
      'reviewer_name', rv.full_name,
      'full_name', p.full_name,
      'email', p.email,
      'school_id', p.school_id,
      'member_type', p.member_type,
      'department', p.department,
      'program', p.program,
      'major', p.major,
      'year_level', p.year_level,
      'current_role', p.role
    ) order by (case when r.status = 'pending' then 0 else 1 end), r.created_at desc), '[]'::jsonb)
    from public.role_requests r
    join public.profiles p on p.id = r.user_id
    left join public.profiles rv on rv.id = r.reviewed_by
  );
end $$;
grant execute on function public.admin_list_role_requests() to authenticated;

create or replace function public.admin_review_role_request(
  p_request_id      uuid,
  p_decision        text,
  p_decision_reason text default null
)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  req  public.role_requests;
  prof public.profiles;
  v_dec text := lower(btrim(coalesce(p_decision, '')));
  v_reason text := nullif(btrim(coalesce(p_decision_reason, '')), '');
begin
  if not public.is_admin() then raise exception 'Admin only'; end if;
  if v_dec not in ('approved', 'rejected') then
    raise exception 'Decision must be approved or rejected';
  end if;

  select * into req from public.role_requests where id = p_request_id for update;
  if not found then raise exception 'Role request not found'; end if;
  if req.user_id = auth.uid() then
    raise exception 'Admins cannot approve or reject their own requests';
  end if;
  if req.status <> 'pending' then
    raise exception 'This request has already been reviewed';
  end if;

  select * into prof from public.profiles where id = req.user_id;

  update public.role_requests
     set status          = v_dec,
         reviewed_by     = auth.uid(),
         decision_reason = v_reason,
         reviewed_at     = now()
   where id = p_request_id
   returning * into req;

  if v_dec = 'approved' and prof.role = 'user' then
    perform set_config('eventsync.allow_role_change', '1', true);
    update public.profiles set role = 'organizer' where id = req.user_id;
    perform set_config('eventsync.allow_role_change', '0', true);
  end if;

  perform public.log_activity(
    'role_request.' || v_dec, 'role_request', req.id::text,
    jsonb_build_object('user_id', req.user_id, 'email', prof.email, 'reason', v_reason)
  );

  return to_jsonb(req);
end $$;
grant execute on function public.admin_review_role_request(uuid, text, text) to authenticated;

create or replace function public.admin_set_user_role(p_user_id uuid, p_role text)
returns void language plpgsql security definer set search_path = public as $$
declare
  target public.profiles;
  v_role text := lower(btrim(coalesce(p_role, '')));
begin
  if not public.is_admin() then raise exception 'Admin only'; end if;
  if v_role not in ('user', 'organizer', 'admin') then raise exception 'Invalid role'; end if;
  if p_user_id = auth.uid() then raise exception 'You cannot change your own role'; end if;

  select * into target from public.profiles where id = p_user_id;
  if not found then raise exception 'User not found'; end if;

  perform set_config('eventsync.allow_role_change', '1', true);
  update public.profiles set role = v_role where id = p_user_id;
  perform set_config('eventsync.allow_role_change', '0', true);

  perform public.log_activity(
    'user.role_changed', 'profile', p_user_id::text,
    jsonb_build_object('email', target.email, 'old_role', target.role, 'new_role', v_role)
  );
end $$;
grant execute on function public.admin_set_user_role(uuid, text) to authenticated;

-- Update admin_list_users so admins see both participants ('user') and organizers ('organizer')
create or replace function public.admin_list_users()
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  summary jsonb;
  rows    jsonb;
begin
  if not public.is_admin() then raise exception 'Admin only'; end if;

  select jsonb_build_object(
    'total',          count(*)::int,
    'participants',   count(*) filter (where role = 'user')::int,
    'administrators', count(*) filter (where role = 'admin')::int,
    'active',         count(*) filter (where status = 'active')::int,
    'new_this_week',  count(*) filter (where created_at >= now() - interval '7 days')::int
  ) into summary
  from public.profiles;

  select coalesce(jsonb_agg(jsonb_build_object(
    'id',                   p.id,
    'full_name',            p.full_name,
    'school_id',            p.school_id,
    'email',                p.email,
    'role',                 p.role,
    'member_type',          p.member_type,
    'department',           p.department,
    'program',              p.program,
    'major',                p.major,
    'program_needs_update', p.program_needs_update,
    'course',               p.course,
    'year_level',           p.year_level,
    'section',              p.section,
    'contact_number',       p.contact_number,
    'status',               p.status,
    'must_change_password', p.must_change_password,
    'created_at',           p.created_at,
    'events_registered',    coalesce(r.reg_cnt, 0),
    'events_attended',      coalesce(a.att_cnt, 0)
  ) order by p.created_at desc), '[]'::jsonb)
  into rows
  from public.profiles p
  left join (
    select user_id, count(*)::int as reg_cnt
    from public.registrations where status = 'registered'
    group by user_id
  ) r on r.user_id = p.id
  left join (
    select user_id, count(*)::int as att_cnt
    from public.attendance
    group by user_id
  ) a on a.user_id = p.id
  where p.role in ('user', 'organizer');

  return jsonb_build_object('summary', summary, 'users', rows);
end $$;

-- 3. Event Eligibility Columns + Organizer RLS policies
alter table public.events add column if not exists allowed_schools text[];
alter table public.events add column if not exists allowed_programs text[];
alter table public.events add column if not exists allowed_year_levels smallint[];

grant select (
  id, title, description, venue, starts_at, ends_at,
  registration_opens_at, registration_deadline,
  early_grace_minutes, late_grace_minutes, late_after_minutes,
  allow_early_test_attendance, capacity, registered_count, status,
  image_path, image_updated_at,
  feedback_audience, feedback_opened_early,
  allowed_schools, allowed_programs, allowed_year_levels,
  created_by, created_at
) on public.events to authenticated;

drop policy if exists events_select on public.events;
create policy events_select on public.events
  for select using (status = 'published' or public.is_admin() or (public.is_organizer() and created_by = auth.uid()));

drop policy if exists events_organizer_write on public.events;
create policy events_organizer_write on public.events
  for all using (public.is_organizer() and created_by = auth.uid())
  with check (public.is_organizer() and created_by = auth.uid());

drop policy if exists reg_select on public.registrations;
create policy reg_select on public.registrations
  for select using (user_id = auth.uid() or public.can_manage_event(event_id));

drop policy if exists att_select on public.attendance;
create policy att_select on public.attendance
  for select using (user_id = auth.uid() or public.can_manage_event(event_id));

drop policy if exists profiles_select on public.profiles;
create policy profiles_select on public.profiles
  for select using (id = auth.uid() or public.is_admin());

-- Recreate event_stats with eligibility columns and organizer access to own events
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
       e.created_by, e.created_at,
       (select count(*) from public.attendance a
         where a.event_id = e.id and not a.voided and not a.is_test)::int as attended_count,
       (select count(*) from public.attendance a
         where a.event_id = e.id and not a.voided and a.is_test)::int as test_attended_count,
       (select count(*) from public.attendance a
         where a.event_id = e.id and a.voided)::int as voided_count
from public.events e
where e.status = 'published' or public.is_admin() or (public.is_organizer() and e.created_by = auth.uid());
grant select on public.event_stats to authenticated;

-- 4. Enforce Eligibility + Host restriction in _register_core
create or replace function public._register_core(uid uuid, p_event_id uuid, p_now timestamptz default now())
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  ev   public.events;
  reg  public.registrations;
  prof public.profiles;
  cnt  int;
  had  boolean;
begin
  select * into ev from public.events where id = p_event_id for update;
  if not found or ev.status <> 'published' then
    raise exception 'Registration is closed for this event';
  end if;
  if ev.registration_opens_at is not null and p_now < ev.registration_opens_at then
    raise exception 'Registration opens on %.', public.fmt_manila(ev.registration_opens_at);
  end if;
  if ev.registration_deadline is not null and p_now > ev.registration_deadline then
    raise exception 'Registration is closed';
  end if;
  if ev.ends_at < p_now then
    raise exception 'This event has already ended';
  end if;

  select * into prof from public.profiles where id = uid;
  if found and prof.role = 'organizer' and ev.created_by = uid then
    raise exception 'Organizers cannot register as attendees for their own event';
  end if;

  -- Eligibility checks (when configured on the event)
  if coalesce(cardinality(ev.allowed_schools), 0) > 0 then
    if not (coalesce(prof.department, '') = any(ev.allowed_schools)) then
      raise exception 'This event is restricted to: %', array_to_string(ev.allowed_schools, ', ');
    end if;
  end if;

  if coalesce(cardinality(ev.allowed_programs), 0) > 0 then
    if not (coalesce(prof.program, '') = any(ev.allowed_programs)) then
      raise exception 'This event is restricted to program(s): %', array_to_string(ev.allowed_programs, ', ');
    end if;
  end if;

  if coalesce(cardinality(ev.allowed_year_levels), 0) > 0 then
    if not (coalesce(prof.year_level, -1::smallint) = any(ev.allowed_year_levels)) then
      raise exception 'This event is restricted to year level(s): %', array_to_string(ev.allowed_year_levels, ', ');
    end if;
  end if;

  select * into reg from public.registrations where event_id = p_event_id and user_id = uid;
  had := found;
  if had and reg.status = 'registered' then
    return to_jsonb(reg) || jsonb_build_object('already_registered', true);
  end if;
  select count(*) into cnt from public.registrations where event_id = p_event_id and status = 'registered';
  if ev.capacity is not null and cnt >= ev.capacity then
    raise exception 'Event is full';
  end if;
  if had then
    update public.registrations set status = 'registered', registered_at = p_now where id = reg.id returning * into reg;
  else
    insert into public.registrations(event_id, user_id, registered_at) values (p_event_id, uid, p_now) returning * into reg;
  end if;
  perform public.log_activity('registration.created','registration',reg.id::text, jsonb_build_object('event',ev.title));
  return to_jsonb(reg) || jsonb_build_object('already_registered', false);
end $$;
revoke execute on function public._register_core(uuid, uuid, timestamptz) from public, anon, authenticated;

-- 5. Update _record_attendance, verify_attendance, sync_offline_attendance, attendance_sheet, admin_set_feedback_early
--    for Organizer own-event access and Self-Scan prevention
create or replace function public._record_attendance(
  p_qr_token      uuid,
  p_event_id      uuid,
  p_check_time    timestamptz,
  p_mode          text,
  p_clock_suspect boolean default false,
  p_direction     text default 'IN',
  p_scan_id       uuid default null
)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  reg public.registrations;
  ev  public.events;
  prof public.profiles;
  att public.attendance;
  updated_att public.attendance;
  ver public.profiles;
  ws  record;
  v_is_test boolean := false;
  v_dir text := upper(coalesce(nullif(btrim(p_direction), ''), 'IN'));
begin
  if v_dir not in ('IN', 'OUT') then
    raise exception 'Invalid scan mode: %', v_dir;
  end if;

  -- Idempotent replay check for offline sync by scan_id
  if p_scan_id is not null then
    if v_dir = 'IN' then
      select * into att from public.attendance where check_in_scan_id = p_scan_id;
      if found then
        select * into ev from public.events where id = att.event_id;
        select * into prof from public.profiles where id = att.user_id;
        return jsonb_build_object(
          'status','ok','code','OK','mode','IN','idempotent',true,
          'message', case when att.is_test then 'Test attendance recorded (outside schedule)' else 'Attendance recorded' end,
          'participant',prof.full_name,'school_id',prof.school_id,'course',prof.course,'year_level',prof.year_level,
          'event',ev.title,'checked_in_at',att.checked_in_at,'is_test',att.is_test,'clock_suspect',att.clock_suspect
        );
      end if;
    else
      select * into att from public.attendance where check_out_scan_id = p_scan_id;
      if found then
        select * into ev from public.events where id = att.event_id;
        select * into prof from public.profiles where id = att.user_id;
        return jsonb_build_object(
          'status','checked_out','code','CHECKED_OUT','mode','OUT','idempotent',true,
          'message','Time out recorded',
          'participant',prof.full_name,'school_id',prof.school_id,'course',prof.course,'year_level',prof.year_level,
          'event',ev.title,'checked_in_at',att.checked_in_at,'check_out_time',att.check_out_time,
          'is_test',att.is_test,'clock_suspect',att.clock_suspect
        );
      end if;
    end if;
  end if;

  select * into reg from public.registrations where qr_token = p_qr_token;
  if not found then
    perform public.log_activity('attendance.invalid', 'attendance', null, jsonb_build_object('mode', p_mode, 'direction', v_dir));
    return jsonb_build_object('status','invalid','code','INVALID_QR','mode',v_dir,'message','This code is not an EventSync pass.');
  end if;

  select * into ev from public.events where id = reg.event_id;
  select * into prof from public.profiles where id = reg.user_id;

  -- Organizer scope: can only scan for their own events
  if public.is_organizer() and not public.is_admin() and ev.created_by is distinct from auth.uid() then
    raise exception 'Organizers can only scan attendance for their own events';
  end if;

  -- Self-scan prevention: no user can scan their own QR pass
  if auth.uid() is not null and reg.user_id = auth.uid() then
    return jsonb_build_object(
      'status','self_scan','code','SELF_SCAN_NOT_ALLOWED','mode',v_dir,
      'message','You cannot scan your own QR pass. Ask another organizer or admin to verify you.',
      'participant',prof.full_name,'school_id',prof.school_id,'course',prof.course,'year_level',prof.year_level,
      'event',ev.title
    );
  end if;

  if p_event_id is not null and reg.event_id <> p_event_id then
    return jsonb_build_object(
      'status','wrong_event','code','WRONG_EVENT','mode',v_dir,
      'message','This QR pass belongs to ' || ev.title || '.',
      'participant',prof.full_name,'school_id',prof.school_id,'course',prof.course,'year_level',prof.year_level,
      'event',ev.title
    );
  end if;

  if reg.status <> 'registered' then
    return jsonb_build_object(
      'status','cancelled','code','REGISTRATION_CANCELLED','mode',v_dir,
      'message','This registration was cancelled.',
      'participant',prof.full_name,'school_id',prof.school_id,'course',prof.course,'year_level',prof.year_level,
      'event',ev.title
    );
  end if;

  select * into ws from public.get_attendance_state(ev, p_check_time);

  if ws.state = 'CANCELLED' and not ev.allow_early_test_attendance then
    return jsonb_build_object(
      'status','cancelled','code','EVENT_CANCELLED','mode',v_dir,
      'message','This event has been cancelled.',
      'participant',prof.full_name,'school_id',prof.school_id,'course',prof.course,'year_level',prof.year_level,
      'event',ev.title,'opensAt',ws.opens_at,'closesAt',ws.closes_at
    );
  elsif ws.state = 'NOT_STARTED' and not ev.allow_early_test_attendance then
    return jsonb_build_object(
      'status','not_started','code','EVENT_NOT_STARTED','mode',v_dir,
      'message','Attendance opens on ' || public.fmt_manila(ws.opens_at) || '.',
      'participant',prof.full_name,'school_id',prof.school_id,'course',prof.course,'year_level',prof.year_level,
      'event',ev.title,'opensAt',ws.opens_at,'closesAt',ws.closes_at
    );
  elsif ws.state = 'ENDED' and not ev.allow_early_test_attendance then
    return jsonb_build_object(
      'status','ended','code','EVENT_ENDED','mode',v_dir,
      'message','This event ended on ' || public.fmt_manila(ev.ends_at) || '.',
      'participant',prof.full_name,'school_id',prof.school_id,'course',prof.course,'year_level',prof.year_level,
      'event',ev.title,'opensAt',ws.opens_at,'closesAt',ws.closes_at,'endsAt',ev.ends_at
    );
  end if;

  if ev.allow_early_test_attendance and ws.state <> 'OPEN' then
    v_is_test := true;
  end if;

  -- ---------- MODE: OUT ----------
  if v_dir = 'OUT' then
    select * into att from public.attendance where registration_id = reg.id;
    if not found or att.voided then
      return jsonb_build_object(
        'status','no_time_in','code','NO_TIME_IN_RECORDED','mode','OUT',
        'message','No time-in recorded for this pass yet.',
        'participant',prof.full_name,'school_id',prof.school_id,'course',prof.course,'year_level',prof.year_level,
        'event',ev.title
      );
    end if;

    if p_check_time < att.checked_in_at then
      return jsonb_build_object(
        'status','error','code','INVALID_TIME_OUT','mode','OUT',
        'message','Time-out cannot be earlier than time-in.',
        'participant',prof.full_name,'school_id',prof.school_id,'course',prof.course,'year_level',prof.year_level,
        'event',ev.title,'checked_in_at',att.checked_in_at
      );
    end if;

    update public.attendance
       set check_out_time         = p_check_time,
           check_out_scan_id      = coalesce(p_scan_id, check_out_scan_id),
           checked_out_by_user_id = auth.uid()
     where id = att.id
       and check_out_time is null
       and not voided
    returning * into updated_att;

    if updated_att.id is null then
      select * into att from public.attendance where id = att.id;
      select * into ver from public.profiles where id = att.checked_out_by_user_id;
      return jsonb_build_object(
        'status','already_checked_out','code','ALREADY_CHECKED_OUT','mode','OUT',
        'message','Already checked out',
        'participant',prof.full_name,'school_id',prof.school_id,'course',prof.course,'year_level',prof.year_level,
        'event',ev.title,'checked_in_at',att.checked_in_at,'check_out_time',att.check_out_time,
        'verified_by_name', coalesce(ver.full_name, ver.email, 'Scanner station')
      );
    end if;

    perform public.log_activity(
      'attendance.checked_out', 'attendance', updated_att.id::text,
      jsonb_build_object('participant', prof.full_name, 'event', ev.title, 'mode', p_mode, 'is_test', updated_att.is_test)
    );

    return jsonb_build_object(
      'status','checked_out','code','CHECKED_OUT','mode','OUT',
      'message', case when updated_att.is_test then 'Test time-out recorded' else 'Time out recorded' end,
      'participant',prof.full_name,'school_id',prof.school_id,'course',prof.course,'year_level',prof.year_level,
      'event',ev.title,'checked_in_at',updated_att.checked_in_at,'check_out_time',updated_att.check_out_time,
      'is_test',updated_att.is_test,'clock_suspect',p_clock_suspect
    );
  end if;

  -- ---------- MODE: IN ----------
  select * into att from public.attendance where registration_id = reg.id;
  if found and not att.voided then
    select * into ver from public.profiles where id = att.verified_by;
    return jsonb_build_object(
      'status','duplicate','code','ALREADY_CHECKED_IN','mode','IN',
      'message','Already checked in',
      'participant',prof.full_name,'school_id',prof.school_id,'course',prof.course,'year_level',prof.year_level,
      'event',ev.title,'checked_in_at',att.checked_in_at,'is_test',att.is_test,
      'verified_by_name', coalesce(ver.full_name, ver.email, 'Scanner station')
    );
  elsif found and att.voided then
    update public.attendance
       set checked_in_at          = p_check_time,
           verified_by            = auth.uid(),
           check_in_scan_id       = p_scan_id,
           check_out_time         = null,
           check_out_scan_id      = null,
           checked_out_by_user_id = null,
           is_test                = v_is_test,
           clock_suspect          = p_clock_suspect,
           voided                 = false,
           void_reason            = null,
           voided_by              = null,
           voided_at              = null
     where id = att.id
     returning * into att;
  else
    insert into public.attendance(registration_id, event_id, user_id, verified_by, checked_in_at, check_in_scan_id, is_test, clock_suspect)
    values (reg.id, reg.event_id, reg.user_id, auth.uid(), p_check_time, p_scan_id, v_is_test, p_clock_suspect)
    on conflict (registration_id) do nothing
    returning * into att;

    if att.id is null then
      select * into att from public.attendance where registration_id = reg.id;
      select * into ver from public.profiles where id = att.verified_by;
      return jsonb_build_object(
        'status','duplicate','code','ALREADY_CHECKED_IN','mode','IN',
        'message','Already checked in',
        'participant',prof.full_name,'school_id',prof.school_id,'course',prof.course,'year_level',prof.year_level,
        'event',ev.title,'checked_in_at',att.checked_in_at,'is_test',att.is_test,
        'verified_by_name', coalesce(ver.full_name, ver.email, 'Scanner station')
      );
    end if;
  end if;

  perform public.log_activity(
    case when v_is_test then 'attendance.test_verified' else 'attendance.verified' end,
    'attendance', att.id::text,
    jsonb_build_object('participant', prof.full_name, 'event', ev.title, 'mode', p_mode, 'is_test', v_is_test, 'clock_suspect', p_clock_suspect)
  );

  return jsonb_build_object(
    'status','ok','code','OK','mode','IN',
    'message', case when v_is_test then 'Test attendance recorded (outside schedule)' else 'Attendance recorded' end,
    'participant',prof.full_name,'school_id',prof.school_id,'course',prof.course,'year_level',prof.year_level,
    'event',ev.title,'checked_in_at',att.checked_in_at,
    'is_test',att.is_test,'clock_suspect',p_clock_suspect
  );
end $$;
revoke execute on function public._record_attendance(uuid, uuid, timestamptz, text, boolean, text, uuid) from public, anon, authenticated;

create or replace function public.verify_attendance(
  p_qr_token  uuid,
  p_event_id  uuid default null,
  p_now       timestamptz default now(),
  p_mode      text default 'scan',
  p_direction text default 'IN'
)
returns jsonb language plpgsql security definer set search_path = public as $$
begin
  if not (public.is_admin() or public.is_organizer()) then
    raise exception 'Only admins and organizers can verify attendance';
  end if;
  return public._record_attendance(p_qr_token, p_event_id, coalesce(p_now, now()), coalesce(p_mode, 'scan'), false, p_direction, null);
end $$;
grant execute on function public.verify_attendance(uuid, uuid, timestamptz, text, text) to authenticated;

create or replace function public.attendance_sheet(
  p_event_id     uuid,
  p_filter       text default 'all',
  p_format       text default null,
  p_include_test boolean default false,
  p_now          timestamptz default now()
)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  ev public.events;
  reg int;
  pres int;
  late_cnt int;
  out_cnt int;
  rows jsonb;
  ws record;
  v_absent_label text;
begin
  if not public.can_manage_event(p_event_id) then
    raise exception 'Only administrators or the event organizer can export attendance';
  end if;
  if p_filter not in ('all','present') then raise exception 'Invalid filter'; end if;
  select * into ev from public.events where id = p_event_id;
  if not found then raise exception 'Event not found'; end if;

  select * into ws from public.get_attendance_state(ev, coalesce(p_now, now()));
  v_absent_label := case when ws.state = 'ENDED' then 'Absent' else 'Pending' end;

  select count(*) filter (where r.status = 'registered'),
         count(*) filter (where r.status = 'registered' and a.id is not null and not a.voided and (p_include_test or not a.is_test)),
         count(*) filter (
           where r.status = 'registered' and a.id is not null and not a.voided and (p_include_test or not a.is_test)
             and public.is_late_checkin(ev.starts_at, a.checked_in_at, ev.late_after_minutes)
         ),
         count(*) filter (
           where r.status = 'registered' and a.id is not null and not a.voided and (p_include_test or not a.is_test)
             and a.check_out_time is not null
         )
    into reg, pres, late_cnt, out_cnt
    from public.registrations r
    left join public.attendance a on a.registration_id = r.id
   where r.event_id = p_event_id;

  select coalesce(jsonb_agg(jsonb_build_object(
           'full_name', s.full_name, 'school_id', s.school_id,
           'department', s.department, 'program', s.program, 'major', s.major,
           'program_needs_update', s.program_needs_update,
           'course', s.course, 'year_level', s.year_level,
           'member_type', s.member_type, 'time_in', s.checked_in_at,
           'time_out', s.check_out_time,
           'present', s.present, 'is_late', s.is_late, 'is_test', s.is_test, 'status_label', s.status_label
         ) order by s.ln, s.lf), '[]'::jsonb)
    into rows
    from (select p.full_name, p.school_id, p.department, p.program, p.major, p.program_needs_update,
                 p.course, p.year_level, p.member_type,
                 case when a.id is not null and not a.voided and (p_include_test or not a.is_test) then a.checked_in_at else null end as checked_in_at,
                 case when a.id is not null and not a.voided and (p_include_test or not a.is_test) then a.check_out_time else null end as check_out_time,
                 (a.id is not null and not a.voided and (p_include_test or not a.is_test)) as present,
                 (a.id is not null and not a.voided and (p_include_test or not a.is_test)
                  and public.is_late_checkin(ev.starts_at, a.checked_in_at, ev.late_after_minutes)) as is_late,
                 coalesce(a.is_test, false) as is_test,
                 case
                   when a.id is not null and not a.voided and (p_include_test or not a.is_test) then
                     case when public.is_late_checkin(ev.starts_at, a.checked_in_at, ev.late_after_minutes)
                          then 'Present (Late)' else 'Present' end
                   else v_absent_label
                 end as status_label,
                 lower(regexp_replace(btrim(p.full_name), '^.*\s', '')) as ln,
                 lower(p.full_name) as lf
            from public.registrations r
            join public.profiles p on p.id = r.user_id
            left join public.attendance a on a.registration_id = r.id
           where r.event_id = p_event_id and r.status = 'registered'
             and (p_filter = 'all' or (a.id is not null and not a.voided and (p_include_test or not a.is_test)))) s;

  if p_format is not null then
    perform public.log_activity('report.exported', 'report', p_event_id::text,
            jsonb_build_object('event', ev.title, 'format', p_format, 'filter', p_filter, 'include_test', p_include_test, 'rows', jsonb_array_length(rows)));
  end if;

  return jsonb_build_object(
    'event', jsonb_build_object(
      'id', ev.id, 'title', ev.title, 'starts_at', ev.starts_at, 'ends_at', ev.ends_at,
      'venue', ev.venue, 'late_after_minutes', ev.late_after_minutes,
      'attendance_state', ws.state, 'opens_at', ws.opens_at, 'closes_at', ws.closes_at
    ),
    'filter', p_filter,
    'include_test', p_include_test,
    'rows', rows,
    'totals', jsonb_build_object(
      'registered', reg, 'present', pres, 'late', late_cnt, 'timed_out', out_cnt,
      'absent', case when ws.state = 'ENDED' then reg - pres else 0 end,
      'pending', case when ws.state = 'ENDED' then 0 else reg - pres end
    )
  );
end $$;

create or replace function public.admin_set_feedback_early(p_event_id uuid, p_open boolean)
returns void language plpgsql security definer set search_path = public as $$
declare ev public.events;
begin
  if not public.can_manage_event(p_event_id) then raise exception 'Admin or event organizer only'; end if;
  update public.events set feedback_opened_early = coalesce(p_open, false) where id = p_event_id returning * into ev;
  if not found then raise exception 'Event not found'; end if;
  perform public.log_activity(
    case when ev.feedback_opened_early then 'event.feedback_opened_early' else 'event.feedback_closed_early' end,
    'event', p_event_id::text, jsonb_build_object('title', ev.title)
  );
end $$;

notify pgrst, 'reload schema';
