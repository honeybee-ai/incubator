import type { AcpClient } from '@agentcoordinationprotocol/sdk';

/**
 * Reports agent progress via ACP events.
 */
export class ProgressReporter {
  private client: AcpClient;
  private agentId: string;
  private startTime: number;
  private iterationCount = 0;

  constructor(client: AcpClient, agentId: string) {
    this.client = client;
    this.agentId = agentId;
    this.startTime = Date.now();
  }

  /**
   * Report iteration progress.
   */
  async reportIteration(iteration: number, maxIterations: number): Promise<void> {
    this.iterationCount = iteration;
    const progress = iteration / maxIterations;

    // Only report every 5 iterations to avoid flooding
    if (iteration % 5 !== 0 && iteration !== 1) return;

    try {
      await this.client.publishEvent('agent.progress', {
        agent: this.agentId,
        iteration,
        maxIterations,
        progress: Math.round(progress * 100),
        elapsed: Date.now() - this.startTime,
      });
    } catch {
      // Best-effort reporting
    }
  }

  /**
   * Report completion.
   */
  async reportComplete(summary: string, usage?: { promptTokens: number; completionTokens: number; totalTokens: number }): Promise<void> {
    try {
      await this.client.publishEvent('agent.complete', {
        agent: this.agentId,
        summary,
        iterations: this.iterationCount,
        elapsed: Date.now() - this.startTime,
        ...(usage ? { usage } : {}),
      });
    } catch {
      // Best-effort reporting
    }
  }
}
