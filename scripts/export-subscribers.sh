#!/usr/bin/env bash
# Export the VomCalc email list to Google Drive.
#
# Kassidy's standing rule: anything Seven builds has to be reachable in Drive, and the
# marketing list is the whole point of the accounts work — it must not live only inside
# Supabase. This writes a CSV (import-ready for any email tool) and keeps ONE file updated
# in place, so the link never changes.
#
# Run:  bash scripts/export-subscribers.sh [--quiet]
#       --quiet keeps routine runs silent and reports only a change in list size or a failure,
#       so a scheduled run never becomes noise.
set -euo pipefail

QUIET=0
[ "${1:-}" = "--quiet" ] && QUIET=1

ENV_FILE="$HOME/.hermes/vomcalc_env"
STATE_FILE="$HOME/.hermes/state/vomcalc_email_list.json"
FOLDER_ID="${VOM_DRIVE_FOLDER:-18vslJLqCWuNxDEmKx0HbO_BfJ54RyT_m}"   # Seven Outputs
NAME="VomCalc — Email List (latest).csv"
DRIVE="$HOME/.hermes/scripts/drive_rest.py"

[ -f "$ENV_FILE" ] || { echo "✗ $ENV_FILE missing" >&2; exit 1; }
set -a; . "$ENV_FILE"; set +a
[ -n "${SUPABASE_URL:-}" ] && [ -n "${SUPABASE_SERVICE_ROLE_KEY:-}" ] || { echo "✗ Supabase creds missing" >&2; exit 1; }

mkdir -p "$(dirname "$STATE_FILE")"
TMP="$(mktemp /tmp/vom_subscribers_XXXXXX.csv)"
trap 'rm -f "$TMP"' EXIT

# ── 1. pull the list ─────────────────────────────────────────────────────────
curl -sS -m 30 \
  "$SUPABASE_URL/rest/v1/subscribers?select=email,source,marketing_opt_in,first_seen_at,last_seen_at,unsubscribed_at&order=first_seen_at.asc" \
  -H "apikey: $SUPABASE_SERVICE_ROLE_KEY" -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY" \
  -o /tmp/vom_subs.json

python3 - "$TMP" <<'PY'
import csv, json, sys
rows = json.load(open("/tmp/vom_subs.json"))
if isinstance(rows, dict):          # an error payload, not a list
    print("✗ unexpected response:", str(rows)[:200]); sys.exit(1)
with open(sys.argv[1], "w", newline="") as fh:
    w = csv.writer(fh)
    w.writerow(["email", "source", "marketing_opt_in", "first_seen", "last_seen", "unsubscribed"])
    for r in rows:
        w.writerow([
            r.get("email", ""), r.get("source") or "", r.get("marketing_opt_in", True),
            (r.get("first_seen_at") or "")[:10], (r.get("last_seen_at") or "")[:10],
            (r.get("unsubscribed_at") or "")[:10],
        ])
PY
COUNT="$(python3 -c "
import csv,sys
print(max(0, sum(1 for _ in open('$TMP')) - 1))")"

# ── 2. create the file once, then keep it updated in place ───────────────────
FILE_ID=""
if [ -f "$STATE_FILE" ]; then
  FILE_ID="$(python3 -c "import json;print(json.load(open('$STATE_FILE')).get('file_id',''))" 2>/dev/null || true)"
fi

if [ -n "$FILE_ID" ] && python3 "$DRIVE" get "$FILE_ID" >/dev/null 2>&1; then
  python3 "$DRIVE" update "$FILE_ID" "$TMP" "text/csv" >/dev/null
  ACTION="updated"
else
  OUT="$(python3 "$HOME/.hermes/scripts/drive_upload_convert.py" "$TMP" "$FOLDER_ID" "$NAME" "text/csv" "text/csv" 2>&1)"
  FILE_ID="$(echo "$OUT" | grep -oE '[A-Za-z0-9_-]{28,}' | head -1)"
  ACTION="created"
  [ -n "$FILE_ID" ] || { echo "✗ upload failed: $OUT" >&2; exit 1; }
  printf '{"file_id": "%s", "name": "%s"}\n' "$FILE_ID" "$NAME" > "$STATE_FILE"
fi

PREV=0
if [ -f "$STATE_FILE" ]; then
  PREV="$(python3 -c "import json;print(json.load(open('$STATE_FILE')).get('count',0))" 2>/dev/null || echo 0)"
fi

# Remember id + count so the next run can tell whether anything actually changed.
python3 - "$STATE_FILE" "$FILE_ID" "$NAME" "$COUNT" <<'PY'
import json, sys
path, fid, name, count = sys.argv[1], sys.argv[2], sys.argv[3], int(sys.argv[4])
st = {}
try:
    st = json.load(open(path))
except Exception:
    pass
st.update({"file_id": fid, "name": name, "count": count})
json.dump(st, open(path, "w"), indent=2)
PY

if [ "$QUIET" = "0" ] || [ "$COUNT" != "$PREV" ]; then
  if [ "$COUNT" -gt "$PREV" ]; then
    echo "VomCalc: +$((COUNT - PREV)) new signup(s) — email list now $COUNT in Drive"
  else
    echo "VomCalc email list $ACTION in Drive — $COUNT subscriber(s)"
  fi
  echo "https://drive.google.com/file/d/$FILE_ID/view"
fi
