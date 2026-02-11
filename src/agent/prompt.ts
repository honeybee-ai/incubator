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
 * Without a protocol, falls back to generic coding-assistant instructions.
 */
export function generateSystemPrompt(
  agentId: string,
  role: string,
  tools: ToolDef[],
  protocol?: ProtocolResponse | null,
  options?: { disableReasoning?: boolean },
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
  } else {
    lines.push('- Use the tools to complete your assigned work.');
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
 * Generate a minimal prompt when no protocol is loaded.
 */
export function generateFallbackPrompt(
  agentId: string,
  role: string,
  tools: ToolDef[],
): string {
  return generateSystemPrompt(agentId, role, tools, null);
}
