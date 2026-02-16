import { describe, it, expect } from 'vitest';
import { createLoopDetectionHook } from './loop-detection-hook.js';
import type { HookContext, PostIterationPayload } from './types.js';
import type { TokenUsage } from '../types.js';

const CTX: HookContext = { agentId: 'test-1', role: 'dev', iteration: 1 };
const ZERO_USAGE: TokenUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };

function makePayload(content: string | null, hasToolCalls: boolean): PostIterationPayload {
  return { content, hasToolCalls, usage: ZERO_USAGE, totalTokens: 0 };
}

describe('createLoopDetectionHook', () => {
  it('returns hook with correct metadata', () => {
    const hook = createLoopDetectionHook();
    expect(hook.name).toBe('loop-detection');
    expect(hook.point).toBe('PostIteration');
    expect(hook.priority).toBe(50);
  });

  it('does not trigger below threshold', () => {
    const hook = createLoopDetectionHook({ threshold: 3 });

    // Same call twice = under threshold
    const r1 = hook.handler(CTX, makePayload('read_file:main.ts', true));
    expect(r1).toBeUndefined();

    const r2 = hook.handler(CTX, makePayload('read_file:main.ts', true));
    expect(r2).toBeUndefined();
  });

  it('triggers at threshold', () => {
    const hook = createLoopDetectionHook({ threshold: 3 });

    hook.handler(CTX, makePayload('same-call', true));
    hook.handler(CTX, makePayload('same-call', true));
    const result = hook.handler(CTX, makePayload('same-call', true));

    expect(result).toBeDefined();
    expect(result?.stop).toContain('Loop detected');
    expect(result?.stop).toContain('3');
  });

  it('resets on different tool call', () => {
    const hook = createLoopDetectionHook({ threshold: 3 });

    hook.handler(CTX, makePayload('call-A', true));
    hook.handler(CTX, makePayload('call-A', true));
    // Different call resets counter
    hook.handler(CTX, makePayload('call-B', true));
    const result = hook.handler(CTX, makePayload('call-B', true));

    expect(result).toBeUndefined();
  });

  it('resets on non-tool-call iteration', () => {
    const hook = createLoopDetectionHook({ threshold: 3 });

    hook.handler(CTX, makePayload('same', true));
    hook.handler(CTX, makePayload('same', true));
    // No tool calls = reset
    hook.handler(CTX, makePayload('text only', false));
    const result = hook.handler(CTX, makePayload('same', true));

    expect(result).toBeUndefined();
  });

  it('uses default threshold of 3', () => {
    const hook = createLoopDetectionHook();

    hook.handler(CTX, makePayload('x', true));
    hook.handler(CTX, makePayload('x', true));
    const result = hook.handler(CTX, makePayload('x', true));

    expect(result?.stop).toContain('Loop detected');
  });

  it('supports custom threshold', () => {
    const hook = createLoopDetectionHook({ threshold: 5 });

    for (let i = 0; i < 4; i++) {
      expect(hook.handler(CTX, makePayload('x', true))).toBeUndefined();
    }
    const result = hook.handler(CTX, makePayload('x', true));
    expect(result?.stop).toContain('5');
  });

  it('ignores empty content signatures', () => {
    const hook = createLoopDetectionHook({ threshold: 2 });

    // Empty string content shouldn't trigger loop detection
    hook.handler(CTX, makePayload('', true));
    const result = hook.handler(CTX, makePayload('', true));

    // Empty signatures are ignored (reset)
    expect(result).toBeUndefined();
  });
});
