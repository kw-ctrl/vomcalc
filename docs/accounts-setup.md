# VomCalc — Accounts, Email List & Access Codes

**Status: LIVE.** Accounts, email capture and access codes are running in production.
The paid gate is **off**, so everyone still gets the full tool for free while the list builds.

Last updated: 16 Sep 2026

| | |
|---|---|
| Supabase project | `luaqzmyvgliljtiecojg` (us-west-2, **free tier**) |
| Live codes | `YOUTUBE14` (14 days, unlimited) · `ESCAPE-EV` (permanent, EV members) |
| Admin token | in Vercel + `~/.hermes/vomcalc_env` (chmod 600) — governs `/api/admin/codes` |
| Paid gate | **off** (`VOM_GATE_ENABLED` unset) |
| Google SSO | **live** — enabled 16 Sep |
| Watchdog | daily 6am keep-alive cron `c6c4925e88d9` |
| Email list export | daily 7am → Drive, cron `5d0d473b8ba0` |
| Owner access | kw@ + kassidywarren@gmail.com are `ev_member` (free forever) |

---

## 1. The model

| Who | What they get | How |
|---|---|---|
| Anyone | Calculator + Velocity Score | No account needed |
| Free account | Same, and their email joins the list | Sign In → create account |
| **YouTube / IG code** | **Everything free for 14 days** | One code per video/DM, or single-use batches |
| **EV community** | **Everything free, forever** | Private code, or their email on the allowlist |
| Paid (after the free period) | Everything, ongoing | Stripe subscription — **not wired yet** |

---

## 2. What's live

**Email list** — `subscribers` table. Captured the moment someone submits the signup form
(not only once they confirm), with source + UTM. Every address also mirrors to your vault CRM.

A CSV copy lives in Drive (**Seven Outputs → VomCalc — Email List (latest).csv**) and is refreshed
daily, kept as one file so the link never changes. Any email tool can import it. Run it on demand
with `bash scripts/export-subscribers.sh`.

**Accounts** — Supabase auth: email + password, **and Google sign-in** (a "Continue with Google"
button appears in the sign-in modal automatically; the button only renders while the provider is
actually configured, so a dead button can never show). There's a Sign In button in the app header.
Signup is instant (no confirmation email round-trip) because Supabase's built-in sender is
rate-limited to a trickle on free tier and would have silently failed under real traffic.
A one-line change reverts that if you'd rather verify addresses.

**Codes** — `access_codes` + `code_redemptions`. Redeemed in the app ("Redeem a Code" in the
account menu, or on the gate itself). Rules enforced in the database: one use per account,
caps respected even under simultaneous redemption, expired/deactivated codes refused, and a
trial code **adds** to any remaining time rather than replacing it.

**Access levels** — decided server-side by `effective_access()`:
EV member → paid → trial → free. The browser can't grant itself anything.

**Deals** — now save to the server (per account) with a browser-local fallback when signed out.

---

## 3. Handing out access

```bash
# A shared code for a video description — 14 days, unlimited uses
curl -X POST https://www.vomcalc.com/api/admin/codes \
  -H "x-admin-token: $ADMIN_TOKEN" -H 'Content-Type: application/json' \
  -d '{"code":"YOUTUBE14","grantsDays":14,"source":"youtube","maxRedemptions":null}'

# 25 single-use codes to DM
curl -X POST https://www.vomcalc.com/api/admin/codes \
  -H "x-admin-token: $ADMIN_TOKEN" -H 'Content-Type: application/json' \
  -d '{"batch":25,"prefix":"IG","grantsDays":14,"source":"instagram"}'

# Permanent access for an EV member
curl -X POST https://www.vomcalc.com/api/admin/codes \
  -H "x-admin-token: $ADMIN_TOKEN" -H 'Content-Type: application/json' \
  -d '{"code":"ESCAPE-EV","grantsLevel":"ev_member"}'
```

For YouTube, put the deep link in the description: **`vomcalc.com/app?code=YOUTUBE14`** — the
field arrives pre-filled.

---

## 4. Still to do

**Stripe (billing).** Blocker is only the key — the one in the repo expired and was test-mode
anyway. Then `bash scripts/stripe-setup.sh` creates **both** products (VomCalc monthly/annual
AND the Escape Velocity membership), the webhook endpoint, and pushes every id to Vercel.

**A price.** Not chosen yet.

---

## 4b. Escape Velocity onboarding — Stripe payment → access

Two different things land in the same webhook and they are not interchangeable:

| | VomCalc subscription | Escape Velocity |
|---|---|---|
| What it is | a tool subscription | a community membership |
| Grants | `paid` (ends with the subscription) | `ev_member` (permanent) |
| Cancelling it | revokes premium at period end | **never** auto-revokes (see below) |

**The chain**

1. Buyer pays on a Stripe **payment link** that carries `metadata.tier = ev`.
2. `checkout.session.completed` hits `/api/billing/webhook`.
3. The EV branch calls `grantEv()` **before** the `if (!userId) break` guard — a payment-link
   buyer has no account yet, so that guard would hand a paying member nothing while the
   webhook still reported success.
4. `grantEv()` writes two places: `ev_member_emails` (durable — makes them `ev_member` the
   moment they sign up with the email they paid with, order no longer matters) and
   `accounts.base_level` (when they were already signed in).
5. `effective_access()` then returns `ev_member` everywhere: courses, resource library,
   partner directory and the full tool.

**The bug this uncovered (fixed 16 Sep, migration `0004_accounts_on_signup.sql`)**

`effective_access()` loads the `accounts` row first and returned `free` / "no account record"
before it ever consulted the allowlist. Accounts rows were only created lazily, so anyone who
had just signed up had none — meaning **the EV allowlist and the Stripe EV grant both silently
failed for anyone who had not already transacted**. Proven against production before the fix
(a fresh signup resolved to `{"level":"free","reason":"no account record"}` with the address
sitting in `ev_member_emails`). 0004 adds an `auth.users` trigger that creates the access row
on signup, plus a backfill. Applied to production and verified.

**Still manual — the last mile**

Paying grants portal access; it does **not** put anyone in the Google Drive folders. Those are
shared user-by-user (~38 members), with no link sharing, so a member who is not on the share
gets "You need access" on every resource link. Today that is a manual step. It is automatable:
read new `ev_member_emails` rows and `permissions.create` (role `reader`) on the EV folder
tree with kw@'s Drive token, tracked in a state file so it is idempotent. Worth building —
otherwise the welcome email links to resources the member cannot open.

**Not auto-revoked, on purpose.** Cancelling an EV subscription does not strip the allowlist
row: a manual grant and a Stripe grant look identical in that table, so an automatic revoke
would silently remove a member Kassidy added by hand. Revoking an EV membership is a
deliberate manual action until the grant records its origin separately.

**Verify it any time (no Stripe key needed, hits the real database with the real handler):**

```bash
node scripts/ev-onboarding-test.mjs    # 12 assertions — EV grant, replay, and the control
                                       # that a $20 tool subscription is NOT mistaken for EV
```

---

**Google SSO — DONE.** OAuth client created and wired into Supabase. Verified by starting the real
authorize handshake: Google returns its sign-in page rather than `redirect_uri_mismatch`, so the
redirect URI is registered correctly. Credentials are stored in `~/.hermes/vomcalc_env`; to move to
a different project, re-run provisioning with `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`.

**Landing copy.** No longer blocks the flip: each promise carries both versions, and
`js/landing-gate.js` swaps them from the server's gate flag. While the gate is off the page renders
byte-identically to before (verified by hash); flipping the gate changes the wording automatically.
The authored copy is a draft — edit it in `public/landing.html` (`data-copy-gated="…"`).

**Vault CRM mirror is failing.** `vault.kassidywarren.com/api/subscribe` returns HTTP 500 for a
valid payload (reproducible with plain curl, so it's not the app). Their list isn't receiving
addresses. Our own `subscribers` table is the source of truth either way; worth fixing or
retiring that endpoint.

**Free tier risk.** Free projects pause after ~7 days idle and are deleted if left paused — that
is how the previous project was lost. The daily watchdog prevents the pause, but now that money
is involved, **Pro ($25/mo) also buys daily backups**. One-line upgrade.

---

## 5. Re-running provisioning

Idempotent. It finds the existing project by name, re-applies migrations, reuses the existing
admin token, re-pushes env and redeploys:

```bash
cd ~/projects/vomcalc
SUPABASE_ACCESS_TOKEN=*** bash scripts/provision.sh
```

---

## 6. Verification

```bash
bash supabase/tests/run.sh           # 26 assertions against a throwaway Postgres
bash scripts/e2e-live-test.sh        # real users + real codes against production, then cleans up
node scripts/webhook-live-test.mjs   # 17 assertions: signed Stripe events -> entitlements
```

The webhook suite needs no Stripe key — it signs events with the deployment's own webhook secret
and asserts the real handler, database and access rules: active → paid, past_due loses premium,
canceled loses premium after the period, and tampered / wrong-secret / replayed payloads rejected.
`scripts/local-webhook-debug.mjs` runs the same handler locally with console output visible when
something needs isolating.

Covers every tier, expiry, code stacking, single-use caps, EV permanence, Stripe signature
rejection, an 8-way concurrency race on a 1-use code, the deal-store round-trip, the users
trigger and delete-cascade. **All passing.** The live suite creates and then removes its own
users, so the list stays clean.
