-- ─────────────────────────────────────────────────────────────────────────────
-- 0004 — every signed-in user gets an access record.
--
-- The bug this fixes: `effective_access()` loads the accounts row FIRST and returns
-- 'free' with reason 'no account record' before it ever consults the EV allowlist or a
-- paid subscription. Accounts rows were only ever created lazily, by whatever happened to
-- call ensureAccount() first (a Stripe webhook, a redeem). So someone who had just signed
-- up had no row, and an Escape Velocity member added to `ev_member_emails` by email — the
-- whole point of that table — still resolved to 'free'.
--
-- Verified against production before writing this: a fresh signup had no accounts row and
-- effective_access returned {"level":"free","reason":"no account record"} even with the
-- address sitting in ev_member_emails. Meaning the allowlist and the Stripe EV grant both
-- silently failed for anyone who had not already transacted.
--
-- `public.users` (0002) keeps a profile row; this is the access row.
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function public.sync_account_record()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.accounts (user_id, email, updated_at)
  values (new.id, coalesce(new.email, ''), now())
  on conflict (user_id) do update
    set email      = coalesce(excluded.email, public.accounts.email),
        updated_at = now();
  return new;
end;
$$;

drop trigger if exists on_auth_user_account_synced on auth.users;
create trigger on_auth_user_account_synced
  after insert or update of email on auth.users
  for each row execute function public.sync_account_record();

-- Backfill everyone who already signed up without one. base_level keeps its default
-- ('free'), so this cannot hand anyone access they did not already have.
insert into public.accounts (user_id, email)
select u.id, coalesce(u.email, '')
  from auth.users u
  left join public.accounts a on a.user_id = u.id
 where a.user_id is null;

revoke all on function public.sync_account_record() from public;
