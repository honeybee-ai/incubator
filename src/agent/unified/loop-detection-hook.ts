/**
 * LoopDetectionHook — extracted from runner.ts inline loop detection.
 *
 * Detects when an agent makes the same tool call(s) N times in a row.
 * Installed as a PostIteration hook.
 */
import type { AgentHook, HookContext, PostIterationPayload, PostIterationResult } from './types.js';

export interface LoopDetectionOptions {
  /** Number of consecutive identical calls before triggering. Default: 3. */
  threshold?: number;
}

export function createLoopDetectionHook(options?: LoopDetectionOptions): AgentHook<'PostIteration'> {
  const threshold = options?.threshold ?? 3;
  let lastSignature = '';
  let repeatCount = 0;

  return {
    name: 'loop-detection',
    point: 'PostIteration',
    priority: 50, // Run early
    handler: (_ctx: HookContext, payload: PostIterationPayload): PostIterationResult | void => {
      // Only track tool-call iterations
      if (!payload.hasToolCalls) {
        lastSignature = '';
        repeatCount = 0;
        return;
      }

      // Use content as a rough signature (tool calls are serialized in content for hook visibility)
      const sig = payload.content ?? '';
      if (sig === lastSignature && sig !== '') {
        repeatCount++;
      } else {
        lastSignature = sig;
        repeatCount = 1;
      }

      if (repeatCount >= threshold) {
        return { stop: `Loop detected: same tool call repeated ${repeatCount} times` };
      }
    },
  };
}
