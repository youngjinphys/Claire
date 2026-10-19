-- Stage 12 runtime XDR: privacy-limited, atomic login-attempt guard.
-- Caller: server-side service_role only. Never store IP, email, password or token.
create table if not exists public.s12_auth_rate_window (
  scope_key text primary key check (scope_key ~ '^[as]:[a-f0-9]{64}$'),
  attempts integer not null default 0 check (attempts >= 0),
  failures integer not null default 0 check (failures >= 0),
  window_started_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists s12_auth_rate_window_updated_idx
  on public.s12_auth_rate_window (updated_at);
alter table public.s12_auth_rate_window enable row level security;
revoke all on table public.s12_auth_rate_window from public, anon, authenticated;
grant select, insert, update, delete on table public.s12_auth_rate_window to service_role;

create or replace function public.s12_auth_claim(p_account_key text, p_source_key text)
returns jsonb language plpgsql security invoker set search_path = ''
as $$
declare
  v_now timestamptz := clock_timestamp();
  v_scope text;
  v_attempts integer;
  v_started timestamptz;
  v_account integer := 0;
  v_source integer := 0;
  v_retry integer := 0;
begin
  if p_account_key !~ '^a:[a-f0-9]{64}$'
     or (p_source_key is not null and p_source_key !~ '^s:[a-f0-9]{64}$') then
    raise exception 'invalid XDR guard key' using errcode = '22023';
  end if;
  -- Deterministic lock order: account then source, each atomic upsert.
  foreach v_scope in array array[p_account_key, p_source_key] loop
    if v_scope is null then continue; end if;
    insert into public.s12_auth_rate_window(scope_key,attempts,failures,window_started_at,updated_at)
      values (v_scope,1,0,v_now,v_now)
    on conflict (scope_key) do update set
      attempts = case when s12_auth_rate_window.window_started_at <= v_now - interval '10 minutes'
        then 1 else least(s12_auth_rate_window.attempts + 1, 100000) end,
      failures = case when s12_auth_rate_window.window_started_at <= v_now - interval '10 minutes'
        then 0 else s12_auth_rate_window.failures end,
      window_started_at = case when s12_auth_rate_window.window_started_at <= v_now - interval '10 minutes'
        then v_now else s12_auth_rate_window.window_started_at end,
      updated_at = v_now
    returning attempts, window_started_at into v_attempts, v_started;
    if v_scope = p_account_key then v_account := v_attempts; else v_source := v_attempts; end if;
    if (v_scope = p_account_key and v_attempts > 20)
       or (v_scope = p_source_key and v_attempts > 50) then
      v_retry := greatest(v_retry, greatest(1,ceil(extract(epoch from
        (v_started + interval '10 minutes' - v_now)))::integer));
    end if;
  end loop;
  return jsonb_build_object('allowed', v_retry = 0,
    'accountAttempts', v_account, 'sourceAttempts', v_source,
    'retryAfterSeconds', v_retry);
end
$$;

create or replace function public.s12_auth_record_result(
  p_account_key text, p_source_key text, p_success boolean
) returns jsonb language plpgsql security invoker set search_path = ''
as $$
declare
  v_now timestamptz := clock_timestamp();
  v_scope text;
  v_failures integer;
  v_account integer := 0;
  v_source integer := 0;
begin
  if p_account_key !~ '^a:[a-f0-9]{64}$'
     or (p_source_key is not null and p_source_key !~ '^s:[a-f0-9]{64}$')
     or p_success is null then
    raise exception 'invalid XDR guard result' using errcode = '22023';
  end if;
  foreach v_scope in array array[p_account_key, p_source_key] loop
    if v_scope is null then continue; end if;
    update public.s12_auth_rate_window
      set failures = case when p_success then 0 else least(failures + 1, 100000) end,
        updated_at = v_now
      where scope_key = v_scope and window_started_at > v_now - interval '10 minutes'
    returning failures into v_failures;
    if found then
      if v_scope = p_account_key then v_account := v_failures;
      else v_source := v_failures; end if;
    end if;
  end loop;
  return jsonb_build_object('accountFailures',v_account,'sourceFailures',v_source);
end
$$;

revoke execute on function public.s12_auth_claim(text,text) from public, anon, authenticated;
revoke execute on function public.s12_auth_record_result(text,text,boolean) from public, anon, authenticated;
grant execute on function public.s12_auth_claim(text,text) to service_role;
grant execute on function public.s12_auth_record_result(text,text,boolean) to service_role;

comment on table public.s12_auth_rate_window is
  'Stage 12 10-minute HMAC-keyed login attempt aggregates; no raw identities or passwords. Operator deletes rows older than 24h.';
