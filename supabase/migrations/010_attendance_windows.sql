-- =====================================================================
-- Migration 010: Separate Registration & Attendance Windows,
-- Test Mode Override, Offline Sync Validation, and Voided Check-ins
-- =====================================================================

-- 1. Events schedule & grace columns
alter table public.events add column if not exists registration_opens_at timestamptz;
alter table public.events add column if not exists early_grace_minutes int not null default 60;
alter table public.events add column if not exists late_grace_minutes int not null default 60;
alter table public.events add column if not exists allow_early_test_attendance boolean not null default false;

do $$ begin
  alter table public.events drop constraint if exists events_status_check;
  alter table public.events add constraint events_status_check
    check (status in ('draft', 'published', 'closed', 'cancelled'));
  alter table public.events drop constraint if exists events_grace_check;
  alter table public.events add constraint events_grace_check
    check (early_grace_minutes between 0 and 1440 and late_grace_minutes between 0 and 1440);
  alter table public.events drop constraint if exists events_reg_window_check;
  alter table public.events add constraint events_reg_window_check
    check (
      (registration_opens_at is null or registration_deadline is null or registration_opens_at <= registration_deadline)
      and (registration_deadline is null or registration_deadline <= ends_at)
    );
end $$;

-- 2. Attendance flags for test mode, offline clock suspicion, and voiding
alter table public.attendance add column if not exists is_test boolean not null default false;
alter table public.attendance add column if not exists clock_suspect boolean not null default false;
alter table public.attendance add column if not exists voided boolean not null default false;
alter table public.attendance add column if not exists void_reason text;
alter table public.attendance add column if not exists voided_by uuid references public.profiles(id) on delete set null;
alter table public.attendance add column if not exists voided_at timestamptz;

-- 3. Update event_stats view: attended_count excludes voided & test records
drop view if exists public.event_stats;
create view public.event_stats as
select e.*,
       (select count(*) from public.attendance a
         where a.event_id = e.id and not a.voided and not a.is_test)::int as attended_count,
       (select count(*) from public.attendance a
         where a.event_id = e.id and not a.voided and a.is_test)::int as test_attended_count,
       (select count(*) from public.attendance a
         where a.event_id = e.id and a.voided)::int as voided_count
from public.events e
where e.status = 'published' or public.is_admin();
grant select on public.event_stats to authenticated;

-- 4. Log test-mode toggle on events
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

    if new.allow_early_test_attendance is distinct from old.allow_early_test_attendance then
      perform public.log_activity(
        case when new.allow_early_test_attendance then 'event.test_mode_enabled' else 'event.test_mode_disabled' end,
        'event', new.id::text, jsonb_build_object('title', new.title));
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

    non_image_changed := (to_jsonb(new) - 'registered_count' - 'image_path' - 'image_updated_at' - 'allow_early_test_attendance')
                         is distinct from
                         (to_jsonb(old) - 'registered_count' - 'image_path' - 'image_updated_at' - 'allow_early_test_attendance');

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

-- 5. Manila time formatter + single server-side get_attendance_state()
create or replace function public.fmt_manila(p_ts timestamptz)
returns text language sql immutable as $$
  select trim(to_char(p_ts at time zone 'Asia/Manila', 'Mon FMDD, YYYY, FMHH12:MI AM'));
$$;

create or replace function public.get_attendance_state(
  p_event public.events,
  p_now   timestamptz default now()
)
returns table (state text, opens_at timestamptz, closes_at timestamptz)
language plpgsql immutable as $$
declare
  v_opens  timestamptz := p_event.starts_at - make_interval(mins => coalesce(p_event.early_grace_minutes, 60));
  v_closes timestamptz := p_event.ends_at   + make_interval(mins => coalesce(p_event.late_grace_minutes, 60));
begin
  if p_event.status = 'cancelled' then
    return query select 'CANCELLED'::text, v_opens, v_closes;
  elsif p_now < v_opens then
    return query select 'NOT_STARTED'::text, v_opens, v_closes;
  elsif p_now > v_closes then
    return query select 'ENDED'::text, v_opens, v_closes;
  else
    return query select 'OPEN'::text, v_opens, v_closes;
  end if;
end $$;

-- 6. Enforce separate Registration Window (registration_opens_at .. registration_deadline)
drop function if exists public._register_core(uuid, uuid);
create or replace function public._register_core(uid uuid, p_event_id uuid, p_now timestamptz default now())
returns jsonb language plpgsql security definer set search_path = public as $$
declare ev public.events; reg public.registrations; cnt int; had boolean;
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

drop function if exists public.register_for_event(uuid);
create or replace function public.register_for_event(p_event_id uuid, p_now timestamptz default now())
returns jsonb language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'Not authenticated'; end if;
  return public._register_core(auth.uid(), p_event_id, p_now);
end $$;
grant execute on function public.register_for_event(uuid, timestamptz) to authenticated;

drop function if exists public.admin_register_user_for_event(uuid, uuid);
create or replace function public.admin_register_user_for_event(p_user_id uuid, p_event_id uuid, p_now timestamptz default now())
returns jsonb language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'Admin only'; end if;
  return public._register_core(p_user_id, p_event_id, p_now);
end $$;
grant execute on function public.admin_register_user_for_event(uuid, uuid, timestamptz) to authenticated;

-- 7. Core attendance recorder used by scan, manual, and offline sync
create or replace function public._record_attendance(
  p_qr_token      uuid,
  p_event_id      uuid,
  p_check_time    timestamptz,
  p_mode          text,
  p_clock_suspect boolean default false
)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  reg public.registrations;
  ev  public.events;
  prof public.profiles;
  att public.attendance;
  ws  record;
  v_is_test boolean := false;
begin
  select * into reg from public.registrations where qr_token = p_qr_token;
  if not found then
    perform public.log_activity('attendance.invalid', 'attendance', null, jsonb_build_object('mode', p_mode));
    return jsonb_build_object('status','invalid','code','INVALID_QR','message','QR code not recognised');
  end if;

  select * into ev from public.events where id = reg.event_id;
  select * into prof from public.profiles where id = reg.user_id;

  if p_event_id is not null and reg.event_id <> p_event_id then
    return jsonb_build_object(
      'status','wrong_event','code','WRONG_EVENT',
      'message','This QR pass is for ' || ev.title,
      'participant',prof.full_name,'event',ev.title
    );
  end if;

  if reg.status <> 'registered' then
    return jsonb_build_object(
      'status','cancelled','code','REGISTRATION_CANCELLED',
      'message','Registration was cancelled','participant',prof.full_name,'event',ev.title
    );
  end if;

  select * into ws from public.get_attendance_state(ev, p_check_time);

  if ws.state = 'CANCELLED' and not ev.allow_early_test_attendance then
    return jsonb_build_object(
      'status','cancelled','code','EVENT_CANCELLED',
      'message','This event has been cancelled.',
      'participant',prof.full_name,'event',ev.title,'opensAt',ws.opens_at,'closesAt',ws.closes_at
    );
  elsif ws.state = 'NOT_STARTED' and not ev.allow_early_test_attendance then
    return jsonb_build_object(
      'status','not_started','code','EVENT_NOT_STARTED',
      'message','Attendance opens on ' || public.fmt_manila(ws.opens_at) || '.',
      'participant',prof.full_name,'event',ev.title,'opensAt',ws.opens_at,'closesAt',ws.closes_at
    );
  elsif ws.state = 'ENDED' and not ev.allow_early_test_attendance then
    return jsonb_build_object(
      'status','ended','code','EVENT_ENDED',
      'message','Attendance for this event is closed.',
      'participant',prof.full_name,'event',ev.title,'opensAt',ws.opens_at,'closesAt',ws.closes_at
    );
  end if;

  if ev.allow_early_test_attendance and ws.state <> 'OPEN' then
    v_is_test := true;
  end if;

  -- Check existing attendance row (respecting voided rows)
  select * into att from public.attendance where registration_id = reg.id;
  if found and not att.voided then
    return jsonb_build_object(
      'status','duplicate','code','ALREADY_CHECKED_IN',
      'message','Already checked in','participant',prof.full_name,
      'event',ev.title,'checked_in_at',att.checked_in_at,'is_test',att.is_test
    );
  elsif found and att.voided then
    update public.attendance
       set checked_in_at = p_check_time,
           verified_by   = auth.uid(),
           is_test       = v_is_test,
           clock_suspect = p_clock_suspect,
           voided        = false,
           void_reason   = null,
           voided_by     = null,
           voided_at     = null
     where id = att.id
     returning * into att;
  else
    insert into public.attendance(registration_id, event_id, user_id, verified_by, checked_in_at, is_test, clock_suspect)
    values (reg.id, reg.event_id, reg.user_id, auth.uid(), p_check_time, v_is_test, p_clock_suspect)
    on conflict (registration_id) do nothing
    returning * into att;

    if att.id is null then
      select * into att from public.attendance where registration_id = reg.id;
      return jsonb_build_object(
        'status','duplicate','code','ALREADY_CHECKED_IN',
        'message','Already checked in','participant',prof.full_name,
        'event',ev.title,'checked_in_at',att.checked_in_at,'is_test',att.is_test
      );
    end if;
  end if;

  perform public.log_activity(
    case when v_is_test then 'attendance.test_verified' else 'attendance.verified' end,
    'attendance', att.id::text,
    jsonb_build_object('participant', prof.full_name, 'event', ev.title, 'mode', p_mode, 'is_test', v_is_test, 'clock_suspect', p_clock_suspect)
  );

  return jsonb_build_object(
    'status','ok','code','OK',
    'message', case when v_is_test then 'Test attendance recorded (outside schedule)' else 'Attendance recorded' end,
    'participant',prof.full_name,'event',ev.title,'checked_in_at',att.checked_in_at,
    'is_test',att.is_test,'clock_suspect',att.clock_suspect
  );
end $$;
revoke execute on function public._record_attendance(uuid, uuid, timestamptz, text, boolean) from public, anon, authenticated;

-- 8. Scan & Manual RPC
drop function if exists public.verify_attendance(uuid);
create or replace function public.verify_attendance(
  p_qr_token uuid,
  p_event_id uuid default null,
  p_now      timestamptz default now(),
  p_mode     text default 'scan'
)
returns jsonb language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'Only admins can verify attendance'; end if;
  return public._record_attendance(p_qr_token, p_event_id, coalesce(p_now, now()), coalesce(p_mode, 'scan'), false);
end $$;
grant execute on function public.verify_attendance(uuid, uuid, timestamptz, text) to authenticated;

-- 9. Offline Sync RPC: validates scanned_at against attendance window + rejects future timestamps
create or replace function public.sync_offline_attendance(
  p_items jsonb,
  p_now   timestamptz default now()
)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  item jsonb;
  v_tok uuid;
  v_ev  uuid;
  v_scanned timestamptz;
  v_suspect boolean;
  res jsonb;
  out jsonb := '[]'::jsonb;
begin
  if not public.is_admin() then raise exception 'Only admins can sync offline attendance'; end if;
  for item in select * from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) loop
    begin
      v_tok := (item->>'qr_token')::uuid;
      v_ev  := nullif(item->>'event_id', '')::uuid;
      v_scanned := (item->>'scanned_at')::timestamptz;
    exception when others then
      out := out || jsonb_build_array(jsonb_build_object(
        'qr_token', item->>'qr_token', 'status', 'invalid', 'code', 'INVALID_ITEM', 'message', 'Invalid queued scan format'
      ));
      continue;
    end;

    if v_scanned is null then
      out := out || jsonb_build_array(jsonb_build_object(
        'qr_token', v_tok, 'status', 'invalid', 'code', 'MISSING_SCANNED_AT', 'message', 'Missing scannedAt timestamp'
      ));
      continue;
    end if;

    if v_scanned > p_now + interval '2 minutes' then
      out := out || jsonb_build_array(jsonb_build_object(
        'qr_token', v_tok, 'status', 'error', 'code', 'FUTURE_TIMESTAMP',
        'message', 'Scan timestamp is in the future relative to server clock'
      ));
      continue;
    end if;

    v_suspect := abs(extract(epoch from (p_now - v_scanned))) > 3600;
    res := public._record_attendance(v_tok, v_ev, v_scanned, 'offline_sync', v_suspect);
    out := out || jsonb_build_array(res || jsonb_build_object('qr_token', v_tok, 'scanned_at', v_scanned));
  end loop;
  return out;
end $$;
grant execute on function public.sync_offline_attendance(jsonb, timestamptz) to authenticated;

-- 10. Admin void / restore / clear-test RPCs
create or replace function public.admin_void_attendance(p_attendance_id uuid, p_reason text default 'Voided by administrator')
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'Admin only'; end if;
  update public.attendance
     set voided = true,
         void_reason = coalesce(nullif(btrim(p_reason), ''), 'Voided by administrator'),
         voided_by = auth.uid(),
         voided_at = now()
   where id = p_attendance_id;
  if not found then raise exception 'Attendance record not found'; end if;
  perform public.log_activity('attendance.voided', 'attendance', p_attendance_id::text, jsonb_build_object('reason', p_reason));
end $$;
grant execute on function public.admin_void_attendance(uuid, text) to authenticated;

create or replace function public.admin_restore_attendance(p_attendance_id uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'Admin only'; end if;
  update public.attendance
     set voided = false,
         void_reason = null,
         voided_by = null,
         voided_at = null
   where id = p_attendance_id;
  if not found then raise exception 'Attendance record not found'; end if;
  perform public.log_activity('attendance.restored', 'attendance', p_attendance_id::text, '{}'::jsonb);
end $$;
grant execute on function public.admin_restore_attendance(uuid) to authenticated;

create or replace function public.admin_clear_test_attendance(p_event_id uuid)
returns int language plpgsql security definer set search_path = public as $$
declare cnt int;
begin
  if not public.is_admin() then raise exception 'Admin only'; end if;
  delete from public.attendance where event_id = p_event_id and is_test = true;
  get diagnostics cnt = row_count;
  perform public.log_activity('attendance.test_cleared', 'event', p_event_id::text, jsonb_build_object('deleted_count', cnt));
  return cnt;
end $$;
grant execute on function public.admin_clear_test_attendance(uuid) to authenticated;

-- 11. Update attendance_sheet: exclude voided always, exclude test by default, Pending vs Absent
drop function if exists public.attendance_sheet(uuid, text, text);
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
  rows jsonb;
  ws record;
  v_absent_label text;
begin
  if not public.is_admin() then raise exception 'Only administrators can export attendance'; end if;
  if p_filter not in ('all','present') then raise exception 'Invalid filter'; end if;
  select * into ev from public.events where id = p_event_id;
  if not found then raise exception 'Event not found'; end if;

  select * into ws from public.get_attendance_state(ev, coalesce(p_now, now()));
  v_absent_label := case when ws.state = 'ENDED' then 'Absent' else 'Pending' end;

  select count(*) filter (where r.status = 'registered'),
         count(*) filter (where r.status = 'registered' and a.id is not null and not a.voided and (p_include_test or not a.is_test))
    into reg, pres
    from public.registrations r
    left join public.attendance a on a.registration_id = r.id
   where r.event_id = p_event_id;

  select coalesce(jsonb_agg(jsonb_build_object(
           'full_name', s.full_name, 'school_id', s.school_id,
           'department', s.department, 'program', s.program, 'major', s.major,
           'program_needs_update', s.program_needs_update,
           'course', s.course, 'year_level', s.year_level,
           'member_type', s.member_type, 'time_in', s.checked_in_at,
           'present', s.present, 'is_test', s.is_test, 'status_label', s.status_label
         ) order by s.ln, s.lf), '[]'::jsonb)
    into rows
    from (select p.full_name, p.school_id, p.department, p.program, p.major, p.program_needs_update,
                 p.course, p.year_level, p.member_type,
                 case when a.id is not null and not a.voided and (p_include_test or not a.is_test) then a.checked_in_at else null end as checked_in_at,
                 (a.id is not null and not a.voided and (p_include_test or not a.is_test)) as present,
                 coalesce(a.is_test, false) as is_test,
                 case when a.id is not null and not a.voided and (p_include_test or not a.is_test) then 'Present' else v_absent_label end as status_label,
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
      'venue', ev.venue, 'attendance_state', ws.state, 'opens_at', ws.opens_at, 'closes_at', ws.closes_at
    ),
    'filter', p_filter,
    'include_test', p_include_test,
    'rows', rows,
    'totals', jsonb_build_object('registered', reg, 'present', pres, 'absent', case when ws.state = 'ENDED' then reg - pres else 0 end, 'pending', case when ws.state = 'ENDED' then 0 else reg - pres end)
  );
end $$;
grant execute on function public.attendance_sheet(uuid, text, text, boolean, timestamptz) to authenticated;

notify pgrst, 'reload schema';
