# VomCalc — Accounts, Email List & Access Codes

Status: **built and deployed, dormant.** The tool is still free for everyone. Everything below
switches on with one command once a Supabase project exists.

Last updated: 16 Sep 2026

---

## 1. The model

| Who | What they get | How |
|---|---|---|
| Anyone (anonymous) | Calculator + Velocity Score | No account needed |
| Free account | Same, plus their email is on the list | Email sign-in |
| **Code from YouTube / IG** | **Everything free for 14 days** | One code, handed out in the video/DM |
| **EV community member** | **Everything free, forever** | Private code, or their email on the allowlist |
| Paid (after the free period) | Everything, ongoing | Stripe subscription |

The paid gate is **off** until you flip it. Accounts, emails and codes already work while it's off,
so the list builds from day one without changing what visitors get.

---

## 2. What was built

**Database** (`supabase/migrations/0001_init.sql`)
- `subscribers` — the marketing list. One row per email, with source and UTM. Exportable any time.
- `accounts` — access record per user (trial end, Stripe ids, plan).
- `access_codes` — codes with a grant (14-day trial, or permanent EV), a redemption cap, and an expiry date.
- `code_redemptions` — who used what. One use per account is enforced in the DB.
- `ev_member_emails` — the allowlist route for EV members (works alongside the private code).
- `events` — signup / code redeemed / checkout started / subscribed, for funnel reporting.
- `effective_access(user_id)` — **the** access decision, server-side. Precedence: EV → paid → trial → free.
- `redeem_code(code, user, email)` — row-locked, so a code capped at 1 use can never be redeemed twice
  even if two people submit at the same instant.

**API**
- `GET /api/auth/state` — what this visitor may see. Also the one place a new account and marketing-list
  row are created, so every signup is captured exactly once (and mirrored to your vault CRM).
- `POST /api/codes/redeem` — applies a code.
- `POST /api/billing/checkout` · `/portal` · `/webhook` — Stripe subscription, portal, and webhook
  (signature-verified; unverified calls rejected).
- `POST /api/admin/codes` — mint codes. Single shared code, or a batch of 25 single-use ones.
- `GET /api/health` — ops view (DB, Stripe mode, gate state). Also what the daily keep-alive hits.

**Front end**
- Level badge in the header (Free / trial with days left / Subscribed / EV Member).
- "Redeem a Code" in the account menu, plus a code box on the gate itself.
- Deep links for hand-outs: `vomcalc.com/app?code=YOUTUBE14` opens with the field pre-filled.
- All of it is server-driven: the browser can't grant itself anything.

---

## 3. Switching it on (one command)

1. Get an access token: **supabase.com/dashboard/account/tokens**
2. Run:

```bash
cd ~/projects/vomcalc
SUPABASE_ACCESS_TOKEN=sbp_your_token bash scripts/provision.sh
```

That creates the project, applies the schema, pushes all env vars to Vercel, configures auth for the
domain, deploys, and verifies `/api/health`. It prints your admin token and the exact curl commands for
minting codes.

**Note on the tier:** the last project was deleted because free projects pause after ~7 days of
inactivity. The daily keep-alive cron (6am, `c6c4925e88d9`) prevents that, so free is workable — but
**Pro ($25/mo) also buys daily backups**, which matters once people are paying. Pass `PLAN=pro` if you
want that.

---

## 4. Codes

Mint from the admin endpoint (`ADMIN_TOKEN` is printed by the provision script):

```bash
# A shared code for a YouTube video — 14 days, unlimited uses
curl -X POST https://www.vomcalc.com/api/admin/codes \
  -H "x-admin-token: $ADMIN_TOKEN" -H 'Content-Type: application/json' \
  -d '{"code":"YOUTUBE14","grantsDays":14,"source":"youtube","maxRedemptions":null}'

# 25 single-use codes for DMs
curl -X POST https://www.vomcalc.com/api/admin/codes \
  -H "x-admin-token: $ADMIN_TOKEN" -H 'Content-Type: application/json' \
  -d '{"batch":25,"prefix":"IG","grantsDays":14,"source":"instagram"}'

# The EV community code — permanent free access
curl -X POST https://www.vomcalc.com/api/admin/codes \
  -H "x-admin-token: $ADMIN_TOKEN" -H 'Content-Type: application/json' \
  -d '{"code":"ESCAPE-EV","grantsLevel":"ev_member"}'
```

For YouTube, put the deep link in the description: `vomcalc.com/app?code=YOUTUBE14`.
For the community, the EV code is easier to keep secret as a *private* code rather than a public one.
Codes stack — a second code adds to the remaining time rather than replacing it.

---

## 5. Billing

Flipping billing on needs a live Stripe key (the one in the repo expired, and it was test-mode).

1. In Stripe, create the two prices (monthly + annual).
2. Re-run the provision script with `STRIPE_SECRET_KEY`, `STRIPE_MONTHLY_PRICE_ID`,
   `STRIPE_ANNUAL_PRICE_ID`, `STRIPE_WEBHOOK_SECRET`.
3. Add the webhook endpoint: `https://www.vomcalc.com/api/billing/webhook` with events
   `checkout.session.completed`, `customer.subscription.*`, `invoice.payment_failed`.
4. Test with a real card in test mode end to end before switching the gate on.
5. When ready to charge: set `VOM_GATE_ENABLED=true` on Vercel. Free tier keeps the Velocity Score;
   the full report locks behind trial / paid / EV.

**Launch copy depends on this.** The landing page currently promises "the tool is free, full access".
That copy is true today and becomes misleading the moment the gate goes on — the wording needs to move
to the code/trial story at the same time. Worth deciding together.

---

## 6. Google SSO

One manual step, because Google won't let a script create an OAuth client:

1. console.cloud.google.com → APIs & Services → Credentials → Create credentials → OAuth client ID
2. Type: **Web application**
3. Authorised redirect URI: `https://<your-project-ref>.supabase.co/auth/v1/callback`
4. Send me the client ID and secret, or re-run the provision script with
   `GOOGLE_CLIENT_ID=… GOOGLE_CLIENT_SECRET=…` and it wires Supabase for you.

Until then email sign-in (magic link / password) works on its own.

---

## 7. Verification

The access rules are tested against a real Postgres, not assumed:

```bash
cd ~/projects/vomcalc && bash supabase/tests/run.sh
```

23 assertions — every tier, expiry behaviour, code stacking, single-use caps, EV permanence, Stripe
webhook signature validation, and an 8-way concurrency race on a 1-use code. Currently **all passing**.
