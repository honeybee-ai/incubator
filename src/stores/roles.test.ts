import { describe, it, expect } from 'vitest';
import { RoleStore } from './roles.js';

describe('RoleStore', () => {
  function setup() {
    return new RoleStore();
  }

  it('assigns a role to an agent', async () => {
    const store = setup();
    const assignment = await store.assign('agent_1', 'researcher');
    expect(assignment.agent).toBe('agent_1');
    expect(assignment.role).toBe('researcher');
    expect(assignment.assignedAt).toBeDefined();
  });

  it('gets assignment by agent', async () => {
    const store = setup();
    await store.assign('agent_1', 'researcher');
    const result = await store.getByAgent('agent_1');
    expect(result).not.toBeNull();
    expect(result!.role).toBe('researcher');
  });

  it('returns null for unassigned agent', async () => {
    const store = setup();
    const result = await store.getByAgent('agent_1');
    expect(result).toBeNull();
  });

  it('reassigning overwrites the previous role', async () => {
    const store = setup();
    await store.assign('agent_1', 'researcher');
    await store.assign('agent_1', 'leader');
    const result = await store.getByAgent('agent_1');
    expect(result!.role).toBe('leader');

    // Should only have one assignment for agent_1
    const all = await store.getAssignments();
    const forAgent1 = all.filter(a => a.agent === 'agent_1');
    expect(forAgent1.length).toBe(1);
  });

  it('removes an agent role assignment', async () => {
    const store = setup();
    await store.assign('agent_1', 'researcher');
    const removed = await store.remove('agent_1');
    expect(removed).toBe(true);

    const result = await store.getByAgent('agent_1');
    expect(result).toBeNull();
  });

  it('remove returns false for non-existent agent', async () => {
    const store = setup();
    const removed = await store.remove('agent_1');
    expect(removed).toBe(false);
  });

  it('getAssignments returns all current assignments', async () => {
    const store = setup();
    await store.assign('agent_1', 'researcher');
    await store.assign('agent_2', 'writer');
    await store.assign('agent_3', 'reviewer');

    const all = await store.getAssignments();
    expect(all.length).toBe(3);
    const roles = all.map(a => a.role).sort();
    expect(roles).toEqual(['researcher', 'reviewer', 'writer']);
  });

  it('getAssignments returns empty array initially', async () => {
    const store = setup();
    const all = await store.getAssignments();
    expect(all).toEqual([]);
  });

  it('remove then re-assign works', async () => {
    const store = setup();
    await store.assign('agent_1', 'researcher');
    await store.remove('agent_1');
    await store.assign('agent_1', 'leader');

    const result = await store.getByAgent('agent_1');
    expect(result!.role).toBe('leader');
  });
});
