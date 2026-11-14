-- =====================================================================
-- EventSync - Supabase schema (NEW project; do NOT run on any other DB)
-- Run this whole file in Supabase Dashboard -> SQL Editor.
-- =====================================================================
create extension if not exists pgcrypto;

-- ---------- TABLES ----------
create table if not exists public.profiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  full_name   text not null default '',
  email       text not null default '',
  phone       text,
  role        text not null default 'user' check (role in ('admin','user')),
  created_at  timestamptz not null default now()
);

create table if not exists public.events (
  id          uuid primary key default gen_random_uuid(),
  title       text not null check (char_length(title) between 3 and 150),
  description text,
  venue       text not null,
  starts_at   timestamptz not null,
  ends_at     timestamptz not null,
  capacity    int check (capacity is null or capacity > 0),
  status      text not null default 'draft' check (status in ('draft','published','closed')),
  created_by  uuid references public.profiles(id) on delete set null,
  created_at  timestamptz not null default now(),
  check (ends_at > starts_at)
);

create table if not exists public.registrations (
  id            uuid primary key default gen_random_uuid(),
  event_id      uuid not null references public.events(id) on delete cascade,
  user_id       uuid not null references public.profiles(id) on delete cascade,
  status        text not null default 'registered' check (status in ('registered','cancelled')),
  qr_token      uuid not null unique default gen_random_uuid(),
  registered_at timestamptz not null default now(),
  constraint registrations_unique_per_event unique (event_id, user_id)   -- duplicate registration prevention
);

create table if not exists public.attendance (
  id              uuid primary key default gen_random_uuid(),
  registration_id uuid not null unique references public.registrations(id) on delete cascade, -- duplicate attendance prevention
  event_id        uuid not null references public.events(id) on delete cascade,
  user_id         uuid not null references public.profiles(id) on delete cascade,
  verified_by     uuid references public.profiles(id) on delete set null,
  checked_in_at   timestamptz not null default now()
);

create table if not exists public.activity_logs (
  id         bigint generated always as identity primary key,
  actor_id   uuid references public.profiles(id) on delete set null,
  action     text not null,
  entity     text not null,
  entity_id  text,
  details    jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists idx_reg_event   on public.registrations(event_id);
create index if not exists idx_reg_user    on public.registrations(user_id);
create index if not exists idx_att_event   on public.attendance(event_id);
create index if not exists idx_logs_time   on public.activity_logs(created_at desc);

-- ---------- HELPERS ----------
create or replace function public.is_admin()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.profiles where id = auth.uid() and role = 'admin');
$$;

create or replace function public.log_activity(p_action text, p_entity text, p_entity_id text, p_details jsonb default '{}')
returns void language sql security definer set search_path = public as $$
  insert into public.activity_logs(actor_id, action, entity, entity_id, details)
  values (auth.uid(), p_action, p_entity, p_entity_id, coalesce(p_details,'{}'::jsonb));
$$;
revoke execute on function public.log_activity(text,text,text,jsonb) from public, anon, authenticated;

-- ---------- AUTH -> PROFILE (role is ALWAYS 'user' on signup) ----------
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles(id, full_name, email, role)
  values (new.id, coalesce(new.raw_user_meta_data->>'full_name',''), coalesce(new.email,''), 'user')
  on conflict (id) do nothing;
  return new;
end $$;
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- anti-tamper: clients can never change role (promote admins from SQL editor only)
create or replace function public.prevent_role_change()
returns trigger language plpgsql as $$
begin
  if new.role is distinct from old.role and auth.uid() is not null then
    raise exception 'Role cannot be changed from the client';
  end if;
  return new;
end $$;
drop trigger if exists trg_prevent_role_change on public.profiles;
create trigger trg_prevent_role_change before update on public.profiles
  for each row execute function public.prevent_role_change();

-- ---------- AUDIT TRIGGER FOR EVENTS ----------
create or replace function public.trg_log_events()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    perform public.log_activity('event.created','event',new.id::text, jsonb_build_object('title',new.title,'status',new.status));
    return new;
  elsif tg_op = 'UPDATE' then
    perform public.log_activity(
      case when new.status is distinct from old.status then 'event.status_'||new.status else 'event.updated' end,
      'event', new.id::text, jsonb_build_object('title',new.title,'status',new.status));
    return new;
  else
    perform public.log_activity('event.deleted','event',old.id::text, jsonb_build_object('title',old.title));
    return old;
  end if;
end $$;
drop trigger if exists trg_events_log on public.events;
create trigger trg_events_log after insert or update or delete on public.events
  for each row execute function public.trg_log_events();

-- ---------- VIEW: event stats (filters drafts for non-admins) ----------
create or replace view public.event_stats as
select e.*,
       (select count(*) from public.registrations r where r.event_id = e.id and r.status = 'registered')::int as registered_count,
       (select count(*) from public.attendance a where a.event_id = e.id)::int as attended_count
from public.events e
where e.status = 'published' or public.is_admin();
grant select on public.event_stats to authenticated;

-- ---------- RPC: REGISTER ----------
create or replace function public.register_for_event(p_event_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare ev public.events; reg public.registrations; cnt int; had boolean; uid uuid := auth.uid();
begin
  if uid is null then raise exception 'Not authenticated'; end if;
  select * into ev from public.events where id = p_event_id for update;  -- row lock serialises capacity checks
  if not found or ev.status <> 'published' then raise exception 'Event is not open for registration'; end if;
  if ev.ends_at < now() then raise exception 'Event has already ended'; end if;

  select * into reg from public.registrations where event_id = p_event_id and user_id = uid;
  had := found;   -- capture now: later queries reset FOUND
  if had and reg.status = 'registered' then raise exception 'You are already registered for this event'; end if;

  select count(*) into cnt from public.registrations where event_id = p_event_id and status = 'registered';
  if ev.capacity is not null and cnt >= ev.capacity then raise exception 'Event is full'; end if;

  if had then
    update public.registrations set status = 'registered', registered_at = now() where id = reg.id returning * into reg;
  else
    insert into public.registrations(event_id, user_id) values (p_event_id, uid) returning * into reg;
  end if;
  perform public.log_activity('registration.created','registration',reg.id::text, jsonb_build_object('event',ev.title));
  return to_jsonb(reg);
end $$;

-- ---------- RPC: CANCEL (owner) ----------
create or replace function public.cancel_registration(p_registration_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare reg public.registrations;
begin
  select * into reg from public.registrations where id = p_registration_id;
  if not found or (reg.user_id <> auth.uid() and not public.is_admin()) then raise exception 'Registration not found'; end if;
  if exists (select 1 from public.attendance where registration_id = reg.id) then
    raise exception 'Cannot cancel: attendance already recorded';
  end if;
  update public.registrations set status = 'cancelled' where id = reg.id;
  perform public.log_activity('registration.cancelled','registration',reg.id::text,'{}');
end $$;

-- ---------- RPC: ADMIN SET STATUS ----------
create or replace function public.admin_set_registration_status(p_registration_id uuid, p_status text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'Admin only'; end if;
  if p_status not in ('registered','cancelled') then raise exception 'Invalid status'; end if;
  if p_status = 'cancelled' and exists (select 1 from public.attendance where registration_id = p_registration_id) then
    raise exception 'Cannot cancel: attendance already recorded';
  end if;
  update public.registrations set status = p_status where id = p_registration_id;
  perform public.log_activity('registration.'||p_status,'registration',p_registration_id::text,'{"by":"admin"}');
end $$;

-- ---------- RPC: VERIFY ATTENDANCE (admin only, atomic, idempotent) ----------
create or replace function public.verify_attendance(p_qr_token uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare reg public.registrations; ev public.events; prof public.profiles; att public.attendance;
begin
  if not public.is_admin() then raise exception 'Only admins can verify attendance'; end if;
  select * into reg from public.registrations where qr_token = p_qr_token;
  if not found then
    perform public.log_activity('attendance.invalid','attendance',null,'{}');
    return jsonb_build_object('status','invalid','message','QR code not recognised');
  end if;
  select * into ev from public.events where id = reg.event_id;
  select * into prof from public.profiles where id = reg.user_id;
  if reg.status <> 'registered' then
    return jsonb_build_object('status','cancelled','message','Registration was cancelled','participant',prof.full_name,'event',ev.title);
  end if;

  insert into public.attendance(registration_id, event_id, user_id, verified_by)
  values (reg.id, reg.event_id, reg.user_id, auth.uid())
  on conflict (registration_id) do nothing
  returning * into att;

  if att.id is null then
    select * into att from public.attendance where registration_id = reg.id;
    return jsonb_build_object('status','duplicate','message','Already checked in','participant',prof.full_name,
                              'event',ev.title,'checked_in_at',att.checked_in_at);
  end if;
  perform public.log_activity('attendance.verified','attendance',att.id::text,
          jsonb_build_object('participant',prof.full_name,'event',ev.title));
  return jsonb_build_object('status','ok','message','Attendance recorded','participant',prof.full_name,
                            'event',ev.title,'checked_in_at',att.checked_in_at);
end $$;

grant execute on function public.register_for_event(uuid)                 to authenticated;
grant execute on function public.cancel_registration(uuid)                to authenticated;
grant execute on function public.admin_set_registration_status(uuid,text) to authenticated;
grant execute on function public.verify_attendance(uuid)                  to authenticated;

-- ---------- ROW LEVEL SECURITY ----------
alter table public.profiles      enable row level security;
alter table public.events        enable row level security;
alter table public.registrations enable row level security;
alter table public.attendance    enable row level security;
alter table public.activity_logs enable row level security;

drop policy if exists profiles_select on public.profiles;
create policy profiles_select on public.profiles for select to authenticated using (id = auth.uid() or public.is_admin());
drop policy if exists profiles_update on public.profiles;
create policy profiles_update on public.profiles for update to authenticated using (id = auth.uid()) with check (id = auth.uid());

drop policy if exists events_select on public.events;
create policy events_select on public.events for select to authenticated using (status = 'published' or public.is_admin());
drop policy if exists events_admin_write on public.events;
create policy events_admin_write on public.events for all to authenticated using (public.is_admin()) with check (public.is_admin());

-- registrations & attendance: read-only for clients; all writes go through RPCs
drop policy if exists reg_select on public.registrations;
create policy reg_select on public.registrations for select to authenticated using (user_id = auth.uid() or public.is_admin());
drop policy if exists att_select on public.attendance;
create policy att_select on public.attendance for select to authenticated using (user_id = auth.uid() or public.is_admin());

drop policy if exists logs_select on public.activity_logs;
create policy logs_select on public.activity_logs for select to authenticated using (public.is_admin());

-- ---------- REALTIME ----------
do $$ begin
  begin alter publication supabase_realtime add table public.events;        exception when duplicate_object then null; end;
  begin alter publication supabase_realtime add table public.registrations; exception when duplicate_object then null; end;
  begin alter publication supabase_realtime add table public.attendance;    exception when duplicate_object then null; end;
  begin alter publication supabase_realtime add table public.activity_logs; exception when duplicate_object then null; end;
end $$;

-- ---------- ADMINS ----------
-- Admin accounts are created ONLY from the terminal: npm run create-admin  (see README).
-- Public signup always produces role 'user'.

-- ---------- GRANTS (clients get only what RLS then filters) ----------
grant usage on schema public to authenticated;
grant select on public.events, public.registrations, public.attendance, public.activity_logs to authenticated;
grant select, update on public.profiles to authenticated;
grant insert, update, delete on public.events to authenticated;  -- RLS restricts writes to admins
revoke all on all tables in schema public from anon;
revoke truncate, references, trigger on all tables in schema public from authenticated;
notify pgrst, 'reload schema';

grant usage on schema public to service_role;
grant all on all tables in schema public to service_role;
grant execute on all functions in schema public to service_role;


-- ===== Migration 002 (registration flow) =====
-- =====================================================================
-- Migration 002: registration flow fixes (idempotent - safe to re-run)
--  * fixes register_for_event (FOUND flag bug => nothing was inserted)
--  * events.registered_count maintained by trigger => live seat counts for ALL users
--  * registration deadline, cancel-only-before-start
-- =====================================================================
alter table public.events add column if not exists registered_count int not null default 0;
alter table public.events add column if not exists registration_deadline timestamptz;

-- ---------- seat counter: runs inside the same transaction as the registration change ----------
create or replace function public.sync_registered_count()
returns trigger language plpgsql security definer set search_path = public as $$
declare eid uuid := coalesce(new.event_id, old.event_id);
begin
  update public.events
     set registered_count = (select count(*) from public.registrations where event_id = eid and status = 'registered')
   where id = eid;
  return null;
end $$;
drop trigger if exists trg_sync_count on public.registrations;
create trigger trg_sync_count after insert or update of status or delete on public.registrations
  for each row execute function public.sync_registered_count();

update public.events e set registered_count =
  (select count(*) from public.registrations r where r.event_id = e.id and r.status = 'registered');

-- audit trigger: ignore counter-only updates
create or replace function public.trg_log_events()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    perform public.log_activity('event.created','event',new.id::text, jsonb_build_object('title',new.title,'status',new.status));
    return new;
  elsif tg_op = 'UPDATE' then
    if (to_jsonb(new) - 'registered_count') = (to_jsonb(old) - 'registered_count') then return new; end if;
    perform public.log_activity(
      case when new.status is distinct from old.status then 'event.status_'||new.status else 'event.updated' end,
      'event', new.id::text, jsonb_build_object('title',new.title,'status',new.status));
    return new;
  else
    perform public.log_activity('event.deleted','event',old.id::text, jsonb_build_object('title',old.title));
    return old;
  end if;
end $$;

-- ---------- view: counter now comes from events.registered_count (via e.*) ----------
drop view if exists public.event_stats;
create view public.event_stats as
select e.*,
       (select count(*) from public.attendance a where a.event_id = e.id)::int as attended_count
from public.events e
where e.status = 'published' or public.is_admin();
grant select on public.event_stats to authenticated;

-- ---------- RPC: REGISTER (fixed) ----------
create or replace function public.register_for_event(p_event_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare ev public.events; reg public.registrations; cnt int; had boolean; uid uuid := auth.uid();
begin
  if uid is null then raise exception 'Not authenticated'; end if;
  select * into ev from public.events where id = p_event_id for update;   -- row lock serialises capacity checks
  if not found or ev.status <> 'published' then raise exception 'Registration is closed for this event'; end if;
  if ev.registration_deadline is not null and ev.registration_deadline < now() then
    raise exception 'The registration deadline has passed'; end if;
  if ev.ends_at < now() then raise exception 'This event has already ended'; end if;

  select * into reg from public.registrations where event_id = p_event_id and user_id = uid;
  had := found;                                  -- capture NOW: later statements reset FOUND
  if had and reg.status = 'registered' then
    return to_jsonb(reg) || jsonb_build_object('already_registered', true);
  end if;

  select count(*) into cnt from public.registrations where event_id = p_event_id and status = 'registered';
  if ev.capacity is not null and cnt >= ev.capacity then raise exception 'Event is full'; end if;

  if had then
    update public.registrations set status = 'registered', registered_at = now() where id = reg.id returning * into reg;
  else
    insert into public.registrations(event_id, user_id) values (p_event_id, uid) returning * into reg;
  end if;
  perform public.log_activity('registration.created','registration',reg.id::text, jsonb_build_object('event',ev.title));
  return to_jsonb(reg) || jsonb_build_object('already_registered', false);
end $$;

-- ---------- RPC: CANCEL (participants only before the event starts) ----------
create or replace function public.cancel_registration(p_registration_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare reg public.registrations; ev public.events;
begin
  select * into reg from public.registrations where id = p_registration_id;
  if not found or (reg.user_id <> auth.uid() and not public.is_admin()) then raise exception 'Registration not found'; end if;
  select * into ev from public.events where id = reg.event_id;
  if reg.user_id = auth.uid() and not public.is_admin() and ev.starts_at <= now() then
    raise exception 'Cannot cancel: the event has already started';
  end if;
  if exists (select 1 from public.attendance where registration_id = reg.id) then
    raise exception 'Cannot cancel: attendance already recorded';
  end if;
  if reg.status = 'cancelled' then return; end if;
  update public.registrations set status = 'cancelled' where id = reg.id;
  perform public.log_activity('registration.cancelled','registration',reg.id::text,'{}');
end $$;

grant execute on function public.register_for_event(uuid)  to authenticated;
grant execute on function public.cancel_registration(uuid) to authenticated;
grant execute on all functions in schema public to service_role;
notify pgrst, 'reload schema';



-- ===== Migration 003 (participant profile) =====
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



-- ===== Migration 004 (attendance sheet export) =====
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



-- ===== Migration 005 (admin users) =====
-- =====================================================================
-- Migration 005: Admin Users management, account status, temp password reset
-- Idempotent.
-- =====================================================================
alter table public.profiles add column if not exists status               text not null default 'active' check (status in ('active','inactive'));
alter table public.profiles add column if not exists must_change_password boolean not null default false;
alter table public.profiles add column if not exists deactivated_at       timestamptz;

-- Only active admins count as admin
create or replace function public.is_admin()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid() and role = 'admin' and status = 'active'
  );
$$;

-- Prevent clients from changing status or deactivated_at directly
revoke update on public.profiles from authenticated;
grant update (full_name, phone, contact_number, member_type, course, year_level, section) on public.profiles to authenticated;

-- ---------- RPC: list users + summary (admin only; never exposes password hashes or sessions) ----------
create or replace function public.admin_list_users()
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  summary jsonb;
  rows jsonb;
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
  ) a on a.user_id = p.id;

  return jsonb_build_object('summary', summary, 'users', rows);
end $$;

-- ---------- RPC: single user detail + registrations ----------
create or replace function public.admin_user_detail(p_user_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  prof jsonb;
  regs jsonb;
begin
  if not public.is_admin() then raise exception 'Admin only'; end if;

  select jsonb_build_object(
    'id', p.id, 'full_name', p.full_name, 'school_id', p.school_id, 'email', p.email,
    'role', p.role, 'member_type', p.member_type, 'course', p.course, 'year_level', p.year_level,
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

-- ---------- RPC: deactivate / reactivate account ----------
create or replace function public.admin_set_user_status(p_user_id uuid, p_status text)
returns void language plpgsql security definer set search_path = public as $$
declare target public.profiles;
begin
  if not public.is_admin() then raise exception 'Admin only'; end if;
  if p_status not in ('active', 'inactive') then raise exception 'Invalid status'; end if;
  if p_user_id = auth.uid() then raise exception 'You cannot deactivate your own account'; end if;

  select * into target from public.profiles where id = p_user_id;
  if not found then raise exception 'User not found'; end if;

  update public.profiles
     set status = p_status,
         deactivated_at = case when p_status = 'inactive' then now() else null end
   where id = p_user_id;

  if p_status = 'inactive' then
    update auth.users set banned_until = '2099-12-31T23:59:59Z'::timestamptz where id = p_user_id;
    delete from auth.sessions where user_id = p_user_id;
  else
    update auth.users set banned_until = null where id = p_user_id;
  end if;

  perform public.log_activity(
    case when p_status = 'inactive' then 'user.deactivated' else 'user.reactivated' end,
    'profile', p_user_id::text, jsonb_build_object('email', target.email)
  );
end $$;

-- ---------- RPC: reset participant password (temp password + forced change) ----------
create or replace function public.admin_reset_user_password(p_user_id uuid, p_temp_password text)
returns void language plpgsql security definer set search_path = public as $$
declare target public.profiles;
begin
  if not public.is_admin() then raise exception 'Admin only'; end if;
  if char_length(coalesce(p_temp_password, '')) < 8 then raise exception 'Temporary password must be at least 8 characters'; end if;

  select * into target from public.profiles where id = p_user_id;
  if not found then raise exception 'User not found'; end if;
  if target.role <> 'user' then raise exception 'Only participant passwords can be reset here'; end if;

  update auth.users
     set encrypted_password = extensions.crypt(p_temp_password, extensions.gen_salt('bf')),
         updated_at = now()
   where id = p_user_id;
  delete from auth.sessions where user_id = p_user_id;
  update public.profiles set must_change_password = true where id = p_user_id;

  perform public.log_activity('user.password_reset', 'profile', p_user_id::text, jsonb_build_object('email', target.email));
end $$;

-- ---------- RPC: clear must_change_password after user updates password ----------
create or replace function public.complete_password_change()
returns void language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'Not authenticated'; end if;
  update public.profiles set must_change_password = false where id = auth.uid();
end $$;

-- ---------- RPC: create a new administrator account (admin only) ----------
create or replace function public.admin_create_admin(p_full_name text, p_email text, p_password text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  uid uuid := gen_random_uuid();
  nm text := btrim(coalesce(p_full_name, ''));
  em text := lower(btrim(coalesce(p_email, '')));
begin
  if not public.is_admin() then raise exception 'Admin only'; end if;
  if char_length(nm) < 2 or char_length(nm) > 120 then raise exception 'Full name is required'; end if;
  if em !~* '^[^@\s]+@[^@\s]+\.[^@\s]+$' then raise exception 'A valid email is required'; end if;
  if exists (select 1 from public.profiles where lower(email) = em) then raise exception 'This email is already registered'; end if;
  if char_length(coalesce(p_password, '')) < 8 then raise exception 'Password must be at least 8 characters'; end if;

  insert into auth.users(instance_id,id,aud,role,email,encrypted_password,email_confirmed_at,raw_app_meta_data,raw_user_meta_data,
                         created_at,updated_at,confirmation_token,recovery_token,email_change_token_new,email_change)
  values ('00000000-0000-0000-0000-000000000000', uid, 'authenticated','authenticated', em,
          extensions.crypt(p_password, extensions.gen_salt('bf')), now(),
          '{"provider":"email","providers":["email"],"created_by":"trusted_tool"}'::jsonb,
          jsonb_build_object('full_name', nm), now(), now(), '', '', '', '');

  insert into auth.identities(id,user_id,identity_data,provider,provider_id,last_sign_in_at,created_at,updated_at)
  values (gen_random_uuid(), uid, jsonb_build_object('sub', uid::text, 'email', em), 'email', uid::text, now(), now(), now());

  update public.profiles set role = 'admin', full_name = nm where id = uid;

  perform public.log_activity('user.admin_created', 'profile', uid::text, jsonb_build_object('email', em));
  return jsonb_build_object('id', uid, 'email', em, 'role', 'admin');
end $$;

revoke execute on function public.admin_list_users()                   from public, anon;
revoke execute on function public.admin_user_detail(uuid)              from public, anon;
revoke execute on function public.admin_set_user_status(uuid, text)    from public, anon;
revoke execute on function public.admin_reset_user_password(uuid, text) from public, anon;
revoke execute on function public.complete_password_change()           from public, anon;
revoke execute on function public.admin_create_admin(text, text, text) from public, anon;

grant execute on function public.admin_list_users()                   to authenticated;
grant execute on function public.admin_user_detail(uuid)              to authenticated;
grant execute on function public.admin_set_user_status(uuid, text)    to authenticated;
grant execute on function public.admin_reset_user_password(uuid, text) to authenticated;
grant execute on function public.complete_password_change()           to authenticated;
grant execute on function public.admin_create_admin(text, text, text) to authenticated;
grant execute on all functions in schema public to service_role;

-- Realtime for profiles (RLS ensures only admins & the user themselves receive profile events)
do $$ begin
  begin alter publication supabase_realtime add table public.profiles; exception when duplicate_object then null; end;
end $$;

notify pgrst, 'reload schema';

