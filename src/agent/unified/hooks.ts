/**
 * Hook execution engine — priority-sorted, runs in order.
 * Matches Claude Agent SDK hook naming convention.
 */
import type {
  AgentHook,
  HookPoint,
  HookContext,
  HookPayloadMap,
  PreToolUseResult,
  PostToolUseResult,
  PreIterationResult,
  PostIterationResult,
  OnErrorResult,
} from './types.js';

const DEFAULT_PRIORITY = 100;

export class HookEngine {
  private hooks = new Map<HookPoint, AgentHook[]>();

  add(hook: AgentHook): void {
    const point = hook.point;
    if (!this.hooks.has(point)) {
      this.hooks.set(point, []);
    }
    const list = this.hooks.get(point)!;
    // Remove existing hook with same name (replace)
    const idx = list.findIndex(h => h.name === hook.name);
    if (idx >= 0) list.splice(idx, 1);
    list.push(hook);
    // Sort by priority (ascending — lower runs first)
    list.sort((a, b) => (a.priority ?? DEFAULT_PRIORITY) - (b.priority ?? DEFAULT_PRIORITY));
  }

  remove(name: string): void {
    for (const [point, list] of this.hooks) {
      const idx = list.findIndex(h => h.name === name);
      if (idx >= 0) {
        list.splice(idx, 1);
        if (list.length === 0) this.hooks.delete(point);
      }
    }
  }

  has(name: string): boolean {
    for (const list of this.hooks.values()) {
      if (list.some(h => h.name === name)) return true;
    }
    return false;
  }

  getHooks(point: HookPoint): AgentHook[] {
    return this.hooks.get(point) ?? [];
  }

  /**
   * Run all hooks for a given point. Returns merged result.
   * For PreToolUse: first `block` wins.
   * For PostToolUse: last `result` wins.
   * For PreIteration: first `block` wins, injects are concatenated.
   * For PostIteration: first `stop` wins.
   * For OnError: first `recover: true` wins.
   */
  async run<T extends HookPoint>(
    point: T,
    ctx: HookContext,
    payload: HookPayloadMap[T]['payload'],
  ): Promise<HookPayloadMap[T]['result']> {
    const hooks = this.hooks.get(point);
    if (!hooks || hooks.length === 0) return undefined as HookPayloadMap[T]['result'];

    let merged: Record<string, unknown> = {};

    for (const hook of hooks) {
      try {
        const result = await hook.handler(ctx, payload);
        if (!result) continue;

        const res = result as Record<string, unknown>;

        if (point === 'PreToolUse') {
          // First block wins
          if (res.block && !merged.block) {
            merged.block = res.block;
          }
          // Last args wins
          if (res.args) {
            merged.args = res.args;
            // Update payload for next hook
            (payload as unknown as Record<string, unknown>).args = res.args;
          }
        } else if (point === 'PostToolUse') {
          // Last result wins
          if (res.result !== undefined) {
            merged.result = res.result;
          }
        } else if (point === 'PreIteration') {
          // First block wins
          if (res.block && !merged.block) {
            merged.block = res.block;
          }
          // Injects concatenate
          if (res.inject) {
            merged.inject = merged.inject
              ? `${merged.inject}\n${res.inject}`
              : res.inject;
          }
        } else if (point === 'PostIteration') {
          // First stop wins
          if (res.stop && !merged.stop) {
            merged.stop = res.stop;
          }
        } else if (point === 'OnError') {
          // First recover wins
          if (res.recover && !merged.recover) {
            merged.recover = res.recover;
          }
        }
      } catch {
        // Hook errors are swallowed — hooks must never break the agent
      }
    }

    return (Object.keys(merged).length > 0 ? merged : undefined) as HookPayloadMap[T]['result'];
  }

  clear(): void {
    this.hooks.clear();
  }
}
