import type { RoleAssignment } from '../types.js';
import type { IRoleStore } from './interfaces.js';

export class RoleStore implements IRoleStore {
  private assignments = new Map<string, RoleAssignment>();

  async assign(agentId: string, role: string): Promise<RoleAssignment> {
    const assignment: RoleAssignment = {
      agent: agentId,
      role,
      assignedAt: new Date().toISOString(),
    };
    this.assignments.set(agentId, assignment);
    return assignment;
  }

  async getAssignments(): Promise<RoleAssignment[]> {
    return [...this.assignments.values()];
  }

  async getByAgent(agentId: string): Promise<RoleAssignment | null> {
    return this.assignments.get(agentId) ?? null;
  }

  async remove(agentId: string): Promise<boolean> {
    return this.assignments.delete(agentId);
  }
}
