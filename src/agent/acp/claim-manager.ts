import type { AcpClient } from '@agentcoordinationprotocol/sdk';

const DEFAULT_TTL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Lazy file-level claim manager. Acquires claims on first write,
 * caches locally, and batch-releases on completion.
 */
export class ClaimManager {
  private client: AcpClient;
  private heldClaims = new Map<string, number>(); // resource → acquire timestamp
  private ttlMs: number;

  constructor(client: AcpClient, ttlMs: number = DEFAULT_TTL_MS) {
    this.client = client;
    this.ttlMs = ttlMs;
  }

  /**
   * Ensure we hold a claim for a file path.
   * Returns null if claim acquired (or already held), or an error message if conflict.
   */
  async ensureClaim(filePath: string): Promise<string | null> {
    const resource = `file:${filePath}`;

    // Already held by us
    if (this.heldClaims.has(resource)) {
      return null;
    }

    try {
      const res = await this.client.claim(resource, `writing to ${filePath}`, { ttlMs: this.ttlMs });
      if (res.ok && res.data.status === 'approved') {
        this.heldClaims.set(resource, Date.now());
        return null;
      }

      // Rejected — another agent holds it
      if (res.data.status === 'rejected') {
        const owner = (res.data as { claim?: { owner?: string } }).claim?.owner ?? 'another agent';
        return `Cannot write to "${filePath}": claimed by ${owner}. Coordinate with them or choose a different file.`;
      }

      return `Claim for "${filePath}" returned unexpected status: ${res.data.status}`;
    } catch (err) {
      // If the server is unreachable, allow the write (best-effort coordination)
      return null;
    }
  }

  /**
   * Release all held claims.
   */
  async releaseAll(): Promise<void> {
    const resources = [...this.heldClaims.keys()];
    for (const resource of resources) {
      try {
        await this.client.releaseClaim(resource);
      } catch {
        // Best-effort release
      }
      this.heldClaims.delete(resource);
    }
  }

  /**
   * Get all currently held claims.
   */
  getHeldClaims(): string[] {
    return [...this.heldClaims.keys()];
  }
}
