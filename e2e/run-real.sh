#!/bin/bash
#
# Real Claude agent E2E test for Incubator.
# N agents split a monolith into modules — with vs without coordination.
#
# Usage: bash e2e/run-real.sh [num_agents]
#

set -euo pipefail

NUM_AGENTS="${1:-3}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
BASE_DIR="/tmp/incubator-real-e2e"
SERVER_PORT=3199
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

echo -e "\n${BOLD}${CYAN}  Incubator Real Agent E2E Test${NC}"
echo -e "  ${NUM_AGENTS} Claude agents ($MODEL) × 2 scenarios"
echo -e "  Task: split monolith.js into separate modules\n"

# ─── The shared task prompt ─────────────────────────────────

BASE_PROMPT='You are splitting monolith.js into separate module files. The monolith has 5 sections:
1. User Management: createUser, deactivateUser, changeRole, formatUserDisplay
2. Post Management: createPost, publishPost, addTag, removeTag
3. Search & Filtering: searchPosts, filterByTag, filterByAuthor, sortByDate, paginate
4. Cache: createCache
5. Utilities: generateId, retry, debounce, deepClone + constants DEFAULT_PAGE_SIZE, MAX_RETRIES, CACHE_TTL_MS

Create these files: users.js, posts.js, search.js, cache.js, utils.js
Each module exports its functions via module.exports. Use require() for cross-module deps (e.g. posts needs generateId from utils).
Update monolith.js to be an index that re-exports from all modules.
Do NOT add comments. Do NOT refactor logic. ONLY split and wire imports/exports.'

# ════════════════════════════════════════════════════════════
# Scenario 1: Without Incubator
# ════════════════════════════════════════════════════════════

echo -e "${BOLD}${YELLOW}  ── Scenario 1: WITHOUT Incubator ──${NC}\n"

WITHOUT_DIR="$BASE_DIR/without"
mkdir -p "$WITHOUT_DIR"
cp "$SCRIPT_DIR/monolith.js" "$WITHOUT_DIR/monolith.js"

# All agents share ONE directory — collisions are the point
PIDS=()
for i in $(seq 1 "$NUM_AGENTS"); do
  echo -e "  ${DIM}Spawning agent $i → $WITHOUT_DIR${NC}"
  (
    cd "$WITHOUT_DIR"
    claude -p "$BASE_PROMPT" \
      --allowedTools "Read,Edit,Write,Glob,Grep" \
      --no-session-persistence \
      --dangerously-skip-permissions \
      --model "$MODEL" \
      > "$WITHOUT_DIR/agent-${i}-output.txt" 2>&1
  ) &
  PIDS+=($!)
done

echo -e "  Waiting for ${#PIDS[@]} agents...\n"
for pid in "${PIDS[@]}"; do
  wait "$pid" || true
done
echo -e "  ${GREEN}Scenario 1 complete.${NC}\n"

# ════════════════════════════════════════════════════════════
# Scenario 2: With Incubator
# ════════════════════════════════════════════════════════════

echo -e "${BOLD}${YELLOW}  ── Scenario 2: WITH Incubator ──${NC}\n"

WITH_DIR="$BASE_DIR/with"
mkdir -p "$WITH_DIR"
cp "$SCRIPT_DIR/monolith.js" "$WITH_DIR/monolith.js"

# Start Incubator with verbose logging
echo -e "  Starting Incubator on port $SERVER_PORT (logging to $SERVER_LOG)..."
node "$PROJECT_DIR/dist/index.js" --http --port="$SERVER_PORT" --verbose 2>"$SERVER_LOG" &
SERVER_PID=$!
sleep 1

if ! kill -0 "$SERVER_PID" 2>/dev/null; then
  echo -e "  ${RED}Server failed to start. Log:${NC}"
  cat "$SERVER_LOG"
  exit 1
fi
echo -e "  ${GREEN}Server running (PID $SERVER_PID)${NC}\n"

# MCP config
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

COORD_PROMPT="$BASE_PROMPT

COORDINATION — You are one of $NUM_AGENTS agents working on the SAME directory at the same time. Use the incubator MCP tools:

1. FIRST: call incubator_searchDiscoveries to see what others have done.
2. To work on a file, call incubator_claim with resource=\"file:<filename>\" (e.g. \"file:users.js\"). If REJECTED, skip it.
3. After creating a module, call incubator_publishDiscovery with topic=\"module:<filename>\" listing what it exports, so other agents know.
4. Claim \"file:monolith.js\" before editing the index. If you can't get it, publish your exports via discovery so whoever writes the index can include them.
5. Call incubator_releaseClaim when done with each file.
6. Only touch files you successfully claimed."

PIDS=()
for i in $(seq 1 "$NUM_AGENTS"); do
  echo -e "  ${DIM}Spawning agent $i → $WITH_DIR${NC}"
  (
    cd "$WITH_DIR"
    claude -p "$COORD_PROMPT" \
      --allowedTools "Read,Edit,Write,Glob,Grep,mcp__incubator__incubator_claim,mcp__incubator__incubator_releaseClaim,mcp__incubator__incubator_checkClaim,mcp__incubator__incubator_listClaims,mcp__incubator__incubator_publishDiscovery,mcp__incubator__incubator_searchDiscoveries,mcp__incubator__incubator_publishEvent,mcp__incubator__incubator_getEvents,mcp__incubator__incubator_getState,mcp__incubator__incubator_setState,mcp__incubator__incubator_queryState,mcp__incubator__incubator_deleteState" \
      --mcp-config "$MCP_CONFIG" \
      --strict-mcp-config \
      --no-session-persistence \
      --dangerously-skip-permissions \
      --model "$MODEL" \
      > "$WITH_DIR/agent-${i}-output.txt" 2>&1
  ) &
  PIDS+=($!)
done

echo -e "  Waiting for ${#PIDS[@]} agents...\n"

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

echo -e "\n  ${GREEN}Scenario 2 complete.${NC}\n"

# ════════════════════════════════════════════════════════════
# Analysis
# ════════════════════════════════════════════════════════════

echo -e "${BOLD}${CYAN}  ════════════════════════════════════════${NC}"
echo -e "${BOLD}${CYAN}  RESULTS${NC}"
echo -e "${BOLD}${CYAN}  ════════════════════════════════════════${NC}\n"

analyze_dir() {
  local dir="$1"
  local label="$2"

  echo -e "  ${BOLD}${label}${NC}"
  echo -e "  ${DIM}$dir${NC}\n"

  # List JS files
  local count=0
  echo -e "  Files created:"
  for f in "$dir"/*.js; do
    [[ -f "$f" ]] || continue
    local name
    name=$(basename "$f")
    local lines
    lines=$(wc -l < "$f")
    echo -e "    ${GREEN}$(printf '%-15s' "$name")${NC} ${lines} lines"
    count=$((count + 1))
  done
  echo -e "  ${DIM}Total: $count files${NC}\n"

  # Try to load
  if node -e "require('$dir/monolith.js')" 2>/dev/null; then
    echo -e "  ${GREEN}node require() → OK${NC}"
  else
    echo -e "  ${RED}node require() → FAILED${NC}"
    node -e "require('$dir/monolith.js')" 2>&1 | head -3 | sed 's/^/    /'
  fi
  echo ""
}

analyze_dir "$WITHOUT_DIR" "WITHOUT Incubator"
analyze_dir "$WITH_DIR" "WITH Incubator"

# Incubator server log summary
echo -e "  ${BOLD}Incubator Server Activity:${NC}\n"
if [[ -f "$SERVER_LOG" ]]; then
  claims=$(grep -c "claim " "$SERVER_LOG" 2>/dev/null || echo 0)
  discoveries=$(grep -c "publishDiscovery" "$SERVER_LOG" 2>/dev/null || echo 0)
  rejections=$(grep -c "rejected" "$SERVER_LOG" 2>/dev/null || echo 0)
  releases=$(grep -c "releaseClaim" "$SERVER_LOG" 2>/dev/null || echo 0)
  echo -e "    Claims attempted: $claims"
  echo -e "    Claims rejected:  $rejections"
  echo -e "    Claims released:  $releases"
  echo -e "    Discoveries:      $discoveries"
  echo ""
  echo -e "  ${DIM}Full log: $SERVER_LOG${NC}"
fi

echo -e "\n  ${DIM}Agent outputs: $BASE_DIR/*/agent-*-output.txt${NC}\n"
