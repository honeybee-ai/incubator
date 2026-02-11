#!/bin/bash
#
# claude-acp Stop hook
# Publishes completion event and optionally continues if events are pending.
#

set -euo pipefail

# Check if ACP is configured
if [[ -z "${INCUBATOR_URL:-}" ]] || [[ -z "${ACP_NAMESPACE:-}" ]] || [[ -z "${ACP_AGENT_ID:-}" ]]; then
  exit 0
fi

BASE="${INCUBATOR_URL}/api"
NS=""
if [[ "${ACP_NAMESPACE}" != "default" ]]; then
  NS="/${ACP_NAMESPACE}"
fi

# Publish agent completion event
curl -sf -X POST "${BASE}${NS}/events" \
  -H "Content-Type: application/json" \
  -H "X-Agent-Id: ${ACP_AGENT_ID}" \
  -d "{\"type\": \"agent.stopped\", \"data\": {\"agent\": \"${ACP_AGENT_ID}\", \"role\": \"${ACP_ROLE:-unknown}\"}}" \
  2>/dev/null || true

# Check for pending events if wake_on is configured
if [[ -n "${ACP_WAKE_ON:-}" ]]; then
  # Poll for recent events
  EVENTS=$(curl -sf "${BASE}${NS}/events?since=0&type=${ACP_WAKE_ON%%,*}" \
    -H "X-Agent-Id: ${ACP_AGENT_ID}" 2>/dev/null || echo '{"events":[]}')

  EVENT_COUNT=$(echo "$EVENTS" | jq '.events | length' 2>/dev/null || echo "0")

  if [[ "$EVENT_COUNT" -gt 0 ]]; then
    # Events pending — block exit and tell Claude to handle them
    jq -n '{
      "decision": "block",
      "reason": "ACP events pending. Check for new coordination events and handle them before stopping.",
      "systemMessage": "claude-acp: Pending events detected. Use the acp tool to check events before stopping."
    }'
    exit 0
  fi
fi

# No pending events — allow clean exit
exit 0
