-- ─────────────────────────────────────────────────────────────────────────────
-- VomCalc — accounts, marketing list, access codes, subscriptions
-- Run with:  supabase db push   (or paste into the SQL editor)
--
-- Design notes
--  * `subscribers` is the MARKETING list — one row per human email, independent of
--    whether they ever confirm an account. Exportable to a sheet at any time.
--  * `accounts` is the ACCESS record, keyed to auth.users.
--  * `access_codes` is how free access is handed out (YouTube/IG DMs = a code that
--    grants a trial; the EV code grants permanent access).
--  * Access is resolved by `effective_access()` on the SERVER so the client can
--    never grant itself anything.
--  * RLS is ON everywhere with no permissive policies: only the service role
--    (used by the serverless API) can read/write. Defense in depth.
-- ─────────────────────────────────────────────────────────────────────────────

create extension if not exists citext;

-- ── Marketing list ───────────────────────────────────────────────────────────
create table if not exists public.subscribers (
  email              citext primary key,
  source             text,                    -- 'vom-signup' | 'youtube' | 'instagram' | 'ev-community'
  utm                jsonb default '{}'::jsonb,
  first_seen_at      timestamptz not null default now(),
  last_seen_at       timestamptz not null default now(),
  signup_count       integer not null default 1,
  marketing_opt_in   boolean not null default true,
  unsubscribed_at    timestamptz,
  notes              text
);

-- ── Accounts (access) ────────────────────────────────────────────────────────
create table if not exists public.accounts (
  user_id                 uuid primary key references auth.users(id) on delete cascade,
  email                   citext not null,
  -- Base level granted directly (not counting a live code/subscription):
  base_level              text not null default 'free',   -- free | ev_member
  trial_ends_at           timestamptz,
  trial_code              citext,
  stripe_customer_id      text,
  stripe_subscription_id  text,
  subscription_status     text,                            -- active | trialing | past_due | canceled | unpaid
  current_period_end      timestamptz,
  plan                    text,                            -- monthly | annual
  first_seen_at           timestamptz not null default now(),
  updated_at              timestamptz not null default now()
);

create index if not exists accounts_email_idx on public.accounts (email);
create index if not exists accounts_stripe_customer_idx on public.accounts (stripe_customer_id);

-- ── EV member allowlist ──────────────────────────────────────────────────────
-- Whichever route Kassidy picks (a private code OR an email list), both work.
create table if not exists public.ev_member_emails (
  email       citext primary key,
  added_at    timestamptz not null default now(),
  note        text
);

-- ── Access codes ─────────────────────────────────────────────────────────────
create table if not exists public.access_codes (
  code             citext primary key,
  grants_level     text not null default 'trial',   -- trial | ev_member
  grants_days      integer,                          -- null = permanent (ev_member)
  source           text,                             -- youtube | instagram | ev-community | partner
  campaign         text,
  max_redemptions  integer,                          -- null = unlimited
  redeemed_count   integer not null default 0,
  starts_at        timestamptz not null default now(),
  expires_at       timestamptz,                      -- when the CODE stops working
  active           boolean not null default true,
  created_at       timestamptz not null default now(),
  constraint grants_shape check (
    (grants_level = 'ev_member' and grants_days is null)
    or (grants_level = 'trial' and grants_days is not null and grants_days > 0)
  )
);

create table if not exists public.code_redemptions (
  id           bigserial primary key,
  code         citext not null references public.access_codes(code) on delete cascade,
  user_id      uuid not null references auth.users(id) on delete cascade,
  email        citext,
  redeemed_at  timestamptz not null default now(),
  unique (code, user_id)
);

create index if not exists code_redemptions_user_idx on public.code_redemptions (user_id);

-- ── Funnel events (marketing analytics) ──────────────────────────────────────
create table if not exists public.events (
  id         bigserial primary key,
  user_id    uuid,
  email      citext,
  name       text not null,                 -- signup | code_redeemed | checkout_started | subscribed | report_generated
  props      jsonb default '{}'::jsonb,
  at         timestamptz not null default now()
);

create index if not exists events_name_at_idx on public.events (name, at desc);

-- ─────────────────────────────────────────────────────────────────────────────
-- effective_access(): THE authoritative access decision.
-- Order of precedence: ev_member > paid > trial > free
-- Returns the level plus why, so the UI can say something honest.
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function public.effective_access(p_user_id uuid)
returns table (level text, reason text, expires_at timestamptz)
language plpgsql
security definer
set search_path = public
as $$
declare
  a public.accounts;
  is_ev boolean;
begin
  if p_user_id is null then
    return query select 'anonymous'::text, 'not signed in'::text, null::timestamptz;
    return;
  end if;

  select * into a from public.accounts where user_id = p_user_id;
  if not found then
    return query select 'free'::text, 'no account record'::text, null::timestamptz;
    return;
  end if;

  select exists (select 1 from public.ev_member_emails e where e.email = a.email) into is_ev;

  -- 1. EV member — permanent
  if a.base_level = 'ev_member' or is_ev then
    return query select 'ev_member'::text, 'Escape Velocity member'::text, null::timestamptz;
    return;
  end if;

  -- 2. Paid — active subscription not past its period end
  if a.stripe_subscription_id is not null
     and coalesce(a.subscription_status, '') in ('active', 'trialing')
     and (a.current_period_end is null or a.current_period_end > now()) then
    return query select 'paid'::text, coalesce(a.plan, 'subscription')::text, a.current_period_end;
    return;
  end if;

  -- 3. Trial from a redeemed code
  if a.trial_ends_at is not null and a.trial_ends_at > now() then
    return query select 'trial'::text, 'free access code'::text, a.trial_ends_at;
    return;
  end if;

  -- 4. Otherwise free (calculator + velocity score)
  if a.trial_ends_at is not null then
    return query select 'expired'::text, 'free period ended'::text, a.trial_ends_at;
    return;
  end if;

  return query select 'free'::text, 'free tier'::text, null::timestamptz;
end;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- redeem_code(): atomic single-redemption. Safe under concurrency.
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function public.redeem_code(p_code citext, p_user_id uuid, p_email citext)
returns table (ok boolean, level text, expires_at timestamptz, message text)
language plpgsql
security definer
set search_path = public
as $$
declare
  c public.access_codes;
  already int;
  new_expiry timestamptz;
begin
  if p_user_id is null then
    return query select false, null::text, null::timestamptz, 'Sign in first.'::text;
    return;
  end if;

  -- Lock the code row so two simultaneous redemptions can't exceed the cap
  select * into c from public.access_codes where code = upper(btrim(p_code)) for update;
  if not found then
    return query select false, null::text, null::timestamptz, 'That code is not valid.'::text;
    return;
  end if;
  if not c.active then
    return query select false, null::text, null::timestamptz, 'That code is no longer active.'::text;
    return;
  end if;
  if c.expires_at is not null and c.expires_at <= now() then
    return query select false, null::text, null::timestamptz, 'That code has expired.'::text;
    return;
  end if;

  select count(*) into already from public.code_redemptions r
    where r.code = c.code and r.user_id = p_user_id;
  if already > 0 then
    return query select false, null::text, null::timestamptz, 'You have already used that code.'::text;
    return;
  end if;

  if c.max_redemptions is not null and c.redeemed_count >= c.max_redemptions then
    return query select false, null::text, null::timestamptz, 'That code has been fully claimed.'::text;
    return;
  end if;

  insert into public.code_redemptions (code, user_id, email) values (c.code, p_user_id, p_email);

  update public.access_codes
     set redeemed_count = redeemed_count + 1
   where code = c.code;

  -- Apply the grant
  insert into public.accounts (user_id, email, updated_at)
    values (p_user_id, coalesce(p_email, ''), now())
    on conflict (user_id) do nothing;

  if c.grants_level = 'ev_member' then
    update public.accounts
       set base_level = 'ev_member', updated_at = now()
     where user_id = p_user_id;
    return query select true, 'ev_member'::text, null::timestamptz, 'Escape Velocity access unlocked — permanent.'::text;
    return;
  end if;

  -- Trial: extend from whichever is later — now, or an existing trial end (stacks)
  select greatest(now(), coalesce(a.trial_ends_at, now())) into new_expiry
    from public.accounts a where a.user_id = p_user_id;

  update public.accounts
     set trial_ends_at = new_expiry + make_interval(days => c.grants_days),
         trial_code = c.code,
         updated_at = now()
   where user_id = p_user_id;

  select a.trial_ends_at into new_expiry from public.accounts a where a.user_id = p_user_id;

  return query select true, 'trial'::text, new_expiry, ('Free access until ' || to_char(new_expiry, 'Mon DD, YYYY'))::text;
end;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- RLS: on, with no permissive policies. Service role (serverless) bypasses.
-- ─────────────────────────────────────────────────────────────────────────────
alter table public.subscribers       enable row level security;
alter table public.accounts          enable row level security;
alter table public.ev_member_emails  enable row level security;
alter table public.access_codes      enable row level security;
alter table public.code_redemptions  enable row level security;
alter table public.events            enable row level security;

-- A signed-in user may read ONLY their own access record (never the code list,
-- never the subscriber list).
drop policy if exists accounts_read_own on public.accounts;
create policy accounts_read_own on public.accounts
  for select using (auth.uid() = user_id);
