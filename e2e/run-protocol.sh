#!/bin/bash
#
# Real Claude agent E2E test using ACP coordination spec.
# N agents split a monolith into modules — using getProtocol instead of
# hardcoded coordination prompts.
#
# Usage: bash e2e/run-protocol.sh [num_agents]
#

set -euo pipefail

NUM_AGENTS="${1:-3}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
BASE_DIR="/tmp/incubator-protocol-e2e"
SERVER_PORT=3198
MODEL="${MODEL:-haiku}"
SERVER_LOG="$BASE_DIR/incubator-server.log"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
CYAN='\033[0;36m'
YELLOW='\033[1;33m'
BOLD='\033[1m'
DIM='\033[2m'
NC='\033[0m'

cleanup() {
  if [[ -n "${SERVER_PID:-}" ]]; then
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT

rm -rf "$BASE_DIR"
mkdir -p "$BASE_DIR"

echo -e "\n${BOLD}${CYAN}  Incubator Protocol E2E Test${NC}"
echo -e "  ${NUM_AGENTS} Claude agents ($MODEL) using getProtocol"
echo -e "  Task: split monolith.js into separate modules"
echo -e "  Spec: examples/monolith-split.acp.json\n"

# ════════════════════════════════════════════════════════════
# Start server with protocol spec loaded
# ════════════════════════════════════════════════════════════

WORK_DIR="$BASE_DIR/work"
mkdir -p "$WORK_DIR"
cp "$SCRIPT_DIR/monolith.js" "$WORK_DIR/monolith.js"

echo -e "  Starting Incubator with protocol spec on port $SERVER_PORT..."

# Build first
(cd "$PROJECT_DIR" && npm run build) > /dev/null 2>&1

node "$PROJECT_DIR/dist/index.js" \
  --http \
  --port="$SERVER_PORT" \
  --protocol="$PROJECT_DIR/examples/monolith-split.acp.json" \
  --verbose \
  2>"$SERVER_LOG" &
SERVER_PID=$!
sleep 1

if ! kill -0 "$SERVER_PID" 2>/dev/null; then
  echo -e "  ${RED}Server failed to start. Log:${NC}"
  cat "$SERVER_LOG"
  exit 1
fi
echo -e "  ${GREEN}Server running (PID $SERVER_PID)${NC}\n"

# Set initial phase to 'work' via REST
curl -s -X PUT "http://localhost:$SERVER_PORT/api/state/phase" \
  -H "Content-Type: application/json" \
  -d '{"value": "work", "agentId": "e2e-runner"}' > /dev/null

echo -e "  Phase set to 'work' via REST\n"

# ════════════════════════════════════════════════════════════
# Launch agents with protocol-based prompt
# ════════════════════════════════════════════════════════════

MCP_CONFIG="$BASE_DIR/mcp-config.json"
cat > "$MCP_CONFIG" << EOF
{
  "mcpServers": {
    "incubator": {
      "type": "http",
      "url": "http://localhost:$SERVER_PORT/mcp"
    }
  }
}
EOF

# The prompt tells agents to use getProtocol — no hardcoded coordination rules
PROTO_PROMPT='You are splitting monolith.js into separate module files. The monolith has 5 sections:
1. User Management: createUser, deactivateUser, changeRole, formatUserDisplay
2. Post Management: createPost, publishPost, addTag, removeTag
3. Search & Filtering: searchPosts, filterByTag, filterByAuthor, sortByDate, paginate
4. Cache: createCache
5. Utilities: generateId, retry, debounce, deepClone + constants DEFAULT_PAGE_SIZE, MAX_RETRIES, CACHE_TTL_MS

Create these files: users.js, posts.js, search.js, cache.js, utils.js
Each module exports its functions via module.exports. Use require() for cross-module deps (e.g. posts needs generateId from utils).
Update monolith.js to be an index that re-exports from all modules.
Do NOT add comments. Do NOT refactor logic. ONLY split and wire imports/exports.

COORDINATION — You are one of several agents working on the SAME directory at the same time.
Call incubator_getProtocol with role="worker" FIRST to get your coordination instructions.
Follow the steps it gives you. Call getProtocol again if you see a phase change.'

PIDS=()
for i in $(seq 1 "$NUM_AGENTS"); do
  echo -e "  ${DIM}Spawning agent $i → $WORK_DIR${NC}"
  (
    cd "$WORK_DIR"
    claude -p "$PROTO_PROMPT" \
      --allowedTools "Read,Edit,Write,Glob,Grep,mcp__incubator__incubator_claim,mcp__incubator__incubator_releaseClaim,mcp__incubator__incubator_checkClaim,mcp__incubator__incubator_listClaims,mcp__incubator__incubator_publishDiscovery,mcp__incubator__incubator_searchDiscoveries,mcp__incubator__incubator_publishEvent,mcp__incubator__incubator_getEvents,mcp__incubator__incubator_getState,mcp__incubator__incubator_setState,mcp__incubator__incubator_queryState,mcp__incubator__incubator_deleteState,mcp__incubator__incubator_getProtocol" \
      --mcp-config "$MCP_CONFIG" \
      --strict-mcp-config \
      --no-session-persistence \
      --dangerously-skip-permissions \
      --model "$MODEL" \
      > "$WORK_DIR/agent-${i}-output.txt" 2>&1
  ) &
  PIDS+=($!)
done

echo -e "\n  Waiting for ${#PIDS[@]} agents...\n"

# Tail the server log while waiting
tail -f "$SERVER_LOG" --pid=$$ 2>/dev/null &
TAIL_PID=$!

for pid in "${PIDS[@]}"; do
  wait "$pid" || true
done

kill "$TAIL_PID" 2>/dev/null || true
kill "$SERVER_PID" 2>/dev/null || true
wait "$SERVER_PID" 2>/dev/null || true
unset SERVER_PID

echo -e "\n  ${GREEN}All agents finished.${NC}\n"

# ════════════════════════════════════════════════════════════
# Analysis
# ════════════════════════════════════════════════════════════

echo -e "${BOLD}${CYAN}  ════════════════════════════════════════${NC}"
echo -e "${BOLD}${CYAN}  RESULTS${NC}"
echo -e "${BOLD}${CYAN}  ════════════════════════════════════════${NC}\n"

echo -e "  ${BOLD}Files created:${NC}\n"
count=0
for f in "$WORK_DIR"/*.js; do
  [[ -f "$f" ]] || continue
  name=$(basename "$f")
  lines=$(wc -l < "$f")
  echo -e "    ${GREEN}$(printf '%-15s' "$name")${NC} ${lines} lines"
  count=$((count + 1))
done
echo -e "\n  ${DIM}Total: $count files${NC}\n"

# Try to load
if node -e "require('$WORK_DIR/monolith.js')" 2>/dev/null; then
  echo -e "  ${GREEN}node require() → OK${NC}"
else
  echo -e "  ${RED}node require() → FAILED${NC}"
  node -e "require('$WORK_DIR/monolith.js')" 2>&1 | head -5 | sed 's/^/    /'
fi

# Server activity
echo -e "\n  ${BOLD}Incubator Server Activity:${NC}\n"
if [[ -f "$SERVER_LOG" ]]; then
  claims=$(grep -c "claim " "$SERVER_LOG" 2>/dev/null || echo 0)
  discoveries=$(grep -c "publishDiscovery" "$SERVER_LOG" 2>/dev/null || echo 0)
  rejections=$(grep -c "rejected" "$SERVER_LOG" 2>/dev/null || echo 0)
  releases=$(grep -c "releaseClaim" "$SERVER_LOG" 2>/dev/null || echo 0)
  protocol_calls=$(grep -c "getProtocol" "$SERVER_LOG" 2>/dev/null || echo 0)
  echo -e "    getProtocol calls: $protocol_calls"
  echo -e "    Claims attempted:  $claims"
  echo -e "    Claims rejected:   $rejections"
  echo -e "    Claims released:   $releases"
  echo -e "    Discoveries:       $discoveries"
  echo ""
  echo -e "  ${DIM}Full log: $SERVER_LOG${NC}"
fi

echo -e "\n  ${DIM}Agent outputs: $WORK_DIR/agent-*-output.txt${NC}\n"
