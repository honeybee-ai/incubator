import { createAcpClient } from '@agentcoordinationprotocol/sdk';
import type { AcpClient } from '@agentcoordinationprotocol/sdk';
import { ClaimManager } from './claim-manager.js';
import { EventClient } from './event-client.js';
import { ProgressReporter } from './progress.js';
import { WebSocketEventClient, type WakeCondition } from './ws-event-client.js';

interface ControlStatus {
  halted: boolean;
  paused: boolean;
  reason?: string;
}

export interface ProtocolResponse {
  protocol: { name: string; title: string };
  role: { name: string; description: string };
  current_phase: string;
  instructions: string;
  phases: Record<string, { description: string; terminal?: boolean }>;
  governance?: Record<string, unknown>;
  team?: Array<{ agent: string; role: string }>;
  rules?: Record<string, { loop?: boolean; steps: Array<{ action: string; description?: string; hint?: string; params?: Record<string, unknown> }> }>;
  resources?: Record<string, unknown>;
  wait?: { types?: string[]; max_timeout?: number };
  /** Context retention: 0 = stateless (reset each iteration), N = keep last N exchanges. Omit for full history. */
  context?: number;
  /** LLM temperature override from spec. */
  temperature?: number;
  /** Disable LLM reasoning/thinking (e.g. gpt-oss). false = disable. */
  reasoning?: boolean;
  /** Reasoning effort level (e.g. 'low', 'medium', 'high'). */
  reasoning_effort?: string;
}

/** Raw response from REST GET /api/protocol */
interface RawProtocolData {
  loaded: boolean;
  spec?: {
    name: string;
    title: string;
    roles: Record<string, { description: string; count?: string }>;
    phases: Record<string, { description: string; terminal?: boolean }>;
    resources?: Record<string, unknown>;
    governance?: Record<string, unknown>;
    rules?: Record<string, Record<string, { loop?: boolean; steps: Array<{ action: string; description?: string; hint?: string; params?: Record<string, unknown> }> }>>;
  };
  team?: Array<{ agent: string; role: string }>;
}

export interface AcpRuntimeConfig {
  serverUrl: string;
  namespace: string;
  agentId: string;
  role: string;
  maxIterations: number;
  verbose?: boolean;
  /** Use WebSocket for event delivery instead of polling. */
  useWebSocket?: boolean;
}

/**
 * Invisible ACP coordination layer.
 * Wraps AcpClient and provides:
 * - Lazy file-level claims on writes
 * - Event polling between iterations
 * - Progress reporting
 * - Control status (halt/pause) checking
 *
 * The LLM never sees coordination tools — it only gets environment tools from Propolis.
 */
export class AcpRuntime {
  private client: AcpClient;
  private claims: ClaimManager;
  private events: EventClient;
  private progress: ProgressReporter;
  private config: AcpRuntimeConfig;
  private iterationCount = 0;
  private wsClient: WebSocketEventClient | null = null;

  constructor(config: AcpRuntimeConfig) {
    this.config = config;
    this.client = createAcpClient({
      server: config.serverUrl,
      agentId: config.agentId,
      namespace: config.namespace,
    });
    this.claims = new ClaimManager(this.client);
    this.events = new EventClient(this.client, config.agentId);
    this.progress = new ProgressReporter(this.client, config.agentId);
    if (config.useWebSocket) {
      this.wsClient = new WebSocketEventClient(config.serverUrl, config.namespace, config.agentId, config.role);
    }
  }

  /**
   * Connect to incubator and register role.
   */
  async connect(): Promise<void> {
    try {
      await this.client.requestRole(this.config.role);
    } catch {
      // Server may not support role registration — continue
    }
    // Connect WebSocket for push-based events
    if (this.wsClient) {
      try {
        await this.wsClient.connect();
      } catch {
        // WS unavailable — fall back to polling
        this.wsClient = null;
      }
    }
  }

  /**
   * Disconnect — release claims, close WS, and report completion.
   */
  async disconnect(): Promise<void> {
    await this.claims.releaseAll();
    if (this.wsClient) {
      this.wsClient.close();
      this.wsClient = null;
    }
  }

  /**
   * Wait for a wake event. Used by sleep/wake agents between iterations.
   * Returns formatted event strings, or empty array on timeout.
   */
  async waitForWake(condition: WakeCondition): Promise<string[]> {
    if (this.wsClient) {
      return this.wsClient.waitForWake(condition);
    }
    // Fallback: poll for events
    const deadline = condition.timeout && condition.timeout > 0
      ? Date.now() + condition.timeout
      : 0;
    const POLL_INTERVAL = 2000;

    while (deadline === 0 || Date.now() < deadline) {
      const events = await this.events.drain();
      if (events.length > 0) {
        if (condition.types) {
          const typeSet = new Set(condition.types);
          const matching = events.filter(e => {
            // Extract type from format "Event from X: [type] data"
            const m = e.match(/\[([^\]]+)\]/);
            return m && typeSet.has(m[1]);
          });
          if (matching.length > 0) return matching;
        } else {
          return events;
        }
      }
      await new Promise(r => setTimeout(r, POLL_INTERVAL));
    }
    return []; // timeout
  }

  /**
   * Get the last inject string from a dance-enabled WS connection.
   * Consumed on read.
   */
  getLastInject(): string | null {
    return this.wsClient?.getLastInject() ?? null;
  }

  /**
   * Call a dance tool on the server via WebSocket.
   */
  async callDanceTool(tool: string, args: Record<string, unknown>): Promise<unknown> {
    if (!this.wsClient) {
      throw new Error('Dance tool calls require WebSocket connection');
    }
    return this.wsClient.callDanceTool(tool, args);
  }

  /**
   * Get dance tool definitions from the server (received via WS).
   */
  getDanceTools(): import('../types.js').ToolDef[] | null {
    return this.wsClient?.getDanceTools() ?? null;
  }

  /**
   * Called by runner before each iteration.
   * Returns context messages to inject (events from other agents).
   */
  async beforeIteration(): Promise<string[]> {
    this.iterationCount++;
    await this.progress.reportIteration(this.iterationCount, this.config.maxIterations);

    const messages: string[] = [];

    // Drain events — prefer WS buffer, fall back to polling
    if (this.wsClient) {
      const wsEvents = this.wsClient.drain();
      messages.push(...wsEvents);
    } else {
      const events = await this.events.drain();
      messages.push(...events);
    }

    // Drain direct messages (always via polling — messages aren't on WS)
    const directMessages = await this.events.drainMessages();
    messages.push(...directMessages);

    return messages;
  }

  /**
   * Called when Propolis executes a file write.
   * Auto-acquires file claim. Returns error message if conflict, null if OK.
   */
  async onFileWrite(path: string): Promise<string | null> {
    return this.claims.ensureClaim(path);
  }

  /**
   * Called on task completion — release claims and report.
   */
  async onComplete(summary: string, usage?: { promptTokens: number; completionTokens: number; totalTokens: number }): Promise<void> {
    await this.progress.reportComplete(summary, usage);
    await this.claims.releaseAll();
  }

  /**
   * Fetch protocol from incubator for system prompt generation.
   */
  async fetchProtocol(): Promise<ProtocolResponse | null> {
    try {
      const res = await this.client.getProtocol(this.config.role);
      if (!res.ok) return null;
      const data = res.data as unknown as RawProtocolData | ProtocolResponse;

      // If the response has 'loaded' property, it's the raw spec format
      if ('loaded' in data) {
        return buildFromRawSpec(data as RawProtocolData, this.config.role);
      }

      // Otherwise it's already in ProtocolResponse format
      return data as ProtocolResponse;
    } catch {
      return null;
    }
  }

  /**
   * Publish a coordination event (exposed as synthetic tool in invisible mode).
   */
  async publishEvent(type: string, data: Record<string, unknown> = {}): Promise<string> {
    try {
      const res = await this.client.publishEvent(type, data);
      if (!res.ok) return JSON.stringify({ error: `Failed to publish event: ${res.status}` });
      return JSON.stringify({ published: true, type });
    } catch (err) {
      return JSON.stringify({ error: `publishEvent failed: ${(err as Error).message}` });
    }
  }

  /**
   * Set shared state (exposed as synthetic tool in invisible mode).
   */
  async setState(key: string, value: unknown): Promise<string> {
    try {
      const res = await this.client.setState(key, value);
      if (!res.ok) return JSON.stringify({ error: `Failed to set state: ${res.status}` });
      return JSON.stringify({ ok: true, key });
    } catch (err) {
      return JSON.stringify({ error: `setState failed: ${(err as Error).message}` });
    }
  }

  /**
   * Get shared state (exposed as synthetic tool in invisible mode).
   * Optional key for single-key lookup or glob-pattern filtering.
   */
  async getState(key?: string): Promise<string> {
    try {
      if (key && key !== 'all') {
        // Single key lookup
        if (!key.includes('*') && !key.includes('?')) {
          const res = await this.client.getStateKey(key);
          if (!res.ok) return JSON.stringify({ error: `Failed to get state key: ${res.status}` });
          return JSON.stringify(res.data);
        }
        // Glob pattern
        const res = await this.client.getState(key);
        if (!res.ok) return JSON.stringify({ error: `Failed to get state: ${res.status}` });
        return JSON.stringify(res.data);
      }
      const res = await this.client.getState();
      if (!res.ok) return JSON.stringify({ error: `Failed to get state: ${res.status}` });
      return JSON.stringify(res.data);
    } catch (err) {
      return JSON.stringify({ error: `getState failed: ${(err as Error).message}` });
    }
  }

  /**
   * Claim exclusive ownership of a resource (exposed as synthetic tool).
   */
  async claimResource(resource: string, reason?: string): Promise<string> {
    try {
      const res = await this.client.claim(resource, reason ?? resource, { ttlMs: 5 * 60 * 1000 });
      if (!res.ok) return JSON.stringify({ error: `Failed to claim: ${res.status}` });
      const data = res.data as { status: string; claim?: { owner?: string } };
      if (data.status === 'approved') {
        return JSON.stringify({ status: 'approved', resource });
      }
      const owner = data.claim?.owner ?? 'another agent';
      return JSON.stringify({ status: 'rejected', resource, owner, message: `Already claimed by ${owner}` });
    } catch (err) {
      return JSON.stringify({ error: `claimResource failed: ${(err as Error).message}` });
    }
  }

  /**
   * Release a previously claimed resource (exposed as synthetic tool).
   */
  async releaseResource(resource: string): Promise<string> {
    try {
      const res = await this.client.releaseClaim(resource);
      if (!res.ok) return JSON.stringify({ error: `Failed to release: ${res.status}` });
      return JSON.stringify({ released: true, resource });
    } catch (err) {
      return JSON.stringify({ error: `releaseResource failed: ${(err as Error).message}` });
    }
  }

  /**
   * Load an ACP protocol spec at runtime (YAML or JSON string).
   * Sends to incubator via PUT /api/protocol.
   */
  async loadProtocol(spec: string): Promise<string> {
    try {
      const res = await this.client.loadProtocol({ spec });
      if (!res.ok) return JSON.stringify({ error: `Failed to load protocol: ${res.status}` });
      return JSON.stringify(res.data);
    } catch (err) {
      return JSON.stringify({ error: `loadProtocol failed: ${(err as Error).message}` });
    }
  }

  /**
   * Check halt/pause status.
   */
  async checkControl(): Promise<ControlStatus> {
    try {
      const res = await this.client.getControlStatus();
      if (!res.ok) return { halted: false, paused: false };
      const data = res.data as ControlStatus;
      return {
        halted: data.halted ?? false,
        paused: data.paused ?? false,
        reason: data.reason,
      };
    } catch {
      return { halted: false, paused: false };
    }
  }

  /**
   * Wait for resume after pause.
   */
  async waitForResume(pollIntervalMs = 2000): Promise<string> {
    while (true) {
      await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
      const status = await this.checkControl();
      if (!status.paused) {
        return 'resumed';
      }
    }
  }
}

/**
 * Transform the raw spec from REST /api/protocol into ProtocolResponse format.
 */
function buildFromRawSpec(data: RawProtocolData, role: string): ProtocolResponse | null {
  if (!data.loaded || !data.spec) return null;

  const spec = data.spec;
  const roleNames = Object.keys(spec.roles);
  const roleName = roleNames.includes(role) ? role : roleNames[0];
  const roleDef = spec.roles[roleName];
  if (!roleDef) return null;

  const phaseNames = Object.keys(spec.phases);
  const currentPhase = phaseNames[0]; // default to first phase

  const phases: Record<string, { description: string; terminal?: boolean }> = {};
  for (const [name, def] of Object.entries(spec.phases)) {
    phases[name] = { description: def.description, ...(def.terminal ? { terminal: true } : {}) };
  }

  // Extract rules for this role (keyed by phase)
  const roleRules = spec.rules?.[roleName];
  const rules: Record<string, { loop?: boolean; steps: Array<{ action: string; description?: string; hint?: string; params?: Record<string, unknown> }> }> = {};
  if (roleRules) {
    for (const [phase, rule] of Object.entries(roleRules)) {
      rules[phase] = rule;
    }
  }

  // Extract wait spec and context from role definition (if present)
  const wait = (roleDef as Record<string, unknown>).wait as { types?: string[]; max_timeout?: number } | undefined;
  const context = (roleDef as Record<string, unknown>).context as number | undefined;
  const temperature = (roleDef as Record<string, unknown>).temperature as number | undefined;
  const reasoning = (roleDef as Record<string, unknown>).reasoning as boolean | undefined;
  const reasoning_effort = (roleDef as Record<string, unknown>).reasoning_effort as string | undefined;

  return {
    protocol: { name: spec.name, title: spec.title },
    role: { name: roleName, description: roleDef.description },
    current_phase: currentPhase,
    instructions: `Follow the ${spec.title} protocol as the ${roleName} role.`,
    phases,
    ...(spec.governance ? { governance: spec.governance } : {}),
    ...(data.team?.length ? { team: data.team } : {}),
    ...(Object.keys(rules).length > 0 ? { rules } : {}),
    ...(spec.resources ? { resources: spec.resources } : {}),
    ...(wait ? { wait } : {}),
    ...(context !== undefined ? { context } : {}),
    ...(temperature !== undefined ? { temperature } : {}),
    ...(reasoning !== undefined ? { reasoning } : {}),
    ...(reasoning_effort ? { reasoning_effort } : {}),
  };
}
