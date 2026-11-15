-- =====================================================================
-- Migration 008: Official BiPSU Main Campus Schools, Programs & Majors
-- Safe, repeatable migration that preserves all existing user data.
-- =====================================================================

-- 1. Add structured program columns to public.profiles
alter table public.profiles add column if not exists department text;
alter table public.profiles add column if not exists program text;
alter table public.profiles add column if not exists major text;
alter table public.profiles add column if not exists program_needs_update boolean not null default false;

-- 2. Official BiPSU Main Campus program catalog (server-side source of truth)
create table if not exists public.program_catalog (
  school_code  text not null,
  school_name  text not null,
  program_code text primary key,
  program_name text not null unique,
  short_name   text not null,
  majors       text[] not null default '{}'
);
grant select on public.program_catalog to anon, authenticated;

insert into public.program_catalog (school_code, school_name, program_code, program_name, short_name, majors) values
  ('SCJE', 'School of Criminal Justice Education', 'BSCRIM', 'Bachelor of Science in Criminology', 'BS Criminology', '{}'),
  ('STE',  'School of Teacher Education', 'BECED', 'Bachelor of Early Childhood Education', 'B Early Childhood Education', '{}'),
  ('STE',  'School of Teacher Education', 'BEED',  'Bachelor of Elementary Education', 'B Elementary Education', '{}'),
  ('STE',  'School of Teacher Education', 'BPED',  'Bachelor of Physical Education', 'B Physical Education', '{}'),
  ('STE',  'School of Teacher Education', 'BSED',  'Bachelor in Secondary Education', 'B Secondary Education', array['English','Filipino','Math','Science','Social Studies']),
  ('STE',  'School of Teacher Education', 'BSNED', 'Bachelor of Special Needs Education', 'B Special Needs Education', '{}'),
  ('STE',  'School of Teacher Education', 'BTLED', 'Bachelor of Technology and Livelihood Education', 'B Technology & Livelihood Education', '{}'),
  ('SNHS', 'School of Nursing and Health Sciences', 'BSN', 'Bachelor of Science in Nursing', 'BS Nursing', '{}'),
  ('SOE',  'School of Engineering', 'BSCE',  'Bachelor of Science in Civil Engineering', 'BS Civil Engineering', '{}'),
  ('SOE',  'School of Engineering', 'BSEE',  'Bachelor of Science in Electrical Engineering', 'BS Electrical Engineering', '{}'),
  ('SOE',  'School of Engineering', 'BSME',  'Bachelor of Science in Mechanical Engineering', 'BS Mechanical Engineering', '{}'),
  ('SOE',  'School of Engineering', 'BSCPE', 'Bachelor of Science in Computer Engineering', 'BS Computer Engineering', '{}'),
  ('SAS',  'School of Arts and Sciences', 'BACA',   'Bachelor of Arts, Major in Communication Arts', 'BA Communication Arts', '{}'),
  ('SAS',  'School of Arts and Sciences', 'BAECON', 'Bachelor of Arts, Major in Economics', 'BA Economics', '{}'),
  ('SAS',  'School of Arts and Sciences', 'BSBA',   'Bachelor of Science in Business Administration', 'BS Business Administration', array['Financial Management','Marketing Management']),
  ('SME',  'School of Management and Entrepreneurship', 'BSHM', 'Bachelor of Science in Hospitality Management', 'BS Hospitality Management', '{}'),
  ('SME',  'School of Management and Entrepreneurship', 'BSTM', 'Bachelor of Science in Tourism Management', 'BS Tourism Management', '{}'),
  ('STCS', 'School of Technology and Computer Studies', 'BSCS', 'Bachelor of Science in Computer Science', 'BS Computer Science', '{}'),
  ('STCS', 'School of Technology and Computer Studies', 'BSIS', 'Bachelor of Science in Information Systems', 'BS Information Systems', '{}'),
  ('STCS', 'School of Technology and Computer Studies', 'BSIT', 'Bachelor of Science in Industrial Technology', 'BS Industrial Technology',
    array['Automotive Technology','Cosmetology','Drafting','Electricity','Electronics','Foods','Garments','Handicraft','Machine Shop/Metal Fabrication','RAC Technology'])
on conflict (program_code) do update
  set school_code  = excluded.school_code,
      school_name  = excluded.school_name,
      program_name = excluded.program_name,
      short_name   = excluded.short_name,
      majors       = excluded.majors;

-- 3. Migrate legacy accounts safely without losing any names, emails, school IDs, or registrations
update public.profiles
   set department = 'School of Technology and Computer Studies',
       program = 'Bachelor of Science in Computer Science',
       major = null,
       course = 'BS Computer Science',
       program_needs_update = false
 where department is null and course = 'BSCS';

update public.profiles
   set department = 'School of Teacher Education',
       program = 'Bachelor of Elementary Education',
       major = null,
       course = 'B Elementary Education',
       program_needs_update = false
 where department is null and course = 'BEED';

update public.profiles
   set department = 'School of Nursing and Health Sciences',
       program = 'Bachelor of Science in Nursing',
       major = null,
       course = 'BS Nursing',
       program_needs_update = false
 where department is null and course = 'Nursing';

update public.profiles
   set department = 'School of Arts and Sciences',
       program = 'Bachelor of Science in Business Administration',
       major = null,
       course = 'BS Business Administration',
       program_needs_update = true
 where department is null and course = 'BSBA';

update public.profiles
   set course = 'Needs update',
       program_needs_update = true
 where department is null
   and role = 'user'
   and coalesce(btrim(course), '') <> ''
   and course not in ('BSCS', 'BEED', 'Nursing', 'BSBA', 'Needs update');

-- 4. Server-side program validator
create or replace function public.resolve_program_selection(
  p_member_type text,
  p_department  text,
  p_program     text,
  p_major       text,
  p_course      text default null
)
returns table (department text, program text, major text, course text)
language plpgsql stable set search_path = public as $$
declare
  mt   text := btrim(coalesce(p_member_type, ''));
  dept text := btrim(coalesce(p_department, ''));
  prog text := btrim(coalesce(p_program, ''));
  maj  text := btrim(coalesce(p_major, ''));
  crs  text := btrim(coalesce(p_course, ''));
  cat  public.program_catalog;
  sc_name text;
begin
  if dept in ('Other / Not listed', 'OTHER') then
    crs := coalesce(nullif(prog, ''), nullif(crs, ''));
    if crs is null or crs = '' then raise exception 'Please specify your course / department'; end if;
    if char_length(crs) > 100 then raise exception 'Course / Department is too long'; end if;
    if maj <> '' then raise exception 'Major is not applicable for Other'; end if;
    return query select 'Other / Not listed'::text, crs, null::text, crs;
    return;
  end if;

  if mt in ('faculty', 'staff') then
    if dept = '' then raise exception 'School / Office is required'; end if;
    if dept in ('Administrative / Office', 'ADMIN_OFFICE') then
      sc_name := 'Administrative / Office';
    else
      select distinct pc.school_name into sc_name
        from public.program_catalog pc
       where pc.school_name = dept or pc.school_code = dept
       limit 1;
      if sc_name is null then raise exception 'Select a valid School / Office'; end if;
    end if;
    if maj <> '' then raise exception 'Major is not applicable for Faculty / Staff'; end if;
    return query select sc_name, null::text, null::text, sc_name;
    return;
  end if;

  if dept = '' then raise exception 'School / College is required'; end if;
  select distinct pc.school_name into sc_name
    from public.program_catalog pc
   where pc.school_name = dept or pc.school_code = dept
   limit 1;
  if sc_name is null then raise exception 'Select a valid School / College'; end if;

  if prog = '' then raise exception 'Program is required'; end if;
  select * into cat
    from public.program_catalog pc
   where pc.school_name = sc_name
     and (pc.program_name = prog or pc.program_code = prog or pc.short_name = prog)
   limit 1;
  if not found then raise exception 'Select a valid Program for this school'; end if;

  if coalesce(array_length(cat.majors, 1), 0) > 0 then
    if maj = '' or not (maj = any(cat.majors)) then
      raise exception 'Select a valid Major for this program';
    end if;
  else
    if maj <> '' then raise exception 'This program does not have majors'; end if;
  end if;

  return query select
    sc_name,
    cat.program_name,
    nullif(maj, ''),
    cat.short_name || case when maj <> '' then ' (' || maj || ')' else '' end;
end $$;
revoke execute on function public.resolve_program_selection(text,text,text,text,text) from public, anon, authenticated;

-- 5. Update validate_participant + handle_new_user
create or replace function public.validate_participant(m jsonb, p_email text)
returns void language plpgsql stable set search_path = public as $$
declare
  nm text := btrim(coalesce(m->>'full_name',''));
  sid text := btrim(coalesce(m->>'school_id',''));
  mt text := coalesce(m->>'member_type','');
  yl text := coalesce(m->>'year_level','');
  contact text := btrim(coalesce(m->>'contact_number',''));
  sec text := btrim(coalesce(m->>'section',''));
begin
  if char_length(nm) < 2 or char_length(nm) > 120 then raise exception 'Full name is required'; end if;
  if sid !~ '^[A-Za-z0-9-]{4,20}$' then raise exception 'School ID must be 4-20 letters, numbers or dashes'; end if;
  if exists (select 1 from public.profiles where lower(school_id) = lower(sid)) then raise exception 'This school ID is already registered'; end if;
  if p_email !~* '^[^@\s]+@[^@\s]+\.[^@\s]+$' then raise exception 'A valid email is required'; end if;
  if exists (select 1 from public.profiles where lower(email) = lower(p_email)) then raise exception 'This email is already registered'; end if;
  if contact <> '' and contact !~ '^(09[0-9]{9}|\+639[0-9]{9})$' then raise exception 'Contact number must be 09XXXXXXXXX or +639XXXXXXXXX'; end if;
  if mt not in ('student','faculty','staff') then raise exception 'Select Student, Faculty or Staff'; end if;
  perform * from public.resolve_program_selection(mt, m->>'department', m->>'program', m->>'major', m->>'course');
  if mt = 'student' and yl !~ '^[1-4]$' then raise exception 'Year level is required for students'; end if;
  if char_length(sec) > 30 then raise exception 'Section is too long'; end if;
  if coalesce(m->>'consent','') <> 'true' then raise exception 'Privacy consent is required'; end if;
end $$;
revoke execute on function public.validate_participant(jsonb, text) from public, anon, authenticated;

create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  m jsonb := coalesce(new.raw_user_meta_data, '{}'::jsonb);
  trusted boolean := coalesce(new.raw_app_meta_data->>'created_by', '') = 'trusted_tool';
  resolved record;
  v_dept text; v_prog text; v_maj text; v_crs text;
begin
  if not trusted then
    perform public.validate_participant(m, coalesce(new.email, ''));
    select * into resolved from public.resolve_program_selection(
      m->>'member_type', m->>'department', m->>'program', m->>'major', m->>'course'
    );
    v_dept := resolved.department; v_prog := resolved.program; v_maj := resolved.major; v_crs := resolved.course;
  else
    v_dept := nullif(btrim(coalesce(m->>'department','')), '');
    v_prog := nullif(btrim(coalesce(m->>'program','')), '');
    v_maj  := nullif(btrim(coalesce(m->>'major','')), '');
    v_crs  := nullif(btrim(coalesce(m->>'course','')), '');
  end if;

  insert into public.profiles(
    id, full_name, email, role, school_id, contact_number, member_type,
    department, program, major, course, program_needs_update,
    year_level, section, consent_at
  )
  values (
    new.id, btrim(coalesce(m->>'full_name','')), coalesce(new.email,''), 'user',
    nullif(btrim(coalesce(m->>'school_id','')), ''), nullif(btrim(coalesce(m->>'contact_number','')), ''),
    nullif(m->>'member_type',''),
    v_dept, v_prog, v_maj, v_crs, false,
    case when m->>'member_type' = 'student' then nullif(m->>'year_level','')::smallint end,
    nullif(btrim(coalesce(m->>'section','')), ''),
    case when m->>'consent' = 'true' then now() end
  )
  on conflict (id) do nothing;
  return new;
end $$;

-- 6. Profile updates: allow updating structured program columns and validate on change
revoke update on public.profiles from authenticated;
grant update (full_name, phone, contact_number, member_type, department, program, major, course, program_needs_update, year_level, section) on public.profiles to authenticated;

create or replace function public.validate_profile_update()
returns trigger language plpgsql set search_path = public as $$
declare
  resolved record;
  prog_changed boolean;
begin
  if coalesce(new.contact_number,'') <> '' and new.contact_number !~ '^(09[0-9]{9}|\+639[0-9]{9})$' then
    raise exception 'Contact number must be 09XXXXXXXXX or +639XXXXXXXXX'; end if;
  if new.member_type = 'student' and new.year_level is null and auth.uid() is not null then
    raise exception 'Year level is required for students'; end if;
  if new.member_type is distinct from 'student' then new.year_level := null; end if;
  if char_length(btrim(coalesce(new.full_name,''))) < 2 then raise exception 'Full name is required'; end if;

  prog_changed := (new.department is distinct from old.department)
               or (new.program is distinct from old.program)
               or (new.major is distinct from old.major)
               or (new.course is distinct from old.course)
               or (new.member_type is distinct from old.member_type and coalesce(new.department,'') <> '')
               or (old.program_needs_update and not new.program_needs_update);

  if auth.uid() is not null and prog_changed then
    select * into resolved from public.resolve_program_selection(
      new.member_type, new.department, new.program, new.major, new.course
    );
    new.department := resolved.department;
    new.program    := resolved.program;
    new.major      := resolved.major;
    new.course     := resolved.course;
    new.program_needs_update := false;
  end if;
  return new;
end $$;

-- 7. Update attendance_sheet, admin_list_users, and admin_user_detail to include department/program/major/program_needs_update
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
           'full_name', s.full_name, 'school_id', s.school_id,
           'department', s.department, 'program', s.program, 'major', s.major,
           'program_needs_update', s.program_needs_update,
           'course', s.course, 'year_level', s.year_level,
           'member_type', s.member_type, 'time_in', s.checked_in_at, 'present', s.present
         ) order by s.ln, s.lf), '[]'::jsonb)
    into rows
    from (select p.full_name, p.school_id, p.department, p.program, p.major, p.program_needs_update,
                 p.course, p.year_level, p.member_type, a.checked_in_at,
                 (a.id is not null) as present,
                 lower(regexp_replace(btrim(p.full_name), '^.*\s', '')) as ln,
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
  where p.role = 'user';

  return jsonb_build_object('summary', summary, 'users', rows);
end $$;

create or replace function public.admin_user_detail(p_user_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  prof jsonb;
  regs jsonb;
begin
  if not public.is_admin() then raise exception 'Admin only'; end if;

  select jsonb_build_object(
    'id', p.id, 'full_name', p.full_name, 'school_id', p.school_id, 'email', p.email,
    'role', p.role, 'member_type', p.member_type,
    'department', p.department, 'program', p.program, 'major', p.major, 'program_needs_update', p.program_needs_update,
    'course', p.course, 'year_level', p.year_level,
    'section', p.section, 'contact_number', p.contact_number, 'status', p.status,
    'must_change_password', p.must_change_password, 'created_at', p.created_at, 'deactivated_at', p.deactivated_at
  ) into prof from public.profiles p where p.id = p_user_id;

  if prof is null then raise exception 'User not found'; end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'id', r.id, 'event_id', r.event_id, 'event_title', e.title, 'venue', e.venue,
    'starts_at', e.starts_at, 'status', r.status, 'registered_at', r.registered_at,
    'checked_in_at', a.checked_in_at
  ) order by r.registered_at desc), '[]'::jsonb)
  into regs
  from public.registrations r
  join public.events e on e.id = r.event_id
  left join public.attendance a on a.registration_id = r.id
  where r.user_id = p_user_id;

  return jsonb_build_object('profile', prof, 'registrations', regs);
end $$;

notify pgrst, 'reload schema';
