import type { ReinforcementRequest } from '../types.js';
import type { IReinforcementStore, IEventStore } from './interfaces.js';
import { randomBytes } from 'node:crypto';

export class ReinforcementStore implements IReinforcementStore {
  private requests = new Map<string, ReinforcementRequest>();
  private eventStore: IEventStore;

  constructor(eventStore: IEventStore) {
    this.eventStore = eventStore;
  }

  async request(agentId: string, role: string, count: number, reason?: string): Promise<ReinforcementRequest> {
    const req: ReinforcementRequest = {
      id: randomBytes(8).toString('hex'),
      requestedBy: agentId,
      role,
      count: Math.max(1, count),
      reason,
      status: 'pending',
      createdAt: new Date().toISOString(),
    };
    this.requests.set(req.id, req);
    return req;
  }

  async approve(requestId: string): Promise<ReinforcementRequest | null> {
    const req = this.requests.get(requestId);
    if (!req || req.status !== 'pending') return null;
    req.status = 'approved';
    await this.eventStore.publish('reinforcement.approved', { request_id: requestId, role: req.role, count: req.count }, 'server');
    return req;
  }

  async deny(requestId: string, reason: string): Promise<ReinforcementRequest | null> {
    const req = this.requests.get(requestId);
    if (!req || req.status !== 'pending') return null;
    req.status = 'denied';
    req.denialReason = reason;
    await this.eventStore.publish('reinforcement.denied', { request_id: requestId, role: req.role, reason }, 'server');
    return req;
  }

  async list(): Promise<ReinforcementRequest[]> {
    return [...this.requests.values()];
  }
}
