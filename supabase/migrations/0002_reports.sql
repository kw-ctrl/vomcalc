-- ─────────────────────────────────────────────────────────────────────────────
-- 0002 — the deal store the app already talks to.
--
-- api/deals/*.js read and write a `reports` table (with a `public.users` mirror for the
-- FK the older code expects). Those live in whatever project the app points at, so a new
-- project needs them too — otherwise "Save Deal" fails the moment someone is signed in
-- (while signed out it silently falls back to browser storage, which hides the problem).
-- ─────────────────────────────────────────────────────────────────────────────

-- ── public.users: a lightweight mirror of auth.users that the app upserts against ──
create table if not exists public.users (
  id             uuid primary key references auth.users(id) on delete cascade,
  email          citext,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  last_login_at  timestamptz
);

-- Keep it populated automatically rather than relying on every caller to upsert.
create or replace function public.sync_public_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.users (id, email, updated_at, last_login_at)
  values (new.id, new.email, now(), now())
  on conflict (id) do update
    set email = coalesce(excluded.email, public.users.email),
        updated_at = now(),
        last_login_at = now();
  return new;
end;
$$;

drop trigger if exists on_auth_user_synced on auth.users;
create trigger on_auth_user_synced
  after insert or update of email on auth.users
  for each row execute function public.sync_public_user();

-- ── reports: one row per saved deal ─────────────────────────────────────────
create table if not exists public.reports (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid references auth.users(id) on delete cascade,
  title             text,
  property_address  text,
  property_type     text,
  listed_price      numeric,
  velocity_score    numeric,
  moic              numeric,
  irr               numeric,
  input_snapshot    jsonb default '{}'::jsonb,
  result_snapshot   jsonb default '{}'::jsonb,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create index if not exists reports_user_updated_idx on public.reports (user_id, updated_at desc);

alter table public.users   enable row level security;
alter table public.reports enable row level security;

-- A signed-in user may read and write only their own deals. The serverless API uses the
-- service role and bypasses RLS; this policy protects the anon key that ships to browsers.
drop policy if exists reports_owner_all on public.reports;
create policy reports_owner_all on public.reports
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists users_read_own on public.users;
create policy users_read_own on public.users
  for select using (auth.uid() = id);
