import type { AgentRun, IRunStore } from './interfaces.js';

export class RunStore implements IRunStore {
  private runs = new Map<string, AgentRun>();

  async start(agentId: string, role: string): Promise<AgentRun> {
    const run: AgentRun = {
      agentId,
      role,
      status: 'running',
      startedAt: new Date().toISOString(),
    };
    this.runs.set(agentId, run);
    return run;
  }

  async complete(agentId: string, data: Partial<AgentRun>): Promise<AgentRun | null> {
    const run = this.runs.get(agentId);
    if (!run) return null;

    Object.assign(run, data, { completedAt: new Date().toISOString() });
    if (!run.status || run.status === 'running') {
      run.status = 'completed';
    }
    return run;
  }

  async get(agentId: string): Promise<AgentRun | null> {
    return this.runs.get(agentId) ?? null;
  }

  async list(status?: string): Promise<AgentRun[]> {
    const all = [...this.runs.values()];
    if (!status) return all;
    return all.filter(r => r.status === status);
  }

  async summary(): Promise<{ agents: number; completed: number; errors: number; totalTokens: number; totalDuration: number }> {
    let completed = 0;
    let errors = 0;
    let totalTokens = 0;
    let totalDuration = 0;

    for (const run of this.runs.values()) {
      if (run.status === 'completed' || run.status === 'halted') completed++;
      if (run.status === 'error') errors++;
      if (run.usage) totalTokens += run.usage.totalTokens;
      if (run.elapsed) totalDuration += run.elapsed;
    }

    return { agents: this.runs.size, completed, errors, totalTokens, totalDuration };
  }
}
