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
  ) a on a.user_id = p.id
  where p.role = 'user';

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
