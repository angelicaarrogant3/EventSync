-- =====================================================================
-- Migration 003: participant profile (school ID, course, year, ...) + server-side signup validation
-- Idempotent. Account + profile are created in ONE transaction (auth.users insert -> trigger).
-- =====================================================================
alter table public.profiles add column if not exists school_id      text;
alter table public.profiles add column if not exists contact_number text;
alter table public.profiles add column if not exists member_type    text check (member_type in ('student','faculty','staff'));
alter table public.profiles add column if not exists course         text;
alter table public.profiles add column if not exists year_level     smallint check (year_level between 1 and 4);
alter table public.profiles add column if not exists section        text;
alter table public.profiles add column if not exists consent_at     timestamptz;

create unique index if not exists profiles_school_id_key on public.profiles (lower(school_id)) where school_id is not null;
create unique index if not exists profiles_email_key     on public.profiles (lower(email)) where email <> '';

-- ---------- the one validator used by signup, admin registration and (indirectly) profile edits ----------
create or replace function public.validate_participant(m jsonb, p_email text)
returns void language plpgsql stable set search_path = public as $$
declare
  nm text := btrim(coalesce(m->>'full_name',''));
  sid text := btrim(coalesce(m->>'school_id',''));
  mt text := coalesce(m->>'member_type','');
  crs text := btrim(coalesce(m->>'course',''));
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
  if crs = '' or char_length(crs) > 60 then raise exception 'Course / Department is required'; end if;
  if mt = 'student' and yl !~ '^[1-4]$' then raise exception 'Year level is required for students'; end if;
  if char_length(sec) > 30 then raise exception 'Section is too long'; end if;
  if coalesce(m->>'consent','') <> 'true' then raise exception 'Privacy consent is required'; end if;
end $$;
revoke execute on function public.validate_participant(jsonb, text) from public, anon, authenticated;

-- ---------- signup -> profile (role is ALWAYS 'user' = participant; metadata can never set it) ----------
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  m jsonb := coalesce(new.raw_user_meta_data, '{}'::jsonb);
  trusted boolean := coalesce(new.raw_app_meta_data->>'created_by', '') = 'trusted_tool';  -- app_metadata cannot be set by clients
begin
  if not trusted then perform public.validate_participant(m, coalesce(new.email, '')); end if;
  insert into public.profiles(id, full_name, email, role, school_id, contact_number, member_type, course, year_level, section, consent_at)
  values (new.id, btrim(coalesce(m->>'full_name','')), coalesce(new.email,''), 'user',
          nullif(btrim(coalesce(m->>'school_id','')), ''), nullif(btrim(coalesce(m->>'contact_number','')), ''),
          nullif(m->>'member_type',''), nullif(btrim(coalesce(m->>'course','')), ''),
          case when m->>'member_type' = 'student' then nullif(m->>'year_level','')::smallint end,
          nullif(btrim(coalesce(m->>'section','')), ''),
          case when m->>'consent' = 'true' then now() end)
  on conflict (id) do nothing;
  return new;
end $$;

-- ---------- availability check for friendly messages (reveals only taken/not taken) ----------
create or replace function public.signup_availability(p_school_id text, p_email text)
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'school_id_taken', exists (select 1 from public.profiles where lower(school_id) = lower(btrim(coalesce(p_school_id,''))) and coalesce(p_school_id,'') <> ''),
    'email_taken',     exists (select 1 from public.profiles where lower(email) = lower(btrim(coalesce(p_email,''))) and coalesce(p_email,'') <> ''));
$$;
grant execute on function public.signup_availability(text, text) to anon, authenticated;

-- ---------- participants may edit ONLY these columns (school_id, email, role stay admin-controlled) ----------
revoke update on public.profiles from authenticated;
grant update (full_name, phone, contact_number, member_type, course, year_level, section) on public.profiles to authenticated;

create or replace function public.validate_profile_update()
returns trigger language plpgsql as $$
begin
  if coalesce(new.contact_number,'') <> '' and new.contact_number !~ '^(09[0-9]{9}|\+639[0-9]{9})$' then
    raise exception 'Contact number must be 09XXXXXXXXX or +639XXXXXXXXX'; end if;
  if new.member_type = 'student' and new.year_level is null and auth.uid() is not null then
    raise exception 'Year level is required for students'; end if;
  if new.member_type is distinct from 'student' then new.year_level := null; end if;
  if char_length(btrim(coalesce(new.full_name,''))) < 2 then raise exception 'Full name is required'; end if;
  return new;
end $$;
drop trigger if exists trg_validate_profile_update on public.profiles;
create trigger trg_validate_profile_update before update on public.profiles for each row execute function public.validate_profile_update();

-- ---------- registration core shared by participants and admins ----------
create or replace function public._register_core(uid uuid, p_event_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare ev public.events; reg public.registrations; cnt int; had boolean;
begin
  select * into ev from public.events where id = p_event_id for update;
  if not found or ev.status <> 'published' then raise exception 'Registration is closed for this event'; end if;
  if ev.registration_deadline is not null and ev.registration_deadline < now() then raise exception 'The registration deadline has passed'; end if;
  if ev.ends_at < now() then raise exception 'This event has already ended'; end if;
  select * into reg from public.registrations where event_id = p_event_id and user_id = uid;
  had := found;
  if had and reg.status = 'registered' then return to_jsonb(reg) || jsonb_build_object('already_registered', true); end if;
  select count(*) into cnt from public.registrations where event_id = p_event_id and status = 'registered';
  if ev.capacity is not null and cnt >= ev.capacity then raise exception 'Event is full'; end if;
  if had then update public.registrations set status = 'registered', registered_at = now() where id = reg.id returning * into reg;
  else insert into public.registrations(event_id, user_id) values (p_event_id, uid) returning * into reg; end if;
  perform public.log_activity('registration.created','registration',reg.id::text, jsonb_build_object('event',ev.title));
  return to_jsonb(reg) || jsonb_build_object('already_registered', false);
end $$;
revoke execute on function public._register_core(uuid, uuid) from public, anon, authenticated;

create or replace function public.register_for_event(p_event_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'Not authenticated'; end if;
  return public._register_core(auth.uid(), p_event_id);
end $$;

create or replace function public.admin_register_user_for_event(p_user_id uuid, p_event_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'Admin only'; end if;
  return public._register_core(p_user_id, p_event_id);
end $$;

-- ---------- admin: assisted registration of a participant (same fields as public signup) ----------
create or replace function public.admin_register_participant(p jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare uid uuid := gen_random_uuid(); em text := lower(btrim(coalesce(p->>'email','')));
begin
  if not public.is_admin() then raise exception 'Admin only'; end if;
  if char_length(coalesce(p->>'password','')) < 8 then raise exception 'Password must be at least 8 characters'; end if;
  perform public.validate_participant(p, em);
  insert into auth.users(instance_id,id,aud,role,email,encrypted_password,email_confirmed_at,raw_app_meta_data,raw_user_meta_data,
                         created_at,updated_at,confirmation_token,recovery_token,email_change_token_new,email_change)
  values ('00000000-0000-0000-0000-000000000000', uid, 'authenticated','authenticated', em,
          extensions.crypt(p->>'password', extensions.gen_salt('bf')), now(),
          '{"provider":"email","providers":["email"]}'::jsonb, (p - 'password' - 'role'), now(), now(), '', '', '', '');
  insert into auth.identities(id,user_id,identity_data,provider,provider_id,last_sign_in_at,created_at,updated_at)
  values (gen_random_uuid(), uid, jsonb_build_object('sub', uid::text, 'email', em), 'email', uid::text, now(), now(), now());
  perform public.log_activity('participant.created','profile', uid::text, jsonb_build_object('school_id', p->>'school_id', 'by', 'admin'));
  return jsonb_build_object('id', uid, 'email', em);
end $$;

grant execute on function public.register_for_event(uuid)                to authenticated;
grant execute on function public.admin_register_user_for_event(uuid,uuid) to authenticated;
grant execute on function public.admin_register_participant(jsonb)      to authenticated;
grant execute on all functions in schema public to service_role;
notify pgrst, 'reload schema';
