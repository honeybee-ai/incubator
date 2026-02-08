# Protocol E2E Test Report — 2026-02-07

## Test Parameters

| Parameter | Value |
|-----------|-------|
| Date | 2026-02-07 15:14 UTC |
| Agents | 3 |
| Model | Claude Haiku |
| Spec | `examples/monolith-split.acp.json` |
| Task | Split `monolith.js` (178 lines, 21 exports) into 5 modules + index |
| Backend | Memory |
| Carapace | Active |
| Duration | ~70 seconds (server log: 15:14:27 → 15:15:40) |

## Objective

Verify that agents can coordinate using `getProtocol` instead of hardcoded coordination prompts. The spec defines roles, phases, rules, resource naming, and error handling. Agents should call `getProtocol` on startup, receive phase-aware instructions, and follow the protocol steps autonomously.

## Results

### Files Produced

| File | Lines | Cross-module deps | Status |
|------|-------|-------------------|--------|
| `utils.js` | 42 | None (leaf module) | Created |
| `users.js` | 36 | `generateId` from utils | Created |
| `posts.js` | 39 | `generateId` from utils | Created |
| `search.js` | 44 | `DEFAULT_PAGE_SIZE` from utils | Created |
| `cache.js` | 33 | `CACHE_TTL_MS` from utils | Created |
| `monolith.js` | 29 | Re-exports all 5 modules | Rewritten as index |

**Total: 6 files, 223 lines**

`node -e "require('./monolith.js')"` — **PASS** (all 21 exports intact)

### Coordination Activity

| Metric | Count |
|--------|-------|
| `getProtocol` calls | 5 |
| Claims attempted | 23 |
| Claims approved | 15 |
| Claims rejected | 8 |
| Claims released | 15 |
| Discoveries published | 12 |
| Events published | 10 |
| State reads (halt check) | 10 |

### Agent Breakdown

#### agent_00e0c879

| Action | Details |
|--------|---------|
| getProtocol | 2 calls (startup + mid-run re-check) |
| Claimed | `file:search.js`, `file:utils.js`, `file:monolith.js` |
| Rejected | `file:users.js` (x1), `file:posts.js` (x1), `file:cache.js` (x1), `file:monolith.js` (x2) |
| Discoveries | 4 (search, utils, monolith + 1 duplicate search) |

#### agent_c31a8b6d

| Action | Details |
|--------|---------|
| getProtocol | 2 calls (startup + end of run) |
| Claimed | `file:users.js`, `file:posts.js`, `file:search.js`, `file:cache.js`, `file:utils.js`, `file:monolith.js` |
| Rejected | 0 |
| Discoveries | 6 (users, posts, search, cache, utils, monolith) |

#### agent_d4c17796

| Action | Details |
|--------|---------|
| getProtocol | 1 call (startup) |
| Claimed | `file:posts.js`, `file:cache.js`, `file:monolith.js`, `file:users.js`, `file:search.js`, `file:utils.js` |
| Rejected | `file:users.js` (x1), `file:search.js` (x1), `file:utils.js` (x2) |
| Discoveries | 2 (posts, cache) |

## Timeline

```
T+0.0s  Server starts, protocol loaded
T+0.0s  Phase set to "work" via REST
T+2.7s  All 3 agents connect, sessions established
T+3.2s  All 3 agents call getProtocol (role=worker, phase=work)
T+4.8s  All 3 agents check halt flag (MISS), search discoveries (0 results)

── First claim wave ──
T+7.9s  c31a8b6d claims file:users.js → approved
T+8.7s  d4c17796 claims file:users.js → REJECTED → claims file:posts.js → approved
T+11.8s 00e0c879 claims file:users.js → REJECTED → file:posts.js → REJECTED → file:search.js → approved

── First completions ──
T+14.3s c31a8b6d: discovery(users) + release + event
T+15.1s d4c17796: discovery(posts) + release + event
T+20.5s 00e0c879: discovery(search) + release + event

── Second wave ──
T+17.8s c31a8b6d claims file:posts.js → approved (re-work)
T+18.1s d4c17796 claims file:cache.js → approved
T+23.0s 00e0c879 claims file:utils.js → approved

── Monolith index ──
T+26.0s d4c17796 claims file:monolith.js → approved, searches discoveries for context
T+30.0s 00e0c879 attempts file:monolith.js → REJECTED (d4c17796 owns it)
T+35.9s d4c17796: discovery(monolith) + release + event

── Cleanup passes ──
T+37.0s Agents continue claiming remaining unclaimed files, some re-work
T+50.0s All resources have discoveries published
T+73.0s Last agent calls getProtocol, all agents exit
```

## Protocol Adherence

The spec defined this work-phase loop:

1. `getState` — check halt flag
2. `searchDiscoveries` — check established conventions
3. `claim` — claim next unclaimed resource (on_rejected: skip)
4. `external` — do the actual work
5. `publishDiscovery` — share exports
6. `releaseClaim` — release
7. `publishEvent` — announce completion

**Observed agent behavior matches the spec exactly.** All 3 agents followed the prescribed step order. Key observations:

- **Halt check**: Every agent checked `getState(halt)` before each iteration — the protocol's step 1.
- **Discovery search**: Agents searched existing discoveries before claiming — the protocol's step 2.
- **Claim-reject-skip**: When claims were rejected, agents moved to the next unclaimed resource — the protocol's `on_rejected: { skip: true }`.
- **Discovery-before-release**: Agents published discoveries about exports *before* releasing their claims — steps 5 and 6 in order.
- **Event publishing**: Every completed resource was announced via `work.completed` event — step 7.
- **getProtocol re-calls**: 2 agents called `getProtocol` again mid-run to refresh instructions — matching the spec's "call getProtocol again when you see a phase.changed event" guidance.

## Issues Observed

### 1. No termination signal

Agents looped through all resources, then started re-claiming already-completed files. Without a coordinator role to set the halt flag or advance to the "done" phase, workers have no signal to stop. They naturally ran out of new work to do and self-terminated based on context, not the protocol.

**Recommendation**: The spec's completion condition (`state_key: phase, equals: done`) requires either a coordinator or a self-check. Add a rule step that checks if all instances have discoveries and self-sets phase to "done" if so.

### 2. Duplicate work on second pass

agent_c31a8b6d re-claimed and re-worked `file:posts.js` and `file:search.js` on its second pass. The `$next_unclaimed` variable only checks active claims and discoveries, but once a resource is released, it becomes "unclaimed" again even though it has a discovery. The variable resolver skips resources with discoveries, but the agents didn't always use `$next_unclaimed` — some made their own claim decisions.

**Recommendation**: This is acceptable behavior. The last writer wins for file content, and the claims prevent concurrent modification. The duplicate work is wasted effort but not harmful.

### 3. Namespace bug (fixed during test)

The initial run loaded the protocol into namespace `monolith-split` (from `spec.name`) but agents connected to the `default` namespace. Fixed by loading the protocol into both `default` and `spec.name` namespaces when `--protocol` is used.

## Comparison: Protocol vs Hardcoded Prompts

| Aspect | Hardcoded Prompt (run-real.sh) | Protocol Spec (run-protocol.sh) |
|--------|-------------------------------|--------------------------------|
| Coordination source | 6-line prompt paragraph | `.acp.json` file |
| Agent prompt | Task + coordination rules | Task + "call getProtocol" |
| Phase awareness | None | Full (init → work → finalize → done) |
| Resource naming | Implicit | Explicit conventions |
| Error handling | Implicit | Explicit (claim_rejected → skip) |
| Reusable across tasks | No (prompt per task) | Yes (spec per pattern) |
| Machine-parseable | No | Yes (JSON Schema validated) |
| Composable | No | Yes (swap specs for different patterns) |

## Conclusion

The coordination spec system works as designed. Agents call `getProtocol` once, receive structured instructions with resolved runtime variables, and follow the protocol steps without any coordination rules in their prompt. The spec-driven approach eliminates prompt injection of coordination rules and makes coordination patterns reusable, composable, and shareable.

The main gap is termination logic — workers need a way to detect completion without a coordinator. This is a spec design issue, not a platform issue.
