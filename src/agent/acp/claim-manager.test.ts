import { describe, it, expect, vi } from 'vitest';
import { ClaimManager } from './claim-manager.js';

function createMockClient(claimStatus: 'approved' | 'rejected' = 'approved') {
  return {
    claim: vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      data: {
        status: claimStatus,
        claim: claimStatus === 'rejected' ? { owner: 'other-agent' } : { owner: 'self' },
      },
    }),
    releaseClaim: vi.fn().mockResolvedValue({ ok: true, status: 200, data: {} }),
  } as unknown as Parameters<typeof ClaimManager extends new (client: infer C, ...args: unknown[]) => unknown ? C : never>[0];
}

describe('ClaimManager', () => {
  it('acquires a claim on first write', async () => {
    const client = createMockClient('approved');
    const manager = new ClaimManager(client as any);

    const result = await manager.ensureClaim('src/main.ts');
    expect(result).toBeNull(); // no error
    expect(client.claim).toHaveBeenCalledWith('file:src/main.ts', 'writing to src/main.ts', { ttlMs: 300000 });
  });

  it('caches claims — second call does not re-claim', async () => {
    const client = createMockClient('approved');
    const manager = new ClaimManager(client as any);

    await manager.ensureClaim('src/main.ts');
    await manager.ensureClaim('src/main.ts');
    expect(client.claim).toHaveBeenCalledTimes(1);
  });

  it('returns error message on claim conflict', async () => {
    const client = createMockClient('rejected');
    const manager = new ClaimManager(client as any);

    const result = await manager.ensureClaim('src/main.ts');
    expect(result).toContain('other-agent');
    expect(result).toContain('Cannot write');
  });

  it('releases all held claims', async () => {
    const client = createMockClient('approved');
    const manager = new ClaimManager(client as any);

    await manager.ensureClaim('a.ts');
    await manager.ensureClaim('b.ts');
    expect(manager.getHeldClaims()).toHaveLength(2);

    await manager.releaseAll();
    expect(manager.getHeldClaims()).toHaveLength(0);
    expect(client.releaseClaim).toHaveBeenCalledTimes(2);
  });

  it('handles server errors gracefully', async () => {
    const client = {
      claim: vi.fn().mockRejectedValue(new Error('network error')),
      releaseClaim: vi.fn().mockRejectedValue(new Error('network error')),
    };
    const manager = new ClaimManager(client as any);

    // Should not throw, returns null (best-effort)
    const result = await manager.ensureClaim('src/main.ts');
    expect(result).toBeNull();
  });
});
