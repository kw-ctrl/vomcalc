#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# One-shot provisioning for VomCalc accounts.
#
#   SUPABASE_ACCESS_TOKEN=sbp_xxx bash scripts/provision.sh
#
# Optional extras:
#   PLAN=pro                     # "free" (default) or "pro" — free projects pause
#                                # after ~7 days idle and are deleted if left paused
#   STRIPE_SECRET_KEY=sk_live_…  # wires billing at the same time
#   STRIPE_MONTHLY_PRICE_ID=price_… STRIPE_ANNUAL_PRICE_ID=price_…
#   STRIPE_WEBHOOK_SECRET=whsec_…
#   GOOGLE_CLIENT_ID=… GOOGLE_CLIENT_SECRET=…   # enables Google SSO
#
# What it does: create the Supabase project → apply supabase/migrations/*.sql →
# push every env var to Vercel (production) → configure Supabase auth for the app
# domain → deploy → verify /api/health. Idempotent enough to re-run.
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$(pwd)"
API="https://api.supabase.com/v1"
PROJECT_NAME="${PROJECT_NAME:-vomcalc}"
REGION="${REGION:-us-west-1}"
PLAN="${PLAN:-free}"
APP_URL="https://www.vomcalc.com"
VERCEL_PROJECT="${VERCEL_PROJECT:-kassidy-underwriter-2}"

die() { echo "✗ $*" >&2; exit 1; }
say() { echo "· $*"; }

TOKEN="${SUPABASE_ACCESS_TOKEN:-}"
[ -n "$TOKEN" ] || die "SUPABASE_ACCESS_TOKEN is required (supabase.com/dashboard/account/tokens)"
command -v jq >/dev/null || die "jq is required (brew install jq)"
command -v vercel >/dev/null || die "vercel CLI is required"

api() { # api <method> <path> [body]
  local method="$1" path="$2" body="${3:-}"
  if [ -n "$body" ]; then
    curl -sS -X "$method" "$API$path" -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d "$body"
  else
    curl -sS -X "$method" "$API$path" -H "Authorization: Bearer $TOKEN"
  fi
}

# ── 1. Project ───────────────────────────────────────────────────────────────
say "looking for an existing '$PROJECT_NAME' project"
EXISTING="$(api GET /projects | jq -r --arg n "$PROJECT_NAME" '.[] | select(.name==$n) | .id' | head -1)"

if [ -n "${EXISTING:-}" ] && [ "$EXISTING" != "null" ]; then
  REF="$EXISTING"
  say "reusing existing project ref $REF"
  # If it is paused, bring it back rather than creating a duplicate.
  STATUS="$(api GET "/projects/$REF" | jq -r '.status // "UNKNOWN"')"
  if [ "$STATUS" = "INACTIVE" ]; then
    say "project is paused — restoring"
    api POST "/projects/$REF/restore" '{}' >/dev/null || true
  fi
else
  say "creating project (plan=$PLAN region=$REGION)"
  ORG="$(api GET /organizations | jq -r '.[0].id')"
  [ -n "$ORG" ] && [ "$ORG" != "null" ] || die "no Supabase organization available for this token"

  DBPASS="$(openssl rand -base64 24 | tr -d '/+=' | cut -c1-24)"
  CREATED="$(api POST /projects "$(jq -nc --arg n "$PROJECT_NAME" --arg o "$ORG" --arg r "$REGION" --arg p "$DBPASS" --arg plan "$PLAN" \
      '{name:$n, organization_id:$o, region:$r, db_pass:$p, plan:$plan}')")"
  REF="$(echo "$CREATED" | jq -r '.id // empty')"
  [ -n "$REF" ] || die "project creation failed: $CREATED"
  echo "$DBPASS" > "$HOME/.hermes/vomcalc_dbpass_$REF.txt"
  say "created ref $REF (db password saved to ~/.hermes/vomcalc_dbpass_$REF.txt)"
fi

say "waiting for the project to become healthy"
for i in $(seq 1 60); do
  STATUS="$(api GET "/projects/$REF" | jq -r '.status // "UNKNOWN"')"
  [ "$STATUS" = "ACTIVE_HEALTHY" ] && break
  sleep 5
  [ "$i" = "60" ] && die "project did not become healthy (last status: $STATUS)"
done
say "project is healthy"

# ── 2. Keys ──────────────────────────────────────────────────────────────────
say "reading API keys"
KEYS="$(api GET "/projects/$REF/api-keys?reveal=true")"
ANON="$(echo "$KEYS" | jq -r '.[] | select(.name=="anon") | .api_key' | head -1)"
SERVICE="$(echo "$KEYS" | jq -r '.[] | select(.name=="service_role") | .api_key' | head -1)"
[ -n "$ANON" ] && [ -n "$SERVICE" ] || die "could not read anon/service keys"
SB_URL="https://$REF.supabase.co"

# ── 3. Schema ────────────────────────────────────────────────────────────────
say "applying migrations"
for f in supabase/migrations/*.sql; do
  SQL="$(cat "$f")"
  RES="$(api POST "/projects/$REF/database/query" "$(jq -nc --arg q "$SQL" '{query:$q}')")"
  if echo "$RES" | jq -e '(.error // .message) and (.error // .message) != ""' >/dev/null 2>&1 && ! echo "$RES" | jq -e 'type=="array"' >/dev/null 2>&1; then
    echo "  ! $f reported: $RES"
    say "  falling back to psql"
    DBPASS="$(cat "$HOME/.hermes/vomcalc_dbpass_$REF.txt" 2>/dev/null || true)"
    [ -n "$DBPASS" ] || die "psql fallback needs the db password (not found for $REF)"
    PGBIN="${PGBIN:-/opt/homebrew/opt/postgresql@16/bin}"
    LC_ALL="${LC_ALL:-en_US.UTF-8}" "$PGBIN/psql" \
      "postgresql://postgres.$REF:$DBPASS@aws-0-$REGION.pooler.supabase.com:5432/postgres" \
      -v ON_ERROR_STOP=1 -q -f "$f" || die "migration failed: $f"
  else
    echo "  ✓ $f"
  fi
done

# ── 4. Supabase auth config ──────────────────────────────────────────────────
say "configuring auth (site URL + redirect allow-list)"
AUTH_CFG="$(jq -nc --arg s "$APP_URL" --arg a "$APP_URL/app,$APP_URL" \
  '{site_url:$s, uri_allow_list:$a}')"
if [ -n "${GOOGLE_CLIENT_ID:-}" ] && [ -n "${GOOGLE_CLIENT_SECRET:-}" ]; then
  say "enabling Google SSO"
  AUTH_CFG="$(echo "$AUTH_CFG" | jq --arg id "$GOOGLE_CLIENT_ID" --arg sec "$GOOGLE_CLIENT_SECRET" \
    '. + {external_google_enabled:true, external_google_client_id:$id, external_google_secret:$sec}')"
fi
api PATCH "/projects/$REF/config/auth" "$AUTH_CFG" >/dev/null && echo "  ✓ auth configured"

# ── 5. Vercel env ────────────────────────────────────────────────────────────
say "pushing env vars to Vercel ($VERCEL_PROJECT, production)"
ADMIN_TOKEN_VALUE="${ADMIN_TOKEN:-$(openssl rand -hex 24)}"

set_env() {
  local key="$1" value="$2"
  [ -n "$value" ] || return 0
  # Remove then add, so re-runs don't stack duplicate values.
  vercel env rm "$key" production --yes >/dev/null 2>&1 || true
  printf '%s' "$value" | vercel env add "$key" production >/dev/null
  echo "  ✓ $key"
}

set_env SUPABASE_URL "$SB_URL"
set_env SUPABASE_ANON_KEY "$ANON"
set_env SUPABASE_SERVICE_ROLE_KEY "$SERVICE"
set_env ADMIN_TOKEN "$ADMIN_TOKEN_VALUE"
[ -n "${STRIPE_SECRET_KEY:-}" ]         && set_env STRIPE_SECRET_KEY "$STRIPE_SECRET_KEY"
[ -n "${STRIPE_MONTHLY_PRICE_ID:-}" ]   && set_env STRIPE_MONTHLY_PRICE_ID "$STRIPE_MONTHLY_PRICE_ID"
[ -n "${STRIPE_ANNUAL_PRICE_ID:-}" ]    && set_env STRIPE_ANNUAL_PRICE_ID "$STRIPE_ANNUAL_PRICE_ID"
[ -n "${STRIPE_WEBHOOK_SECRET:-}" ]     && set_env STRIPE_WEBHOOK_SECRET "$STRIPE_WEBHOOK_SECRET"
# Deliberately NOT enabling the paid gate here — flip it when you're ready to charge:
#   vercel env rm VOM_GATE_ENABLED production --yes; printf 'true' | vercel env add VOM_GATE_ENABLED production

# ── 6. Local env for the keep-alive cron + scripts ───────────────────────────
say "saving local credentials"
cat > "$HOME/.hermes/vomcalc_env" <<EOF
SUPABASE_URL=$SB_URL
SUPABASE_ANON_KEY=$ANON
SUPABASE_SERVICE_ROLE_KEY=$SERVICE
ADMIN_TOKEN=$ADMIN_TOKEN_VALUE
EOF
chmod 600 "$HOME/.hermes/vomcalc_env"
echo "  ✓ ~/.hermes/vomcalc_env"

# ── 7. Deploy + verify ───────────────────────────────────────────────────────
say "deploying"
vercel --prod --yes >/dev/null 2>&1 || die "vercel deploy failed"
sleep 5
say "health check"
curl -sS -m 30 "$APP_URL/api/health" | jq .

cat <<EOF

────────────────────────────────────────────────────────────────────────────
DONE. Remaining manual steps (printed so nothing is forgotten):

  1. ADMIN_TOKEN (governs /api/admin/codes): $ADMIN_TOKEN_VALUE
  2. Mint codes, e.g.
       curl -X POST $APP_URL/api/admin/codes \\
         -H "x-admin-token: $ADMIN_TOKEN_VALUE" -H 'Content-Type: application/json' \\
         -d '{"code":"YOUTUBE14","grantsDays":14,"source":"youtube","maxRedemptions":null}'
       (use {"batch":25,"prefix":"YT","grantsDays":14,"source":"instagram"} for 25 single-use codes)
  3. EV members: either the permanent code   {"code":"ESCAPE-EV","grantsLevel":"ev_member"}
     or just add their emails to the ev_member_emails table.
  4. Stripe: create the two prices, then re-run this script with
     STRIPE_SECRET_KEY / STRIPE_*_PRICE_ID / STRIPE_WEBHOOK_SECRET set.
     Webhook endpoint: $APP_URL/api/billing/webhook
     Events: checkout.session.completed, customer.subscription.*, invoice.payment_failed
  5. When you're ready to charge: enable VOM_GATE_ENABLED=true (free tier keeps the
     Velocity Score; the full report locks behind trial/paid/EV).
  6. Google SSO: create an OAuth client (Web application) with redirect URI
     $SB_URL/auth/v1/callback, then re-run with GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET.
────────────────────────────────────────────────────────────────────────────
EOF
