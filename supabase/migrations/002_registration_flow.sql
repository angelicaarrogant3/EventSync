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
