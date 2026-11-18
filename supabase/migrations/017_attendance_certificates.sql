-- =====================================================================
-- Migration 017: Attendance Certificates with Custom Uploaded Designs
-- Safe, repeatable migration; preserves all existing tables, views, RPCs, and tests.
-- =====================================================================

-- 1. Table: public.certificate_templates
create table if not exists public.certificate_templates (
  id         uuid primary key default gen_random_uuid(),
  owner_id   uuid references public.profiles(id) on delete set null,
  name       text not null,
  file_path  text,
  mime_type  text not null default 'system/default',
  width      int not null default 2000 check (width >= 400 and width <= 10000),
  height     int not null default 1414 check (height >= 300 and height <= 10000),
  layout     jsonb not null default '[]'::jsonb,
  version    int not null default 1 check (version >= 1),
  is_global  boolean not null default false,
  is_active  boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Validate template layout (mandatory certificate_id + qr_code, block PII fields, bump version on edit)
create or replace function public.validate_certificate_template()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  item jsonb;
  ftype text;
  has_cert_id boolean := false;
  has_qr      boolean := false;
  has_name    boolean := false;
  allowed_types constant text[] := array[
    'participant_name', 'event_name', 'event_date', 'venue',
    'organizing_office', 'program', 'school', 'year_level', 'section',
    'issue_date', 'signatory_1_name', 'signatory_1_title', 'signatory_1_sig',
    'signatory_2_name', 'signatory_2_title', 'signatory_2_sig',
    'certificate_id', 'qr_code'
  ];
  forbidden_types constant text[] := array[
    'school_id', 'student_id', 'employee_id', 'id_number', 'email', 'phone', 'contact_number'
  ];
begin
  if char_length(btrim(coalesce(new.name, ''))) < 2 then
    raise exception 'Template name is required';
  end if;

  if new.mime_type not in ('system/default', 'image/png', 'image/jpeg', 'application/pdf') then
    raise exception 'Unsupported template file format. Use PNG, JPG, or single-page PDF.';
  end if;

  if jsonb_typeof(new.layout) <> 'array' then
    raise exception 'Template layout must be a JSON array of field boxes';
  end if;

  for item in select * from jsonb_array_elements(new.layout)
  loop
    ftype := lower(btrim(coalesce(item->>'type', '')));
    if ftype = any(forbidden_types) then
      raise exception 'Field "%" is not allowed on certificates (ID numbers, email, and phone are prohibited)', ftype;
    end if;
    if not (ftype = any(allowed_types)) then
      raise exception 'Unknown certificate field type: %', ftype;
    end if;
    if ftype = 'certificate_id' then has_cert_id := true; end if;
    if ftype = 'qr_code' then has_qr := true; end if;
    if ftype = 'participant_name' then has_name := true; end if;
  end loop;

  if not has_cert_id or not has_qr then
    raise exception 'Certificate ID and QR code boxes are mandatory and cannot be removed';
  end if;

  if not has_name then
    raise exception 'Participant full name box is required';
  end if;

  -- Only admins can mark a template as global
  if new.is_global and auth.uid() is not null and not public.is_admin() then
    raise exception 'Only administrators can create or mark global templates';
  end if;

  if tg_op = 'UPDATE' then
    if (new.layout is distinct from old.layout)
       or (new.file_path is distinct from old.file_path)
       or (new.width is distinct from old.width)
       or (new.height is distinct from old.height) then
      new.version := old.version + 1;
    end if;
    new.updated_at := now();
  end if;

  return new;
end $$;

drop trigger if exists trg_validate_certificate_template on public.certificate_templates;
create trigger trg_validate_certificate_template
  before insert or update on public.certificate_templates
  for each row execute function public.validate_certificate_template();

-- Seed the Default System Template ("Certificate of Participation", "This is to certify that", "has participated in")
insert into public.certificate_templates (
  id, owner_id, name, file_path, mime_type, width, height, version, is_global, is_active, layout
)
values (
  '00000000-0000-0000-0000-00000000ce01',
  null,
  'BiPSU Default — Certificate of Participation',
  null,
  'system/default',
  2000,
  1414,
  1,
  true,
  true,
  '[
    {"type":"participant_name","x":250,"y":500,"width":1500,"height":90,"font":"serif","size":62,"color":"#991b1b","alignment":"center","auto_shrink":true},
    {"type":"program","x":350,"y":610,"width":1300,"height":42,"font":"sans","size":26,"color":"#57534e","alignment":"center","auto_shrink":true},
    {"type":"event_name","x":250,"y":760,"width":1500,"height":75,"font":"serif","size":46,"color":"#1c1917","alignment":"center","auto_shrink":true},
    {"type":"event_date","x":350,"y":855,"width":1300,"height":40,"font":"sans","size":26,"color":"#44403c","alignment":"center","auto_shrink":true},
    {"type":"venue","x":350,"y":900,"width":1300,"height":40,"font":"sans","size":24,"color":"#57534e","alignment":"center","auto_shrink":true},
    {"type":"organizing_office","x":350,"y":945,"width":1300,"height":38,"font":"sans","size":22,"color":"#78716c","alignment":"center","auto_shrink":true},
    {"type":"signatory_1_name","x":280,"y":1075,"width":560,"height":36,"font":"sans","size":24,"color":"#1c1917","alignment":"center","auto_shrink":true},
    {"type":"signatory_1_title","x":280,"y":1112,"width":560,"height":32,"font":"sans","size":20,"color":"#57534e","alignment":"center","auto_shrink":true},
    {"type":"signatory_2_name","x":1160,"y":1075,"width":560,"height":36,"font":"sans","size":24,"color":"#1c1917","alignment":"center","auto_shrink":true},
    {"type":"signatory_2_title","x":1160,"y":1112,"width":560,"height":32,"font":"sans","size":20,"color":"#57534e","alignment":"center","auto_shrink":true},
    {"type":"issue_date","x":700,"y":1215,"width":600,"height":32,"font":"sans","size":20,"color":"#57534e","alignment":"center","auto_shrink":false},
    {"type":"certificate_id","x":700,"y":1255,"width":600,"height":32,"font":"mono","size":20,"color":"#44403c","alignment":"center","auto_shrink":false},
    {"type":"qr_code","x":1680,"y":1090,"width":180,"height":180,"font":"sans","size":16,"color":"#000000","alignment":"center","auto_shrink":false}
  ]'::jsonb
)
on conflict (id) do nothing;

-- 2. Add Certificate Settings columns to public.events
alter table public.events add column if not exists certificates_enabled    boolean not null default true;
alter table public.events add column if not exists certificate_template_id uuid references public.certificate_templates(id) on delete set null;
alter table public.events add column if not exists organizing_office       text;
alter table public.events add column if not exists signatory_1_name        text;
alter table public.events add column if not exists signatory_1_title       text;
alter table public.events add column if not exists signatory_1_sig_path    text;
alter table public.events add column if not exists signatory_2_name        text;
alter table public.events add column if not exists signatory_2_title       text;
alter table public.events add column if not exists signatory_2_sig_path    text;

grant select (
  id, title, description, venue, starts_at, ends_at,
  registration_opens_at, registration_deadline,
  early_grace_minutes, late_grace_minutes, late_after_minutes,
  allow_early_test_attendance, capacity, registered_count, status,
  image_path, image_updated_at,
  feedback_audience, feedback_opened_early,
  allowed_schools, allowed_programs, allowed_year_levels,
  certificates_enabled, certificate_template_id, organizing_office,
  signatory_1_name, signatory_1_title, signatory_1_sig_path,
  signatory_2_name, signatory_2_title, signatory_2_sig_path,
  created_by, created_at
) on public.events to authenticated;

-- 3. Table: public.certificates
create table if not exists public.certificates (
  id                     uuid primary key default gen_random_uuid(),
  certificate_code       text not null unique,
  user_id                uuid not null references public.profiles(id) on delete cascade,
  event_id               uuid not null references public.events(id) on delete cascade,
  template_id            uuid references public.certificate_templates(id) on delete set null,
  template_version       int not null default 1,
  layout_snapshot        jsonb not null,
  issued_at              timestamptz not null default now(),
  status                 text not null default 'valid' check (status in ('valid', 'revoked')),
  name_at_issuance       text not null,
  event_name_at_issuance text not null,
  event_date_at_issuance text not null,
  revoked_by             uuid references public.profiles(id) on delete set null,
  revoked_at             timestamptz,
  revoke_reason          text,
  unique (user_id, event_id)
);

-- Block deleting a template that is referenced by any issued certificate or event
create or replace function public.prevent_template_delete_if_used()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if old.id = '00000000-0000-0000-0000-00000000ce01'::uuid then
    raise exception 'The default system template cannot be deleted';
  end if;
  if exists (select 1 from public.certificates where template_id = old.id)
     or exists (select 1 from public.events where certificate_template_id = old.id) then
    raise exception 'Template is in use by existing events or certificates. Mark it as inactive instead of deleting.';
  end if;
  perform public.log_activity('certificate_template.deleted', 'certificate_template', old.id::text, jsonb_build_object('name', old.name));
  return old;
end $$;

drop trigger if exists trg_prevent_template_delete on public.certificate_templates;
create trigger trg_prevent_template_delete
  before delete on public.certificate_templates
  for each row execute function public.prevent_template_delete_if_used();

create or replace function public.trg_log_certificate_template()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    perform public.log_activity('certificate_template.created', 'certificate_template', new.id::text,
      jsonb_build_object('name', new.name, 'is_global', new.is_global, 'version', new.version));
  elsif tg_op = 'UPDATE' then
    perform public.log_activity('certificate_template.updated', 'certificate_template', new.id::text,
      jsonb_build_object('name', new.name, 'is_global', new.is_global, 'version', new.version, 'is_active', new.is_active));
  end if;
  return new;
end $$;

drop trigger if exists trg_log_certificate_template on public.certificate_templates;
create trigger trg_log_certificate_template
  after insert or update on public.certificate_templates
  for each row execute function public.trg_log_certificate_template();

-- 4. RLS on certificate_templates and certificates
alter table public.certificate_templates enable row level security;
alter table public.certificates enable row level security;

-- Organizers can read global templates and their own templates; Admins can read all
drop policy if exists cert_tpl_select on public.certificate_templates;
create policy cert_tpl_select on public.certificate_templates
  for select using (
    public.is_admin()
    or (public.is_organizer() and (is_global or owner_id = auth.uid()))
    or (is_global and id = '00000000-0000-0000-0000-00000000ce01'::uuid)
  );

drop policy if exists cert_tpl_insert on public.certificate_templates;
create policy cert_tpl_insert on public.certificate_templates
  for insert with check (
    public.is_admin()
    or (public.is_organizer() and owner_id = auth.uid() and not is_global)
  );

drop policy if exists cert_tpl_update on public.certificate_templates;
create policy cert_tpl_update on public.certificate_templates
  for update using (
    public.is_admin()
    or (public.is_organizer() and owner_id = auth.uid() and not is_global)
  )
  with check (
    public.is_admin()
    or (public.is_organizer() and owner_id = auth.uid() and not is_global)
  );

drop policy if exists cert_tpl_delete on public.certificate_templates;
create policy cert_tpl_delete on public.certificate_templates
  for delete using (
    public.is_admin()
    or (public.is_organizer() and owner_id = auth.uid() and not is_global)
  );

grant select, insert, update, delete on public.certificate_templates to authenticated;

-- Certificates RLS: Participants read own; Organizers read own events'; Admins read all. Direct writes blocked!
revoke insert, update, delete on public.certificates from anon, authenticated;
grant select on public.certificates to authenticated;

drop policy if exists cert_select on public.certificates;
create policy cert_select on public.certificates
  for select using (
    user_id = auth.uid()
    or public.can_manage_event(event_id)
  );

-- 5. Recreate event_stats view with certificate fields & count
drop view if exists public.event_stats;
create view public.event_stats as
select e.id, e.title, e.description, e.venue, e.starts_at, e.ends_at,
       e.registration_opens_at, e.registration_deadline,
       e.early_grace_minutes, e.late_grace_minutes, e.late_after_minutes,
       e.allow_early_test_attendance, e.capacity, e.registered_count, e.status,
       e.image_path, e.image_updated_at,
       case when public.is_admin() or (public.is_organizer() and e.created_by = auth.uid()) then e.feedback_url else null end as feedback_url,
       (e.feedback_url is not null) as has_feedback_url,
       e.feedback_audience, e.feedback_opened_early,
       e.allowed_schools, e.allowed_programs, e.allowed_year_levels,
       e.certificates_enabled, e.certificate_template_id, e.organizing_office,
       e.signatory_1_name, e.signatory_1_title, e.signatory_1_sig_path,
       e.signatory_2_name, e.signatory_2_title, e.signatory_2_sig_path,
       e.created_by, e.created_at,
       (select count(*) from public.attendance a
         where a.event_id = e.id and not a.voided and not a.is_test)::int as attended_count,
       (select count(*) from public.attendance a
         where a.event_id = e.id and not a.voided and a.is_test)::int as test_attended_count,
       (select count(*) from public.attendance a
         where a.event_id = e.id and a.voided)::int as voided_count,
       (select count(*) from public.certificates c
         where c.event_id = e.id and c.status = 'valid')::int as certificates_issued_count
from public.events e
where e.status = 'published' or public.is_admin() or (public.is_organizer() and e.created_by = auth.uid());
grant select on public.event_stats to authenticated;

-- 6. Random non-sequential certificate code generator (e.g. CERT-2026-K7M4Q9X2)
create or replace function public.generate_certificate_code(p_now timestamptz default now())
returns text language plpgsql volatile set search_path = public as $$
declare
  chars constant text := '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
  yr text := to_char(p_now at time zone 'Asia/Manila', 'YYYY');
  suffix text;
  code text;
  i int;
  b bytea;
begin
  loop
    suffix := '';
    b := extensions.gen_random_bytes(8);
    for i in 0..7 loop
      suffix := suffix || substr(chars, (get_byte(b, i) % length(chars)) + 1, 1);
    end loop;
    code := 'CERT-' || yr || '-' || suffix;
    exit when not exists (select 1 from public.certificates where certificate_code = code);
  end loop;
  return code;
end $$;

-- Format event date (single date or range if multi-day) in Asia/Manila
create or replace function public.fmt_event_date_range(p_starts timestamptz, p_ends timestamptz)
returns text language sql immutable as $$
  select case
    when to_char(p_starts at time zone 'Asia/Manila', 'YYYY-MM-DD') = to_char(p_ends at time zone 'Asia/Manila', 'YYYY-MM-DD') then
      trim(to_char(p_starts at time zone 'Asia/Manila', 'Mon FMDD, YYYY'))
    else
      trim(to_char(p_starts at time zone 'Asia/Manila', 'Mon FMDD, YYYY')) || ' – ' || trim(to_char(p_ends at time zone 'Asia/Manila', 'Mon FMDD, YYYY'))
  end;
$$;

-- 7. Transactional Certificate Issuance RPC
create or replace function public.issue_my_certificate(
  p_event_id uuid,
  p_now      timestamptz default now()
)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  uid   uuid := auth.uid();
  ev    public.events;
  reg   public.registrations;
  att   public.attendance;
  prof  public.profiles;
  tpl   public.certificate_templates;
  cert  public.certificates;
  org_p public.profiles;
  v_code text;
  v_date_str text;
  v_office text;
  v_snap jsonb;
begin
  if uid is null then raise exception 'Not authenticated'; end if;

  select * into ev from public.events where id = p_event_id;
  if not found then raise exception 'Event not found'; end if;

  select * into prof from public.profiles where id = uid;
  if not found then raise exception 'Profile not found'; end if;

  -- Rule: An organizer cannot get an attendee certificate for their own event
  if ev.created_by = uid and prof.role = 'organizer' then
    raise exception 'Organizers cannot receive an attendee certificate for their own event';
  end if;

  -- Check if certificate was already issued for (uid, p_event_id)
  -- Existing certificates remain accessible even if certificates_enabled was later turned off
  select * into cert from public.certificates where user_id = uid and event_id = p_event_id for update;
  if found then
    if cert.status = 'revoked' then
      raise exception 'This certificate has been revoked (%). Contact an administrator.', coalesce(cert.revoke_reason, 'no reason specified');
    end if;
    return to_jsonb(cert);
  end if;

  if not ev.certificates_enabled then
    raise exception 'Certificates are not enabled for this event';
  end if;

  if ev.status = 'cancelled' then
    raise exception 'This event was cancelled';
  end if;

  -- Rule: Event must have ended before a certificate can be issued
  if coalesce(p_now, now()) <= ev.ends_at then
    raise exception 'Certificates become available after the event ends on %.', public.fmt_manila(ev.ends_at);
  end if;

  -- Lock registration and verify valid non-voided, non-test attendance inside transaction
  select * into reg from public.registrations
   where event_id = p_event_id and user_id = uid and status = 'registered'
   for update;
  if not found then
    raise exception 'You do not have an active registration for this event';
  end if;

  select * into att from public.attendance
   where registration_id = reg.id and not voided and not is_test;
  if not found then
    raise exception 'No valid attendance record found for this event';
  end if;

  -- Resolve selected template or fallback to default global template
  if ev.certificate_template_id is not null then
    select * into tpl from public.certificate_templates where id = ev.certificate_template_id;
  end if;
  if tpl.id is null then
    select * into tpl from public.certificate_templates where id = '00000000-0000-0000-0000-00000000ce01'::uuid;
  end if;

  select * into org_p from public.profiles where id = ev.created_by;
  v_code := public.generate_certificate_code(coalesce(p_now, now()));
  v_date_str := public.fmt_event_date_range(ev.starts_at, ev.ends_at);
  v_office := coalesce(nullif(btrim(ev.organizing_office), ''), org_p.department, 'BiPSU Main Campus');

  v_snap := jsonb_build_object(
    'template_id', tpl.id,
    'template_name', tpl.name,
    'template_version', tpl.version,
    'file_path', tpl.file_path,
    'mime_type', tpl.mime_type,
    'width', tpl.width,
    'height', tpl.height,
    'fields', tpl.layout,
    'values', jsonb_build_object(
      'participant_name', coalesce(nullif(btrim(prof.full_name), ''), prof.email),
      'event_name', ev.title,
      'event_date', v_date_str,
      'venue', ev.venue,
      'organizing_office', v_office,
      'program', coalesce(prof.program, prof.course, ''),
      'school', coalesce(prof.department, ''),
      'year_level', case when prof.year_level is not null then 'Year ' || prof.year_level::text else '' end,
      'section', coalesce(prof.section, ''),
      'issue_date', trim(to_char(coalesce(p_now, now()) at time zone 'Asia/Manila', 'Mon FMDD, YYYY')),
      'signatory_1_name', coalesce(ev.signatory_1_name, org_p.full_name, 'Event Organizer'),
      'signatory_1_title', coalesce(ev.signatory_1_title, 'Event Organizer'),
      'signatory_1_sig_path', ev.signatory_1_sig_path,
      'signatory_2_name', coalesce(ev.signatory_2_name, 'EventSync Verification'),
      'signatory_2_title', coalesce(ev.signatory_2_title, 'BiPSU Main Campus'),
      'signatory_2_sig_path', ev.signatory_2_sig_path,
      'certificate_id', v_code,
      'qr_code', v_code
    )
  );

  insert into public.certificates (
    certificate_code, user_id, event_id, template_id, template_version,
    layout_snapshot, issued_at, status,
    name_at_issuance, event_name_at_issuance, event_date_at_issuance
  )
  values (
    v_code, uid, p_event_id, tpl.id, tpl.version,
    v_snap, coalesce(p_now, now()), 'valid',
    coalesce(nullif(btrim(prof.full_name), ''), prof.email),
    ev.title,
    v_date_str
  )
  on conflict (user_id, event_id) do update
    set user_id = excluded.user_id
  returning * into cert;

  perform public.log_activity(
    'certificate.issued', 'certificate', cert.id::text,
    jsonb_build_object('certificate_code', cert.certificate_code, 'event_id', p_event_id, 'user_id', uid)
  );

  return to_jsonb(cert);
end $$;
grant execute on function public.issue_my_certificate(uuid, timestamptz) to authenticated;

-- 8. Admin Revocation & Reissue RPCs
create or replace function public.admin_revoke_certificate(
  p_certificate_id uuid,
  p_reason         text
)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  cert public.certificates;
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
begin
  if not public.is_admin() then raise exception 'Admin only'; end if;
  if v_reason is null then raise exception 'A revocation reason is required'; end if;

  update public.certificates
     set status        = 'revoked',
         revoked_by    = auth.uid(),
         revoked_at    = now(),
         revoke_reason = v_reason
   where id = p_certificate_id
   returning * into cert;

  if not found then raise exception 'Certificate not found'; end if;

  perform public.log_activity(
    'certificate.revoked', 'certificate', cert.id::text,
    jsonb_build_object('certificate_code', cert.certificate_code, 'reason', v_reason)
  );

  return to_jsonb(cert);
end $$;
grant execute on function public.admin_revoke_certificate(uuid, text) to authenticated;

create or replace function public.admin_reissue_certificate(p_certificate_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  cert public.certificates;
  prof public.profiles;
  v_name text;
begin
  if not public.is_admin() then raise exception 'Admin only'; end if;
  select * into cert from public.certificates where id = p_certificate_id for update;
  if not found then raise exception 'Certificate not found'; end if;

  select * into prof from public.profiles where id = cert.user_id;
  v_name := coalesce(nullif(btrim(prof.full_name), ''), prof.email);

  update public.certificates
     set status           = 'valid',
         revoked_by       = null,
         revoked_at       = null,
         revoke_reason    = null,
         name_at_issuance = v_name,
         layout_snapshot  = jsonb_set(cert.layout_snapshot, '{values,participant_name}', to_jsonb(v_name))
   where id = p_certificate_id
   returning * into cert;

  perform public.log_activity(
    'certificate.reissued', 'certificate', cert.id::text,
    jsonb_build_object('certificate_code', cert.certificate_code, 'name_at_issuance', v_name)
  );

  return to_jsonb(cert);
end $$;
grant execute on function public.admin_reissue_certificate(uuid) to authenticated;

-- 9. Public Verification RPC with Rate-Limiting (never exposes ID numbers, email, or program)
create table if not exists public.certificate_verify_attempts (
  id           bigserial primary key,
  attempted_at timestamptz not null default now(),
  client_key   text not null
);
alter table public.certificate_verify_attempts enable row level security;

create or replace function public.verify_certificate_code(p_code text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_code text := upper(btrim(coalesce(p_code, '')));
  v_client text := coalesce(auth.uid()::text, current_setting('request.headers', true)::jsonb->>'x-forwarded-for', 'anon');
  v_recent int;
  cert public.certificates;
  ev   public.events;
  org_p public.profiles;
begin
  -- Clean up old rate-limit rows (> 5 minutes) and enforce max 30 lookups / minute per client
  delete from public.certificate_verify_attempts where attempted_at < now() - interval '5 minutes';
  select count(*) into v_recent
    from public.certificate_verify_attempts
   where client_key = v_client and attempted_at > now() - interval '1 minute';
  if v_recent >= 30 then
    raise exception 'Too many verification attempts. Please wait a minute and try again.';
  end if;
  insert into public.certificate_verify_attempts(client_key) values (v_client);

  if v_code = '' then
    return jsonb_build_object('status', 'not_found');
  end if;

  select * into cert from public.certificates where upper(certificate_code) = v_code;
  if not found then
    return jsonb_build_object('status', 'not_found', 'certificate_code', v_code);
  end if;

  select * into ev from public.events where id = cert.event_id;
  select * into org_p from public.profiles where id = ev.created_by;

  -- Strictly return ONLY allowed public fields (no school_id, email, or program)
  return jsonb_build_object(
    'status', cert.status,
    'certificate_code', cert.certificate_code,
    'participant_name', cert.name_at_issuance,
    'event_name', cert.event_name_at_issuance,
    'event_date', cert.event_date_at_issuance,
    'issuing_organizer', coalesce(
      nullif(btrim(cert.layout_snapshot->'values'->>'organizing_office'), ''),
      nullif(btrim(ev.organizing_office), ''),
      org_p.full_name,
      'BiPSU Main Campus'
    ),
    'issued_at', cert.issued_at,
    'revoked_at', cert.revoked_at,
    'revoke_reason', cert.revoke_reason
  );
end $$;
grant execute on function public.verify_certificate_code(text) to anon, authenticated;

-- 10. Update my_registrations(p_now) to include certificate status alongside feedback status
create or replace function public.my_registrations(p_now timestamptz default now())
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  uid uuid := auth.uid();
  out jsonb;
begin
  if uid is null then raise exception 'Not authenticated'; end if;

  select coalesce(jsonb_agg(
    jsonb_build_object(
      'id', r.id,
      'event_id', r.event_id,
      'status', r.status,
      'qr_token', r.qr_token,
      'registered_at', r.registered_at,
      'events', jsonb_build_object(
        'id', e.id,
        'title', e.title,
        'venue', e.venue,
        'starts_at', e.starts_at,
        'ends_at', e.ends_at,
        'early_grace_minutes', e.early_grace_minutes,
        'late_grace_minutes', e.late_grace_minutes,
        'late_after_minutes', e.late_after_minutes,
        'status', e.status,
        'image_path', e.image_path,
        'image_updated_at', e.image_updated_at,
        'feedback_audience', e.feedback_audience,
        'feedback_opened_early', e.feedback_opened_early,
        'certificates_enabled', e.certificates_enabled
      ),
      'attendance', case
        when a.id is not null and not a.voided and not a.is_test then
          jsonb_build_object('checked_in_at', a.checked_in_at, 'check_out_time', a.check_out_time)
        else null
      end,
      'feedback', (
        case
          when e.feedback_url is null or e.status = 'cancelled' or r.status <> 'registered' then
            jsonb_build_object('available', false, 'reason', 'unavailable')
          when p_now <= e.ends_at and not e.feedback_opened_early then
            jsonb_build_object('available', false, 'reason', 'not_ended')
          when e.feedback_audience = 'attended' and (a.id is null or a.voided or a.is_test) then
            jsonb_build_object('available', false, 'reason', 'attended_only')
          else
            jsonb_build_object('available', true, 'url', e.feedback_url, 'reason', 'eligible')
        end
      ),
      'certificate', (
        case
          when c.id is not null and c.status = 'revoked' then
            jsonb_build_object('state', 'revoked', 'certificate_id', c.id, 'certificate_code', c.certificate_code, 'revoke_reason', c.revoke_reason)
          when c.id is not null and c.status = 'valid' then
            jsonb_build_object('state', 'ready', 'issued', true, 'certificate_id', c.id, 'certificate_code', c.certificate_code)
          when a.id is null or a.voided or a.is_test or r.status <> 'registered' then
            jsonb_build_object('state', 'not_attended', 'available_at', e.ends_at)
          when not e.certificates_enabled then
            jsonb_build_object('state', 'disabled')
          when p_now <= e.ends_at then
            jsonb_build_object('state', 'pending_event_end', 'available_at', e.ends_at)
          else
            jsonb_build_object('state', 'ready', 'issued', false, 'available_at', e.ends_at)
        end
      )
    ) order by r.registered_at desc
  ), '[]'::jsonb)
  into out
  from public.registrations r
  join public.events e on e.id = r.event_id
  left join public.attendance a on a.registration_id = r.id
  left join public.certificates c on c.event_id = r.event_id and c.user_id = uid
  where r.user_id = uid;

  return out;
end $$;
grant execute on function public.my_registrations(timestamptz) to authenticated;

-- 11. Private Storage Bucket for Certificate Templates & Signatures (10 MB limit, PNG/JPG/PDF)
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'certificate-templates',
  'certificate-templates',
  false,
  10485760,
  array['image/png', 'image/jpeg', 'application/pdf']
)
on conflict (id) do update
  set public = excluded.public,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists cert_templates_storage_select on storage.objects;
create policy cert_templates_storage_select
  on storage.objects for select to authenticated
  using (bucket_id = 'certificate-templates');

drop policy if exists cert_templates_storage_insert on storage.objects;
create policy cert_templates_storage_insert
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'certificate-templates'
    and (public.is_admin() or (public.is_organizer() and (storage.foldername(name))[1] = auth.uid()::text))
  );

drop policy if exists cert_templates_storage_update on storage.objects;
create policy cert_templates_storage_update
  on storage.objects for update to authenticated
  using (
    bucket_id = 'certificate-templates'
    and (public.is_admin() or (public.is_organizer() and (storage.foldername(name))[1] = auth.uid()::text))
  );

drop policy if exists cert_templates_storage_delete on storage.objects;
create policy cert_templates_storage_delete
  on storage.objects for delete to authenticated
  using (
    bucket_id = 'certificate-templates'
    and (public.is_admin() or (public.is_organizer() and (storage.foldername(name))[1] = auth.uid()::text))
  );

-- Fix profile update trigger permission so authenticated users can save program changes on My Profile
grant execute on function public.resolve_program_selection(text, text, text, text, text) to authenticated;
alter function public.validate_profile_update() security definer;
alter function public.sync_profile_program_code() security definer;

notify pgrst, 'reload schema';
