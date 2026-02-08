import type { Proposal } from '../types.js';
import type { IProposalStore, IEventStore } from './interfaces.js';
import { randomBytes } from 'node:crypto';

export class ProposalStore implements IProposalStore {
  private proposals = new Map<string, Proposal>();
  private eventStore: IEventStore;

  constructor(eventStore: IEventStore) {
    this.eventStore = eventStore;
  }

  async propose(agentId: string, action: string, detail?: string, quorum?: number): Promise<Proposal> {
    const proposal: Proposal = {
      id: randomBytes(8).toString('hex'),
      proposedBy: agentId,
      action,
      detail,
      requires_quorum: quorum ?? 2,
      endorsements: [agentId],
      status: 'open',
      createdAt: new Date().toISOString(),
    };
    this.proposals.set(proposal.id, proposal);
    await this.eventStore.publish('governance.proposal.created', { proposal_id: proposal.id, action, proposedBy: agentId, requires_quorum: proposal.requires_quorum }, agentId);
    return proposal;
  }

  async endorse(proposalId: string, agentId: string): Promise<Proposal | null> {
    const proposal = this.proposals.get(proposalId);
    if (!proposal || proposal.status !== 'open') return null;
    if (!proposal.endorsements.includes(agentId)) {
      proposal.endorsements.push(agentId);
    }
    if (proposal.endorsements.length >= proposal.requires_quorum) {
      proposal.status = 'approved';
      await this.eventStore.publish('governance.proposal.approved', { proposal_id: proposalId, action: proposal.action, endorsements: proposal.endorsements }, agentId);
    }
    return proposal;
  }

  async list(status?: string): Promise<Proposal[]> {
    const all = [...this.proposals.values()];
    if (!status) return all;
    return all.filter(p => p.status === status);
  }

  async get(proposalId: string): Promise<Proposal | null> {
    return this.proposals.get(proposalId) ?? null;
  }
}
