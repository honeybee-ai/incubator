# Incubator

**Give your swarm shared memory.**

When you spawn multiple AI agents to work on the same problem, they run blind. No awareness of what others are doing. They make decisions in isolation and commit to them — picking the same variable names, overwriting each other's files, duplicating work that's already done.

Incubator is an MCP server that lets agents add live context to each other while running. No orchestrator deciding who does what. No pre-scripted roles. No sequential handoffs. Agents self-organize by reading each other's state, claiming resources before touching them, and sharing discoveries as they work.

And anything that speaks HTTP can join the conversation.

## The Problem

3 agents splitting a monolith into modules, without coordination:

```
agent 1: "I split the monolith into 5 modules"    ← did all the work
agent 2: "I split the monolith into 5 modules"    ← overwrote agent 1
agent 3: "I split the monolith into 5 modules"    ← overwrote agent 2
```

All 3 did the same 5 files. 15 file writes for 6 files of actual work. Last writer wins, everyone else's output is garbage.

## The Fix

Same 3 agents, same task, with Incubator:

```
agent_45af598c  claim file:utils.js → approved
agent_45af598c  claim file:cache.js → approved
agent_dff039a5  claim file:utils.js → rejected (owner: agent_45af598c)
agent_dff039a5  claim file:posts.js → approved
agent_dff039a5  claim file:search.js → approved
agent_13fa08bc  claim file:utils.js → rejected (owner: agent_45af598c)
agent_13fa08bc  claim file:posts.js → rejected (owner: agent_dff039a5)
...
agent_45af598c  publishDiscovery "module:utils.js exports generateId, retry, debounce, deepClone"
agent_dff039a5  publishDiscovery "module:posts.js exports createPost, publishPost, addTag, removeTag"
```

Each agent claims what it's working on. Rejections redirect agents to unclaimed work. Discoveries give every agent context about what others decided — without anyone having to prompt them.

6 file writes for 6 files. Zero collisions. Zero wasted work.

## Bottom-Up, Not Top-Down

Most multi-agent frameworks use an orchestrator: a central brain that assigns tasks, routes messages, and sequences work. The orchestrator is a bottleneck and a single point of failure. It has to understand the problem well enough to decompose it. If it plans wrong, every agent does wrong work.

Incubator is the opposite. There's no orchestrator. Agents share a coordination layer — claims, discoveries, events, state — and figure out the division of labor themselves. The coordination primitives are simple enough that any LLM understands them from the tool descriptions alone.

| | Orchestrator (top-down) | Incubator (bottom-up) |
|---|---|---|
| **Who decides** | Central planner | Each agent |
| **Failure mode** | Orchestrator wrong → all agents wrong | One agent wrong → others adapt |
| **Scaling** | Orchestrator becomes bottleneck | Agents self-balance |
| **Flexibility** | Pre-planned task graph | Emergent work distribution |
| **Agent awareness** | Only what orchestrator tells them | Full shared context |

## How It Works

Incubator is a lightweight MCP server with a REST API. Agents connect over MCP and get coordination tools. Everything else — dashboards, scripts, webhooks, CI pipelines — talks REST.

Same stores. Same state. Three protocols.

```
┌───────────┐     MCP      ┌─────────────────┐     REST      ┌─────────────┐
│  Agent 1  │◄────────────►│                 │◄─────────────►│  Dashboard  │
│  Agent 2  │◄────────────►│    Incubator    │◄─────────────►│  Webhooks   │
│  Agent 3  │◄────────────►│                 │◄─────────────►│  CI / cron  │
└───────────┘              └────────┬────────┘               └─────────────┘
                                    │ WebSocket
                            ┌───────▼────────┐
                            │  Live clients  │
                            │  (push events) │
                            └────────────────┘
                            Memory, SQLite, or Redis
                            Single process or distributed
                            Zero to minimal infrastructure
```

### MCP Tools

**Claims** — resource locking, first-come-first-served
- `incubator_claim` / `incubator_releaseClaim` / `incubator_checkClaim` / `incubator_listClaims`

**Discoveries** — shared knowledge with text search
- `incubator_publishDiscovery` / `incubator_searchDiscoveries`

**Events** — agent-to-agent signaling with cursor-based polling
- `incubator_publishEvent` / `incubator_getEvents`

**State** — shared key-value store, last-writer-wins
- `incubator_getState` / `incubator_setState` / `incubator_queryState` / `incubator_deleteState`

**Protocol** — coordination spec bootstrap
- `incubator_getProtocol` — returns phase-aware instructions, rules, and resource conventions from a loaded spec

The tool descriptions themselves are the coordination protocol. Agents read them, understand the pattern, and self-organize. No plugin, no separate instructions, no injected system prompts. For structured workflows, load a [coordination spec](#coordination-specs) and agents call `getProtocol` to get phase-specific instructions.

### REST API

Every MCP operation is also available over plain HTTP. Prefix with `/api/`:

| Method | Route | Description |
|--------|-------|-------------|
| `GET` | `/api/health` | Server status, agent count, claim/event counts |
| `GET` | `/api/state/:key` | Read a state value |
| `PUT` | `/api/state/:key` | Write a state value |
| `DELETE` | `/api/state/:key` | Delete a state value |
| `GET` | `/api/state?pattern=&category=` | Query state entries |
| `POST` | `/api/claims` | Claim a resource |
| `DELETE` | `/api/claims/:resource` | Release a claim |
| `GET` | `/api/claims/:resource` | Check who owns a resource |
| `GET` | `/api/claims?pattern=` | List active claims |
| `POST` | `/api/events` | Publish an event |
| `GET` | `/api/events?since=&type=` | Poll events by cursor |
| `POST` | `/api/discoveries` | Share a discovery |
| `GET` | `/api/discoveries?query=&category=` | Search discoveries |
| `GET` | `/api/protocol` | Get loaded coordination spec |
| `PUT` | `/api/protocol` | Load a coordination spec |

Agent identity is passed via `agentId` in the JSON body or `X-Agent-Id` header. CORS is enabled by default. Namespace isolation via `X-Namespace` header (default: `default`).

```bash
# Check server health
curl http://localhost:3100/api/health

# Set shared state
curl -X PUT http://localhost:3100/api/state/config \
  -H "Content-Type: application/json" \
  -d '{"value": {"maxRetries": 3}, "agentId": "dashboard"}'

# Watch active claims
curl http://localhost:3100/api/claims

# Search what agents have found
curl "http://localhost:3100/api/discoveries?query=naming+convention"
```

### WebSocket (Real-Time Push)

Events are pushed to WebSocket clients the instant they're published. No polling. Connect to `/ws` on the same port:

```
ws://localhost:3100/ws?namespace=default&since=0&types=conflict,completed
```

| Parameter | Description |
|-----------|-------------|
| `namespace` | Namespace to subscribe to (default: `default`) |
| `since` | Replay events after this cursor, then stream live |
| `types` | Comma-separated event type filter (omit for all) |

On connect, the server replays any missed events (from `since`), sends a `replay_done` marker, then streams live events as they happen:

```json
{"type": "event", "event": {"id": 5, "type": "conflict", "data": {...}, ...}}
{"type": "event", "event": {"id": 6, "type": "completed", "data": {...}, ...}}
{"type": "replay_done", "cursor": 6}
{"type": "event", "event": {"id": 7, "type": "conflict", "data": {...}, ...}}
```

Clients can update their type filter without reconnecting:

```json
{"type": "subscribe", "types": ["conflict"]}
```

Send `null` types to receive everything again. A `ping` message is sent every 30 seconds as a keepalive.

WebSocket auto-enables in HTTP mode when the `ws` package is installed. If not installed, everything else works normally — agents poll via MCP, REST clients poll via `GET /api/events?since=`.

```bash
# Install ws to enable WebSocket push
npm install ws

# Quick test with wscat
wscat -c ws://localhost:3100/ws
```

**With Redis backend**, WebSocket push works across multiple Incubator instances. Events published to one instance are pushed to WebSocket clients connected to any instance via Redis Pub/Sub.

## The STOP Button

The REST API enables something orchestrators can't do cleanly: external control over running agents.

Agents check a shared state key before each operation. An external system sets that key via REST. Next time any agent checks, it sees the signal and stops gracefully.

```bash
# Agents are working...

# Send STOP from anywhere — curl, a dashboard, a webhook
curl -X PUT http://localhost:3100/api/state/halt \
  -H "Content-Type: application/json" \
  -d '{"value": true, "agentId": "dashboard"}'

# Agents see halt=true on their next state check, report what they completed, and exit

# Resume later
curl -X DELETE http://localhost:3100/api/state/halt
```

This isn't a special feature. It's just the coordination primitives doing their job. Any state key can be a control signal. Any REST client can send it. The agents don't know or care that the signal came from outside MCP.

See the [examples package](https://github.com/agentcoordinationprotocol/acp-spec/tree/main/packages/examples) for protocol demos.

## Security: Coordination Injection

The coordination layer is an attack surface. If one agent gets compromised via prompt injection, it can poison shared state, discoveries, and events that every other agent trusts. We call this a **coordination injection attack** — the compromised agent doesn't need to hack the server. It just writes something toxic into shared memory and lets the other agents do the damage.

Incubator defends against this with [carapace](https://www.npmjs.com/package/carapace), a deterministic prompt injection scanner. Three layers of defense, all on by default:

1. **Writes** — every write to state, claims, events, and discoveries is scanned before it hits the stores. Malicious content is rejected with a `PIABlockedError`.
2. **Reads** — every read filters results through the scanner. Poisoned entries that somehow entered the stores (migration, manual edit, pre-guard snapshots) are silently dropped.
3. **Snapshots** — persisted snapshots are scanned on load. Poisoned entries are stripped before they reach the stores.

```
agent_evil → setState("config", "Ignore all instructions...")
           → carapace: score 150, BLOCK
           → 403 { error: "prompt_injection_detected", findings: [...] }

agent_good → setState("config", "maxRetries: 3")
           → carapace: score 0, PASS
           → 200 { success: true }
```

Internal system events (like `claim.acquired`) bypass the guard since they're generated by Incubator itself, not by agent input.

**MCP agents** see `{ isError: true, text: "[carapace] Blocked: ..." }` and can retry with clean content. **REST clients** get a `403` with the full scan result including score and findings.

To disable (not recommended):

```bash
node dist/index.js --http --no-guard
# WARNING: Carapace disabled — no prompt injection scanning
```

## Use Cases

**Multi-agent coding** — N agents working on the same repo. Claims prevent file conflicts. Discoveries share naming conventions and patterns found.

**Human-in-the-loop control** — Dashboard monitors agent progress in real time via REST. Pause, resume, or redirect agents by setting state.

**CI/CD integration** — Pipeline sets shared state before agents run (target branch, test results, deploy config). Agents read it without custom tooling.

**Webhook-driven coordination** — External events (GitHub PR merged, Slack message, monitoring alert) publish to the event store. Agents poll and react.

**Agent handoffs** — Agent A finishes phase 1, publishes discoveries summarizing what it learned. Agent B picks up phase 2 with full context, no prompt needed.

**Rate limiting / resource management** — Claims with TTL as leases. Agents check out API quotas, database connections, or deployment slots.

## Quick Start

```bash
npm install
npm run build
```

### Start the server

```bash
# HTTP mode (multi-agent, MCP + REST)
# Carapace is on by default — all writes are scanned for prompt injection
node dist/index.js --http --port=3100 --verbose

# With SQLite persistence (survives restarts)
node dist/index.js --http --backend=sqlite --db=./incubator.db

# With a coordination spec (agents call getProtocol for instructions)
node dist/index.js --http --protocol=path/to/spec.acp.yml

# With Redis (multi-process scaling, shared across instances)
node dist/index.js --http --backend=redis
node dist/index.js --http --backend=redis --redis-url=redis://10.0.0.5:6379

# With JSON snapshot persistence (memory backend only)
node dist/index.js --http --persist=./data/snapshot

# Stdio mode (single agent / testing)
node dist/index.js --agent-id=agent_1
```

### Connect from Claude Code

Create an MCP config file:

```json
{
  "mcpServers": {
    "incubator": {
      "type": "http",
      "url": "http://localhost:3100/mcp"
    }
  }
}
```

Then pass it when launching agents:

```bash
claude -p "your task here" --mcp-config mcp.json --model haiku
```

Or add it permanently:

```bash
claude mcp add --transport http incubator http://localhost:3100/mcp
```

### Tell agents how to coordinate

Add coordination instructions to your prompt:

```
You are one of N agents working on the same directory. Use the incubator tools:

1. Call incubator_searchDiscoveries first to see what others have done.
2. Call incubator_claim before touching any file. If rejected, skip it.
3. Call incubator_publishDiscovery after completing work so others know.
4. Call incubator_releaseClaim when done with each resource.
5. Only touch resources you successfully claimed.
```

That's it. The agents figure out the rest.

For structured workflows, use a [coordination spec](#coordination-specs) instead — agents call `getProtocol` and get phase-aware instructions automatically.

## Coordination Specs

For repeatable workflows, define the coordination pattern once in a `.acp.json` file. Agents call `getProtocol` on startup and get phase-aware instructions — no copy-paste prompts, no hardcoded coordination rules.

```bash
# Start with a coordination spec
node dist/index.js --http --protocol=path/to/spec.acp.yml

# Agents call getProtocol to get their instructions
# No prompt injection of coordination rules needed
```

A spec defines **roles** (types of agents), **phases** (workflow stages), **rules** (what each role does per phase), and **resources** (naming conventions for claims, discoveries, events, state keys).

```json
{
  "acp": "1.0",
  "name": "monolith-split",
  "title": "Monolith Module Split",
  "roles": {
    "worker": { "description": "Extracts modules from the monolith", "count": "2+" },
    "coordinator": { "description": "Monitors progress, manages phases", "count": "0-1" }
  },
  "phases": {
    "init": { "description": "Orient and check existing state" },
    "work": { "description": "Claim and process resources" },
    "done": { "description": "All work complete", "terminal": true }
  },
  "rules": {
    "worker": {
      "work": {
        "loop": true,
        "steps": [
          { "action": "claim", "params": { "resource": "$next_unclaimed" }, "on_rejected": { "skip": true } },
          { "action": "external", "hint": "Read source, extract module, write output" },
          { "action": "publishDiscovery", "params": { "topic": "module:$resource", "category": "exports" } },
          { "action": "releaseClaim" }
        ]
      }
    }
  }
}
```

When an agent calls `incubator_getProtocol`, it gets back:

- **Rendered instructions** — natural language prose the LLM follows, generated from the spec + current runtime state
- **Structured rules** — the steps for its role in the current phase, with resolved `$variables`
- **Resource conventions** — how to name claims, discoveries, events, and state keys
- **Phase overview** — all phases and which one is current
- **Error handling** — what to do on claim rejection, expiry, or halt

The agent calls `getProtocol` once on startup, follows the instructions, and calls it again when it observes a phase change. Phases advance via shared state (`setState({ key: 'phase', value: 'work' })`).

### Runtime variables

Specs can use `$variables` that resolve against live store state:

| Variable | Source | Description |
|----------|--------|-------------|
| `$self` | Agent ID | The calling agent's identifier |
| `$cursor` | Event store | Current event cursor for polling |
| `$next_unclaimed` | Claims + instances | First resource not yet claimed or completed |
| `$active_claims` | Claims store | Currently active claim resources |
| `$completed_resources` | Discoveries | Resources with published discoveries |

### Loading specs

```bash
# Via CLI flag (loaded on startup)
node dist/index.js --http --protocol=path/to/spec.acp.json

# Via REST API (loaded at runtime)
curl -X PUT http://localhost:3100/api/protocol \
  -H "Content-Type: application/json" \
  -d '{"spec": "{\"acp\":\"1.0\", ...}"}'

# Check what's loaded
curl http://localhost:3100/api/protocol
```

See the [ACP examples package](https://github.com/agentcoordinationprotocol/acp-spec/tree/main/packages/examples) for protocol specs.

## Technical Details

- **Near-zero infrastructure** — Default is pure in-memory. Optional SQLite for single-process persistence. Optional Redis for multi-process scaling.
- **Sub-millisecond startup** — `node dist/index.js` and it's ready. SQLite auto-creates its schema on first run. Redis connects before the server starts.
- **Single process or distributed** — Memory and SQLite are single-threaded with no race conditions. Redis lets multiple Incubator instances share one coordination layer.
- **Pluggable backends** — Memory (default), SQLite, or Redis. Same async interfaces, same behavior. Swap with a CLI flag.
- **Minimal dependencies** — `@agentcoordinationprotocol/spec`, `@modelcontextprotocol/sdk`, `zod`, and `carapace`. `better-sqlite3`, `ioredis`, `ws` are optional (loaded on demand).
- **Three protocols** — MCP for agents, REST for external systems, WebSocket for real-time push. Same stores, same state.
- **Three persistence modes** — JSON snapshots (`--persist`) for memory backend. SQLite and Redis are inherently persistent.
- **Optional TTL** — State entries and claims can auto-expire. Lazy cleanup on read (consistent across all backends).
- **Cursor-based events** — Agents call `getEvents(since: cursor)` to catch up via MCP/REST. WebSocket clients get events pushed in real time with replay-then-live (no missed events, no duplicates).
- **Text search for discoveries** — Substring matching, not vector similarity. At agent scale (dozens of discoveries, not millions), it's instant and deterministic.
- **Namespace isolation** — Multiple teams/projects share one server. SQLite isolates by namespace column; Redis by key prefix. No data leakage.

## Architecture

```
incubator/
  src/
    index.ts              # CLI entry, dual transport (stdio + HTTP)
    server.ts             # McpServer, 13 tool registrations
    rest.ts               # REST API route handlers
    bus.ts                # NotificationBus (LocalBus + RedisBus)
    ws.ts                 # WebSocket manager (upgrade, replay, live push)
    guard.ts              # Carapace integration (coordination injection defense)
    stores/
      interfaces.ts       # Store interfaces (IStateStore, IEventStore, etc.)
      backend.ts          # Backend factory (memory, sqlite, or redis)
      state.ts            # Memory: key-value store (last-writer-wins)
      claims.ts           # Memory: resource claims (first-come-first-served)
      events.ts           # Memory: append-only event log with cursors
      discoveries.ts      # Memory: shared findings with text search
      sqlite/
        db.ts             # Schema init, DB handle caching
        state.ts          # SQLite state store
        claims.ts         # SQLite claim store
        events.ts         # SQLite event store
        discoveries.ts    # SQLite discovery store
        index.ts          # createSqliteStores factory
      redis/
        db.ts             # Connection management, client caching
        state.ts          # Redis state store (Hash)
        claims.ts         # Redis claim store (Hash + WATCH)
        events.ts         # Redis event store (Sorted Set + MULTI/EXEC)
        discoveries.ts    # Redis discovery store (List)
        index.ts          # createRedisStores factory
    types.ts              # TypeScript types
    persistence.ts        # JSON snapshot save/load (memory backend)
    namespaces.ts         # Namespace registry with backend config
    utils.ts              # matchGlob, generateId, isExpired
  e2e/
    run.ts                # Simulated E2E (4 workers × 10 rounds)
    stop-button.ts        # STOP button integration test
```

## Design Decisions

- **Bottom-up coordination** — No orchestrator. Agents self-organize through shared primitives. The tool descriptions are the protocol.
- **Claims are first-come-first-served** — Rejected claims return the current owner so agents can adapt, not just fail.
- **Last-writer-wins for state** — State is shared knowledge, not a lock. Use claims for mutual exclusion.
- **Polling for agents, push for dashboards** — MCP agents poll with `getEvents(since: cursor)` when they're ready. WebSocket clients get real-time push with replay-then-live. Both share the same event store and cursors.
- **REST mirrors MCP** — Same operations, same stores. Agents don't need to know REST exists. External systems don't need to speak MCP.
- **No vector DB** — Substring search for discoveries. Deterministic, instant, and you can `grep` the results in your head.
- **Guard by default** — Carapace scans all writes. Opt out with `--no-guard`, not opt in. Shared memory is a trust boundary; it should be defended unless you explicitly choose otherwise.
- **Pluggable, not coupled** — Async store interfaces let you swap memory for SQLite or Redis without touching any consumer code. Same tests run against all three backends.

## Testing

```bash
# Unit + integration tests (stores, guard, WebSocket, namespaces, protocol)
# Redis tests skip gracefully if no Redis is running
npm test

# Run with Redis for full coverage
docker run -d --name redis-test -p 6379:6379 redis:alpine
npm test
docker stop redis-test && docker rm redis-test

# Simulated E2E (4 workers × 10 rounds, no LLM)
npx tsx e2e/run.ts

# STOP button integration test (3 MCP workers + REST halt signal)
npx tsx e2e/stop-button.ts

# Real agent E2E (3 Claude agents, costs ~$0.15)
bash e2e/run-real.sh
```

## Agent Runner (Built-in LLM Agents)

Incubator can spawn LLM-backed agents that coordinate through ACP primitives autonomously. Load a protocol spec and watch agents self-organize — no external agent framework needed.

**Any provider that speaks OpenAI chat completions works.** Ollama (local, free), OpenAI, Anthropic, Groq, Together, Fireworks, Mistral — one code path covers them all.

### Quick Start

```bash
# Ollama (local, free — install from ollama.com, then pull a model)
ollama pull qwen3:32b
node dist/index.js --http --protocol=protocol.acp.yml \
  --spawn --provider=ollama/qwen3:32b --verbose

# OpenAI
OPENAI_API_KEY=sk-... node dist/index.js --http \
  --protocol=protocol.acp.yml \
  --spawn --provider=openai/gpt-4o --verbose

# Anthropic
ANTHROPIC_API_KEY=sk-ant-... node dist/index.js --http \
  --protocol=protocol.acp.yml \
  --spawn --provider=anthropic/claude-sonnet-4-5-20250929 --verbose

# Groq (or any OpenAI-compatible API)
OPENAI_API_KEY=gsk-... node dist/index.js --http \
  --protocol=protocol.acp.yml \
  --spawn --provider=groq/llama-3.3-70b-versatile --verbose
```

### Provider Shorthand

Format: `provider/model`

| Provider | Example | API Key Env Var |
|----------|---------|-----------------|
| Ollama | `ollama/qwen3:32b` | None (local) |
| OpenAI | `openai/gpt-4o` | `OPENAI_API_KEY` |
| Anthropic | `anthropic/claude-sonnet-4-5-20250929` | `ANTHROPIC_API_KEY` |
| Groq | `groq/llama-3.3-70b-versatile` | `OPENAI_API_KEY` |
| Together | `together/meta-llama/Llama-3-70b` | `OPENAI_API_KEY` |

Unknown provider names are treated as OpenAI-compatible (same chat completions format).

### Configuration

| Flag | Default | Description |
|------|---------|-------------|
| `--spawn` | — | Enable agent spawning (requires `--protocol`) |
| `--provider=<shorthand>` | `ollama/qwen3:8b` | Default provider/model for all agents |
| `--max-iterations=<n>` | `50` | Per-agent iteration limit |
| `--spawn-roles=<roles>` | all roles | Comma-separated role filter |

### How It Works

1. Server starts in HTTP mode with a protocol spec loaded
2. `--spawn` reads the spec's `roles` section and spawns the right number of agents
3. Each agent gets a system prompt generated from the protocol spec + their role
4. Agents run a ReAct loop: call LLM → execute tool calls via REST API → feed results back
5. Tool calls map to the 13 Incubator tools (`incubator_getState`, `incubator_claim`, etc.)
6. Every 10 iterations, agents re-fetch their protocol to detect phase transitions
7. Agents finish when they stop making tool calls, say "DONE", or hit `--max-iterations`
8. Ctrl+C gracefully stops all agents between iterations

Each agent gets color-coded console output (with `--verbose`), so you can follow multi-agent coordination in real time.

### Programmatic Usage

```typescript
import { AgentRunner } from './agent/runner.js';
import { resolveProvider, preflight } from './agent/providers.js';

const provider = resolveProvider('ollama/qwen3:32b');
await preflight(provider, true);

const runner = new AgentRunner({
  defaultProvider: provider,
  serverUrl: 'http://localhost:3100',
  maxIterations: 50,
  verbose: true,
});

const results = await runner.spawnFromProtocol('protocol.acp.yml');
// results: [{ agentId, role, status, iterations, error? }, ...]
```

## Why "Incubator"

Agents hatch ideas in isolation. Give them a shared space and they become a swarm.
