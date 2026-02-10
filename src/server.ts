import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { StateStore } from './stores/state.js';
import { ClaimStore } from './stores/claims.js';
import { EventStore } from './stores/events.js';
import { DiscoveryStore } from './stores/discoveries.js';
import { MessageStore } from './stores/messages.js';
import { HelpStore } from './stores/help.js';
import { ProgressStore } from './stores/progress.js';
import { ConflictStore } from './stores/conflicts.js';
import { RoleStore } from './stores/roles.js';
import { ProposalStore } from './stores/proposals.js';
import { ReinforcementStore } from './stores/reinforcements.js';
import { ControlStore } from './stores/control.js';
import { RunStore } from './stores/runs.js';
import type { Stores } from './stores/interfaces.js';
import type { ProtocolSpec } from '@agentcoordinationprotocol/spec';
import { resolveVariables, renderInstructions, getRulesForRolePhase, normalizeRules } from '@agentcoordinationprotocol/spec';

export interface ServerOptions {
  agentId?: string;
  namespace?: string;
  persistPath?: string;
  verbose?: boolean;
  sanitizeSnapshot?: (snapshot: import('./types.js').Snapshot) => void;
  onSave?: () => void;
  /** Protocol spec loaded for this namespace, if any */
  getProtocol?: () => ProtocolSpec | undefined;
  /** TopicRouter for cross-namespace topic management */
  getTopicRouter?: () => import('./honeycomb.js').TopicRouter | undefined;
}

export function createStores(): Stores {
  const events = new EventStore();
  const state = new StateStore();
  const claims = new ClaimStore(events);
  const discoveries = new DiscoveryStore(events);
  const messages = new MessageStore();
  const help = new HelpStore(events);
  const progress = new ProgressStore();
  const conflicts = new ConflictStore(events);
  const roles = new RoleStore();
  const proposals = new ProposalStore(events);
  const reinforcements = new ReinforcementStore(events);
  const control = new ControlStore(events);
  const runs = new RunStore();
  return { events, state, claims, discoveries, messages, help, progress, conflicts, roles, proposals, reinforcements, control, runs };
}

export function createServer(stores: Stores, options: ServerOptions = {}) {
  const defaultAgentId = options.agentId ?? 'agent_default';
  const nsLabel = options.namespace && options.namespace !== 'default' ? `@${options.namespace}` : '';

  const server = new McpServer({
    name: 'incubator',
    version: '1.0.0',
  });

  // Helper to get agent ID - in HTTP mode this could be per-session
  function getAgentId(): string {
    return defaultAgentId;
  }

  function maybeSave(): void {
    if (options.onSave) {
      options.onSave();
    }
  }

  function log(tool: string, agentId: string, detail: string): void {
    if (options.verbose) {
      const ts = new Date().toISOString().slice(11, 23);
      console.error(`  ${ts} [${agentId}${nsLabel}] ${tool} ${detail}`);
    }
  }

  // ─── State Tools ──────────────────────────────────────────

  server.registerTool(
    'incubator_getState',
    {
      description: 'Read a shared state value by key. Check state before making decisions to avoid conflicts with other agents.',
      inputSchema: {
        key: z.string().describe('The state key to read'),
      },
    },
    async (args: { key: string }) => {
      const entry = await stores.state.get(args.key);
      log('getState', getAgentId(), `key=${args.key} ${entry ? 'HIT' : 'MISS'}`);
      if (!entry) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ found: false, key: args.key }) }],
        };
      }
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ found: true, entry }) }],
      };
    }
  );

  server.registerTool(
    'incubator_setState',
    {
      description: 'Write a shared state value. Last-writer-wins. Use this to share decisions, progress, or context with other agents. Use claims for mutual exclusion instead.',
      inputSchema: {
        key: z.string().describe('The state key to write'),
        value: z.unknown().describe('The value to store (any JSON-serializable value)'),
        category: z.string().optional().describe('Optional category for grouping (e.g. "config", "progress")'),
        ttlMs: z.number().optional().describe('Optional time-to-live in milliseconds'),
      },
    },
    async (args: { key: string; value: unknown; category?: string; ttlMs?: number }) => {
      const entry = await stores.state.set(args.key, args.value, getAgentId(), args.category, args.ttlMs);
      log('setState', getAgentId(), `key=${args.key} val=${JSON.stringify(args.value).slice(0, 60)}`);
      maybeSave();
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ success: true, entry }) }],
      };
    }
  );

  server.registerTool(
    'incubator_queryState',
    {
      description: 'Search shared state by glob pattern and/or category. Use to discover what other agents have shared.',
      inputSchema: {
        pattern: z.string().optional().describe('Glob pattern to match keys (e.g. "agent_*", "config.*")'),
        category: z.string().optional().describe('Filter by category'),
      },
    },
    async (args: { pattern?: string; category?: string }) => {
      const entries = await stores.state.query(args.pattern, args.category);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ count: entries.length, entries }) }],
      };
    }
  );

  server.registerTool(
    'incubator_deleteState',
    {
      description: 'Remove a shared state value.',
      inputSchema: {
        key: z.string().describe('The state key to delete'),
      },
    },
    async (args: { key: string }) => {
      const deleted = await stores.state.delete(args.key);
      maybeSave();
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ deleted }) }],
      };
    }
  );

  // ─── Claim Tools ──────────────────────────────────────────

  server.registerTool(
    'incubator_claim',
    {
      description: 'Claim exclusive access to a resource (file, variable, function, etc). First-come-first-served. If rejected, the response includes who owns it so you can coordinate. Always claim before modifying shared resources.',
      inputSchema: {
        resource: z.string().describe('Resource identifier (e.g. file path, variable name, function name)'),
        value: z.string().describe('What you plan to do with the resource'),
        ttlMs: z.number().optional().describe('Optional auto-expire in milliseconds (default: no expiry)'),
      },
    },
    async (args: { resource: string; value: string; ttlMs?: number }) => {
      const result = await stores.claims.claim(args.resource, args.value, getAgentId(), args.ttlMs);
      log('claim', getAgentId(), `resource=${args.resource} → ${result.status}${result.status === 'rejected' ? ` (owner: ${result.claim.owner})` : ''}`);
      maybeSave();
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result) }],
      };
    }
  );

  server.registerTool(
    'incubator_releaseClaim',
    {
      description: 'Release a claim when done with a resource. Always release claims promptly.',
      inputSchema: {
        resource: z.string().describe('The resource to release'),
      },
    },
    async (args: { resource: string }) => {
      const claim = await stores.claims.release(args.resource, getAgentId());
      log('releaseClaim', getAgentId(), `resource=${args.resource} ${claim ? 'OK' : 'NOT_OWNER'}`);
      maybeSave();
      if (!claim) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ released: false, reason: 'No active claim found or not owner' }) }],
        };
      }
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ released: true, claim }) }],
      };
    }
  );

  server.registerTool(
    'incubator_checkClaim',
    {
      description: 'Check who owns a resource without claiming it. Use to check before attempting a claim.',
      inputSchema: {
        resource: z.string().describe('The resource to check'),
      },
    },
    async (args: { resource: string }) => {
      const claim = await stores.claims.check(args.resource);
      if (!claim) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ claimed: false, resource: args.resource }) }],
        };
      }
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ claimed: claim.status === 'active', claim }) }],
      };
    }
  );

  server.registerTool(
    'incubator_listClaims',
    {
      description: 'List all active claims, optionally filtered by glob pattern. Use to see what resources are locked.',
      inputSchema: {
        pattern: z.string().optional().describe('Glob pattern to filter resources (e.g. "src/*.ts", "var_*")'),
      },
    },
    async (args: { pattern?: string }) => {
      const claims = await stores.claims.list(args.pattern);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ count: claims.length, claims }) }],
      };
    }
  );

  // ─── Event Tools ──────────────────────────────────────────

  server.registerTool(
    'incubator_publishEvent',
    {
      description: 'Broadcast an event to all agents. Use for: conflicts detected, work completed, blockers found, warnings. Other agents poll for events with getEvents.',
      inputSchema: {
        type: z.string().describe('Event type (e.g. "conflict", "completed", "blocker", "warning")'),
        data: z.unknown().describe('Event payload (any JSON-serializable data)'),
      },
    },
    async (args: { type: string; data: unknown }) => {
      const event = await stores.events.publish(args.type, args.data, getAgentId());
      log('publishEvent', getAgentId(), `type=${args.type}`);
      maybeSave();
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ published: true, event }) }],
      };
    }
  );

  server.registerTool(
    'incubator_getEvents',
    {
      description: 'Poll for events since your last cursor. Call periodically to stay aware of other agents\' activity. Save the returned cursor for next call.',
      inputSchema: {
        since: z.number().optional().describe('Cursor from previous call (omit for all events)'),
        type: z.string().optional().describe('Filter by event type'),
      },
    },
    async (args: { since?: number; type?: string }) => {
      const result = await stores.events.getEvents(args.since, args.type);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result) }],
      };
    }
  );

  // ─── Discovery Tools ─────────────────────────────────────

  server.registerTool(
    'incubator_publishDiscovery',
    {
      description: 'Share a finding that other agents should know about. Use for: naming conventions found, patterns discovered, gotchas encountered, decisions made.',
      inputSchema: {
        topic: z.string().describe('Short topic/title for the discovery'),
        content: z.string().describe('Detailed content of the discovery'),
        category: z.string().optional().describe('Optional category (e.g. "naming", "pattern", "warning")'),
      },
    },
    async (args: { topic: string; content: string; category?: string }) => {
      const discovery = await stores.discoveries.publish(args.topic, args.content, getAgentId(), args.category);
      log('publishDiscovery', getAgentId(), `"${args.topic}" ${args.category ? `[${args.category}]` : ''}`);
      maybeSave();
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ published: true, discovery }) }],
      };
    }
  );

  server.registerTool(
    'incubator_searchDiscoveries',
    {
      description: 'Search discoveries shared by all agents. Text search across topics and content. Check before making decisions that might conflict.',
      inputSchema: {
        query: z.string().optional().describe('Text search query (searches topic and content)'),
        category: z.string().optional().describe('Filter by category'),
      },
    },
    async (args: { query?: string; category?: string }) => {
      const results = await stores.discoveries.search(args.query, args.category);
      log('searchDiscoveries', getAgentId(), `query=${args.query ?? '*'} → ${results.length} results`);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ count: results.length, discoveries: results }) }],
      };
    }
  );

  // ─── Protocol Tool ───────────────────────────────────────

  server.registerTool(
    'incubator_getProtocol',
    {
      description: 'Get the coordination protocol for your role. Returns current phase, steps to follow, resource naming conventions, and natural language instructions. Call this on startup and again when you observe a phase change event.',
      inputSchema: {
        role: z.string().optional().describe('Your role name (if not specified, uses the first role in the spec)'),
      },
    },
    async (args: { role?: string }) => {
      const spec = options.getProtocol?.();
      if (!spec) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: 'No protocol loaded for this namespace' }) }],
        };
      }

      const roleNames = Object.keys(spec.roles);
      const roleName = args.role ?? roleNames[0];
      const roleDef = spec.roles[roleName];
      if (!roleDef) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({
            error: `Unknown role "${roleName}". Available roles: ${roleNames.join(', ')}`,
          }) }],
        };
      }

      // Determine current phase from state (default to first non-terminal phase)
      const phaseState = await stores.state.get('phase');
      const phaseNames = Object.keys(spec.phases);
      const currentPhase = (phaseState?.value as string) ?? phaseNames[0];

      if (!spec.phases[currentPhase]) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({
            error: `Unknown phase "${currentPhase}". Available phases: ${phaseNames.join(', ')}`,
          }) }],
        };
      }

      // Resolve variables
      const vars = await resolveVariables(spec, stores, getAgentId());

      // Get rules for this role/phase
      const phaseRules = getRulesForRolePhase(spec, roleName, currentPhase);

      // Render instructions
      const instructions = renderInstructions(spec, roleName, currentPhase, vars);

      // Build phases overview
      const phasesOverview: Record<string, { description: string; terminal?: boolean }> = {};
      for (const [name, def] of Object.entries(spec.phases)) {
        phasesOverview[name] = { description: def.description, ...(def.terminal ? { terminal: true } : {}) };
      }

      // Build team info from role store
      const teamAssignments = await stores.roles.getAssignments();

      const result = {
        protocol: { name: spec.name, title: spec.title, acp: spec.acp },
        role: { name: roleName, description: roleDef.description },
        current_phase: currentPhase,
        rules: phaseRules.steps ?? [],
        loop: phaseRules.loop ?? false,
        resources: spec.resources ?? {},
        variables: vars,
        instructions,
        phases: phasesOverview,
        ...(spec.errors ? { errors: spec.errors } : {}),
        ...(spec.governance ? { governance: spec.governance } : {}),
        ...(teamAssignments.length > 0 ? { team: teamAssignments } : {}),
      };

      log('getProtocol', getAgentId(), `role=${roleName} phase=${currentPhase}`);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result) }],
      };
    }
  );

  // ─── Control Tools (halt/pause/resume) ──────────────────

  server.registerTool(
    'incubator_requestHalt',
    {
      description: 'Halt the entire protocol or a specific agent. Protocol-wide halt ends the run. Per-agent halt fires that agent (claims auto-released, role removed).',
      inputSchema: {
        reason: z.string().describe('Why the halt is being requested'),
        status: z.enum(['completed', 'failed']).optional().describe('Whether this is a successful completion or failure (default: completed)'),
        target: z.string().optional().describe('Agent ID to halt (omit for protocol-wide halt)'),
      },
    },
    async (args: { reason: string; status?: 'completed' | 'failed'; target?: string }) => {
      const agentId = getAgentId();
      const status = args.status ?? 'completed';

      // Per-agent halt: auto-release claims and remove role
      if (args.target) {
        const claims = await stores.claims.list();
        for (const claim of claims) {
          if (claim.owner === args.target && claim.status === 'active') {
            await stores.claims.release(claim.resource, args.target);
          }
        }
        await stores.roles.remove(args.target);
      }

      const info = await stores.control.halt(args.reason, agentId, status, args.target);
      log('requestHalt', agentId, `target=${args.target ?? 'protocol'} status=${status}`);
      maybeSave();
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ halted: true, info }) }],
      };
    }
  );

  server.registerTool(
    'incubator_requestPause',
    {
      description: 'Pause the entire protocol or a specific agent. Paused agents stop iterating until resumed.',
      inputSchema: {
        reason: z.string().describe('Why the pause is being requested'),
        target: z.string().optional().describe('Agent ID to pause (omit for protocol-wide pause)'),
      },
    },
    async (args: { reason: string; target?: string }) => {
      const agentId = getAgentId();
      const info = await stores.control.pause(args.reason, agentId, args.target);
      log('requestPause', agentId, `target=${args.target ?? 'protocol'}`);
      maybeSave();
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ paused: true, info }) }],
      };
    }
  );

  server.registerTool(
    'incubator_resumeAgent',
    {
      description: 'Resume a paused agent or the entire protocol.',
      inputSchema: {
        reason: z.string().describe('Why the agent/protocol is being resumed'),
        target: z.string().optional().describe('Agent ID to resume (omit for protocol-wide resume)'),
      },
    },
    async (args: { reason: string; target?: string }) => {
      const agentId = getAgentId();
      const resumed = await stores.control.resume(agentId, args.reason, args.target);
      log('resumeAgent', agentId, `target=${args.target ?? 'protocol'} → ${resumed}`);
      maybeSave();
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ resumed }) }],
      };
    }
  );

  // ─── Topic Tools (Honeycomb) ────────────────────────────

  server.registerTool(
    'incubator_getTopics',
    {
      description: 'List published and subscribed cross-namespace topics for this namespace. Topics enable event routing between separate protocol namespaces.',
      inputSchema: {},
    },
    async () => {
      const router = options.getTopicRouter?.();
      const ns = options.namespace ?? 'default';
      if (!router) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: 'Topic routing not enabled' }) }],
        };
      }
      const topics = router.getTopics(ns);
      log('getTopics', getAgentId(), `pub=${topics.publishes.length} sub=${topics.subscribes.length}`);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(topics) }],
      };
    }
  );

  server.registerTool(
    'incubator_subscribeTopic',
    {
      description: 'Subscribe this namespace to a cross-namespace topic at runtime. Events published to this topic in other namespaces will appear in your event stream.',
      inputSchema: {
        topic: z.string().describe('The topic (event type) to subscribe to'),
      },
    },
    async (args: { topic: string }) => {
      const router = options.getTopicRouter?.();
      const ns = options.namespace ?? 'default';
      if (!router) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: 'Topic routing not enabled' }) }],
        };
      }
      router.subscribe(ns, args.topic);
      log('subscribeTopic', getAgentId(), `topic=${args.topic}`);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ subscribed: true, topic: args.topic }) }],
      };
    }
  );

  server.registerTool(
    'incubator_publishTopic',
    {
      description: 'Declare this namespace as publishing a cross-namespace topic at runtime. Events matching this topic will be routed to subscribing namespaces.',
      inputSchema: {
        topic: z.string().describe('The topic (event type) to publish'),
      },
    },
    async (args: { topic: string }) => {
      const router = options.getTopicRouter?.();
      const ns = options.namespace ?? 'default';
      if (!router) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: 'Topic routing not enabled' }) }],
        };
      }
      router.publish(ns, args.topic);
      log('publishTopic', getAgentId(), `topic=${args.topic}`);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ published: true, topic: args.topic }) }],
      };
    }
  );

  return server;
}
