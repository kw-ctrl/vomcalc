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
| Watchdog | daily 6am keep-alive cron `c6c4925e88d9` |

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
Export any time from the table; a Drive-sheet sync can be added if you want it in a spreadsheet.

**Accounts** — Supabase auth (email + password). There's a Sign In button in the app header.
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

**Stripe (billing).** Needs a live key — the one in the repo expired and was test-mode anyway.
Create the two prices, then re-run provisioning with `STRIPE_SECRET_KEY`,
`STRIPE_MONTHLY_PRICE_ID`, `STRIPE_ANNUAL_PRICE_ID`, `STRIPE_WEBHOOK_SECRET`. Webhook:
`https://www.vomcalc.com/api/billing/webhook` with `checkout.session.completed`,
`customer.subscription.*`, `invoice.payment_failed`.

**A price.** Not chosen yet.

**Google SSO.** ~2 minutes in console.cloud.google.com → Credentials → OAuth client ID →
Web application → redirect URI `https://luaqzmyvgliljtiecojg.supabase.co/auth/v1/callback`.
Send me the ID + secret (or re-run provisioning with `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET`).

**Landing copy.** The page currently promises "free, full access". True today, misleading the
moment the gate goes on. It needs to move to the code/trial story at the same time — worth
writing together.

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
bash supabase/tests/run.sh        # 26 assertions against a throwaway Postgres
bash scripts/e2e-live-test.sh     # real users + real codes against production, then cleans up
```

Covers every tier, expiry, code stacking, single-use caps, EV permanence, Stripe signature
rejection, an 8-way concurrency race on a 1-use code, the deal-store round-trip, the users
trigger and delete-cascade. **All passing.** The live suite creates and then removes its own
users, so the list stays clean.
