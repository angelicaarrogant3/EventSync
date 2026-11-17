-- =====================================================================
-- Migration 014: Attendance Time-Out (same QR, IN/OUT mode on scanner)
-- Safe, repeatable migration; preserves all existing attendance rows.
-- =====================================================================

-- 1. Add nullable Time-Out + idempotency scan_id columns to public.attendance
alter table public.attendance add column if not exists check_out_time timestamptz;
alter table public.attendance add column if not exists check_out_scan_id uuid;
alter table public.attendance add column if not exists check_in_scan_id uuid;
alter table public.attendance add column if not exists checked_out_by_user_id uuid references public.profiles(id) on delete set null;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'attendance_check_out_scan_id_key') then
    alter table public.attendance add constraint attendance_check_out_scan_id_key unique (check_out_scan_id);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'attendance_check_in_scan_id_key') then
    alter table public.attendance add constraint attendance_check_in_scan_id_key unique (check_in_scan_id);
  end if;
end $$;

-- 2. Unified decision function for IN and OUT (used by scan, manual, and offline sync)
drop function if exists public._record_attendance(uuid, uuid, timestamptz, text, boolean);
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

    -- Atomic conditional update so two concurrent scanners cannot both set check_out_time
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
    'is_test',att.is_test,'clock_suspect',att.clock_suspect
  );
end $$;
revoke execute on function public._record_attendance(uuid, uuid, timestamptz, text, boolean, text, uuid) from public, anon, authenticated;

-- 3. Update verify_attendance to accept p_direction ('IN' | 'OUT')
drop function if exists public.verify_attendance(uuid, uuid, timestamptz, text);
create or replace function public.verify_attendance(
  p_qr_token  uuid,
  p_event_id  uuid default null,
  p_now       timestamptz default now(),
  p_mode      text default 'scan',
  p_direction text default 'IN'
)
returns jsonb language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'Only admins can verify attendance'; end if;
  return public._record_attendance(p_qr_token, p_event_id, coalesce(p_now, now()), coalesce(p_mode, 'scan'), false, p_direction, null);
end $$;
grant execute on function public.verify_attendance(uuid, uuid, timestamptz, text, text) to authenticated;

-- 4. Update sync_offline_attendance: sort by scanned_at ASC, pass mode & scan_id
create or replace function public.sync_offline_attendance(
  p_items jsonb,
  p_now   timestamptz default now()
)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  item jsonb;
  v_tok uuid;
  v_ev  uuid;
  v_scan_id uuid;
  v_scanned timestamptz;
  v_dir text;
  v_suspect boolean;
  res jsonb;
  out jsonb := '[]'::jsonb;
begin
  if not public.is_admin() then raise exception 'Only admins can sync offline attendance'; end if;
  for item in
    select value
      from jsonb_array_elements(coalesce(p_items, '[]'::jsonb))
     order by nullif(value->>'scanned_at', '')::timestamptz asc nulls last
  loop
    v_dir := upper(coalesce(nullif(btrim(item->>'mode'), ''), 'IN'));
    begin
      v_tok := (item->>'qr_token')::uuid;
      v_ev  := nullif(item->>'event_id', '')::uuid;
      v_scan_id := nullif(coalesce(item->>'scan_id', item->>'scanId'), '')::uuid;
      v_scanned := (item->>'scanned_at')::timestamptz;
    exception when others then
      out := out || jsonb_build_array(jsonb_build_object(
        'qr_token', item->>'qr_token', 'scan_id', coalesce(item->>'scan_id', item->>'scanId'),
        'mode', v_dir, 'status', 'invalid', 'code', 'INVALID_ITEM', 'message', 'Invalid queued scan format'
      ));
      continue;
    end;

    if v_scanned is null then
      out := out || jsonb_build_array(jsonb_build_object(
        'qr_token', v_tok, 'scan_id', v_scan_id, 'mode', v_dir,
        'status', 'invalid', 'code', 'MISSING_SCANNED_AT', 'message', 'Missing scannedAt timestamp'
      ));
      continue;
    end if;

    if v_scanned > p_now + interval '2 minutes' then
      out := out || jsonb_build_array(jsonb_build_object(
        'qr_token', v_tok, 'scan_id', v_scan_id, 'mode', v_dir,
        'status', 'error', 'code', 'FUTURE_TIMESTAMP',
        'message', 'Scan timestamp is in the future relative to server clock'
      ));
      continue;
    end if;

    v_suspect := abs(extract(epoch from (p_now - v_scanned))) > 3600;
    res := public._record_attendance(v_tok, v_ev, v_scanned, 'offline_sync', v_suspect, v_dir, v_scan_id);
    out := out || jsonb_build_array(res || jsonb_build_object('qr_token', v_tok, 'scan_id', v_scan_id, 'scanned_at', v_scanned));
  end loop;
  return out;
end $$;
grant execute on function public.sync_offline_attendance(jsonb, timestamptz) to authenticated;

-- 5. Update attendance_sheet to include check_out_time and timed_out total
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
  if not public.is_admin() then raise exception 'Only administrators can export attendance'; end if;
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
grant execute on function public.attendance_sheet(uuid, text, text, boolean, timestamptz) to authenticated;

notify pgrst, 'reload schema';
