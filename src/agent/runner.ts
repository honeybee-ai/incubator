import { randomUUID } from 'node:crypto';
import type { AgentConfig, ChatMessage, AgentResult, TokenUsage, StartOnConfig, WakeOnConfig } from './types.js';
import type { ProtocolResponse } from './acp/runtime.js';
import { chatCompletion, getToolCallArgs } from './providers.js';
import { generateSystemPrompt, generateFallbackPrompt } from './prompt.js';
import type { ToolClient } from './tool-client.js';
import type { AcpRuntime } from './acp/runtime.js';
import type { DirectRuntime } from './acp/direct-runtime.js';
import { createAcpClient } from '@agentcoordinationprotocol/sdk';
import type { TelemetryReporter } from '@honeybee-ai/hivemind-sdk/telemetry';

// ─── ANSI colors for agent logs ─────────────────────────────────────

const COLORS = [
  '\x1b[36m',  // cyan
  '\x1b[33m',  // yellow
  '\x1b[35m',  // magenta
  '\x1b[32m',  // green
  '\x1b[34m',  // blue
  '\x1b[91m',  // bright red
  '\x1b[92m',  // bright green
  '\x1b[93m',  // bright yellow
  '\x1b[94m',  // bright blue
  '\x1b[95m',  // bright magenta
  '\x1b[96m',  // bright cyan
];
const RESET = '\x1b[0m';
const DIM = '\x1b[2m';

let colorIndex = 0;

// ─── File write tools that trigger auto-claims ──────────────────────

const FILE_WRITE_TOOLS = new Set(['write_file', 'patch_file']);

// ─── Coordination tool presets ───────────────────────────────────────

/** Core ACP primitives — minimal coordination set */
const LITE_TOOLS = new Set([
  'incubator_claim',
  'incubator_releaseClaim',
  'incubator_setState',
  'incubator_publishEvent',
]);

// ─── Synthetic ACP tools (invisible mode) ───────────────────────────

/** Tool names handled by the ACP runtime, not by MCP clients */
const SYNTHETIC_TOOL_NAMES = new Set(['publish_event', 'set_state', 'get_state', 'claim_resource', 'release_resource']);

import type { ToolDef } from './types.js';

const SYNTHETIC_TOOLS: ToolDef[] = [
  {
    type: 'function',
    function: {
      name: 'publish_event',
      description: 'Publish a coordination event to notify other agents of progress or milestones',
      parameters: {
        type: 'object',
        properties: {
          type: { type: 'string', description: 'Event type (e.g. section.written, review.complete)' },
          data: { type: 'string', description: 'JSON object with event payload data (optional)' },
        },
        required: ['type'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'set_state',
      description: 'Set a shared state key visible to all agents in this hive',
      parameters: {
        type: 'object',
        properties: {
          key: { type: 'string', description: 'State key name' },
          value: { type: 'string', description: 'Value to set (string or JSON)' },
        },
        required: ['key', 'value'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_state',
      description: 'Get shared state for this hive. Use key="all" to get everything, a specific key name for one value, or a glob pattern (e.g. "research.*") to get matching keys.',
      parameters: {
        type: 'object',
        properties: {
          key: { type: 'string', description: 'State key name, "all" for everything, or glob pattern (e.g. "plan.*")' },
        },
        required: ['key'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'claim_resource',
      description: 'Claim exclusive ownership of a resource (e.g. a topic, file, or task). Returns rejected if another agent already holds the claim.',
      parameters: {
        type: 'object',
        properties: {
          resource: { type: 'string', description: 'Resource identifier to claim (e.g. "topic:quantum-computing")' },
          reason: { type: 'string', description: 'Why you need this resource' },
        },
        required: ['resource'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'release_resource',
      description: 'Release a previously claimed resource so other agents can use it',
      parameters: {
        type: 'object',
        properties: {
          resource: { type: 'string', description: 'Resource identifier to release' },
        },
        required: ['resource'],
      },
    },
  },
];

// ─── Start trigger helpers ──────────────────────────────────────────

export function describeStartOn(config: StartOnConfig): string {
  const events = config.conditions
    .map(c => c.count > 1 ? `${c.count}x ${c.event}` : c.event)
    .join(' + ');
  return config.timeout > 0
    ? `${events} (timeout: ${config.timeout}s)`
    : `${events} (no timeout)`;
}

export async function waitForEvents(
  config: AgentConfig,
  log: (msg: string) => void,
): Promise<void> {
  const { startOn } = config;
  if (!startOn) return;

  const client = createAcpClient({
    server: config.serverUrl,
    agentId: config.agentId,
    namespace: config.namespace,
  });

  const deadline = startOn.timeout > 0 ? Date.now() + startOn.timeout * 1000 : 0;
  const POLL_INTERVAL = 2000;

  while (deadline === 0 || Date.now() < deadline) {
    let allMet = true;

    for (const cond of startOn.conditions) {
      const res = await client.getEvents(0, { type: cond.event });
      if (!res.ok) { allMet = false; break; }

      // Incubator returns { events: [...], cursor: N }
      const body = res.data as unknown as { events?: unknown[]; cursor?: number };
      const events = Array.isArray(body) ? body : body?.events;
      if (!events || events.length < cond.count) {
        allMet = false;
        break;
      }
    }

    if (allMet) return;
    await new Promise(r => setTimeout(r, POLL_INTERVAL));
  }

  log(`Timeout (${startOn.timeout}s) — starting anyway`);
}

// ─── Default context window sizes by provider ──────────────────────

const DEFAULT_CONTEXT_WINDOWS: Record<string, number> = {
  cerebras: 128_000,
  groq: 128_000,
  ollama: 128_000,
  openai: 128_000,
  anthropic: 200_000,
};

const DEFAULT_COMPACT_THRESHOLD = 0.8;
const DEFAULT_KEEP_LAST_N = 6;
const DEFAULT_MAX_RETRIES = 3;

// ─── AgentRunner (renamed from DroneRunner) ─────────────────────────

export class AgentRunner {
  private stopFlag = false;

  stop(): void {
    this.stopFlag = true;
  }

  async run(
    config: AgentConfig,
    toolClient: ToolClient,
    incubatorClient: ToolClient | null,
    runtime: AcpRuntime | DirectRuntime | null,
    protocolOverride?: ProtocolResponse | null,
    telemetry?: TelemetryReporter,
  ): Promise<AgentResult> {
    const color = COLORS[colorIndex++ % COLORS.length];
    const { agentId, role, provider, maxIterations } = config;
    let iterations = 0;
    let wakeCount = 0;
    const startTime = Date.now();
    const totalUsage: TokenUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
    const iterationUsage: TokenUsage[] = [];

    // Nectar audit: generate run-level ID and check capture flag
    const runId = randomUUID();
    let traceId = randomUUID();
    const captureAudit = process.env.NECTAR_CAPTURE === 'true' || process.env.NECTAR_CAPTURE === '1';

    const log = (msg: string) => {
      if (config.verbose) {
        const ts = new Date().toISOString().slice(11, 23);
        console.error(`${color}  ${ts} [${agentId}] ${msg}${RESET}`);
      }
    };

    let exitReason: string = 'unknown';
    let lastCallSignature = '';
    let repeatCount = 0;

    try {
      // 0a. Connect ACP runtime (invisible coordination)
      if (runtime) {
        await runtime.connect();
        log('ACP runtime connected');
      }

      // 0b. Wait for start trigger if configured
      if (config.startOn) {
        log(`Waiting for trigger: ${describeStartOn(config.startOn)}`);
        await waitForEvents(config, log);
        log('Trigger conditions met — starting agent');
      }

      // 1. Build tool definitions (with optional filtering)
      let toolDefs = [...toolClient.getToolDefs()];

      // Filter tools if whitelist provided (only for MCP clients — NativeToolClient pre-filters)
      if (config.toolFilter && config.mode === 'drone') {
        const filterSet = new Set(config.toolFilter);
        toolDefs = toolDefs.filter(t => filterSet.has(t.function.name));
      }

      // In --no-acp mode, also include incubator tools (with coordination filtering)
      if (incubatorClient) {
        let incTools = incubatorClient.getToolDefs();
        const coord = config.coordination ?? 'full';

        if (coord === 'lite') {
          incTools = incTools.filter(t => LITE_TOOLS.has(t.function.name));
        } else if (coord === 'none') {
          incTools = [];
        } else if (Array.isArray(coord)) {
          const coordSet = new Set(coord);
          incTools = incTools.filter(t => coordSet.has(t.function.name));
        }
        // 'full' = no filtering

        toolDefs.push(...incTools);
        log(`Tools: ${toolDefs.length} (env: ${toolDefs.length - incTools.length}, incubator: ${incTools.length})`);
      } else if (runtime && !config.noAcpInject) {
        // Invisible ACP mode: add synthetic coordination tools
        toolDefs.push(...SYNTHETIC_TOOLS);
        log(`Tools: ${toolDefs.length} (env: ${toolDefs.length - SYNTHETIC_TOOLS.length}, acp: ${SYNTHETIC_TOOLS.length})`);
      } else {
        log(`Tools: ${toolDefs.length} (env only)`);
      }

      // 2. Fetch protocol and generate system prompt
      let protocolData = protocolOverride ?? null;
      if (!protocolData && runtime) {
        protocolData = await runtime.fetchProtocol();
      }

      // Check for dance tools from server
      let danceToolNames: Set<string> | null = null;
      if (runtime) {
        const danceTools = runtime.getDanceTools();
        if (danceTools && danceTools.length > 0) {
          danceToolNames = new Set(danceTools.map(t => t.function.name));
          if (config.toolFilter) {
            // Explicit tools in brood.yaml → merge dance tools alongside env/ACP tools
            const existingNames = new Set(toolDefs.map(t => t.function.name));
            for (const dt of danceTools) {
              if (!existingNames.has(dt.function.name)) {
                toolDefs.push(dt);
              }
            }
            log(`Dance tools: ${[...danceToolNames].join(', ')} (merged with ${existingNames.size} env/acp tools)`);
          } else {
            // No explicit tools → dance tools replace everything (game mode)
            toolDefs = [...danceTools];
            log(`Dance tools: ${[...danceToolNames].join(', ')} (exclusive — replaced all env/acp tools)`);
          }
        }
      }

      // Derive wakeOn from spec wait field if not explicitly configured
      let effectiveWakeOn = config.wakeOn ?? null;
      if (protocolData && !effectiveWakeOn && protocolData.wait) {
        effectiveWakeOn = {
          types: protocolData.wait.types ?? null,
          timeout: protocolData.wait.max_timeout ?? 0,
          maxWakes: 50,
        };
        log(`Derived wakeOn from spec: types=${protocolData.wait.types?.join(',') ?? 'any'}`);
      }

      // Derive context retention from spec (0 = stateless, N = keep last N exchanges, undefined = full history)
      const contextRetention = protocolData?.context;
      if (contextRetention !== undefined) {
        log(`Context retention: ${contextRetention === 0 ? 'stateless' : `last ${contextRetention} exchanges`}`);
      }

      // Spec temperature overrides config
      const effectiveTemperature = protocolData?.temperature ?? config.temperature;
      const disableReasoning = protocolData?.reasoning === false;
      const reasoningEffort = protocolData?.reasoning_effort;

      const systemPrompt = protocolData
        ? generateSystemPrompt(agentId, role, toolDefs, protocolData, { disableReasoning })
        : generateSystemPrompt(agentId, role, toolDefs, null, { peerCount: config.peerCount });

      // 3. Build initial messages
      const messages: ChatMessage[] = [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: config.prompt ?? 'Begin your work. Explore the codebase, understand the task, and implement the required changes.' },
      ];

      log(`Starting (role=${role}, model=${provider.model}, mode=${config.mode})`);

      // SIGTERM handler for kill signal
      const onKill = () => {
        log('SIGTERM received — killing agent');
        this.stopFlag = true;
      };
      process.on('SIGTERM', onKill);

      // Context compaction config
      const contextWindow = config.contextWindow ?? DEFAULT_CONTEXT_WINDOWS[provider.type] ?? 128_000;
      const compactThreshold = Math.floor(contextWindow * DEFAULT_COMPACT_THRESHOLD);
      const maxRetries = config.maxRetries ?? DEFAULT_MAX_RETRIES;

      // 4. Initial sleep — wait for first wake event before running
      if (effectiveWakeOn && runtime) {
        log(`Sleeping — waiting for initial wake event`);
        const wakeEvents = await runtime.waitForWake(effectiveWakeOn);
        if (wakeEvents.length === 0) {
          log('Initial wake timeout — no events, exiting');
          if (runtime) await runtime.onComplete('Wake timeout', totalUsage);
          process.removeListener('SIGTERM', onKill);
          return { iterations: 0, usage: totalUsage, agentId, role, status: 'completed' as const };
        }
        log(`Woke up with ${wakeEvents.length} event(s)`);
        const inject = runtime.getLastInject();
        if (inject) {
          messages.push({ role: 'user', content: `[SYSTEM] ${inject}` });
          log('Injected dance state context');
        }
        for (const evt of wakeEvents) {
          messages.push({ role: 'user', content: `[SYSTEM] ${evt}` });
        }
      }

      // 5. ReAct loop
      while (iterations < maxIterations && !this.stopFlag) {
        iterations++;
        traceId = randomUUID();
        log(`Iteration ${iterations}/${maxIterations}`);

        // Cost controls: maxTotalTokens
        if (config.maxTotalTokens && config.maxTotalTokens > 0 && totalUsage.totalTokens >= config.maxTotalTokens) {
          log(`Token budget exhausted (${totalUsage.totalTokens.toLocaleString()}/${config.maxTotalTokens.toLocaleString()})`);
          break;
        }

        // Cost controls: maxRuntime
        if (config.maxRuntime && config.maxRuntime > 0 && (Date.now() - startTime) >= config.maxRuntime) {
          log(`Runtime limit reached (${config.maxRuntime}ms)`);
          break;
        }

        // Inject coordination context (invisible ACP events + dance state)
        if (runtime) {
          const contextMessages = await runtime.beforeIteration();
          const inject = runtime.getLastInject();

          // Context retention: trim history based on spec setting
          if (contextRetention !== undefined && inject) {
            if (contextRetention === 0) {
              messages.length = 1; // stateless — keep system prompt only
            } else if (messages.length > 1 + contextRetention * 2) {
              // Keep system prompt + last N exchanges (assistant + tool pairs)
              const kept = messages.slice(-(contextRetention * 2));
              messages.length = 1;
              messages.push(...kept);
            }
          }

          for (const msg of contextMessages) {
            messages.push({ role: 'user', content: `[SYSTEM] ${msg}` });
          }
          if (inject) {
            messages.push({ role: 'user', content: `[SYSTEM] ${inject}` });
          }
        }

        // Call LLM with retry logic
        // Set traceId/runId on logging client if it supports it (duck-typed)
        if (toolClient && 'traceId' in toolClient) {
          const loggingClient = toolClient as unknown as { traceId: string; runId: string };
          loggingClient.traceId = traceId;
          loggingClient.runId = runId;
        }

        // Nectar: capture full prompt before LLM call
        if (captureAudit && telemetry) {
          telemetry.record('llm_prompt', {
            runId, traceId, agentId, role,
            provider: provider.type, model: provider.model,
            iteration: iterations, messageCount: messages.length,
            _payload: JSON.stringify(messages),
          });
        }

        let response: ChatMessage;
        let usage: TokenUsage;
        let retryCount = 0;
        while (true) {
          const llmStart = Date.now();
          try {
            const result = await chatCompletion(provider, messages, toolDefs, effectiveTemperature, {
              ...(disableReasoning ? { disableReasoning: true } : {}),
              ...(reasoningEffort ? { reasoningEffort } : {}),
            });
            response = result.message;
            usage = result.usage;
            telemetry?.record('llm_call', {
              runId, traceId, agentId, role, provider: provider.type, model: provider.model,
              promptTokens: usage.promptTokens, completionTokens: usage.completionTokens,
              latency_ms: Date.now() - llmStart,
            });
            break;
          } catch (err) {
            retryCount++;
            telemetry?.record('llm_error', {
              runId, traceId, agentId, role, provider: provider.type, model: provider.model,
              error: (err as Error).message, retryCount,
              latency_ms: Date.now() - llmStart,
            });
            if (retryCount > maxRetries) throw err;
            const delay = 1000 * Math.pow(2, retryCount - 1);
            log(`LLM call failed (attempt ${retryCount}/${maxRetries}): ${(err as Error).message} — retrying in ${delay}ms`);
            await new Promise(r => setTimeout(r, delay));
          }
        }

        // Nectar: capture full response after LLM call
        if (captureAudit && telemetry) {
          telemetry.record('llm_response', {
            runId, traceId, agentId, role,
            provider: provider.type, model: provider.model,
            promptTokens: usage.promptTokens, completionTokens: usage.completionTokens,
            hasToolCalls: !!(response.tool_calls?.length),
            _payload: JSON.stringify({ content: response.content, tool_calls: response.tool_calls }),
          });
        }
        messages.push(response);

        // Track token usage
        totalUsage.promptTokens += usage.promptTokens;
        totalUsage.completionTokens += usage.completionTokens;
        totalUsage.totalTokens += usage.totalTokens;
        iterationUsage.push(usage);

        if (usage.totalTokens > 0) {
          log(`Tokens: +${usage.promptTokens}/${usage.completionTokens} (total: ${totalUsage.totalTokens.toLocaleString()})`);
        }

        // Context compaction: when prompt tokens exceed threshold, trim messages
        if (usage.promptTokens > compactThreshold && messages.length > DEFAULT_KEEP_LAST_N + 2) {
          log(`Context compaction triggered (${usage.promptTokens.toLocaleString()} > ${compactThreshold.toLocaleString()} threshold)`);
          // Keep system prompt (index 0) + last N messages
          const kept = messages.slice(-DEFAULT_KEEP_LAST_N);
          messages.length = 1; // keep system prompt
          messages.push(...kept);
          // Reload state if runtime available
          if (runtime) {
            const freshProtocol = await runtime.fetchProtocol();
            if (freshProtocol) {
              messages[0] = { role: 'system', content: generateSystemPrompt(agentId, role, toolDefs, freshProtocol) };
            }
            const stateStr = await runtime.getState();
            messages.push({ role: 'user', content: `[SYSTEM] Context was compacted. Current state: ${stateStr}` });
          } else {
            messages.push({ role: 'user', content: '[SYSTEM] Context was compacted. Previous messages were trimmed.' });
          }
          telemetry?.record('context_compaction', {
            runId, traceId, agentId, role, iteration: iterations,
            promptTokensBefore: usage.promptTokens, messagesAfter: messages.length,
          });
          log(`Compacted to ${messages.length} messages`);
        }

        // Log assistant response (full text so we can see LLM reasoning)
        if (response.content) {
          log(`${DIM}${response.content}${RESET}${color}`);
        }

        // Check for "DONE" in content — always exits, even in reactive mode
        if (response.content && /\bDONE\b/.test(response.content)) {
          log('Agent said DONE — finishing');
          exitReason = 'done';
          break;
        }

        // No tool calls → sleep/wake or exit
        if (!response.tool_calls || response.tool_calls.length === 0) {
          if (effectiveWakeOn && runtime) {
            const maxWakes = effectiveWakeOn.maxWakes ?? 0;
            if (maxWakes > 0 && ++wakeCount >= maxWakes) {
              log(`Max wakes reached (${maxWakes}) — exiting`);
              exitReason = 'max_wakes';
              break;
            }
            if (maxWakes === 0) wakeCount++;
            log(`Sleeping — waiting for wake events (cycle ${wakeCount})`);
            const wakeEvents = await runtime.waitForWake(effectiveWakeOn);
            if (wakeEvents.length === 0) {
              log('Wake timeout — no events, exiting');
              exitReason = 'wake_timeout';
              break;
            }
            log(`Woke up with ${wakeEvents.length} event(s)`);

            // Inject dance state context if available
            const inject = runtime.getLastInject();
            if (inject) {
              messages.push({ role: 'user', content: `[SYSTEM] ${inject}` });
              log('Injected dance state context');
            }

            for (const evt of wakeEvents) {
              messages.push({ role: 'user', content: `[SYSTEM] ${evt}` });
            }
            continue;
          }
          log('No tool calls — agent finished');
          exitReason = 'no_tool_calls';
          break;
        }

        // Execute each tool call
        let halted = false;
        for (const toolCall of response.tool_calls) {
          const name = toolCall.function.name;
          const args = getToolCallArgs(toolCall);
          const argsStr = Object.keys(args).length > 0
            ? `(${Object.entries(args).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(', ')})`
            : '()';
          log(`Tool: ${name}${argsStr}`);

          // Intercept file writes for auto-claims
          if (runtime && FILE_WRITE_TOOLS.has(name) && args.path) {
            const claimResult = await runtime.onFileWrite(args.path as string);
            if (claimResult) {
              // Claim conflict — return error to LLM
              messages.push({
                role: 'tool',
                content: claimResult,
                tool_call_id: toolCall.id ?? `call_${iterations}`,
              });
              log(`${DIM}→ claim conflict: ${claimResult}${RESET}${color}`);
              continue;
            }
          }

          // Route tool call to the right handler
          let result: string;
          if (danceToolNames && danceToolNames.has(name) && runtime) {
            // Dance tool — route via WS to server
            try {
              const danceResult = await runtime.callDanceTool(name, args);
              result = JSON.stringify(danceResult);
            } catch (err) {
              result = JSON.stringify({ error: `Dance tool failed: ${(err as Error).message}` });
            }
          } else if (runtime && SYNTHETIC_TOOL_NAMES.has(name)) {
            // Synthetic ACP tools — route through runtime
            if (name === 'publish_event') {
              let eventData: Record<string, unknown> = {};
              if (args.data) {
                try { eventData = typeof args.data === 'string' ? JSON.parse(args.data as string) : args.data as Record<string, unknown>; } catch { /* keep empty */ }
              }
              result = await runtime.publishEvent(args.type as string, eventData);
            } else if (name === 'set_state') {
              result = await runtime.setState(args.key as string, args.value);
            } else if (name === 'get_state') {
              result = await runtime.getState(args.key as string | undefined);
            } else if (name === 'claim_resource') {
              result = await runtime.claimResource(args.resource as string, args.reason as string | undefined);
            } else if (name === 'release_resource') {
              result = await runtime.releaseResource(args.resource as string);
            } else {
              result = JSON.stringify({ error: `Unknown synthetic tool: ${name}` });
            }
          } else if (incubatorClient && incubatorClient.hasToolName(name)) {
            result = await incubatorClient.callTool(name, args);
          } else {
            try {
              result = await toolClient.callTool(name, args);
            } catch (err) {
              result = JSON.stringify({ error: `Tool call failed: ${(err as Error).message}` });
            }
          }

          telemetry?.record('tool_call', { runId, traceId, agentId, role, tool: name });

          // Log result
          log(`${DIM}→ ${result}${RESET}${color}`);

          messages.push({
            role: 'tool',
            content: result,
            tool_call_id: toolCall.id ?? `call_${iterations}`,
          });

          // Check halt/pause status (via ACP runtime)
          if (runtime) {
            const controlStatus = await runtime.checkControl();
            if (controlStatus.halted) {
              log(`HALTED: ${controlStatus.reason ?? 'no reason'}`);
              halted = true;
              break;
            }
            if (controlStatus.paused) {
              log(`PAUSED: ${controlStatus.reason ?? 'no reason'} — waiting...`);
              const resumeReason = await runtime.waitForResume();
              log(`RESUMED: ${resumeReason}`);
              messages.push({
                role: 'user',
                content: `[SYSTEM] You were paused (reason: ${controlStatus.reason ?? 'unknown'}). You have been resumed (reason: ${resumeReason}). Continue your work.`,
              });
            }
          }
        }

        if (halted) {
          log('Agent halted — exiting loop');
          exitReason = 'halted';
          if (runtime) await runtime.onComplete('Agent halted', totalUsage);
          telemetry?.record('agent_complete', {
            runId, traceId, agentId, role, status: 'completed', iterations, exitReason,
            provider: provider.type, model: provider.model,
            totalTokens: totalUsage.totalTokens, duration_ms: Date.now() - startTime, wakeCount,
          });
          return { agentId, role, status: 'completed', iterations, usage: totalUsage, iterationUsage };
        }

        // Loop detection: if agent repeats same tool+args 3+ times, break out
        if (response.tool_calls && response.tool_calls.length > 0) {
          const callSig = response.tool_calls.map(tc => {
            const a = getToolCallArgs(tc);
            return `${tc.function.name}:${JSON.stringify(a)}`;
          }).join('|');
          if (callSig === lastCallSignature) {
            repeatCount++;
          } else {
            lastCallSignature = callSig;
            repeatCount = 1;
          }
          if (repeatCount >= 3) {
            log(`Loop detected: same tool call repeated ${repeatCount} times — stopping agent`);
            exitReason = 'loop_detected';
            break;
          }
        }

        // Periodic prompt refresh (every 10 iterations)
        if (iterations % 10 === 0 && runtime) {
          const refreshed = await runtime.fetchProtocol();
          if (refreshed) {
            const newPrompt = generateSystemPrompt(agentId, role, toolDefs, refreshed);
            messages[0] = { role: 'system', content: newPrompt };
            log('Refreshed system prompt');
          }
        }
      }

      if (this.stopFlag) {
        exitReason = 'stopped';
        log('Stopped by runner');
      } else if (iterations >= maxIterations) {
        exitReason = 'max_iterations';
        log(`Hit max iterations (${maxIterations})`);
      }

      // Cleanup SIGTERM handler
      process.off('SIGTERM', onKill);

      // Complete
      const summary = `Agent ${agentId} completed after ${iterations} iterations (${totalUsage.totalTokens.toLocaleString()} tokens)`;
      if (runtime) await runtime.onComplete(summary, totalUsage);
      telemetry?.record('agent_complete', {
        runId, traceId, agentId, role, status: 'completed', iterations, exitReason,
        provider: provider.type, model: provider.model,
        promptTokens: totalUsage.promptTokens, completionTokens: totalUsage.completionTokens,
        totalTokens: totalUsage.totalTokens, duration_ms: Date.now() - startTime, wakeCount,
      });
      log(`Done (${iterations} iterations, ${totalUsage.totalTokens.toLocaleString()} tokens)`);
      return { agentId, role, status: 'completed', iterations, usage: totalUsage, iterationUsage };
    } catch (err) {
      // Cleanup SIGTERM handler on error path too
      try { process.off('SIGTERM', () => {}); } catch { /* ignore */ }

      const errMsg = (err as Error).message;
      if (config.verbose) {
        console.error(`${color}  [${agentId}] ERROR: ${errMsg}${RESET}`);
      }
      if (runtime) {
        try { await runtime.onComplete(`Error: ${errMsg}`, totalUsage); } catch { /* ignore */ }
      }
      telemetry?.record('agent_complete', {
        runId, traceId, agentId, role, status: 'error', iterations, exitReason: 'error', error: errMsg,
        provider: provider.type, model: provider.model,
        totalTokens: totalUsage.totalTokens, duration_ms: Date.now() - startTime,
      });
      return { agentId, role, status: 'error', iterations, error: errMsg, usage: totalUsage, iterationUsage };
    }
  }
}

/** Backwards-compatible alias */
export { AgentRunner as DroneRunner };
