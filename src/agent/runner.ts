import { randomBytes } from 'node:crypto';
import { loadSpecFile } from '@agentcoordinationprotocol/spec';
import { createAcpClient } from '@agentcoordinationprotocol/sdk';
import type { AcpClient } from '@agentcoordinationprotocol/sdk';
import type { AgentConfig, AgentStatus, ProviderConfig, RunnerConfig } from './types.js';
import { chatCompletion, checkConnection, checkModel } from './providers.js';
import { TOOL_DEFS, executeToolCall } from './tools.js';
import { generateSystemPrompt, fetchProtocol } from './prompt.js';
import type { ChatMessage, ToolCall } from './types.js';

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

// ─── Role count parsing ─────────────────────────────────────────────

export function parseRoleCount(count: string | number | undefined): number {
  if (count === undefined) return 1;
  if (typeof count === 'number') return Math.max(1, count);

  const str = String(count).trim();

  // "3+" → use minimum
  if (str.endsWith('+')) {
    return Math.max(1, parseInt(str.slice(0, -1), 10));
  }

  // "0-1", "2-5" → use max
  const rangeMatch = str.match(/^(\d+)-(\d+)$/);
  if (rangeMatch) {
    const max = parseInt(rangeMatch[2], 10);
    return Math.max(1, max);
  }

  // Plain number
  const n = parseInt(str, 10);
  return isNaN(n) ? 1 : Math.max(1, n);
}

// ─── Agent runner ───────────────────────────────────────────────────

interface AgentResult {
  agentId: string;
  role: string;
  status: AgentStatus;
  iterations: number;
  error?: string;
}

export class AgentRunner {
  private config: RunnerConfig;
  private stopFlag = false;
  private colorIndex = 0;

  constructor(config: RunnerConfig) {
    this.config = config;
  }

  stop(): void {
    this.stopFlag = true;
  }

  async spawnFromProtocol(
    protocolPath: string,
    roleOverrides?: Record<string, ProviderConfig>,
  ): Promise<AgentResult[]> {
    // Load and parse the spec to determine roles
    let spec: { roles: Record<string, { description: string; count?: string; model_hint?: string }> };

    try {
      spec = await loadSpecFile(protocolPath) as typeof spec;
    } catch (err) {
      throw new Error(`Failed to parse protocol: ${(err as Error).message}`);
    }

    if (!spec.roles || typeof spec.roles !== 'object') {
      throw new Error('Protocol spec has no roles defined');
    }

    // Determine which roles to spawn
    const roleEntries = Object.entries(spec.roles);
    const filteredRoles = this.config.spawnRoles
      ? roleEntries.filter(([name]) => this.config.spawnRoles!.includes(name))
      : roleEntries;

    if (filteredRoles.length === 0) {
      throw new Error(
        `No matching roles to spawn. Available: ${roleEntries.map(([n]) => n).join(', ')}`
      );
    }

    // Build agent configs
    const agents: AgentConfig[] = [];
    for (const [roleName, roleDef] of filteredRoles) {
      const count = parseRoleCount(roleDef.count);
      // Priority: explicit override > model_hint mapping > default
      const hintProvider = roleDef.model_hint ? this.config.modelHintMap?.[roleDef.model_hint] : undefined;
      const provider = roleOverrides?.[roleName] ?? hintProvider ?? this.config.defaultProvider;

      for (let i = 0; i < count; i++) {
        const suffix = randomBytes(3).toString('hex');
        agents.push({
          agentId: `${roleName}_${suffix}`,
          role: roleName,
          provider,
          serverUrl: this.config.serverUrl,
          maxIterations: this.config.maxIterations,
        });
      }
    }

    this.log('system', `Spawning ${agents.length} agent(s): ${agents.map(a => a.agentId).join(', ')}`);

    // Run all agents concurrently
    const results = await Promise.all(agents.map(a => this.runAgent(a)));
    return results;
  }

  async spawnAgent(config: AgentConfig): Promise<AgentResult> {
    return this.runAgent(config);
  }

  private async runAgent(config: AgentConfig): Promise<AgentResult> {
    const color = COLORS[this.colorIndex++ % COLORS.length];
    const { agentId, role, provider, serverUrl, maxIterations } = config;
    let iterations = 0;

    const agentLog = (msg: string) => {
      if (this.config.verbose) {
        const ts = new Date().toISOString().slice(11, 23);
        console.error(`${color}  ${ts} [${agentId}] ${msg}${RESET}`);
      }
    };

    // Create ACP SDK client for this agent
    const client = createAcpClient({ server: serverUrl, agentId, namespace: 'default' });

    try {
      // 0. Register role with the server
      agentLog(`Starting (role=${role}, model=${provider.model})`);
      try {
        await client.requestRole(role);
        agentLog(`Registered role: ${role}`);
      } catch {
        agentLog('Warning: could not register role (server may not support it)');
      }

      // 1. Fetch protocol and generate system prompt
      const protocolData = await fetchProtocol(role, client);

      let systemPrompt: string;
      if (protocolData) {
        systemPrompt = generateSystemPrompt(protocolData, agentId);
      } else {
        systemPrompt = [
          `You are agent "${agentId}" with the role of "${role}".`,
          '',
          'Use the incubator_* tools to coordinate with other agents.',
          'Call incubator_getProtocol to understand your current phase and instructions.',
          'When you have completed your work, say "DONE".',
        ].join('\n');
      }

      // 2. Build initial messages
      const messages: ChatMessage[] = [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: 'Begin your work. Call incubator_getProtocol to understand your current phase and instructions.' },
      ];

      // 3. ReAct loop
      while (iterations < maxIterations && !this.stopFlag) {
        iterations++;
        agentLog(`Iteration ${iterations}/${maxIterations}`);

        // Call LLM
        const response = await chatCompletion(provider, messages, TOOL_DEFS, config.temperature);
        messages.push(response);

        // Log assistant response
        if (response.content) {
          const preview = response.content.length > 200
            ? response.content.slice(0, 200) + '...'
            : response.content;
          agentLog(`${DIM}${preview}${RESET}${color}`);
        }

        // No tool calls → agent is done
        if (!response.tool_calls || response.tool_calls.length === 0) {
          agentLog('No tool calls — agent finished');
          break;
        }

        // Check for "DONE" in content
        if (response.content && /\bDONE\b/.test(response.content)) {
          agentLog('Agent said DONE — finishing');
          break;
        }

        // Execute each tool call
        let halted = false;
        for (const toolCall of response.tool_calls) {
          const name = toolCall.function.name;
          agentLog(`Tool: ${name}`);

          const result = await executeToolCall(toolCall, client);

          // Log result preview
          const resultPreview = result.length > 150
            ? result.slice(0, 150) + '...'
            : result;
          agentLog(`${DIM}→ ${resultPreview}${RESET}${color}`);

          // Append tool result to messages
          messages.push({
            role: 'tool',
            content: result,
            tool_call_id: toolCall.id ?? `call_${iterations}`,
          });

          // Check halt/pause status after each tool call
          const controlStatus = await checkControlStatus(client);
          if (controlStatus.halted) {
            agentLog(`HALTED: ${controlStatus.haltReason ?? 'no reason'}`);
            halted = true;
            break;
          }
          if (controlStatus.paused) {
            agentLog(`PAUSED: ${controlStatus.pauseReason ?? 'no reason'} — waiting for resume...`);
            const resumeReason = await waitForResume(client, agentLog);
            agentLog(`RESUMED: ${resumeReason}`);
            // Inject context message so the agent knows it was paused/resumed
            messages.push({
              role: 'user',
              content: `[SYSTEM] You were paused (reason: ${controlStatus.pauseReason ?? 'unknown'}). You have been resumed (reason: ${resumeReason}). Continue your work.`,
            });
          }
        }

        if (halted) {
          agentLog('Agent halted — exiting loop');
          return { agentId, role, status: 'completed', iterations };
        }

        // Periodic prompt refresh (every 10 iterations)
        if (iterations % 10 === 0) {
          const refreshed = await fetchProtocol(role, client);
          if (refreshed) {
            const newPrompt = generateSystemPrompt(refreshed, agentId);
            messages[0] = { role: 'system', content: newPrompt };
            agentLog('Refreshed system prompt (phase may have changed)');
          }
        }
      }

      if (this.stopFlag) {
        agentLog('Stopped by runner');
        return { agentId, role, status: 'completed', iterations };
      }

      if (iterations >= maxIterations) {
        agentLog(`Hit max iterations (${maxIterations})`);
      }

      agentLog(`Done (${iterations} iterations)`);
      return { agentId, role, status: 'completed', iterations };
    } catch (err) {
      const errMsg = (err as Error).message;
      if (this.config.verbose) {
        console.error(`${color}  [${agentId}] ERROR: ${errMsg}${RESET}`);
      }
      return { agentId, role, status: 'error', iterations, error: errMsg };
    }
  }

  private log(source: string, msg: string): void {
    const ts = new Date().toISOString().slice(11, 23);
    console.error(`  ${ts} [${source}] ${msg}`);
  }
}

// ─── Control status helpers ─────────────────────────────────────────

interface ControlStatusResponse {
  halted: boolean;
  paused: boolean;
  haltReason?: string;
  haltStatus?: string;
  pauseReason?: string;
}

async function checkControlStatus(client: AcpClient): Promise<ControlStatusResponse> {
  try {
    const res = await client.getControlStatus();
    return res.ok ? res.data as ControlStatusResponse : { halted: false, paused: false };
  } catch {
    // If server doesn't support control endpoints, assume running
    return { halted: false, paused: false };
  }
}

async function waitForResume(
  client: AcpClient,
  log: (msg: string) => void,
  pollIntervalMs = 2000,
): Promise<string> {
  while (true) {
    await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
    const status = await checkControlStatus(client);
    if (!status.paused) {
      return 'resumed';
    }
    log('Still paused, waiting...');
  }
}

// ─── Pre-flight checks ─────────────────────────────────────────────

export async function preflight(provider: ProviderConfig, verbose: boolean): Promise<void> {
  if (verbose) console.error(`[agent] Checking ${provider.type} connection (${provider.baseUrl})...`);

  const connected = await checkConnection(provider);
  if (!connected) {
    const hints: Record<string, string> = {
      ollama: 'Is Ollama running? Try: ollama serve',
      openai: 'Is OPENAI_API_KEY set? Check your API key.',
      anthropic: 'Is ANTHROPIC_API_KEY set? Check your API key.',
    };
    throw new Error(
      `Cannot connect to ${provider.type} at ${provider.baseUrl}. ${hints[provider.type] ?? ''}`
    );
  }

  if (verbose) console.error(`[agent] Connected to ${provider.type}`);

  const modelExists = await checkModel(provider);
  if (!modelExists) {
    if (provider.type === 'ollama') {
      throw new Error(
        `Model "${provider.model}" not found in Ollama. Try: ollama pull ${provider.model}`
      );
    }
  }

  if (verbose) console.error(`[agent] Model ${provider.model} ready`);
}
