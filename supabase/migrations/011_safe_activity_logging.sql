-- =====================================================================
-- Migration 011: Make log_activity() fault-tolerant so logging failures
-- can never break a request.
-- =====================================================================

create or replace function public.log_activity(
  p_action    text,
  p_entity    text,
  p_entity_id text,
  p_details   jsonb default '{}'
)
returns void language plpgsql security definer set search_path = public as $$
begin
  insert into public.activity_logs(actor_id, action, entity, entity_id, details)
  values (auth.uid(), p_action, p_entity, p_entity_id, coalesce(p_details, '{}'::jsonb));
exception when others then
  -- Never let background audit logging break the primary request
  null;
end $$;
revoke execute on function public.log_activity(text, text, text, jsonb) from public, anon, authenticated;
