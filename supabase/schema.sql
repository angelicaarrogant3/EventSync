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
declare ev public.events; reg public.registrations; cnt int; uid uuid := auth.uid();
begin
  if uid is null then raise exception 'Not authenticated'; end if;
  select * into ev from public.events where id = p_event_id for update;  -- row lock serialises capacity checks
  if not found or ev.status <> 'published' then raise exception 'Event is not open for registration'; end if;
  if ev.ends_at < now() then raise exception 'Event has already ended'; end if;

  select * into reg from public.registrations where event_id = p_event_id and user_id = uid;
  if found and reg.status = 'registered' then raise exception 'You are already registered for this event'; end if;

  select count(*) into cnt from public.registrations where event_id = p_event_id and status = 'registered';
  if ev.capacity is not null and cnt >= ev.capacity then raise exception 'Event is full'; end if;

  if found then
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
