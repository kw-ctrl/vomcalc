-- 0003: address/listing lookups (comps + revenue estimates)
--
-- Two tables:
--   lookup_cache  — one row per normalized address, so a repeat lookup costs nothing
--                   and the same address never pays the providers twice.
--   lookup_usage  — per-bucket counters, which is how rate limits and the daily cap on
--                   PAID (BnBCalc, $0.20/report) lookups are enforced. BnBCalc is only
--                   ever called behind a signed-in account, so this is the backstop that
--                   makes it impossible for the public box to run up a bill.

create table if not exists public.lookup_cache (
  address_key text primary key,
  query       text,
  payload     jsonb not null,
  created_at  timestamptz not null default now()
);

-- Cache is read/written by the API only (service role). No policies on purpose: with RLS
-- enabled and no policy, anon/authenticated keys cannot touch it at all.
alter table public.lookup_cache enable row level security;

create index if not exists lookup_cache_created_idx on public.lookup_cache (created_at desc);

create table if not exists public.lookup_usage (
  bucket     text primary key,
  count      int not null default 0,
  updated_at timestamptz not null default now()
);

alter table public.lookup_usage enable row level security;

-- Atomic increment. Returns the count AFTER incrementing, so callers can compare against
-- a limit without a read-then-write race (two simultaneous requests can't both slip past).
create or replace function public.bump_lookup_usage(p_bucket text)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  new_count int;
begin
  insert into public.lookup_usage (bucket, count, updated_at)
  values (p_bucket, 1, now())
  on conflict (bucket) do update
    set count = public.lookup_usage.count + 1,
        updated_at = now()
  returning count into new_count;

  return new_count;
end;
$$;

-- Housekeeping: drop usage counters older than a week (bucket keys end in a date).
create or replace function public.prune_lookup_usage()
returns void
language sql
security definer
set search_path = public
as $$
  delete from public.lookup_usage where updated_at < now() - interval '7 days';
$$;

revoke all on function public.bump_lookup_usage(text) from public, anon, authenticated;
revoke all on function public.prune_lookup_usage() from public, anon, authenticated;
