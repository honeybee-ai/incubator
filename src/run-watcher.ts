import type { NotificationBus } from './bus.js';
import type { IRunStore } from './stores/interfaces.js';
import type { IncubatorEvent } from './types.js';

/**
 * Watches the notification bus for agent lifecycle events and
 * populates the RunStore automatically.
 *
 * Listens for:
 * - role.transition → start a new run
 * - agent.complete  → complete the run with metrics
 */
export class RunWatcher {
  private unsubscribe?: () => void;

  constructor(
    private bus: NotificationBus,
    private runs: IRunStore,
    private namespace = 'default',
  ) {}

  start(): void {
    this.unsubscribe = this.bus.subscribe(this.namespace, (event: IncubatorEvent) => {
      this.handleEvent(event).catch(() => {});
    });
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
  }

  private async handleEvent(event: IncubatorEvent): Promise<void> {
    const data = event.data as Record<string, unknown> | null;
    if (!data) return;

    if (event.type === 'role.transition') {
      const agentId = data.agent as string;
      const role = data.to as string;
      if (agentId && role) {
        await this.runs.start(agentId, role);
      }
    }

    if (event.type === 'agent.complete') {
      const agentId = data.agent as string;
      if (!agentId) return;

      const usage = data.usage as { promptTokens: number; completionTokens: number; totalTokens: number } | undefined;
      const summary = data.summary as string | undefined;
      const iterations = data.iterations as number | undefined;
      const elapsed = data.elapsed as number | undefined;

      // Determine status from summary text
      let status: 'completed' | 'error' | 'halted' = 'completed';
      if (summary?.startsWith('Error:')) status = 'error';
      if (summary === 'Agent halted') status = 'halted';

      await this.runs.complete(agentId, {
        status,
        usage,
        summary,
        iterations,
        elapsed,
        ...(status === 'error' ? { error: summary } : {}),
      });
    }
  }
}
