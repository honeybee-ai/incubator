import type { ToolDef, ToolCall } from './types.js';
import type { AcpClient } from '@agentcoordinationprotocol/sdk';
import { getToolCallArgs } from './providers.js';

// ─── Tool definitions (OpenAI function-calling format) ──────────────

export const TOOL_DEFS: ToolDef[] = [
  // State
  {
    type: 'function',
    function: {
      name: 'incubator_getState',
      description: 'Read a shared state value by key. Check state before making decisions to avoid conflicts with other agents.',
      parameters: {
        type: 'object',
        properties: {
          key: { type: 'string', description: 'The state key to read' },
        },
        required: ['key'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'incubator_setState',
      description: 'Write a shared state value. Last-writer-wins. Use claims for mutual exclusion.',
      parameters: {
        type: 'object',
        properties: {
          key: { type: 'string', description: 'The state key to write' },
          value: { type: 'string', description: 'The value to store (any JSON-serializable value)' },
          category: { type: 'string', description: 'Optional category for grouping' },
          ttlMs: { type: 'number', description: 'Optional time-to-live in milliseconds' },
        },
        required: ['key', 'value'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'incubator_queryState',
      description: 'Search shared state by glob pattern and/or category.',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'Glob pattern to match keys' },
          category: { type: 'string', description: 'Filter by category' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'incubator_deleteState',
      description: 'Remove a shared state value.',
      parameters: {
        type: 'object',
        properties: {
          key: { type: 'string', description: 'The state key to delete' },
        },
        required: ['key'],
      },
    },
  },

  // Claims
  {
    type: 'function',
    function: {
      name: 'incubator_claim',
      description: 'Claim exclusive access to a resource. First-come-first-served. If rejected, the response includes who owns it so you can coordinate.',
      parameters: {
        type: 'object',
        properties: {
          resource: { type: 'string', description: 'Resource identifier' },
          value: { type: 'string', description: 'What you plan to do with the resource' },
          ttlMs: { type: 'number', description: 'Optional auto-expire in milliseconds' },
        },
        required: ['resource', 'value'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'incubator_releaseClaim',
      description: 'Release a claim when done with a resource.',
      parameters: {
        type: 'object',
        properties: {
          resource: { type: 'string', description: 'The resource to release' },
        },
        required: ['resource'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'incubator_checkClaim',
      description: 'Check who owns a resource without claiming it.',
      parameters: {
        type: 'object',
        properties: {
          resource: { type: 'string', description: 'The resource to check' },
        },
        required: ['resource'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'incubator_listClaims',
      description: 'List all active claims, optionally filtered by glob pattern.',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'Glob pattern to filter resources' },
        },
        required: [],
      },
    },
  },

  // Events
  {
    type: 'function',
    function: {
      name: 'incubator_publishEvent',
      description: 'Broadcast an event to all agents. Use for signaling: conflicts, completion, blockers, warnings.',
      parameters: {
        type: 'object',
        properties: {
          type: { type: 'string', description: 'Event type' },
          data: { type: 'string', description: 'Event payload (JSON-serializable)' },
        },
        required: ['type', 'data'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'incubator_getEvents',
      description: 'Poll for events since your last cursor. Save the returned cursor for next call.',
      parameters: {
        type: 'object',
        properties: {
          since: { type: 'number', description: 'Cursor from previous call (omit for all events)' },
          type: { type: 'string', description: 'Filter by event type' },
        },
        required: [],
      },
    },
  },

  // Discoveries
  {
    type: 'function',
    function: {
      name: 'incubator_publishDiscovery',
      description: 'Share a finding that other agents should know about.',
      parameters: {
        type: 'object',
        properties: {
          topic: { type: 'string', description: 'Short topic/title for the discovery' },
          content: { type: 'string', description: 'Detailed content of the discovery' },
          category: { type: 'string', description: 'Optional category' },
        },
        required: ['topic', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'incubator_searchDiscoveries',
      description: 'Search discoveries shared by all agents. Text search across topics and content.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Text search query' },
          category: { type: 'string', description: 'Filter by category' },
        },
        required: [],
      },
    },
  },

  // Protocol
  {
    type: 'function',
    function: {
      name: 'incubator_getProtocol',
      description: 'Get the coordination protocol for your role. Returns current phase, steps, resource naming conventions, and instructions. Call on startup and when you observe a phase change.',
      parameters: {
        type: 'object',
        properties: {
          role: { type: 'string', description: 'Your role name' },
        },
        required: [],
      },
    },
  },

  // ─── Messages (direct agent-to-agent communication) ─────────
  {
    type: 'function',
    function: {
      name: 'incubator_sendMessage',
      description: 'Send a direct message to a specific agent. Use for targeted questions or coordination that doesn\'t need to be broadcast.',
      parameters: {
        type: 'object',
        properties: {
          to: { type: 'string', description: 'Target agent ID' },
          content: { type: 'string', description: 'Message content' },
          replyTo: { type: 'string', description: 'Optional message ID this replies to' },
        },
        required: ['to', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'incubator_getMessages',
      description: 'Get direct messages sent to you. Use the since parameter to only get new messages.',
      parameters: {
        type: 'object',
        properties: {
          since: { type: 'string', description: 'ISO timestamp — only return messages after this time' },
        },
        required: [],
      },
    },
  },

  // ─── Role transitions ──────────────────────────────────────
  {
    type: 'function',
    function: {
      name: 'incubator_requestRole',
      description: 'Request to transition to a different role. The server checks if the transition is allowed by the protocol. If approved, your role changes and all agents are notified.',
      parameters: {
        type: 'object',
        properties: {
          role: { type: 'string', description: 'The role you want to transition to' },
          reason: { type: 'string', description: 'Why you want to switch roles' },
        },
        required: ['role'],
      },
    },
  },

  // ─── Help requests ─────────────────────────────────────────
  {
    type: 'function',
    function: {
      name: 'incubator_requestHelp',
      description: 'Request help from other agents. You stay alive and can continue other work. Another agent can claim your request and assist.',
      parameters: {
        type: 'object',
        properties: {
          problem: { type: 'string', description: 'Description of what you need help with' },
          needs_capability: { type: 'string', description: 'Specific capability needed (e.g. "sql", "testing")' },
          urgency: { type: 'string', enum: ['low', 'normal', 'high'], description: 'How urgent the help request is' },
        },
        required: ['problem'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'incubator_claimHelp',
      description: 'Claim a help request to indicate you are working on it. The requesting agent will be notified.',
      parameters: {
        type: 'object',
        properties: {
          requestId: { type: 'string', description: 'The help request ID to claim' },
        },
        required: ['requestId'],
      },
    },
  },

  // ─── Progress reporting ────────────────────────────────────
  {
    type: 'function',
    function: {
      name: 'incubator_reportProgress',
      description: 'Report progress on a claimed resource. Helps other agents and the dashboard know how far along you are.',
      parameters: {
        type: 'object',
        properties: {
          claim: { type: 'string', description: 'The resource claim you are reporting progress on' },
          progress: { type: 'number', description: 'Progress from 0 to 1 (e.g. 0.5 = 50% done)' },
          note: { type: 'string', description: 'Optional status note' },
        },
        required: ['claim', 'progress'],
      },
    },
  },

  // ─── Conflict flagging ─────────────────────────────────────
  {
    type: 'function',
    function: {
      name: 'incubator_flagConflict',
      description: 'Flag a conflict between two contradictory discoveries. A planner or designated role should resolve it.',
      parameters: {
        type: 'object',
        properties: {
          discovery_a: { type: 'string', description: 'First conflicting discovery topic' },
          discovery_b: { type: 'string', description: 'Second conflicting discovery topic' },
          reason: { type: 'string', description: 'Why these discoveries conflict' },
        },
        required: ['discovery_a', 'discovery_b', 'reason'],
      },
    },
  },

  // ─── Reinforcement ─────────────────────────────────────────
  {
    type: 'function',
    function: {
      name: 'incubator_requestReinforcement',
      description: 'Request additional agents be spawned for a role. The server checks protocol limits before approving. If denied once, do not ask again for the same role.',
      parameters: {
        type: 'object',
        properties: {
          role: { type: 'string', description: 'The role that needs more agents' },
          count: { type: 'number', description: 'How many additional agents to spawn (default 1)' },
          reason: { type: 'string', description: 'Why more agents are needed' },
        },
        required: ['role'],
      },
    },
  },

  // ─── Governance ────────────────────────────────────────────
  {
    type: 'function',
    function: {
      name: 'incubator_requestApproval',
      description: 'Request human approval before proceeding with a high-risk action. The action is held until a human approves or denies.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', description: 'What action needs approval' },
          detail: { type: 'string', description: 'Details about the action' },
          files: { type: 'string', description: 'Comma-separated list of affected files' },
        },
        required: ['action'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'incubator_escalate',
      description: 'Escalate an issue to a human. Different from stop (agents keep running) and requestHelp (this is for humans, not agents). Use when you encounter something that requires human judgment.',
      parameters: {
        type: 'object',
        properties: {
          reason: { type: 'string', description: 'Why this needs human attention' },
          context: { type: 'string', description: 'Additional context for the human' },
        },
        required: ['reason'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'incubator_proposeAction',
      description: 'Propose an action that requires quorum (multiple agents agreeing). Other agents can endorse it. The action is approved when enough endorsements are received.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', description: 'The proposed action' },
          detail: { type: 'string', description: 'Details and rationale' },
          requires_quorum: { type: 'number', description: 'Number of agents that must agree (default from governance config or 2)' },
        },
        required: ['action'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'incubator_endorseAction',
      description: 'Endorse a proposed action. When enough agents endorse, the proposal is automatically approved.',
      parameters: {
        type: 'object',
        properties: {
          proposalId: { type: 'string', description: 'The proposal ID to endorse' },
        },
        required: ['proposalId'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'incubator_requestRollback',
      description: 'Request a rollback of recent changes. Use when a tester finds a regression or an agent realizes their approach was wrong.',
      parameters: {
        type: 'object',
        properties: {
          reason: { type: 'string', description: 'Why the rollback is needed' },
          scope: { type: 'string', description: 'What should be rolled back (files, claims, etc.)' },
        },
        required: ['reason'],
      },
    },
  },

  // ─── Control (halt/pause/resume) ────────────────────────────
  {
    type: 'function',
    function: {
      name: 'incubator_requestHalt',
      description: 'Halt the entire protocol or a specific agent. Protocol-wide halt ends the run for everyone. Per-agent halt fires that agent (claims auto-released, role removed). Use for: task complete, budget exceeded, unrecoverable error, or firing an underperforming agent.',
      parameters: {
        type: 'object',
        properties: {
          reason: { type: 'string', description: 'Why the halt is being requested' },
          status: { type: 'string', enum: ['completed', 'failed'], description: 'Whether this is a successful completion or failure (default: completed)' },
          target: { type: 'string', description: 'Agent ID to halt (omit for protocol-wide halt)' },
        },
        required: ['reason'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'incubator_requestPause',
      description: 'Pause the entire protocol or a specific agent. Paused agents stop iterating until resumed. Use for: waiting on human input, coordinating a delicate operation, or freezing a problematic agent while investigating.',
      parameters: {
        type: 'object',
        properties: {
          reason: { type: 'string', description: 'Why the pause is being requested' },
          target: { type: 'string', description: 'Agent ID to pause (omit for protocol-wide pause)' },
        },
        required: ['reason'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'incubator_resumeAgent',
      description: 'Resume a paused agent or the entire protocol. The resumed agent will receive context about why it was paused and why it is being resumed.',
      parameters: {
        type: 'object',
        properties: {
          reason: { type: 'string', description: 'Why the agent/protocol is being resumed' },
          target: { type: 'string', description: 'Agent ID to resume (omit for protocol-wide resume)' },
        },
        required: ['reason'],
      },
    },
  },
];

// ─── Tool executor (maps tool calls → ACP SDK) ──────────────────────

function callSdkMethod(name: string, args: Record<string, unknown>, client: AcpClient) {
  switch (name) {
    // State
    case 'incubator_getState':
      return client.getStateKey(args.key as string);
    case 'incubator_setState':
      return client.setState(args.key as string, args.value, args.category as string | undefined, args.ttlMs as number | undefined);
    case 'incubator_queryState':
      return client.queryState({ pattern: args.pattern as string | undefined, category: args.category as string | undefined });
    case 'incubator_deleteState':
      return client.deleteState(args.key as string);

    // Claims
    case 'incubator_claim':
      return client.claim(args.resource as string, args.value as string | undefined, { ttlMs: args.ttlMs as number | undefined });
    case 'incubator_releaseClaim':
      return client.releaseClaim(args.resource as string);
    case 'incubator_checkClaim':
      return client.checkClaim(args.resource as string);
    case 'incubator_listClaims':
      return client.listClaims(args.pattern as string | undefined);

    // Events
    case 'incubator_publishEvent':
      return client.publishEvent(args.type as string, args.data as Record<string, unknown>);
    case 'incubator_getEvents':
      return client.getEvents(args.since as number | undefined, { type: args.type as string | undefined });

    // Discoveries
    case 'incubator_publishDiscovery':
      return client.publishDiscovery(args.topic as string, args.content as string, args.category as string | undefined);
    case 'incubator_searchDiscoveries':
      return client.searchDiscoveries({ query: args.query as string | undefined, category: args.category as string | undefined });

    // Protocol
    case 'incubator_getProtocol':
      return client.getProtocol(args.role as string | undefined);

    // Messages
    case 'incubator_sendMessage':
      return client.sendMessage(args.to as string, args.content as string, { replyTo: args.replyTo as string | undefined });
    case 'incubator_getMessages':
      return client.getMessages({ since: args.since as string | undefined });

    // Roles
    case 'incubator_requestRole':
      return client.requestRole(args.role as string, { reason: args.reason as string | undefined });

    // Help
    case 'incubator_requestHelp':
      return client.requestHelp(args.problem as string, args.needs_capability as string | undefined, args.urgency as string | undefined);
    case 'incubator_claimHelp':
      return client.claimHelp(args.requestId as string);

    // Progress
    case 'incubator_reportProgress':
      return client.reportProgress(args.claim as string, args.progress as number, args.note as string | undefined);

    // Conflicts
    case 'incubator_flagConflict':
      return client.flagConflict(args.discovery_a as string, args.discovery_b as string, args.reason as string);

    // Reinforcement
    case 'incubator_requestReinforcement':
      return client.requestReinforcement(args.role as string, { count: args.count as number | undefined, reason: args.reason as string | undefined });

    // Governance
    case 'incubator_requestApproval':
      return client.requestApproval(args.action as string, { detail: args.detail as string | undefined, files: args.files as string | undefined });
    case 'incubator_escalate':
      return client.escalate(args.reason as string, args.context as string | undefined);
    case 'incubator_proposeAction':
      return client.proposeAction(args.action as string, { detail: args.detail as string | undefined, requires_quorum: args.requires_quorum as number | undefined });
    case 'incubator_endorseAction':
      return client.endorseAction(args.proposalId as string);
    case 'incubator_requestRollback':
      return client.requestRollback(args.reason as string, args.scope as string | undefined);

    // Control
    case 'incubator_requestHalt':
      return client.halt(args.reason as string | undefined, { status: args.status as string | undefined, target: args.target as string | undefined });
    case 'incubator_requestPause':
      return client.pause(args.reason as string | undefined, { target: args.target as string | undefined });
    case 'incubator_resumeAgent':
      return client.resume({ reason: args.reason as string | undefined, target: args.target as string | undefined });

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

export async function executeToolCall(
  toolCall: ToolCall,
  client: AcpClient,
): Promise<string> {
  const name = toolCall.function.name;
  const args = getToolCallArgs(toolCall);

  try {
    const response = await callSdkMethod(name, args, client);
    return typeof response.data === 'string' ? response.data : JSON.stringify(response.data);
  } catch (err) {
    return JSON.stringify({ error: `SDK call failed: ${(err as Error).message}` });
  }
}
