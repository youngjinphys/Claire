-- Stage 8: independently verified instructor announcements; no user content is seeded.
-- Applied through Supabase migration step8_learning_announcements_owner_scope.
-- Only the server's service_role may access rows; client roles have no table grants.
create table if not exists public.learning_announcements (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete restrict,
  title text not null check (length(btrim(title)) between 1 and 120),
  content text not null check (length(btrim(content)) between 1 and 2000),
  created_at timestamptz not null default now()
);
create index if not exists learning_announcements_owner_created_idx
  on public.learning_announcements (owner_id, created_at, id);
alter table public.learning_announcements enable row level security;
revoke all privileges on table public.learning_announcements from public, anon, authenticated;
grant select, insert, update, delete on table public.learning_announcements to service_role;
