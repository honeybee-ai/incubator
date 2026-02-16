/**
 * Eval framework types — engineering agent evaluation.
 *
 * Runs real engineering checks on real code produced by real agents.
 * No LLM-as-judge for hard metrics.
 */

// ─── Task Definition ────────────────────────────────────────

export interface EvalTask {
  name: string;
  description: string;
  /** Instruction text injected as ACP state for agents */
  task: string;
  /** Seed files: filename → content (written to worktree before agents run) */
  seed?: Record<string, string>;
  /** Glob patterns for expected output files */
  expected_files?: string[];
  /** Check configuration overrides */
  checks?: Record<string, EvalCheckConfig>;
  /** Resource limits */
  metrics?: {
    max_tokens?: number;
    max_iterations?: number;
    max_duration_s?: number;
  };
  /** Path to brood.yaml (default: stigmergy/sdlc/brood.yaml) */
  brood?: string;
  /** Override LLM provider */
  provider?: string;
}

export interface EvalCheckConfig {
  weight: number;
  /** Custom command (for test check) */
  command?: string;
  /** Score threshold (for security check) */
  threshold?: number;
  /** Disable this check */
  enabled?: boolean;
}

// ─── Check Interface ────────────────────────────────────────

export interface EvalCheck {
  name: string;
  run(workDir: string, task: EvalTask): Promise<EvalCheckResult>;
}

export interface EvalCheckResult {
  name: string;
  passed: boolean;
  /** 0.0 - 1.0 */
  score: number;
  weight: number;
  details: string;
  errors?: string[];
  duration_ms: number;
}

// ─── Process Metrics ────────────────────────────────────────

export interface EvalProcessMetrics {
  total_tokens: number;
  iterations: number;
  compactions: number;
  agents_spawned: number;
  agents_completed: number;
  agents_errored: number;
  wall_clock_ms: number;
  exit_reasons: Record<string, number>;
}

// ─── Result ─────────────────────────────────────────────────

export interface EvalResult {
  id: string;
  task_name: string;
  timestamp: string;
  provider: string;
  brood_file: string;
  checks: EvalCheckResult[];
  process: EvalProcessMetrics;
  /** 0-100 weighted score */
  total_score: number;
  /** A/B/C/D/F */
  grade: string;
  /** Preserved worktree path (if --keep-worktree) */
  worktree_path?: string;
}

// ─── Runner Options ─────────────────────────────────────────

export interface EvalRunOptions {
  /** Override brood.yaml path */
  broodOverride?: string;
  /** Override LLM provider */
  providerOverride?: string;
  /** Don't delete temp worktree after eval */
  keepWorktree?: boolean;
  /** Print agent logs to stderr */
  verbose?: boolean;
  /** Max duration in seconds (default: 600) */
  timeout?: number;
  /** Skip agent execution — run checks on existing worktree */
  dryRunDir?: string;
}
