import type { HelpRequest } from '../types.js';
import type { IHelpStore, IEventStore } from './interfaces.js';
import { randomBytes } from 'node:crypto';

export class HelpStore implements IHelpStore {
  private requests = new Map<string, HelpRequest>();
  private eventStore: IEventStore;

  constructor(eventStore: IEventStore) {
    this.eventStore = eventStore;
  }

  async request(from: string, problem: string, needs_capability?: string, urgency?: 'low' | 'normal' | 'high'): Promise<HelpRequest> {
    const req: HelpRequest = {
      id: randomBytes(8).toString('hex'),
      from,
      problem,
      needs_capability,
      urgency: urgency ?? 'normal',
      status: 'open',
      createdAt: new Date().toISOString(),
    };
    this.requests.set(req.id, req);
    await this.eventStore.publish('help.requested', { request_id: req.id, from, problem, needs_capability, urgency: req.urgency }, from);
    return req;
  }

  async claim(requestId: string, agentId: string): Promise<HelpRequest | null> {
    const req = this.requests.get(requestId);
    if (!req || req.status !== 'open') return null;
    req.status = 'claimed';
    req.claimedBy = agentId;
    await this.eventStore.publish('help.claimed', { request_id: requestId, claimed_by: agentId }, agentId);
    return req;
  }

  async resolve(requestId: string, agentId: string): Promise<HelpRequest | null> {
    const req = this.requests.get(requestId);
    if (!req || req.status !== 'claimed') return null;
    req.status = 'resolved';
    await this.eventStore.publish('help.resolved', { request_id: requestId, resolved_by: agentId }, agentId);
    return req;
  }

  async list(status?: string): Promise<HelpRequest[]> {
    const all = [...this.requests.values()];
    if (!status) return all;
    return all.filter(r => r.status === status);
  }
}
