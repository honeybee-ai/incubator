import { describe, it, expect, vi, afterEach } from 'vitest';
import { generateSystemPrompt, fetchProtocol } from './prompt.js';

const mockProtocolResponse = {
  protocol: { name: 'trading-floor', title: 'The Trading Floor — Resource Market' },
  role: { name: 'trader', description: 'Posts bids and asks, negotiates trades.' },
  current_phase: 'trading',
  rules: [
    { action: 'getState', description: 'Check if market closed', params: { key: 'market_status' } },
    { action: 'getEvents', description: 'Read the order book' },
    { action: 'external', hint: 'Decide your trading move' },
  ],
  loop: true,
  resources: {
    claim_patterns: {
      trade: 'trade:{trade_id}',
      portfolio: 'portfolio:{agent_id}',
    },
    event_types: {
      bid: { type: 'bid' },
      ask: { type: 'ask' },
    },
    state_keys: {
      phase: { key: 'phase', type: 'string' },
      round: { key: 'round', type: 'number' },
    },
  },
  variables: { $self: 'trader_abc123' },
  instructions: 'Follow the trading protocol as the trader role.',
  phases: {
    market_open: { description: 'Traders receive starting portfolios' },
    trading: { description: 'Active trading rounds' },
    settlement: { description: 'Final portfolio calculation' },
    done: { description: 'Market session complete', terminal: true },
  },
};

describe('generateSystemPrompt', () => {
  it('includes role name and description', () => {
    const prompt = generateSystemPrompt(mockProtocolResponse, 'trader_abc123');
    expect(prompt).toContain('trader_abc123');
    expect(prompt).toContain('"trader"');
    expect(prompt).toContain('Posts bids and asks');
  });

  it('includes protocol title', () => {
    const prompt = generateSystemPrompt(mockProtocolResponse, 'trader_abc123');
    expect(prompt).toContain('The Trading Floor');
  });

  it('includes current phase', () => {
    const prompt = generateSystemPrompt(mockProtocolResponse, 'trader_abc123');
    expect(prompt).toContain('## Your Current Phase: trading');
    expect(prompt).toContain('Active trading rounds');
  });

  it('includes all phases with markers', () => {
    const prompt = generateSystemPrompt(mockProtocolResponse, 'trader_abc123');
    expect(prompt).toContain('**trading** (CURRENT)');
    expect(prompt).toContain('**done** (TERMINAL)');
    expect(prompt).toContain('**market_open**:');
  });

  it('includes resource naming conventions', () => {
    const prompt = generateSystemPrompt(mockProtocolResponse, 'trader_abc123');
    expect(prompt).toContain('Resource Naming Conventions');
    expect(prompt).toContain('claim_patterns');
    expect(prompt).toContain('trade:{trade_id}');
  });

  it('includes rendered instructions', () => {
    const prompt = generateSystemPrompt(mockProtocolResponse, 'trader_abc123');
    expect(prompt).toContain('Follow the trading protocol');
  });

  it('includes important notes', () => {
    const prompt = generateSystemPrompt(mockProtocolResponse, 'trader_abc123');
    expect(prompt).toContain('incubator_* tools');
    expect(prompt).toContain('incubator_getProtocol');
    expect(prompt).toContain('DONE');
  });

  it('handles missing resources gracefully', () => {
    const minimal = {
      ...mockProtocolResponse,
      resources: {},
    };
    const prompt = generateSystemPrompt(minimal, 'agent_1');
    expect(prompt).not.toContain('Resource Naming Conventions');
  });
});

describe('fetchProtocol', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it('fetches and returns protocol response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        loaded: true,
        spec: {
          name: 'test',
          title: 'Test Protocol',
          roles: { worker: { description: 'Does work' } },
          phases: { init: { description: 'Initialize' }, done: { description: 'Done', terminal: true } },
        },
      }),
    }));

    const result = await fetchProtocol('worker', 'http://localhost:3100');
    expect(result).not.toBeNull();
    expect(result!.protocol.name).toBe('test');
    expect(result!.role.name).toBe('worker');
    expect(result!.phases.init.description).toBe('Initialize');
  });

  it('returns null on network error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));
    const result = await fetchProtocol('worker', 'http://localhost:3100');
    expect(result).toBeNull();
  });

  it('returns null on non-200 response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 500 }));
    const result = await fetchProtocol('worker', 'http://localhost:3100');
    expect(result).toBeNull();
  });

  it('returns null when no protocol loaded', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ loaded: false }),
    }));
    const result = await fetchProtocol('worker', 'http://localhost:3100');
    expect(result).toBeNull();
  });

  it('defaults to first role when requested role not found', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        loaded: true,
        spec: {
          name: 'test',
          title: 'Test',
          roles: { admin: { description: 'Admin role' } },
          phases: { start: { description: 'Start' } },
        },
      }),
    }));

    const result = await fetchProtocol('nonexistent', 'http://localhost:3100');
    expect(result).not.toBeNull();
    expect(result!.role.name).toBe('admin');
  });

  it('passes through team from REST response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        loaded: true,
        spec: {
          name: 'test',
          title: 'Test',
          roles: { worker: { description: 'Works' } },
          phases: { start: { description: 'Go' } },
        },
        team: [
          { agent: 'worker_1', role: 'worker' },
          { agent: 'worker_2', role: 'worker' },
        ],
      }),
    }));

    const result = await fetchProtocol('worker', 'http://localhost:3100');
    expect(result).not.toBeNull();
    expect(result!.team).toHaveLength(2);
    expect(result!.team![0].agent).toBe('worker_1');
    expect(result!.team![1].role).toBe('worker');
  });

  it('passes through governance from REST response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        loaded: true,
        spec: {
          name: 'test',
          title: 'Test',
          roles: { worker: { description: 'Works' } },
          phases: { start: { description: 'Go' } },
          governance: {
            budget: { max_tokens: 50000 },
            quorum: { default: 2 },
          },
        },
      }),
    }));

    const result = await fetchProtocol('worker', 'http://localhost:3100');
    expect(result).not.toBeNull();
    expect(result!.governance).toBeDefined();
    expect(result!.governance!.budget!.max_tokens).toBe(50000);
    expect(result!.governance!.quorum!.default).toBe(2);
  });
});

// ─── Team & Governance prompt rendering ──────────────────

const mockWithTeam = {
  ...mockProtocolResponse,
  team: [
    { agent: 'trader_abc', role: 'trader' },
    { agent: 'trader_def', role: 'trader' },
    { agent: 'auditor_123', role: 'auditor' },
  ],
  governance: {
    budget: { max_tokens: 100000, warn_at: 0.8 },
    quorum: { default: 2 },
    escalation: { triggers: [{ condition: 'consecutive_failures:3', action: 'notify' }] },
    approval_gates: [{ action: 'deploy', required_role: 'human' }],
  },
};

describe('generateSystemPrompt — team composition', () => {
  it('includes team section when team is present', () => {
    const prompt = generateSystemPrompt(mockWithTeam, 'trader_abc');
    expect(prompt).toContain('## Team');
  });

  it('groups team members by role', () => {
    const prompt = generateSystemPrompt(mockWithTeam, 'trader_abc');
    expect(prompt).toContain('**trader**');
    expect(prompt).toContain('trader_abc');
    expect(prompt).toContain('trader_def');
    expect(prompt).toContain('**auditor**');
    expect(prompt).toContain('auditor_123');
  });

  it('marks the agent own role with (your role)', () => {
    const prompt = generateSystemPrompt(mockWithTeam, 'trader_abc');
    expect(prompt).toContain('**trader** (your role)');
    expect(prompt).not.toContain('**auditor** (your role)');
  });

  it('does not include team section when team is empty', () => {
    const noTeam = { ...mockProtocolResponse, team: [] };
    const prompt = generateSystemPrompt(noTeam, 'agent_1');
    expect(prompt).not.toContain('## Team');
  });

  it('does not include team section when team is absent', () => {
    const prompt = generateSystemPrompt(mockProtocolResponse, 'agent_1');
    expect(prompt).not.toContain('## Team');
  });
});

describe('generateSystemPrompt — governance', () => {
  it('includes governance section when governance is present', () => {
    const prompt = generateSystemPrompt(mockWithTeam, 'trader_abc');
    expect(prompt).toContain('## Governance');
  });

  it('renders budget info', () => {
    const prompt = generateSystemPrompt(mockWithTeam, 'trader_abc');
    expect(prompt).toContain('**Budget**');
    expect(prompt).toContain('max 100000 tokens');
    expect(prompt).toContain('warning at 80%');
  });

  it('renders escalation triggers', () => {
    const prompt = generateSystemPrompt(mockWithTeam, 'trader_abc');
    expect(prompt).toContain('**Escalation triggers**');
    expect(prompt).toContain('consecutive_failures:3');
    expect(prompt).toContain('notify');
  });

  it('renders quorum info', () => {
    const prompt = generateSystemPrompt(mockWithTeam, 'trader_abc');
    expect(prompt).toContain('**Quorum**');
    expect(prompt).toContain('2 endorsements needed');
  });

  it('renders approval gates', () => {
    const prompt = generateSystemPrompt(mockWithTeam, 'trader_abc');
    expect(prompt).toContain('**Approval gates**');
    expect(prompt).toContain('deploy');
    expect(prompt).toContain('human approval');
  });

  it('does not include governance section when absent', () => {
    const prompt = generateSystemPrompt(mockProtocolResponse, 'agent_1');
    expect(prompt).not.toContain('## Governance');
  });

  it('renders max_cost when present', () => {
    const withCost = {
      ...mockProtocolResponse,
      governance: { budget: { max_cost: 5.0 } },
    };
    const prompt = generateSystemPrompt(withCost, 'agent_1');
    expect(prompt).toContain('max $5');
  });

  it('renders quorum per-action overrides', () => {
    const withActions = {
      ...mockProtocolResponse,
      governance: { quorum: { default: 2, actions: { deploy: 3, rollback: 1 } } },
    };
    const prompt = generateSystemPrompt(withActions, 'agent_1');
    expect(prompt).toContain('deploy: 3 endorsements');
    expect(prompt).toContain('rollback: 1 endorsements');
  });

  it('renders approval gate scope when present', () => {
    const withScope = {
      ...mockProtocolResponse,
      governance: {
        approval_gates: [{ action: 'deploy', required_role: 'admin', scope: ['production', 'staging'] }],
      },
    };
    const prompt = generateSystemPrompt(withScope, 'agent_1');
    expect(prompt).toContain('scope: production, staging');
  });
});

describe('generateSystemPrompt — tool hints', () => {
  it('mentions sendMessage tool', () => {
    const prompt = generateSystemPrompt(mockProtocolResponse, 'agent_1');
    expect(prompt).toContain('incubator_sendMessage');
  });

  it('mentions requestHelp tool', () => {
    const prompt = generateSystemPrompt(mockProtocolResponse, 'agent_1');
    expect(prompt).toContain('incubator_requestHelp');
  });

  it('mentions reportProgress tool', () => {
    const prompt = generateSystemPrompt(mockProtocolResponse, 'agent_1');
    expect(prompt).toContain('incubator_reportProgress');
  });

  it('mentions flagConflict tool', () => {
    const prompt = generateSystemPrompt(mockProtocolResponse, 'agent_1');
    expect(prompt).toContain('incubator_flagConflict');
  });

  it('mentions proposeAction when governance present', () => {
    const prompt = generateSystemPrompt(mockWithTeam, 'trader_abc');
    expect(prompt).toContain('incubator_proposeAction');
  });

  it('mentions endorseAction when governance present', () => {
    const prompt = generateSystemPrompt(mockWithTeam, 'trader_abc');
    expect(prompt).toContain('incubator_endorseAction');
  });

  it('mentions escalate when governance present', () => {
    const prompt = generateSystemPrompt(mockWithTeam, 'trader_abc');
    expect(prompt).toContain('incubator_escalate');
  });

  it('does not mention governance tools when no governance', () => {
    const prompt = generateSystemPrompt(mockProtocolResponse, 'agent_1');
    expect(prompt).not.toContain('incubator_proposeAction');
    expect(prompt).not.toContain('incubator_escalate');
  });
});
