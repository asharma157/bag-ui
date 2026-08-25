#!/usr/bin/env bash
# Verifies that the routing context survives every hop, and reports which version served each layer.
#
#   ./verify-propagation.sh                       # against local docker compose
#   ./verify-propagation.sh http://34.12.34.56    # against the Istio ingress gateway on GKE
#
# Locally the "serving version" column will always show the defaults: propagation is what compose
# can prove, routing needs the mesh. On GKE the versions should follow the cookies.
set -euo pipefail

BASE_URL="${1:-http://localhost:8080}"

probe() {
  local label="$1" cookie="$2"
  echo
  echo "── ${label}"
  echo "   Cookie: ${cookie:-<none>}"
  curl -sS --max-time 10 -H "Cookie: ${cookie}" "${BASE_URL}/api/bags" | python3 -c '
import json, sys
data = json.load(sys.stdin)
print("   %-14s %-12s %-12s %s" % ("layer", "requested", "serving", "received bag_fed/bag_orch/bag_service"))
received = {entry["layer"]: (entry.get("received") or {}) for entry in data.get("propagation", [])}
for hop in data.get("chain", []):
    got = received.get(hop["layer"], {})
    seen = "/".join(str(got.get(name) or "-") for name in ("bag_fed", "bag_orch", "bag_service"))
    print("   %-14s %-12s %-12s %s" % (
        hop["layer"], hop.get("requestedVersion") or "-", hop.get("servingVersion") or "UNREACHABLE", seen))
items = data.get("items", [])
print("   items: %d  subtotal: %s  total: %s  promotion: %s" % (
    len(items), data.get("subtotal"), data.get("total"),
    (data.get("promotion") or {}).get("code", "none")))
'
}

echo "Target: ${BASE_URL}"
probe "No cookies — every layer serves its default version" ""
probe "Dev A pins only the backend" "bag_service=1.10"
probe "Dev B pins only orchestration" "bag_orch=2.3"
probe "Dev C pins the whole chain" "bag_fed=feature1; bag_orch=2.3; bag_service=feature1"
echo
