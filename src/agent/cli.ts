#!/usr/bin/env node

import { resolveProvider, checkConnection, checkModel } from './providers.js';
import { AgentRunner } from './runner.js';
import { AcpRuntime, type ProtocolResponse } from './acp/runtime.js';
import { NativeToolClient } from './native-client.js';
import { connectPropolis, connectIncubatorMcp } from './mcp-client.js';
import { loadGuard } from '../propolis/guard.js';
import type { ToolClient } from './tool-client.js';
import type { AgentConfig, ProviderConfig, AgentResult, StartOnConfig, AgentMode, WakeOnConfig } from './types.js';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

function parseArgs(argv: string[]): Record<string, string | boolean> {
  const args: Record<string, string | boolean> = {};
  for (const arg of argv.slice(2)) {
    if (arg.startsWith('--')) {
      const [key, ...rest] = arg.slice(2).split('=');
      args[key] = rest.length > 0 ? rest.join('=') : true;
    }
  }
  return args;
}

async function preflight(provider: ProviderConfig, verbose: boolean): Promise<void> {
  if (verbose) console.error(`[hive] Checking ${provider.type} connection (${provider.baseUrl})...`);

  const MAX_RETRIES = 3;
  const RETRY_DELAY = 3000;
  let connected = false;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    connected = await checkConnection(provider);
    if (connected) break;
    if (attempt < MAX_RETRIES) {
      if (verbose) console.error(`[hive] Connection attempt ${attempt}/${MAX_RETRIES} failed, retrying in ${RETRY_DELAY / 1000}s...`);
      await new Promise(r => setTimeout(r, RETRY_DELAY));
    }
  }

  if (!connected) {
    const hints: Record<string, string> = {
      ollama: 'Is Ollama running? Try: ollama serve',
      openai: 'Is OPENAI_API_KEY set?',
      anthropic: 'Is ANTHROPIC_API_KEY set?',
    };
    throw new Error(
      `Cannot connect to ${provider.type} at ${provider.baseUrl}. ${hints[provider.type] ?? ''}`
    );
  }

  if (verbose) console.error(`[hive] Connected to ${provider.type}`);

  const modelExists = await checkModel(provider);
  if (!modelExists && provider.type === 'ollama') {
    throw new Error(
      `Model "${provider.model}" not found in Ollama. Try: ollama pull ${provider.model}`
    );
  }

  if (verbose) console.error(`[hive] Model ${provider.model} ready`);
}

/**
 * Load protocol from a file and transform to ProtocolResponse format.
 */
function loadProtocolFromFile(filePath: string, role: string): ProtocolResponse | null {
  try {
    const raw = JSON.parse(readFileSync(filePath, 'utf-8'));
    if (!raw.roles?.[role]) return null;
    const roleDef = raw.roles[role];
    const phases: Record<string, { description: string; terminal?: boolean }> = {};
    for (const [name, def] of Object.entries(raw.phases ?? {})) {
      const p = def as { description: string; terminal?: boolean };
      phases[name] = { description: p.description, ...(p.terminal ? { terminal: true } : {}) };
    }
    const phaseNames = Object.keys(phases);
    const roleRules = raw.rules?.[role];
    const rules: Record<string, { loop?: boolean; steps: Array<{ action: string; description?: string; hint?: string; params?: Record<string, unknown> }> }> = {};
    if (roleRules) {
      for (const [phase, rule] of Object.entries(roleRules)) {
        rules[phase] = rule as typeof rules[string];
      }
    }
    return {
      protocol: { name: raw.name, title: raw.title },
      role: { name: role, description: roleDef.description },
      current_phase: phaseNames[0] ?? 'default',
      instructions: `Follow the ${raw.title} protocol as the ${role} role.`,
      phases,
      ...(Object.keys(rules).length > 0 ? { rules } : {}),
      ...(raw.resources ? { resources: raw.resources } : {}),
    };
  } catch {
    return null;
  }
}

function writeReport(result: AgentResult, config: AgentConfig): void {
  try {
    const reportDir = join(process.cwd(), '.honeybee', 'reports');
    mkdirSync(reportDir, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `${result.agentId}_${ts}.json`;
    const report = {
      agentId: result.agentId,
      role: result.role,
      status: result.status,
      mode: config.mode,
      provider: `${config.provider.type}/${config.provider.model}`,
      iterations: result.iterations,
      usage: result.usage,
      iterationUsage: result.iterationUsage,
      error: result.error,
      timestamp: new Date().toISOString(),
    };
    writeFileSync(join(reportDir, filename), JSON.stringify(report, null, 2) + '\n');
    console.error(`[hive] Report written: .honeybee/reports/${filename}`);
  } catch {
    // Non-fatal
  }
}

async function main() {
  const args = parseArgs(process.argv);

  // Mode determination
  const explicitMode = typeof args['mode'] === 'string' ? args['mode'] as AgentMode : null;
  const hasPropolis = typeof args['propolis'] === 'string';
  const noPropolis = args['no-propolis'] === true;

  // Derive mode: --no-propolis or --mode=drone → drone, else worker
  const mode: AgentMode = explicitMode ?? (noPropolis || hasPropolis ? 'drone' : 'worker');

  // Required args
  const providerShorthand = typeof args['provider'] === 'string' ? args['provider'] : 'ollama/qwen3:8b';

  // Working directory (worker mode)
  const workDir = resolve(typeof args['work-dir'] === 'string' ? args['work-dir'] : process.cwd());

  // Propolis target (drone mode)
  const propolisTarget = typeof args['propolis'] === 'string' ? args['propolis'] : 'stdio:--work-dir=.';

  // ACP args
  const serverUrl = typeof args['server'] === 'string' ? args['server'] : 'http://localhost:3100';
  const namespace = typeof args['namespace'] === 'string' ? args['namespace'] : 'default';
  const agentId = typeof args['agent-id'] === 'string' ? args['agent-id'] : `agent_${Date.now().toString(36)}`;
  const role = typeof args['role'] === 'string' ? args['role'] : 'developer';
  const maxIterations = typeof args['max-iterations'] === 'string' ? parseInt(args['max-iterations'], 10) : 50;
  const verbose = args['verbose'] === true;
  const noGuard = args['no-guard'] === true;

  // ACP flags (revised semantics)
  const noAcp = args['no-acp'] === true;           // Completely disable ACP
  const noAcpInject = args['no-acp-inject'] === true; // ACP connected but injection off

  const toolFilter = typeof args['tools'] === 'string' ? args['tools'].split(',') : null;
  const coordinationArg = typeof args['coordination'] === 'string' ? args['coordination'] : 'full';
  const coordination: string | string[] =
    ['lite', 'full', 'none'].includes(coordinationArg) ? coordinationArg : coordinationArg.split(',');

  // Parse --start-on JSON
  const startOnRaw = typeof args['start-on'] === 'string' ? args['start-on'] : null;
  const startOn: StartOnConfig | null = startOnRaw ? JSON.parse(startOnRaw) as StartOnConfig : null;

  // Parse --wake-on JSON
  const wakeOnRaw = typeof args['wake-on'] === 'string' ? args['wake-on'] : null;
  const wakeOn: WakeOnConfig | null = wakeOnRaw ? JSON.parse(wakeOnRaw) as WakeOnConfig : null;

  // Custom prompt (env var preferred for multi-line, CLI fallback)
  const prompt = process.env.AGENT_PROMPT
    || (typeof args['prompt'] === 'string' ? args['prompt'] : undefined)
    || undefined;

  // Resolve provider
  const provider = resolveProvider(providerShorthand);

  // Preflight check
  await preflight(provider, verbose);

  const config: AgentConfig = {
    agentId,
    role,
    provider,
    serverUrl,
    namespace,
    maxIterations,
    verbose,
    mode,
    workDir,
    propolisTarget,
    noAcp,
    noAcpInject,
    toolFilter,
    coordination,
    startOn,
    wakeOn,
    prompt,
  };

  console.error(`[hive] Agent ID:   ${agentId}`);
  console.error(`[hive] Role:       ${role}`);
  console.error(`[hive] Provider:   ${provider.type}/${provider.model}`);
  console.error(`[hive] Mode:       ${mode}`);
  if (mode === 'worker') {
    console.error(`[hive] Work dir:   ${workDir}`);
  } else {
    console.error(`[hive] Propolis:   ${propolisTarget}`);
  }
  if (noAcp) {
    console.error(`[hive] ACP:        disabled`);
  } else if (noAcpInject) {
    console.error(`[hive] ACP:        connected (injection off — synthetic tools exposed)`);
  } else {
    console.error(`[hive] ACP:        invisible injection ON`);
    console.error(`[hive] Incubator:  ${serverUrl} (ns: ${namespace})`);
  }
  if (toolFilter) {
    console.error(`[hive] Tool filter: ${toolFilter.join(', ')}`);
  }
  if (startOn) {
    const desc = startOn.conditions
      .map(c => c.count > 1 ? `${c.count}x ${c.event}` : c.event)
      .join(' + ');
    const timeoutDesc = startOn.timeout > 0 ? `timeout: ${startOn.timeout}s` : 'no timeout';
    console.error(`[hive] Start on:   ${desc} (${timeoutDesc})`);
  }
  if (wakeOn) {
    const types = wakeOn.types ? wakeOn.types.join(', ') : 'any';
    const parts: string[] = [`types: ${types}`];
    if (wakeOn.timeout) parts.push(`timeout: ${wakeOn.timeout}ms`);
    if (wakeOn.maxWakes) parts.push(`max: ${wakeOn.maxWakes}`);
    console.error(`[hive] Wake on:    ${parts.join(', ')}`);
  }

  // Create tool client based on mode
  let toolClient: ToolClient;
  if (mode === 'worker') {
    const guard = noGuard ? null : loadGuard(verbose);
    // Load propolis directly (child process context — no PluginManager)
    let entries: import('@honeybee-ai/hivemind-sdk/integrations').ToolEntry[];
    try {
      const propolis = await import('@honeybee-ai/propolis');
      entries = propolis.TOOL_DEFS(workDir, guard, verbose) as import('@honeybee-ai/hivemind-sdk/integrations').ToolEntry[];
    } catch {
      console.error('[hive] ERROR: Worker mode requires @honeybee-ai/propolis');
      process.exit(1);
    }
    toolClient = new NativeToolClient(entries, toolFilter);
    const toolCount = toolClient.getToolDefs().length;
    console.error(`[hive] Tools:      ${toolCount} (in-process)`);
  } else {
    console.error('[hive] Connecting to Propolis...');
    toolClient = await connectPropolis(propolisTarget);
    const toolCount = toolClient.getToolDefs().length;
    console.error(`[hive] Propolis connected — ${toolCount} tools`);
  }

  // Set up ACP
  let incubatorClient: ToolClient | null = null;
  let runtime: AcpRuntime | null = null;

  if (noAcp) {
    // Completely disabled — optionally connect to incubator for benchmarking
    if (typeof args['server'] === 'string') {
      console.error('[hive] Connecting to Incubator via MCP (--no-acp)...');
      try {
        incubatorClient = await connectIncubatorMcp(serverUrl, namespace);
        const incTools = incubatorClient.getToolDefs();
        console.error(`[hive] Incubator connected — ${incTools.length} tools`);
      } catch (err) {
        console.error(`[hive] Warning: Could not connect to Incubator MCP: ${(err as Error).message}`);
      }
    }
  } else {
    // ACP enabled (default or --no-acp-inject)
    runtime = new AcpRuntime({
      serverUrl,
      namespace,
      agentId,
      role,
      maxIterations,
      verbose,
      useWebSocket: !!wakeOn,
    });
  }

  // Load protocol override for --no-acp mode
  let protocolOverride: ProtocolResponse | null = null;
  if (noAcp && typeof args['protocol'] === 'string') {
    protocolOverride = loadProtocolFromFile(args['protocol'] as string, role);
    if (protocolOverride) {
      console.error(`[hive] Protocol loaded from file: ${protocolOverride.protocol.title}`);
    }
  }

  // Run the agent
  const runner = new AgentRunner();
  console.error('[hive] Starting ReAct loop...');

  const result = await runner.run(config, toolClient, incubatorClient, runtime, protocolOverride);

  // Log result
  const status = result.status === 'completed' ? '✓' : '✗';
  const detail = result.error ? ` (${result.error})` : '';
  console.error(`\n[hive] ${status} ${result.agentId} (${result.role}): ${result.iterations} iterations${detail}`);

  // Token usage summary
  if (result.usage && result.usage.totalTokens > 0) {
    const u = result.usage;
    console.error(`[hive] Token usage:`);
    console.error(`[hive]   Prompt:     ${u.promptTokens.toLocaleString()}`);
    console.error(`[hive]   Completion: ${u.completionTokens.toLocaleString()}`);
    console.error(`[hive]   Total:      ${u.totalTokens.toLocaleString()}`);
    console.error(`[hive]   Avg/iter:   ${Math.round(u.totalTokens / result.iterations).toLocaleString()}`);
  }

  // Write JSON report
  writeReport(result, config);

  // Cleanup
  await toolClient.close();
  if (incubatorClient) await incubatorClient.close();
  if (runtime) await runtime.disconnect();

  process.exit(result.status === 'completed' ? 0 : 1);
}

// Graceful shutdown
process.on('SIGINT', () => {
  console.error('\n[hive] Interrupted');
  process.exit(130);
});

main().catch((err) => {
  console.error('[hive] Fatal error:', err);
  process.exit(1);
});
