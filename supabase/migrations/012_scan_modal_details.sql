-- =====================================================================
-- Migration 012: Enrich _record_attendance() response with participant
-- school_id, program/course, year_level, and verifier station name
-- for the full-screen Scan QR result modal.
-- =====================================================================

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
  ver public.profiles;
  ws  record;
  v_is_test boolean := false;
begin
  select * into reg from public.registrations where qr_token = p_qr_token;
  if not found then
    perform public.log_activity('attendance.invalid', 'attendance', null, jsonb_build_object('mode', p_mode));
    return jsonb_build_object('status','invalid','code','INVALID_QR','message','This code is not an EventSync pass.');
  end if;

  select * into ev from public.events where id = reg.event_id;
  select * into prof from public.profiles where id = reg.user_id;

  if p_event_id is not null and reg.event_id <> p_event_id then
    return jsonb_build_object(
      'status','wrong_event','code','WRONG_EVENT',
      'message','This QR pass belongs to ' || ev.title || '.',
      'participant',prof.full_name,'school_id',prof.school_id,'course',prof.course,'year_level',prof.year_level,
      'event',ev.title
    );
  end if;

  if reg.status <> 'registered' then
    return jsonb_build_object(
      'status','cancelled','code','REGISTRATION_CANCELLED',
      'message','This registration was cancelled.',
      'participant',prof.full_name,'school_id',prof.school_id,'course',prof.course,'year_level',prof.year_level,
      'event',ev.title
    );
  end if;

  select * into ws from public.get_attendance_state(ev, p_check_time);

  if ws.state = 'CANCELLED' and not ev.allow_early_test_attendance then
    return jsonb_build_object(
      'status','cancelled','code','EVENT_CANCELLED',
      'message','This event has been cancelled.',
      'participant',prof.full_name,'school_id',prof.school_id,'course',prof.course,'year_level',prof.year_level,
      'event',ev.title,'opensAt',ws.opens_at,'closesAt',ws.closes_at
    );
  elsif ws.state = 'NOT_STARTED' and not ev.allow_early_test_attendance then
    return jsonb_build_object(
      'status','not_started','code','EVENT_NOT_STARTED',
      'message','Attendance opens on ' || public.fmt_manila(ws.opens_at) || '.',
      'participant',prof.full_name,'school_id',prof.school_id,'course',prof.course,'year_level',prof.year_level,
      'event',ev.title,'opensAt',ws.opens_at,'closesAt',ws.closes_at
    );
  elsif ws.state = 'ENDED' and not ev.allow_early_test_attendance then
    return jsonb_build_object(
      'status','ended','code','EVENT_ENDED',
      'message','This event ended on ' || public.fmt_manila(ev.ends_at) || '.',
      'participant',prof.full_name,'school_id',prof.school_id,'course',prof.course,'year_level',prof.year_level,
      'event',ev.title,'opensAt',ws.opens_at,'closesAt',ws.closes_at,'endsAt',ev.ends_at
    );
  end if;

  if ev.allow_early_test_attendance and ws.state <> 'OPEN' then
    v_is_test := true;
  end if;

  select * into att from public.attendance where registration_id = reg.id;
  if found and not att.voided then
    select * into ver from public.profiles where id = att.verified_by;
    return jsonb_build_object(
      'status','duplicate','code','ALREADY_CHECKED_IN',
      'message','Already checked in',
      'participant',prof.full_name,'school_id',prof.school_id,'course',prof.course,'year_level',prof.year_level,
      'event',ev.title,'checked_in_at',att.checked_in_at,'is_test',att.is_test,
      'verified_by_name', coalesce(ver.full_name, ver.email, 'Scanner station')
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
      select * into ver from public.profiles where id = att.verified_by;
      return jsonb_build_object(
        'status','duplicate','code','ALREADY_CHECKED_IN',
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
    'status','ok','code','OK',
    'message', case when v_is_test then 'Test attendance recorded (outside schedule)' else 'Attendance recorded' end,
    'participant',prof.full_name,'school_id',prof.school_id,'course',prof.course,'year_level',prof.year_level,
    'event',ev.title,'checked_in_at',att.checked_in_at,
    'is_test',att.is_test,'clock_suspect',att.clock_suspect
  );
end $$;
revoke execute on function public._record_attendance(uuid, uuid, timestamptz, text, boolean) from public, anon, authenticated;

notify pgrst, 'reload schema';
