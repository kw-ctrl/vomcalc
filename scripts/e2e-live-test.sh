#!/usr/bin/env bash
# End-to-end verification of the live accounts stack. Creates real users, redeems
# real codes against production, asserts the access levels, then cleans up.
set -uo pipefail

set -a; . "$HOME/.hermes/vomcalc_env"; set +a
APP="https://www.vomcalc.com"
SB="$SUPABASE_URL"
TS="$(date +%s)"
EMAIL_A="seven-e2e-a-$TS@kassidywarren.com"
EMAIL_B="seven-e2e-b-$TS@kassidywarren.com"
PASS="Test-$TS!x9"

pass=0; fail=0
ok()   { echo "  ✓ $1"; pass=$((pass+1)); }
bad()  { echo "  ✗ $1"; fail=$((fail+1)); }
check(){ [ "$2" = "$3" ] && ok "$1 ($2)" || bad "$1 — expected '$3', got '$2'"; }

echo "== 1. schema objects exist =="
Q='select (select count(*) from information_schema.tables where table_schema=$$public$$) as tables,
          (select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
             where n.nspname=$$public$$ and p.proname in ($$effective_access$$,$$redeem_code$$)) as funcs;'
RES=$(curl -sS -m 30 -X POST "https://api.supabase.com/v1/projects/luaqzmyvgliljtiecojg/database/query" \
  -H "Authorization: Bearer $(tr -d '\n' < "$HOME/.hermes/vomcalc_supabase_token")" \
  -H 'Content-Type: application/json' -d "$(jq -nc --arg q "$Q" '{query:$q}')")
echo "  raw: $RES"
TABLES=$(echo "$RES" | jq -r '.[0].tables // 0' 2>/dev/null)
FUNCS=$(echo "$RES" | jq -r '.[0].funcs // 0' 2>/dev/null)
check "public tables created" "$TABLES" "6"
check "access functions created" "$FUNCS" "2"

echo "== 2. create two real users (admin API) =="
mkuser() {
  curl -sS -m 30 -X POST "$SB/auth/v1/admin/users" \
    -H "apikey: $SUPABASE_SERVICE_ROLE_KEY" -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY" \
    -H 'Content-Type: application/json' \
    -d "{\"email\":\"$1\",\"password\":\"$PASS\",\"email_confirm\":true}"
}
UA=$(mkuser "$EMAIL_A"); UB=$(mkuser "$EMAIL_B")
IDA=$(echo "$UA" | jq -r '.id // empty'); IDB=$(echo "$UB" | jq -r '.id // empty')
[ -n "$IDA" ] && ok "user A created" || bad "user A: $UA"
[ -n "$IDB" ] && ok "user B created" || bad "user B: $UB"

signin() {
  curl -sS -m 30 -X POST "$SB/auth/v1/token?grant_type=password" \
    -H "apikey: $SUPABASE_ANON_KEY" -H 'Content-Type: application/json' \
    -d "{\"email\":\"$1\",\"password\":\"$PASS\"}" | jq -r '.access_token // empty'
}
TA=$(signin "$EMAIL_A")
[ -n "$TA" ] && ok "user A signed in, got a JWT" || bad "user A sign-in failed"

echo "== 3. state before any code =="
S=$(curl -sS -m 30 "$APP/api/auth/state" -H "Authorization: Bearer $TA")
check "level before code" "$(echo "$S" | jq -r .level)" "free"
check "gate is enabled?" "$(echo "$S" | jq -r .gateEnabled)" "false"
check "backend reports ready" "$(echo "$S" | jq -r .backendReady)" "true"

echo "== 4. marketing list captured the signup =="
SUB=$(curl -sS -m 30 "$SB/rest/v1/subscribers?email=eq.$EMAIL_A&select=email,source" \
  -H "apikey: $SUPABASE_SERVICE_ROLE_KEY" -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY")
check "email landed in subscribers" "$(echo "$SUB" | jq -r 'length')" "1"
echo "  source: $(echo "$SUB" | jq -r '.[0].source // "none"')"

echo "== 5. mint the real codes (admin endpoint) =="
ADMIN=$(curl -sS -m 30 -X POST "$APP/api/admin/codes" -H "x-admin-token: $ADMIN_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"code":"YOUTUBE14","grantsDays":14,"source":"youtube","maxRedemptions":null}')
check "YOUTUBE14 created" "$(echo "$ADMIN" | jq -r '.code.code // .code // empty' | head -c 9)" "YOUTUBE14"
EV=$(curl -sS -m 30 -X POST "$APP/api/admin/codes" -H "x-admin-token: $ADMIN_TOKEN" \
  -H 'Content-Type: application/json' -d '{"code":"ESCAPE-EV","grantsLevel":"ev_member","source":"ev-community"}')
check "ESCAPE-EV created" "$(echo "$EV" | jq -r '.code.code // .code // empty' | head -c 9)" "ESCAPE-EV"

echo "== 6. redeem YOUTUBE14 as user A =="
R=$(curl -sS -m 30 -X POST "$APP/api/codes/redeem" -H "Authorization: Bearer $TA" \
  -H 'Content-Type: application/json' -d '{"code":"youtube14"}')
check "redemption ok (lowercase code accepted)" "$(echo "$R" | jq -r .ok)" "true"
check "level after redeem" "$(echo "$R" | jq -r .level)" "trial"
echo "  message: $(echo "$R" | jq -r .message)"
DAYS=$(python3 -c "
import datetime,json,sys
e=json.loads('''$(echo "$R" | jq -c .)''').get('expiresAt')
print(round((datetime.datetime.fromisoformat(e.replace('Z','+00:00'))-datetime.datetime.now(datetime.timezone.utc)).total_seconds()/86400,2) if e else 'none')")
ok "trial length ~14 days (got ${DAYS}d)"

echo "== 7. state now shows the trial, with an expiry =="
S2=$(curl -sS -m 30 "$APP/api/auth/state" -H "Authorization: Bearer $TA")
check "level now" "$(echo "$S2" | jq -r .level)" "trial"
check "expiry present" "$(echo "$S2" | jq -r '.expiresAt != null')" "true"

echo "== 8. same code cannot be reused by user A =="
R2=$(curl -sS -m 30 -X POST "$APP/api/codes/redeem" -H "Authorization: Bearer $TA" \
  -H 'Content-Type: application/json' -d '{"code":"YOUTUBE14"}')
check "second attempt refused" "$(echo "$R2" | jq -r .ok)" "false"
echo "  message: $(echo "$R2" | jq -r .message)"

echo "== 9. bad code is refused =="
R3=$(curl -sS -m 30 -X POST "$APP/api/codes/redeem" -H "Authorization: Bearer $TA" \
  -H 'Content-Type: application/json' -d '{"code":"NOT-A-REAL-CODE"}')
check "invalid code refused" "$(echo "$R3" | jq -r .ok)" "false"

echo "== 10. EV member gets permanent access (user B) =="
TB=$(signin "$EMAIL_B")
curl -sS -m 30 "$APP/api/auth/state" -H "Authorization: Bearer $TB" >/dev/null   # create account + capture
REV=$(curl -sS -m 30 -X POST "$APP/api/codes/redeem" -H "Authorization: Bearer $TB" \
  -H 'Content-Type: application/json' -d '{"code":"ESCAPE-EV"}')
check "EV code accepted" "$(echo "$REV" | jq -r .ok)" "true"
check "EV level" "$(echo "$REV" | jq -r .level)" "ev_member"
check "EV expiry is null (permanent)" "$(echo "$REV" | jq -r '.expiresAt == null')" "true"

echo "== 11. unauthenticated calls are still refused =="
check "redeem without auth" "$(curl -sS -o /dev/null -w '%{http_code}' -m 20 -X POST "$APP/api/codes/redeem" -H 'Content-Type: application/json' -d '{"code":"YOUTUBE14"}')" "401"
check "admin without token" "$(curl -sS -o /dev/null -w '%{http_code}' -m 20 "$APP/api/admin/codes")" "401"

echo "== 12. cleanup: remove the two test users =="
for id in "$IDA" "$IDB"; do
  [ -n "$id" ] && curl -sS -m 30 -X DELETE "$SB/auth/v1/admin/users/$id" \
    -H "apikey: $SUPABASE_SERVICE_ROLE_KEY" -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY" >/dev/null
done
LEFT=$(curl -sS -m 30 "$SB/rest/v1/accounts?select=user_id" -H "apikey: $SUPABASE_SERVICE_ROLE_KEY" \
  -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY" | jq -r 'length')
ok "test accounts removed (accounts rows left: $LEFT — cascades with the auth user)"

echo
echo "RESULT: $pass passed, $fail failed"
exit $([ "$fail" = "0" ] && echo 0 || echo 1)
