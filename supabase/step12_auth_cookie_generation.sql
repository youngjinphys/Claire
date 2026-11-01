-- Stage 12 · server-sequenced, per-operation, HttpOnly cookie generations.
-- Additive: no change to existing auth tables, credentials or existing RPCs.
-- Deploy to the existing Supabase project before enabling server generation mode.
create sequence if not exists public.s12_auth_cookie_generation_seq
  as bigint start with 1 increment by 1 minvalue 1
  maxvalue 9007199254740991 no cycle cache 1;

revoke all on sequence public.s12_auth_cookie_generation_seq
  from public, anon, authenticated;
grant usage on sequence public.s12_auth_cookie_generation_seq to service_role;

create or replace function public.s12_auth_cookie_generation_next()
returns text
language sql volatile security invoker set search_path = ''
as $$
  select pg_catalog.nextval('public.s12_auth_cookie_generation_seq'::pg_catalog.regclass)::text;
$$;

revoke execute on function public.s12_auth_cookie_generation_next()
  from public, anon, authenticated;
grant execute on function public.s12_auth_cookie_generation_next()
  to service_role;

comment on sequence public.s12_auth_cookie_generation_seq is
  'Monotone order for auth Set-Cookie generations across serverless workers; no account ID, IP or credentials stored.';
comment on function public.s12_auth_cookie_generation_next() is
  'Service role only. Returns one globally ordered generation for a cookie-changing auth operation.';
