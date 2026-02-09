import { vi } from 'vitest';
import type { AcpClient, ApiResponse } from '@agentcoordinationprotocol/sdk';

const ok: ApiResponse = { ok: true, status: 200, data: {} };

/**
 * Create a fully-mocked AcpClient where every method returns `{ ok: true, status: 200, data: {} }`.
 * Pass overrides to customize specific methods.
 */
export function createMockClient(overrides: Partial<Record<keyof AcpClient, ReturnType<typeof vi.fn>>> = {}): AcpClient {
  return {
    health: vi.fn().mockResolvedValue(ok),
    getControlStatus: vi.fn().mockResolvedValue(ok),
    halt: vi.fn().mockResolvedValue(ok),
    pause: vi.fn().mockResolvedValue(ok),
    resume: vi.fn().mockResolvedValue(ok),
    claim: vi.fn().mockResolvedValue(ok),
    releaseClaim: vi.fn().mockResolvedValue(ok),
    getClaims: vi.fn().mockResolvedValue(ok),
    checkClaim: vi.fn().mockResolvedValue(ok),
    listClaims: vi.fn().mockResolvedValue(ok),
    publishEvent: vi.fn().mockResolvedValue(ok),
    getEvents: vi.fn().mockResolvedValue(ok),
    publishDiscovery: vi.fn().mockResolvedValue(ok),
    getDiscoveries: vi.fn().mockResolvedValue(ok),
    searchDiscoveries: vi.fn().mockResolvedValue(ok),
    sendMessage: vi.fn().mockResolvedValue(ok),
    getMessages: vi.fn().mockResolvedValue(ok),
    requestRole: vi.fn().mockResolvedValue(ok),
    getRoles: vi.fn().mockResolvedValue(ok),
    getHelp: vi.fn().mockResolvedValue(ok),
    requestHelp: vi.fn().mockResolvedValue(ok),
    claimHelp: vi.fn().mockResolvedValue(ok),
    resolveHelp: vi.fn().mockResolvedValue(ok),
    reportProgress: vi.fn().mockResolvedValue(ok),
    getProtocol: vi.fn().mockResolvedValue(ok),
    loadProtocol: vi.fn().mockResolvedValue(ok),
    getState: vi.fn().mockResolvedValue(ok),
    getStateKey: vi.fn().mockResolvedValue(ok),
    queryState: vi.fn().mockResolvedValue(ok),
    setState: vi.fn().mockResolvedValue(ok),
    deleteState: vi.fn().mockResolvedValue(ok),
    flagConflict: vi.fn().mockResolvedValue(ok),
    requestReinforcement: vi.fn().mockResolvedValue(ok),
    requestApproval: vi.fn().mockResolvedValue(ok),
    escalate: vi.fn().mockResolvedValue(ok),
    proposeAction: vi.fn().mockResolvedValue(ok),
    endorseAction: vi.fn().mockResolvedValue(ok),
    requestRollback: vi.fn().mockResolvedValue(ok),
    getNamespaces: vi.fn().mockResolvedValue(ok),
    createNamespace: vi.fn().mockResolvedValue(ok),
    deleteNamespace: vi.fn().mockResolvedValue(ok),
    ...overrides,
  } as unknown as AcpClient;
}

/**
 * Reset all mock functions on a client created by createMockClient().
 */
export function resetMockClient(client: AcpClient): void {
  for (const fn of Object.values(client)) {
    if (typeof fn === 'function' && 'mockClear' in fn) {
      (fn as ReturnType<typeof vi.fn>).mockClear();
    }
  }
}
