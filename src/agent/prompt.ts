interface ProtocolData {
  loaded: boolean;
  spec?: {
    name: string;
    title: string;
    roles: Record<string, { description: string; count?: string; can_become?: string[]; scope?: string[]; capabilities?: string[] }>;
    phases: Record<string, { description: string; terminal?: boolean }>;
    resources?: Record<string, unknown>;
    governance?: GovernanceInfo;
  };
  team?: TeamMember[];
}

interface GovernanceInfo {
  budget?: { max_tokens?: number; max_cost?: number; warn_at?: number };
  escalation?: { triggers?: Array<{ condition: string; action: string }>; channel?: string };
  quorum?: { default?: number; actions?: Record<string, number> };
  approval_gates?: Array<{ action: string; scope?: string[]; required_role?: string }>;
  heartbeat?: { stale_after_ms?: number; dead_after_ms?: number; auto_release_claims?: boolean };
  reinforcement?: { auto_heal?: boolean; cooldown_ms?: number };
}

interface TeamMember {
  agent: string;
  role: string;
  assignedAt?: string;
}

interface ProtocolResponse {
  protocol: { name: string; title: string };
  role: { name: string; description: string };
  current_phase: string;
  rules: Array<{ action: string; description?: string; hint?: string; params?: Record<string, unknown> }>;
  loop: boolean;
  resources: Record<string, unknown>;
  variables: Record<string, unknown>;
  instructions: string;
  phases: Record<string, { description: string; terminal?: boolean }>;
  errors?: Record<string, unknown>;
  governance?: GovernanceInfo;
  team?: TeamMember[];
}

export function generateSystemPrompt(protocolResponse: ProtocolResponse, agentId: string): string {
  const { protocol, role, current_phase, phases, resources, instructions, governance, team } = protocolResponse;

  const lines: string[] = [];

  lines.push(`You are agent "${agentId}" with the role of "${role.name}": ${role.description}`);
  lines.push('');
  lines.push(`## Protocol: ${protocol.title}`);
  lines.push('');

  if (instructions) {
    lines.push(instructions);
    lines.push('');
  }

  lines.push(`## Your Current Phase: ${current_phase}`);
  if (phases[current_phase]) {
    lines.push(phases[current_phase].description);
  }
  lines.push('');

  // Phase overview
  lines.push('## All Phases');
  for (const [name, phase] of Object.entries(phases)) {
    const marker = name === current_phase ? ' (CURRENT)' : phase.terminal ? ' (TERMINAL)' : '';
    lines.push(`- **${name}**${marker}: ${phase.description}`);
  }
  lines.push('');

  // Team composition
  if (team && team.length > 0) {
    lines.push('## Team');
    const byRole = new Map<string, string[]>();
    for (const member of team) {
      const list = byRole.get(member.role) ?? [];
      list.push(member.agent);
      byRole.set(member.role, list);
    }
    for (const [roleName, agents] of byRole) {
      const marker = roleName === role.name ? ' (your role)' : '';
      lines.push(`- **${roleName}**${marker}: ${agents.join(', ')}`);
    }
    lines.push('');
  }

  // Governance rules
  if (governance) {
    lines.push('## Governance');
    if (governance.budget) {
      const parts: string[] = [];
      if (governance.budget.max_tokens) parts.push(`max ${governance.budget.max_tokens} tokens`);
      if (governance.budget.max_cost) parts.push(`max $${governance.budget.max_cost}`);
      if (governance.budget.warn_at) parts.push(`warning at ${Math.round(governance.budget.warn_at * 100)}%`);
      if (parts.length) lines.push(`- **Budget**: ${parts.join(', ')}`);
    }
    if (governance.escalation?.triggers?.length) {
      lines.push('- **Escalation triggers**:');
      for (const t of governance.escalation.triggers) {
        lines.push(`  - ${t.condition} → ${t.action}`);
      }
    }
    if (governance.quorum) {
      lines.push(`- **Quorum**: ${governance.quorum.default ?? 'none'} endorsements needed for proposals`);
      if (governance.quorum.actions) {
        for (const [action, n] of Object.entries(governance.quorum.actions)) {
          lines.push(`  - ${action}: ${n} endorsements`);
        }
      }
    }
    if (governance.approval_gates?.length) {
      lines.push('- **Approval gates**:');
      for (const gate of governance.approval_gates) {
        const who = gate.required_role === 'human' ? 'human approval' : `${gate.required_role} approval`;
        lines.push(`  - ${gate.action}: requires ${who}${gate.scope ? ` (scope: ${gate.scope.join(', ')})` : ''}`);
      }
    }
    lines.push('');
  }

  // Resources
  if (resources && Object.keys(resources).length > 0) {
    lines.push('## Resource Naming Conventions');
    for (const [category, defs] of Object.entries(resources)) {
      lines.push(`### ${category}`);
      if (typeof defs === 'object' && defs !== null) {
        for (const [name, def] of Object.entries(defs as Record<string, unknown>)) {
          if (typeof def === 'string') {
            lines.push(`- \`${name}\`: \`${def}\``);
          } else if (typeof def === 'object' && def !== null) {
            const d = def as Record<string, unknown>;
            lines.push(`- \`${name}\`: ${d.pattern ?? d.key ?? d.type ?? JSON.stringify(def)}`);
          }
        }
      }
    }
    lines.push('');
  }

  lines.push('## Important');
  lines.push('- Use the incubator_* tools to coordinate with other agents.');
  lines.push('- Call incubator_getProtocol periodically to check for phase changes.');
  lines.push('- When you have completed your work and have no more actions to take, say "DONE" to end your turn.');
  lines.push('- Always check state and events before making decisions to avoid conflicts.');
  lines.push('- Use incubator_sendMessage / incubator_getMessages to communicate directly with specific agents.');
  lines.push('- Use incubator_requestHelp if stuck, or incubator_claimHelp to assist others.');
  lines.push('- Use incubator_reportProgress to share progress on your claims.');
  lines.push('- Use incubator_flagConflict if you find contradictory discoveries.');
  if (governance) {
    lines.push('- Use incubator_proposeAction / incubator_endorseAction for quorum-based decisions.');
    lines.push('- Use incubator_escalate to flag issues for human attention.');
  }

  return lines.join('\n');
}

export async function fetchProtocol(role: string, serverUrl: string): Promise<ProtocolResponse | null> {
  try {
    const url = `${serverUrl}/api/protocol?role=${encodeURIComponent(role)}`;
    const res = await fetch(url);
    if (!res.ok) return null;
    const data = await res.json() as ProtocolData | ProtocolResponse;

    // If it's the raw spec endpoint (loaded: true, spec: {...}), we can't generate a prompt from that
    // We need the getProtocol tool response format which includes rendered instructions
    if ('loaded' in data) {
      // The REST /api/protocol returns { loaded, spec } — not the rendered format
      // We need to call the MCP-style getProtocol which processes the spec
      // For REST, the protocol endpoint returns raw spec, so we build a basic prompt
      return buildFromRawSpec(data as ProtocolData & { team?: TeamMember[] }, role);
    }

    return data as ProtocolResponse;
  } catch {
    return null;
  }
}

function buildFromRawSpec(data: ProtocolData, role: string): ProtocolResponse | null {
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

  return {
    protocol: { name: spec.name, title: spec.title },
    role: { name: roleName, description: roleDef.description },
    current_phase: currentPhase,
    rules: [],
    loop: false,
    resources: spec.resources ?? {},
    variables: {},
    instructions: `Follow the ${spec.title} protocol as the ${roleName} role.`,
    phases,
    ...(spec.governance ? { governance: spec.governance } : {}),
    ...(data.team?.length ? { team: data.team } : {}),
  };
}

export async function refreshPrompt(
  agentId: string,
  role: string,
  serverUrl: string,
): Promise<string | null> {
  const protocol = await fetchProtocol(role, serverUrl);
  if (!protocol) return null;
  return generateSystemPrompt(protocol, agentId);
}
