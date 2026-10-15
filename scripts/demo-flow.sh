#!/usr/bin/env bash
# Walks one transfer through the API with curl: create -> fund -> advance until done.
# Needs a running server (pnpm dev) and the exports printed by scripts/demo-seed.mjs.
# Usage: eval "$(node scripts/demo-seed.mjs)"; SCENARIO=HAPPY_PATH bash scripts/demo-flow.sh
set -euo pipefail
BASE_URL="${BASE_URL:-http://localhost:3000}"
SCENARIO="${SCENARIO:-HAPPY_PATH}"   # HAPPY_PATH | FUNDING_DECLINED | PAYOUT_FAILED
: "${DEMO_COOKIE:?run: eval \"\$(node scripts/demo-seed.mjs)\"}"
: "${DEMO_QUOTE_ID:?run: eval \"\$(node scripts/demo-seed.mjs)\"}"

api() { # method path [idempotency-key]
  local args=(-sS -X "$1" "$BASE_URL$2" -H "Origin: $BASE_URL" -H "Cookie: $DEMO_COOKIE" -H "Content-Type: application/json")
  [[ -n "${3:-}" ]] && args+=(-H "Idempotency-Key: $3")
  if [[ "$1" == POST ]]; then args+=(--data "${BODY:-{\}}"); fi
  curl "${args[@]}"
}
show() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);if(j.error){console.log("ERROR",JSON.stringify(j.error));process.exit(1)}const d=j.data;console.log(`${d.status.padEnd(20)} v${d.version}  next=${d.nextAction}  settlement=${d.settlement.status}${d.settlement.txHash?" "+d.settlement.txHash.slice(0,12)+"…":""}  payout=${d.payout.status}  notify=${d.notification.status}`);process.stdout.write(d.id+"\t"+d.nextAction+"\n",()=>{})})'; }

echo "== create transfer ($SCENARIO)"
OUT=$(BODY="{\"quoteId\":\"$DEMO_QUOTE_ID\",\"purpose\":\"PERSONAL_REMITTANCE\",\"demoScenario\":\"$SCENARIO\"}" api POST /api/transfers "$(node -e 'console.log(crypto.randomUUID())')" | show)
echo "$OUT" | head -1; read -r ID NEXT < <(echo "$OUT" | tail -1)

echo "== simulate funding"
OUT=$(api POST "/api/demo/transfers/$ID/funding" "$(node -e 'console.log(crypto.randomUUID())')" | show)
echo "$OUT" | head -1; read -r ID NEXT < <(echo "$OUT" | tail -1)

for _ in $(seq 1 20); do
  case "$NEXT" in
    ADVANCE) echo "== advance"; OUT=$(api POST "/api/demo/transfers/$ID/advance" | show) ;;
    RETRY_PAYOUT) echo "== payout retry"; OUT=$(api POST "/api/demo/transfers/$ID/payout-retry" "$(node -e 'console.log(crypto.randomUUID())')" | show) ;;
    *) break ;;
  esac
  echo "$OUT" | head -1; read -r ID NEXT < <(echo "$OUT" | tail -1)
  sleep 1
done

echo "== final snapshot (GET /api/transfers/$ID)"
api GET "/api/transfers/$ID" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.stringify(JSON.parse(s).data,null,2)))'
