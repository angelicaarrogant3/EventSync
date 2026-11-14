-- =====================================================================
-- Migration 004: attendance sheet export (admin-only, totals computed in the database, every export logged)
-- =====================================================================
create or replace function public.attendance_sheet(p_event_id uuid, p_filter text default 'all', p_format text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare ev public.events; reg int; pres int; rows jsonb;
begin
  if not public.is_admin() then raise exception 'Only administrators can export attendance'; end if;
  if p_filter not in ('all','present') then raise exception 'Invalid filter'; end if;
  select * into ev from public.events where id = p_event_id;
  if not found then raise exception 'Event not found'; end if;

  select count(*) filter (where r.status = 'registered'),
         count(*) filter (where r.status = 'registered' and a.id is not null)
    into reg, pres
    from public.registrations r left join public.attendance a on a.registration_id = r.id
   where r.event_id = p_event_id;

  select coalesce(jsonb_agg(jsonb_build_object(
           'full_name', s.full_name, 'school_id', s.school_id, 'course', s.course, 'year_level', s.year_level,
           'member_type', s.member_type, 'time_in', s.checked_in_at, 'present', s.present
         ) order by s.ln, s.lf), '[]'::jsonb)
    into rows
    from (select p.full_name, p.school_id, p.course, p.year_level, p.member_type, a.checked_in_at,
                 (a.id is not null) as present,
                 lower(regexp_replace(btrim(p.full_name), '^.*\s', '')) as ln,   -- last name
                 lower(p.full_name) as lf
            from public.registrations r
            join public.profiles p on p.id = r.user_id
            left join public.attendance a on a.registration_id = r.id
           where r.event_id = p_event_id and r.status = 'registered'
             and (p_filter = 'all' or a.id is not null)) s;

  if p_format is not null then
    perform public.log_activity('report.exported', 'report', p_event_id::text,
            jsonb_build_object('event', ev.title, 'format', p_format, 'filter', p_filter, 'rows', jsonb_array_length(rows)));
  end if;

  return jsonb_build_object(
    'event', jsonb_build_object('id', ev.id, 'title', ev.title, 'starts_at', ev.starts_at, 'ends_at', ev.ends_at, 'venue', ev.venue),
    'filter', p_filter, 'rows', rows,
    'totals', jsonb_build_object('registered', reg, 'present', pres, 'absent', reg - pres));
end $$;

-- generic export log (used by the "Summary of all events" export); admin only
create or replace function public.log_export(p_kind text, p_details jsonb default '{}')
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'Only administrators can export reports'; end if;
  perform public.log_activity('report.exported', 'report', p_kind, coalesce(p_details, '{}'::jsonb));
end $$;

grant execute on function public.attendance_sheet(uuid, text, text) to authenticated;
grant execute on function public.log_export(text, jsonb)            to authenticated;
notify pgrst, 'reload schema';
