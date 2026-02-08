import type { ProgressReport } from '../types.js';
import type { IProgressStore } from './interfaces.js';

export class ProgressStore implements IProgressStore {
  private reports = new Map<string, ProgressReport>();

  async report(claim: string, agentId: string, progress: number, note?: string): Promise<ProgressReport> {
    const report: ProgressReport = {
      claim,
      agent: agentId,
      progress: Math.max(0, Math.min(1, progress)),
      note,
      updatedAt: new Date().toISOString(),
    };
    this.reports.set(claim, report);
    return report;
  }

  async get(claim: string): Promise<ProgressReport | null> {
    return this.reports.get(claim) ?? null;
  }

  async list(): Promise<ProgressReport[]> {
    return [...this.reports.values()];
  }
}
