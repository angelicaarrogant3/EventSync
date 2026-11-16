-- =====================================================================
-- Migration 009: Connect public.profiles -> public.program_catalog via FK
-- Adds nullable profiles.program_code referencing program_catalog(program_code)
-- so official BiPSU programs have a real FK relationship (visible in ERDs)
-- while Faculty/Staff, Other, and legacy accounts remain NULL.
-- =====================================================================

alter table public.profiles
  add column if not exists program_code text
  references public.program_catalog(program_code) on delete set null;

-- Backfill existing profiles that match an official BiPSU program
update public.profiles p
   set program_code = pc.program_code
  from public.program_catalog pc
 where p.program = pc.program_name
   and p.program_code is distinct from pc.program_code;

-- Keep profiles.program_code automatically synced on insert/update
create or replace function public.sync_profile_program_code()
returns trigger language plpgsql set search_path = public as $$
begin
  if new.program is null or new.department = 'Other / Not listed' then
    new.program_code := null;
  else
    select pc.program_code into new.program_code
      from public.program_catalog pc
     where pc.program_name = new.program
     limit 1;
  end if;
  return new;
end $$;

drop trigger if exists trg_sync_profile_program_code on public.profiles;
create trigger trg_sync_profile_program_code
  before insert or update of department, program on public.profiles
  for each row execute function public.sync_profile_program_code();

notify pgrst, 'reload schema';
