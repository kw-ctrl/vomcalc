#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Stripe setup for VomCalc — creates the product, the two prices, and the webhook
# endpoint, then pushes everything to Vercel. Idempotent: safe to re-run.
#
#   STRIPE_SECRET_KEY=sk_live_… bash scripts/stripe-setup.sh
#
#   MONTHLY_AMOUNT=2000   # cents — $20.00
#   ANNUAL_AMOUNT=15000   # cents — $150.00
#   ADD_TEST_COUPON=1     # also mint a 100%-off promo code for a no-charge end-to-end test
#
# A RESTRICTED live key works fine here (Stripe → Developers → API keys → Create restricted
# key). Minimum scopes: Products write, Prices write, Webhook Endpoints write. A restricted
# key limits the blast radius if it ever leaks, and the app itself needs no more than that.
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

cd "$(dirname "$0")/.."

KEY="${STRIPE_SECRET_KEY:-}"
[ -n "$KEY" ] || { echo "✗ STRIPE_SECRET_KEY is required" >&2; exit 1; }
case "$KEY" in
  sk_live_*|rk_live_*|sk_test_*|rk_test_*) ;;
  *) echo "✗ That looks like a publishable key (pk_…). Prices need a SECRET key (sk_… or a restricted rk_…)." >&2; exit 1 ;;
esac
command -v jq >/dev/null || { echo "✗ jq is required" >&2; exit 1; }

API="https://api.stripe.com/v1"
APP_URL="${APP_URL:-https://www.vomcalc.com}"
VERCEL_PROJECT="${VERCEL_PROJECT:-kassidy-underwriter-2}"
MONTHLY_AMOUNT="${MONTHLY_AMOUNT:-2000}"
ANNUAL_AMOUNT="${ANNUAL_AMOUNT:-15000}"
PRODUCT_NAME="${PRODUCT_NAME:-VomCalc — Velocity of Money Underwriter}"

say() { echo "· $*"; }
sget() { curl -sS -m 30 "$API$1" -u "$KEY:"; }
spost() { curl -sS -m 30 -X POST "$API$1" -u "$KEY:" -H 'Content-Type: application/x-www-form-urlencoded' "${@:2}"; }

MODE="test"; case "$KEY" in *live*) MODE="live" ;; esac
say "using a $MODE key"

# ── 0. account sanity ────────────────────────────────────────────────────────
ACC="$(sget /account)"
if [ "$(echo "$ACC" | jq -r '.error.message // empty')" != "" ]; then
  echo "✗ Stripe rejected the key: $(echo "$ACC" | jq -r '.error.message')" >&2; exit 1
fi
CHARGES="$(echo "$ACC" | jq -r '.charges_enabled')"
PAYOUTS="$(echo "$ACC" | jq -r '.payouts_enabled')"
say "account: $(echo "$ACC" | jq -r '.settings.dashboard.display_name // .id')  charges_enabled=$CHARGES payouts_enabled=$PAYOUTS"
if [ "$MODE" = "live" ] && { [ "$CHARGES" != "true" ] || [ "$PAYOUTS" != "true" ]; }; then
  say "⚠ the account cannot take live payments yet (charges=$CHARGES payouts=$PAYOUTS) — finish activation in Stripe"
fi

# ── 1. product ───────────────────────────────────────────────────────────────
PRODUCT_ID="$(sget "/products?limit=100" | jq -r --arg n "$PRODUCT_NAME" '.data[] | select(.name==$n) | .id' | head -1)"
if [ -z "$PRODUCT_ID" ]; then
  say "creating product"
  PRODUCT_ID="$(spost /products -d "name=$PRODUCT_NAME" -d 'description=Velocity of Money underwriting tool')"
  PRODUCT_ID="$(echo "$PRODUCT_ID" | jq -r '.id // empty')"
  [ -n "$PRODUCT_ID" ] || { echo "✗ product creation failed" >&2; exit 1; }
fi
say "product: $PRODUCT_ID"

# ── 2. prices (reuse an active one with the same amount + interval) ──────────
price_for() { # price_for <amount> <interval>
  local amount="$1" interval="$2" existing
  existing="$(sget "/prices?limit=100&product=$PRODUCT_ID&active=true" | jq -r --arg a "$amount" --arg i "$interval" \
    '.data[] | select(.unit_amount == ($a|tonumber) and .recurring.interval == $i) | .id' | head -1)"
  if [ -n "$existing" ]; then echo "$existing"; return; fi
  spost /prices -d "product=$PRODUCT_ID" -d "unit_amount=$amount" -d 'currency=usd' \
    -d "recurring[interval]=$interval" | jq -r '.id // empty'
}

MONTHLY_ID="$(price_for "$MONTHLY_AMOUNT" month)"
ANNUAL_ID="$(price_for "$ANNUAL_AMOUNT" year)"
[ -n "$MONTHLY_ID" ] || { echo "✗ monthly price failed" >&2; exit 1; }
[ -n "$ANNUAL_ID" ] || { echo "✗ annual price failed" >&2; exit 1; }
say "monthly: $MONTHLY_ID  (\$$(echo "scale=2; $MONTHLY_AMOUNT/100" | bc)/mo)"
say "annual:  $ANNUAL_ID  (\$$(echo "scale=2; $ANNUAL_AMOUNT/100" | bc)/yr)"

# ── 2b. Escape Velocity membership — a DELIBERATELY separate product ─────────
# EV is a community membership (permanent `ev_member` access), not a tool subscription.
# Separate products keep "cancel" unambiguous: cancelling a $20 tool subscription must never
# revoke a lifetime community membership, and they land in different code paths in the
# webhook. The webhook also accepts metadata.tier=ev, so the payment link works even if this
# price id is never stored.
EV_PRODUCT_NAME="${EV_PRODUCT_NAME:-Escape Velocity — Membership}"
EV_AMOUNT="${EV_AMOUNT:-800000}"        # cents — $8,000.00
EV_INTERVAL="${EV_INTERVAL:-one_time}"  # one_time | month | year

EV_PRODUCT_ID="$(sget "/products?limit=100" | jq -r --arg n "$EV_PRODUCT_NAME" '.data[] | select(.name==$n) | .id' | head -1)"
if [ -z "$EV_PRODUCT_ID" ]; then
  say "creating product"
  EV_PRODUCT_ID="$(spost /products -d "name=$EV_PRODUCT_NAME" -d 'description=Escape Velocity community membership' | jq -r '.id // empty')"
  [ -n "$EV_PRODUCT_ID" ] || { echo "✗ EV product creation failed" >&2; exit 1; }
fi
say "EV product: $EV_PRODUCT_ID"

EV_PRICE_ID="$(sget "/prices?limit=100&product=$EV_PRODUCT_ID&active=true" | jq -r --arg a "$EV_AMOUNT" --arg i "$EV_INTERVAL" '
  .data[] | select(.unit_amount == ($a|tonumber))
  | if $i == "one_time" then (select(.recurring == null) | .id) else (select(.recurring.interval == $i) | .id) end' | head -1)"
if [ -z "$EV_PRICE_ID" ]; then
  if [ "$EV_INTERVAL" = "one_time" ]; then
    EV_PRICE_ID="$(spost /prices -d "product=$EV_PRODUCT_ID" -d "unit_amount=$EV_AMOUNT" -d 'currency=usd' | jq -r '.id // empty')"
  else
    EV_PRICE_ID="$(spost /prices -d "product=$EV_PRODUCT_ID" -d "unit_amount=$EV_AMOUNT" -d 'currency=usd' -d "recurring[interval]=$EV_INTERVAL" | jq -r '.id // empty')"
  fi
fi
[ -n "$EV_PRICE_ID" ] || { echo "✗ EV price creation failed" >&2; exit 1; }
say "EV:       $EV_PRICE_ID  (\$$(echo "scale=2; $EV_AMOUNT/100" | bc), $EV_INTERVAL)"

# ── 3. webhook endpoint ──────────────────────────────────────────────────────
WEBHOOK_URL="$APP_URL/api/billing/webhook"
EVENTS=(checkout.session.completed customer.subscription.created customer.subscription.updated customer.subscription.deleted invoice.payment_failed)

EXISTING_ID="$(sget "/webhook_endpoints?limit=100" | jq -r --arg u "$WEBHOOK_URL" '.data[] | select(.url==$u) | .id' | head -1)"
WH_SECRET=""
if [ -n "$EXISTING_ID" ]; then
  say "webhook endpoint already exists ($EXISTING_ID)"
  # The signing secret is only returned at creation, so if we don't hold one we recreate it.
  if [ -f "$HOME/.hermes/vomcalc_env" ] && grep -q '^STRIPE_WEBHOOK_SECRET=whsec_' "$HOME/.hermes/vomcalc_env" 2>/dev/null; then
    WH_SECRET="$(grep '^STRIPE_WEBHOOK_SECRET=' "$HOME/.hermes/vomcalc_env" | cut -d= -f2-)"
    say "reusing the stored signing secret"
  else
    say "no stored signing secret — recreating the endpoint to capture one"
    curl -sS -m 30 -X DELETE "$API/webhook_endpoints/$EXISTING_ID" -u "$KEY:" >/dev/null
    EXISTING_ID=""
  fi
fi
if [ -z "$WH_SECRET" ]; then
  ARGS=(-d "url=$WEBHOOK_URL")
  for e in "${EVENTS[@]}"; do ARGS+=(-d "enabled_events[]=$e"); done
  CREATED="$(spost /webhook_endpoints "${ARGS[@]}")"
  WH_SECRET="$(echo "$CREATED" | jq -r '.secret // empty' | tr -d '[:space:]')"
  WH_ID="$(echo "$CREATED" | jq -r '.id // empty')"
  [ -n "$WH_SECRET" ] || { echo "✗ webhook creation failed: $CREATED" >&2; exit 1; }
  say "webhook: $WH_ID -> $WEBHOOK_URL"
fi

# ── 4. Vercel env ────────────────────────────────────────────────────────────
say "pushing Stripe env to Vercel"
set_env() {
  # Trim: a stray trailing newline on a webhook signing secret makes every signature
  # check fail silently, so the endpoint looks configured but rejects real events.
  local key="$1" val
  val="$(printf '%s' "$2" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"
  [ -n "$val" ] || return 0
  vercel env rm "$key" production --yes >/dev/null 2>&1 || true
  printf '%s' "$val" | vercel env add "$key" production >/dev/null
  echo "  ✓ $key"
}
set_env STRIPE_SECRET_KEY "$KEY"
set_env STRIPE_MONTHLY_PRICE_ID "$MONTHLY_ID"
set_env STRIPE_ANNUAL_PRICE_ID "$ANNUAL_ID"
set_env STRIPE_EV_PRICE_ID "$EV_PRICE_ID"
set_env STRIPE_WEBHOOK_SECRET "$WH_SECRET"

# ── 5. local env (so re-runs reuse the same ids/secret) ──────────────────────
ENV_FILE="$HOME/.hermes/vomcalc_env"
touch "$ENV_FILE"; chmod 600 "$ENV_FILE"
for kv in "STRIPE_SECRET_KEY=$KEY" "STRIPE_MONTHLY_PRICE_ID=$MONTHLY_ID" "STRIPE_ANNUAL_PRICE_ID=$ANNUAL_ID" "STRIPE_EV_PRICE_ID=$EV_PRICE_ID" "STRIPE_WEBHOOK_SECRET=$WH_SECRET"; do
  k="${kv%%=*}"
  grep -v "^$k=" "$ENV_FILE" > "$ENV_FILE.tmp" 2>/dev/null || true
  mv "$ENV_FILE.tmp" "$ENV_FILE"
  echo "$kv" >> "$ENV_FILE"
done
say "saved to $ENV_FILE"

# ── 6. optional: 100%-off promo for a no-charge end-to-end test ──────────────
if [ "${ADD_TEST_COUPON:-0}" = "1" ]; then
  say "creating a 100%-off test coupon + promo code"
  COUPON="$(spost /coupons -d 'percent_off=100' -d 'duration=forever' -d "name=VomCalc E2E test — DELETE ME")"
  COUPON_ID="$(echo "$COUPON" | jq -r '.id // empty')"
  if [ -n "$COUPON_ID" ]; then
    PROMO="$(spost /promotion_codes -d "coupon=$COUPON_ID" -d 'code=SEVEN-E2E-TEST')"
    say "promo code: SEVEN-E2E-TEST  (coupon $COUPON_ID)"
    echo "SEVEN-E2E-TEST  coupon=$COUPON_ID" >> "$ENV_FILE"
  else
    say "⚠ coupon creation failed: $COUPON"
  fi
fi

# ── 7. deploy + verify ───────────────────────────────────────────────────────
say "deploying"
vercel --prod --yes >/dev/null 2>&1 || { echo "✗ deploy failed" >&2; exit 1; }
sleep 5
say "health"
curl -sS -m 30 "$APP_URL/api/health" | jq '{stripe, prices, webhookSecret, gateEnabled, db}'

cat <<EOF

────────────────────────────────────────────────────────────────────────────
Stripe is wired. Monthly \$$(echo "scale=2; $MONTHLY_AMOUNT/100" | bc) / Annual \$$(echo "scale=2; $ANNUAL_AMOUNT/100" | bc) (mode: $MODE).

Still to do:
  1. Verify no-charge end to end:
       open $APP_URL/app, sign in, "See Plans", then at Stripe checkout enter promo
       code SEVEN-E2E-TEST — completes for \$0 and should flip the account to paid.
       (Re-run with ADD_TEST_COUPON=1 first if you skipped it; delete the coupon after.)
  2. Escape Velocity: create the payment link and TAG IT.
       Stripe → Payment links → New → product "$EV_PRODUCT_NAME" → after saving, set
       Metadata  tier = ev
       That metadata is what tells the webhook this is a membership, not a tool
       subscription. Without it the buyer pays and gets nothing.
       Verify any time with:  node scripts/ev-onboarding-test.mjs
  3. Flip the paid gate when the landing copy is updated:
       vercel env rm VOM_GATE_ENABLED production --yes
       printf 'true' | vercel env add VOM_GATE_ENABLED production
       vercel --prod --yes
  4. Google SSO: OAuth client (Web application) with redirect URI
       ${SUPABASE_URL:-https://luaqzmyvgliljtiecojg.supabase.co}/auth/v1/callback
────────────────────────────────────────────────────────────────────────────
EOF
