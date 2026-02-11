---
name: acp
description: Check ACP coordination status — events, claims, state, and protocol context
---

## Instructions

Show the current ACP coordination status. This skill queries the incubator for the agent's current state.

### Usage

- `/acp` or `/acp status` - Show coordination overview (role, phase, recent events, active claims)
- `/acp events` - List recent events in this namespace
- `/acp claims` - Show active resource claims
- `/acp state` - Show shared state entries
- `/acp protocol` - Show full protocol context and instructions

### Implementation

Read the environment variables and query the incubator REST API:

```bash
# Get config
BASE="${INCUBATOR_URL}/api"
NS=""
if [ "${ACP_NAMESPACE}" != "default" ]; then NS="/${ACP_NAMESPACE}"; fi
HEADERS=(-H "X-Agent-Id: ${ACP_AGENT_ID}")

# Status overview
echo "=== ACP Status ==="
echo "Protocol: ${ACP_NAMESPACE} | Role: ${ACP_ROLE} | Agent: ${ACP_AGENT_ID}"
echo ""

# Current protocol context
curl -sf "${BASE}${NS}/protocol?role=${ACP_ROLE}" "${HEADERS[@]}" | jq '.'

# Recent events
echo ""
echo "=== Recent Events ==="
curl -sf "${BASE}${NS}/events?since=0" "${HEADERS[@]}" | jq '.events[-5:]'

# Active claims
echo ""
echo "=== Active Claims ==="
curl -sf "${BASE}${NS}/claims" "${HEADERS[@]}" | jq '.'
```

If env vars are not set, inform the user that ACP coordination is not configured for this session. They need to set `INCUBATOR_URL`, `ACP_NAMESPACE`, `ACP_AGENT_ID`, and `ACP_ROLE`.

### Using the ACP MCP Tool

The `acp` MCP tool is available when the plugin's server is running. Use it for coordination:

```json
// Publish an event
{ "dance": [{ "do": "publish", "type": "task.complete", "data": { "file": "src/index.ts" } }] }

// Claim a resource, do work, release it
{ "dance": [
  { "do": "claim", "resource": "file:src/index.ts" },
  { "do": "release", "resource": "file:src/index.ts" }
] }

// Read shared state
{ "dance": [{ "do": "get_state" }] }

// Set shared state
{ "dance": [{ "do": "set_state", "key": "progress", "value": 0.5 }] }

// Wait for events (blocks until matching event arrives)
{ "dance": [], "wait": "task.assigned" }

// Wait with timeout
{ "dance": [], "wait": { "types": ["task.assigned"], "timeout": 30000 } }
```

The `dance` array runs operations sequentially. The `wait` parameter blocks after all operations complete. This is the same compound tool pattern used by hive agents — one tool call, multiple operations, optional sleep.
