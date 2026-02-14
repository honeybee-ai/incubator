import type { ToolDef } from './types.js';

interface ProtocolResponse {
  protocol: { name: string; title: string };
  role: { name: string; description: string };
  current_phase: string;
  instructions: string;
  phases: Record<string, { description: string; terminal?: boolean }>;
  governance?: Record<string, unknown>;
  team?: Array<{ agent: string; role: string }>;
  rules?: Record<string, { loop?: boolean; steps: Array<{ action: string; description?: string; hint?: string; params?: Record<string, unknown> }> }>;
  resources?: Record<string, unknown>;
}

/**
 * Generate system prompt for an agent.
 * When a protocol is loaded, renders the full role description, phase rules, and resources.
 * Without a protocol, falls back to negotiation bootstrap or generic instructions.
 */
export function generateSystemPrompt(
  agentId: string,
  role: string,
  tools: ToolDef[],
  protocol?: ProtocolResponse | null,
  options?: { disableReasoning?: boolean; peerCount?: number },
): string {
  const lines: string[] = [];

  lines.push(`You are agent "${agentId}" with the role of "${role}".`);
  lines.push('');

  if (protocol) {
    lines.push(`## Protocol: ${protocol.protocol.title}`);
    lines.push('');

    // Role description — this is the critical "what you do" section
    lines.push(`## Your Role: ${protocol.role.name}`);
    lines.push(protocol.role.description);
    lines.push('');

    // Current phase
    lines.push(`## Current Phase: ${protocol.current_phase}`);
    if (protocol.phases[protocol.current_phase]) {
      lines.push(protocol.phases[protocol.current_phase].description);
    }
    lines.push('');

    // Rules for current phase — step-by-step instructions
    if (protocol.rules) {
      const phaseRules = protocol.rules[protocol.current_phase];
      if (phaseRules) {
        lines.push('## Your Steps (follow in order):');
        if (phaseRules.loop) {
          lines.push('*Repeat these steps until no work remains, then say DONE.*');
        }
        lines.push('');
        for (let i = 0; i < phaseRules.steps.length; i++) {
          const step = phaseRules.steps[i];
          const desc = step.hint ?? step.description ?? step.action;
          lines.push(`${i + 1}. ${desc}`);
        }
        lines.push('');
      }
    }

    // Resources — claim patterns, event types, instances
    if (protocol.resources) {
      const res = protocol.resources as Record<string, unknown>;
      if (res.instances && Array.isArray(res.instances)) {
        lines.push('## Available Resources');
        for (const inst of res.instances) {
          lines.push(`- ${inst}`);
        }
        lines.push('');
      }
      if (res.claim_patterns) {
        lines.push('## Claim Patterns');
        for (const [name, pattern] of Object.entries(res.claim_patterns as Record<string, string>)) {
          lines.push(`- ${name}: \`${pattern}\``);
        }
        lines.push('');
      }
    }

    // Phase overview
    lines.push('## All Phases');
    for (const [name, phase] of Object.entries(protocol.phases)) {
      const marker = name === protocol.current_phase ? ' (CURRENT)' : phase.terminal ? ' (TERMINAL)' : '';
      lines.push(`- **${name}**${marker}: ${phase.description}`);
    }
    lines.push('');

    // Team
    if (protocol.team && protocol.team.length > 0) {
      lines.push('## Team');
      const byRole = new Map<string, string[]>();
      for (const member of protocol.team) {
        const list = byRole.get(member.role) ?? [];
        list.push(member.agent);
        byRole.set(member.role, list);
      }
      for (const [roleName, agents] of byRole) {
        const marker = roleName === role ? ' (your role)' : '';
        lines.push(`- **${roleName}**${marker}: ${agents.join(', ')}`);
      }
      lines.push('');
    }
  }

  // Tool overview
  lines.push('## Available Tools');
  lines.push('');
  for (const tool of tools) {
    lines.push(`- **${tool.function.name}**: ${tool.function.description}`);
  }
  lines.push('');

  // Instructions — context-aware
  lines.push('## Instructions');
  if (protocol) {
    lines.push('- Follow the steps above for your role. Use the available tools to complete each step.');
    lines.push('- Work through the workspace files as described in your role description.');
    lines.push('- When you have completed ALL your work and have no more actions to take, respond with just the word "DONE".');
  } else if (options?.peerCount !== undefined && options.peerCount > 1) {
    lines.push(generateBootstrapNegotiationPrompt(agentId, options.peerCount));
  } else if (options?.peerCount === 1) {
    lines.push(generateSelfSpecPrompt());
  } else {
    lines.push('- First, check if a protocol is already loaded by reading shared state.');
    lines.push('- If no protocol exists, use the tools to complete your assigned work.');
    lines.push('- Read files before modifying them to understand existing code.');
    lines.push('- Use grep and glob to explore the codebase before making changes.');
    lines.push('- When you have completed your work and have no more actions to take, say "DONE".');
  }
  lines.push('');

  // Qwen-3 /no_think: suppress <think> blocks when reasoning disabled
  if (options?.disableReasoning) {
    lines.push('/no_think');
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Generate bootstrap negotiation instructions for multi-agent spec creation.
 * Used when no protocol is loaded and multiple agents are connected.
 */
function generateBootstrapNegotiationPrompt(agentId: string, peerCount: number): string {
  return `No protocol is loaded yet. You are one of ${peerCount} agents. You must coordinate to establish an ACP protocol spec before starting work.

## Bootstrap Negotiation Protocol

### Phase 0: Discovery (ALWAYS do this first)
- Use get_state to check the current negotiation status (look for "spec_status" key).
- Based on what you find:
  - spec_status = "activated" → Protocol already loaded. Skip to Phase 4.
  - spec_status = "authoring" → A queen/coordinator is writing the spec. Skip to Phase 3C (Wait).
  - spec_status = "proposing" or "voting" → Negotiation in progress. Join as REVIEWER (Phase 3B).
  - No spec_status → No one has started yet. Proceed to Phase 1.

### Phase 1: Election
- Try to claim "spec_author" to become the spec author.
- If you win the claim → you are the AUTHOR → proceed to Phase 2.
- If the claim is rejected → someone else is authoring → proceed to Phase 3B or 3C.

### Phase 2: Author Path
1. Set state: spec_status = "proposing", negotiation_round = "1", agent_count = "${peerCount}"
2. Draft an ACP protocol spec in YAML format. The spec MUST:
   - Start with \`acp: "1.0"\` (required version header)
   - Define a \`name\` and \`title\`
   - Define \`roles\` for all agents (based on the task at hand)
   - Define \`phases\` — at least one must have \`terminal: true\`
   - Optionally define \`rules\` with step-by-step instructions per role per phase
3. Set state: spec_draft = <your YAML spec>, spec_draft_version = "1"
4. Publish event: spec.proposed (with summary of what the spec defines)
5. Wait for spec.vote events from reviewers
6. If all votes are "yes": use load_protocol with the spec YAML string, then set spec_status = "activated", then publish spec.activated
7. If any vote is "no": read feedback, revise the spec, increment spec_draft_version, set updated spec_draft, publish spec.revised (max 5 rounds)
8. After 5 rounds with no consensus: load the best version anyway (majority wins)

### Phase 3A: Reviewer Path (peer negotiation)
1. Wait for spec.proposed or spec.revised event
2. Read spec_draft from shared state
3. Evaluate: Does the spec make sense? Are roles well-defined? Are phases logical? Does it have terminal phases?
4. Publish event: spec.vote with {vote: "yes"} or {vote: "no", feedback: "your specific feedback"}
5. If a spec.revised event arrives, repeat from step 2

### Phase 3B: Late Reviewer (negotiation already started)
- Read spec_draft and spec_draft_version from state
- Evaluate and vote as in Phase 3A

### Phase 3C: Queenful Wait (authority is authoring)
- An authority agent (queen/coordinator) has set spec_status = "authoring".
- Wait for the spec.activated event. Do NOT attempt to negotiate or claim spec_author.
- Once activated, proceed to Phase 4.

### Phase 4: Execute
- The protocol is now loaded. Follow your assigned role.
- Your actions should publish events defined in the spec — downstream systems may be monitoring them.
- Say "Waiting" if it's not your turn yet.

## Important Rules
- NEVER say "DONE" during negotiation — only after your actual work under the loaded protocol is complete.
- Keep spec drafts concise — focus on roles, phases, and rules.
- The spec_author claim has a TTL — if the author crashes, another agent can re-claim.
- ALWAYS check spec_status first. Someone else may already be handling spec creation.
- The load_protocol action takes a YAML string. The spec MUST be valid ACP 1.0 (acp: "1.0", name, title, roles, phases with at least one terminal).`;
}

/**
 * Generate self-spec instructions for a single agent.
 * Used when no protocol is loaded and only one agent exists.
 */
function generateSelfSpecPrompt(): string {
  return `No protocol is loaded yet. You are the only agent.

## Self-Specification
1. Assess the task and workspace.
2. Write a simple ACP protocol spec in YAML that defines your role, phases, and steps.
3. Use load_protocol to activate it.
4. Then follow the protocol to complete your work.
5. When all work is done, say "DONE".

Keep the spec minimal — one role (yours), 2-3 phases, clear exit conditions.`;
}

/**
 * Generate a minimal prompt when no protocol is loaded.
 */
export function generateFallbackPrompt(
  agentId: string,
  role: string,
  tools: ToolDef[],
): string {
  return generateSystemPrompt(agentId, role, tools, null);
}
