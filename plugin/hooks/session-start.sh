#!/bin/bash
#
# claude-acp SessionStart hook
# Connects to incubator, registers role, injects ACP coordination context.
#
# Required env vars:
#   INCUBATOR_URL   - incubator server URL (e.g. http://localhost:4100)
#   ACP_NAMESPACE   - coordination namespace
#   ACP_AGENT_ID    - this agent's ID
#   ACP_ROLE        - role to request
#
# Optional:
#   ACP_WAKE_ON     - comma-separated event types to listen for
#

set -euo pipefail

# Check required env vars
if [[ -z "${INCUBATOR_URL:-}" ]] || [[ -z "${ACP_NAMESPACE:-}" ]] || [[ -z "${ACP_AGENT_ID:-}" ]] || [[ -z "${ACP_ROLE:-}" ]]; then
  # Not configured — skip silently (plugin installed but not in an ACP session)
  cat << 'EOF'
{
  "hookSpecificOutput": {
    "hookEventName": "SessionStart",
    "additionalContext": "claude-acp plugin installed but not configured. Set INCUBATOR_URL, ACP_NAMESPACE, ACP_AGENT_ID, ACP_ROLE to enable coordination."
  }
}
EOF
  exit 0
fi

BASE="${INCUBATOR_URL}/api"
NS=""
if [[ "${ACP_NAMESPACE}" != "default" ]]; then
  NS="/${ACP_NAMESPACE}"
fi

# Request role assignment
ROLE_RESP=$(curl -sf -X POST "${BASE}${NS}/roles/request" \
  -H "Content-Type: application/json" \
  -H "X-Agent-Id: ${ACP_AGENT_ID}" \
  -d "{\"role\": \"${ACP_ROLE}\"}" 2>/dev/null || echo '{"error": "Failed to connect to incubator"}')

# Fetch protocol context
PROTOCOL_RESP=$(curl -sf "${BASE}${NS}/protocol?role=${ACP_ROLE}" \
  -H "X-Agent-Id: ${ACP_AGENT_ID}" 2>/dev/null || echo '{}')

# Extract useful protocol context
PROTOCOL_NAME=$(echo "$PROTOCOL_RESP" | jq -r '.protocol.name // "unknown"' 2>/dev/null)
PROTOCOL_TITLE=$(echo "$PROTOCOL_RESP" | jq -r '.protocol.title // "Unknown Protocol"' 2>/dev/null)
ROLE_DESC=$(echo "$PROTOCOL_RESP" | jq -r '.role.description // "No description"' 2>/dev/null)
CURRENT_PHASE=$(echo "$PROTOCOL_RESP" | jq -r '.current_phase // "unknown"' 2>/dev/null)
INSTRUCTIONS=$(echo "$PROTOCOL_RESP" | jq -r '.instructions // ""' 2>/dev/null)

# Build wake types hint
WAKE_HINT=""
if [[ -n "${ACP_WAKE_ON:-}" ]]; then
  WAKE_HINT="Listen for events: ${ACP_WAKE_ON}. Use the acp tool with wait to sleep until they arrive."
fi

# Build context message
CONTEXT="ACP coordination active.
Protocol: ${PROTOCOL_NAME} (${PROTOCOL_TITLE})
Role: ${ACP_ROLE} — ${ROLE_DESC}
Phase: ${CURRENT_PHASE}
Server: ${INCUBATOR_URL} | Namespace: ${ACP_NAMESPACE} | Agent: ${ACP_AGENT_ID}

Use the 'acp' MCP tool to coordinate with other agents:
- publish: Emit events for other agents
- claim/release: Lock resources to avoid conflicts
- get_state/set_state: Read/write shared state
- wait: Sleep until events arrive (saves API calls)

${INSTRUCTIONS:+Protocol instructions: ${INSTRUCTIONS}}
${WAKE_HINT}"

# Escape for JSON
CONTEXT_JSON=$(echo "$CONTEXT" | jq -Rs .)

cat << EOF
{
  "hookSpecificOutput": {
    "hookEventName": "SessionStart",
    "additionalContext": ${CONTEXT_JSON}
  }
}
EOF
