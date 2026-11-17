-- =====================================================================
-- Migration 013: Optional "Late" attendance label
-- Computed from stored attendance.checked_in_at and events.starts_at.
-- Late people still count as Present in totals and attendance rate.
-- =====================================================================

alter table public.events add column if not exists late_after_minutes int default 15;

do $$ begin
  alter table public.events drop constraint if exists events_late_after_check;
  alter table public.events add constraint events_late_after_check
    check (late_after_minutes is null or late_after_minutes between 0 and 1440);
end $$;

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

create or replace function public.is_late_checkin(
  p_starts_at          timestamptz,
  p_checked_in_at      timestamptz,
  p_late_after_minutes int
)
returns boolean language sql immutable as $$
  select p_checked_in_at is not null
     and p_late_after_minutes is not null
     and p_late_after_minutes > 0
     and p_checked_in_at > (p_starts_at + make_interval(mins => p_late_after_minutes));
$$;

drop function if exists public.attendance_sheet(uuid, text, text, boolean, timestamptz);
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
         )
    into reg, pres, late_cnt
    from public.registrations r
    left join public.attendance a on a.registration_id = r.id
   where r.event_id = p_event_id;

  select coalesce(jsonb_agg(jsonb_build_object(
           'full_name', s.full_name, 'school_id', s.school_id,
           'department', s.department, 'program', s.program, 'major', s.major,
           'program_needs_update', s.program_needs_update,
           'course', s.course, 'year_level', s.year_level,
           'member_type', s.member_type, 'time_in', s.checked_in_at,
           'present', s.present, 'is_late', s.is_late, 'is_test', s.is_test, 'status_label', s.status_label
         ) order by s.ln, s.lf), '[]'::jsonb)
    into rows
    from (select p.full_name, p.school_id, p.department, p.program, p.major, p.program_needs_update,
                 p.course, p.year_level, p.member_type,
                 case when a.id is not null and not a.voided and (p_include_test or not a.is_test) then a.checked_in_at else null end as checked_in_at,
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
      'registered', reg, 'present', pres, 'late', late_cnt,
      'absent', case when ws.state = 'ENDED' then reg - pres else 0 end,
      'pending', case when ws.state = 'ENDED' then 0 else reg - pres end
    )
  );
end $$;
grant execute on function public.attendance_sheet(uuid, text, text, boolean, timestamptz) to authenticated;

notify pgrst, 'reload schema';
