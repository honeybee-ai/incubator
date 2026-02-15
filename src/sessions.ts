import { randomBytes } from 'node:crypto';

/**
 * In-memory session store that maps session tokens to agent IDs.
 *
 * When an agent registers a role via POST /api/roles/request, a session token
 * is generated and returned. Subsequent requests include this token via the
 * X-Session-Token header. The server uses it to verify the caller's identity
 * instead of trusting the client-supplied X-Agent-Id header.
 *
 * This prevents agent ID spoofing (security audit findings R2-H4, R3-H5).
 */
export class SessionStore {
  /** token → agentId */
  private tokenMap = new Map<string, string>();
  /** agentId → token (reverse index for revoke/isRegistered) */
  private agentMap = new Map<string, string>();

  /**
   * Register an agent and return a session token.
   * If the agent already has a token, the existing token is returned.
   */
  register(agentId: string, _role?: string): string {
    const existing = this.agentMap.get(agentId);
    if (existing) return existing;

    const token = randomBytes(24).toString('hex');
    this.tokenMap.set(token, agentId);
    this.agentMap.set(agentId, token);
    return token;
  }

  /** Verify a token and return the associated agent ID, or null. */
  verify(token: string): string | null {
    return this.tokenMap.get(token) ?? null;
  }

  /** Check whether an agent ID has been registered (has a session token). */
  isRegistered(agentId: string): boolean {
    return this.agentMap.has(agentId);
  }

  /** Revoke an agent's session (e.g. on halt or leave). */
  revoke(agentId: string): boolean {
    const token = this.agentMap.get(agentId);
    if (!token) return false;
    this.agentMap.delete(agentId);
    this.tokenMap.delete(token);
    return true;
  }

  /** Clear all sessions (e.g. on reset). */
  clear(): void {
    this.tokenMap.clear();
    this.agentMap.clear();
  }

  /** Number of active sessions. */
  get size(): number {
    return this.agentMap.size;
  }
}
