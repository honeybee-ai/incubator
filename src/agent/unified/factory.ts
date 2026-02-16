/**
 * Agent factory — single creation point replacing orchestrator branches.
 *
 * createAgent() dispatches to the right adapter based on AgentSpec.type.
 */
import type { UnifiedAgent, AgentHook } from './types.js';
import type { AgentSpec } from '../../orchestrator.js';
import { WorkerAgent, type WorkerAgentDeps } from './worker-agent.js';
import { MockAgent, type MockAgentDeps } from './mock-agent.js';
import { ClaudeAgent, type ClaudeAgentOptions } from './claude-agent.js';

export interface FactoryContext {
  /** Dependencies for worker agents */
  workerDeps?: Omit<WorkerAgentDeps, 'provider'> & { provider: import('../types.js').ProviderConfig };
  /** Dependencies for mock agents */
  mockDeps?: Omit<MockAgentDeps, 'behavior'>;
  /** Options for claude agents */
  claudeOptions?: ClaudeAgentOptions;
  /** Hooks to add to every created agent */
  defaultHooks?: AgentHook[];
}

/**
 * Create a UnifiedAgent from an AgentSpec.
 * The factory picks the right adapter and wires dependencies.
 */
export function createAgent(
  spec: AgentSpec,
  agentId: string,
  factoryCtx: FactoryContext,
): UnifiedAgent {
  const type = spec.type ?? 'worker';

  let agent: UnifiedAgent;

  switch (type) {
    case 'worker': {
      if (!factoryCtx.workerDeps) {
        throw new Error('Worker agent requires workerDeps in factory context');
      }
      agent = new WorkerAgent(agentId, spec.role, factoryCtx.workerDeps);
      break;
    }

    case 'mock': {
      const behavior = spec.mock ?? { actions: [] };
      agent = new MockAgent(agentId, spec.role, {
        behavior,
        toolClient: factoryCtx.mockDeps?.toolClient,
        runtime: factoryCtx.mockDeps?.runtime,
        telemetry: factoryCtx.mockDeps?.telemetry,
      });
      break;
    }

    case 'claude': {
      agent = new ClaudeAgent(agentId, spec.role, factoryCtx.claudeOptions);
      break;
    }

    case 'drone': {
      // Phase 2: DroneAgent adapter. For now, fall back to WorkerAgent.
      if (!factoryCtx.workerDeps) {
        throw new Error('Drone agent (using worker fallback) requires workerDeps in factory context');
      }
      agent = new WorkerAgent(agentId, spec.role, factoryCtx.workerDeps);
      break;
    }

    default:
      throw new Error(`Unknown agent type: ${type}`);
  }

  // Apply default hooks
  if (factoryCtx.defaultHooks) {
    for (const hook of factoryCtx.defaultHooks) {
      agent.addHook(hook);
    }
  }

  return agent;
}
