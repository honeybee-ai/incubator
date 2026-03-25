/**
 * Eval runner — core orchestration for evaluation runs.
 *
 * Spawns an SDLC agent pipeline in an isolated temp dir, waits for
 * completion, runs engineering checks, produces a score card.
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import yaml from 'js-yaml';

import { NamespaceRegistry } from '../namespaces.js';
import { LocalBus } from '../bus.js';
import { loadSpecFile } from '@agentcoordinationprotocol/spec';
import { loadDances } from '../dances.js';
import { PluginManager } from '../plugins/index.js';
import { BroodOrchestrator, type AgentsConfig } from '../orchestrator.js';
import { SessionStore } from '../sessions.js';
import { TelemetryReporter } from '@honeybee-ai/hivemind-sdk/telemetry';
import { fileURLToPath } from 'node:url';

import { typecheckCheck } from './checks/typecheck.js';
import { structureCheck } from './checks/structure.js';
import { securityCheck } from './checks/security.js';
import { testCheck } from './checks/test.js';
import { computeScore } from './scorer.js';
import type {
  EvalTask,
  EvalResult,
  EvalCheckResult,
  EvalProcessMetrics,
  EvalRunOptions,
} from './types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─── Telemetry JSONL parser ─────────────────────────────────

function collectProcessMetrics(telemetryDir: string, wallClockMs: number): EvalProcessMetrics {
  const metrics: EvalProcessMetrics = {
    total_tokens: 0,
    iterations: 0,
    compactions: 0,
    agents_spawned: 0,
    agents_completed: 0,
    agents_errored: 0,
    wall_clock_ms: wallClockMs,
    exit_reasons: {},
  };

  if (!existsSync(telemetryDir)) return metrics;

  const files = readdirSync(telemetryDir).filter(f => f.endsWith('.jsonl'));
  for (const file of files) {
    const content = readFileSync(join(telemetryDir, file), 'utf-8');
    for (const line of content.split('\n')) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line);
        const type = event.type ?? event.event_type;

        switch (type) {
          case 'llm_call':
            metrics.total_tokens += (event.prompt_tokens ?? 0) + (event.completion_tokens ?? 0);
            metrics.iterations++;
            break;
          case 'context_compaction':
            metrics.compactions++;
            break;
          case 'agent_spawn':
            metrics.agents_spawned++;
            break;
          case 'agent_complete': {
            const reason = event.exitReason ?? event.exit_reason ?? 'unknown';
            if (reason === 'error') {
              metrics.agents_errored++;
            } else {
              metrics.agents_completed++;
            }
            metrics.exit_reasons[reason] = (metrics.exit_reasons[reason] ?? 0) + 1;
            break;
          }
          case 'agent_exit': {
            const code = event.exitCode ?? event.exit_code;
            if (code === 0) {
              metrics.agents_completed++;
            } else {
              metrics.agents_errored++;
            }
            break;
          }
        }
      } catch {
        // Malformed JSONL line — skip
      }
    }
  }

  return metrics;
}

// ─── Brood parser helpers ────────────────────────────────────

interface ParsedBrood {
  agents: Array<{
    role: string;
    type?: 'worker' | 'drone' | 'claude' | 'mock';
    tools?: string[];
    workspace?: 'memfs' | 'real';
    prompt?: string;
    wakeOn?: { types?: string[]; timeout?: number; maxWakes?: number };
  }>;
  provider: string;
  models?: Record<string, string>;
  stagger: number;
  env?: Record<string, string>;
  specPath?: string;
  dancesPath?: string;
}

function parseBroodForEval(broodPath: string): ParsedBrood {
  const raw = readFileSync(broodPath, 'utf-8');
  const data = (broodPath.endsWith('.json') ? JSON.parse(raw) : yaml.load(raw)) as Record<string, unknown>;

  const hives = (data.hives ?? {}) as Record<string, Record<string, unknown>>;
  const firstHive = Object.values(hives)[0];
  if (!firstHive) {
    throw new Error('Brood YAML has no hives defined');
  }

  const agents = ((firstHive.agents ?? firstHive.workers ?? []) as Array<Record<string, unknown>>).map(a => ({
    role: String(a.role ?? ''),
    type: (a.type as 'worker' | 'drone' | 'claude' | 'mock' | undefined) ?? 'worker',
    tools: Array.isArray(a.tools) ? a.tools.map(String) : undefined,
    workspace: a.workspace as 'memfs' | 'real' | undefined,
    prompt: typeof a.prompt === 'string' ? a.prompt : undefined,
    wakeOn: a.wake_on ? {
      types: (a.wake_on as Record<string, unknown>).types as string[] | undefined,
      timeout: (a.wake_on as Record<string, unknown>).timeout as number | undefined,
      maxWakes: (a.wake_on as Record<string, unknown>).max_wakes as number | undefined,
    } : undefined,
  }));

  const specRef = firstHive.acp ?? firstHive.spec ?? firstHive.protocol;
  const specPath = typeof specRef === 'string'
    ? resolve(dirname(broodPath), specRef)
    : undefined;

  const dancesRef = firstHive.dances ?? firstHive.logic;
  const dancesPath = typeof dancesRef === 'string'
    ? resolve(dirname(broodPath), dancesRef)
    : undefined;

  return {
    agents,
    provider: typeof data.provider === 'string' ? data.provider : 'ollama/qwen3:8b',
    models: typeof data.models === 'object' ? data.models as Record<string, string> : undefined,
    stagger: typeof data.stagger === 'number' ? data.stagger : 0,
    env: typeof data.env === 'object' ? data.env as Record<string, string> : undefined,
    specPath,
    dancesPath,
  };
}

// ─── Main runner ─────────────────────────────────────────────

/**
 * Run a full evaluation: spawn agents, wait for completion, run checks, score.
 */
export async function runEval(task: EvalTask, opts: EvalRunOptions = {}): Promise<EvalResult> {
  const evalId = randomUUID();
  const timestamp = new Date().toISOString();
  const verbose = opts.verbose ?? false;
  const timeoutS = opts.timeout ?? task.metrics?.max_duration_s ?? 600;

  const log = (msg: string) => {
    if (verbose) console.error(`[eval] ${msg}`);
  };

  // ── Resolve brood path (not needed for dry-run) ────────
  let broodPath = '';
  let brood: ParsedBrood | undefined;
  let provider = opts.providerOverride ?? task.provider ?? 'dry-run';

  if (!opts.dryRunDir) {
    broodPath = resolve(
      opts.broodOverride
        ?? task.brood
        ?? join(__dirname, '..', '..', '..', 'stigmergy', 'sdlc', 'brood.yaml'),
    );

    if (!existsSync(broodPath)) {
      throw new Error(`Brood file not found: ${broodPath}`);
    }

    log(`Brood: ${broodPath}`);
    brood = parseBroodForEval(broodPath);
    provider = opts.providerOverride ?? task.provider ?? brood.provider;
  }

  log(`Provider: ${provider}`);
  if (brood) log(`Agents: ${brood.agents.length}`);

  // ── Create or use worktree ──────────────────────────────
  let workDir: string;
  let ownsWorktree = true;

  if (opts.dryRunDir) {
    workDir = resolve(opts.dryRunDir);
    ownsWorktree = false;
    log(`Dry run — using existing worktree: ${workDir}`);
  } else {
    workDir = mkdtempSync(join(tmpdir(), 'wgl-eval-'));
    log(`Worktree: ${workDir}`);
  }

  // ── Write seed files ────────────────────────────────────
  if (task.seed && !opts.dryRunDir) {
    for (const [filePath, content] of Object.entries(task.seed)) {
      const fullPath = join(workDir, filePath);
      mkdirSync(dirname(fullPath), { recursive: true });
      writeFileSync(fullPath, content);
    }
    log(`Seeded ${Object.keys(task.seed).length} files`);
  }

  // ── Initialize git in worktree ──────────────────────────
  if (!opts.dryRunDir) {
    const { execFileSync } = await import('node:child_process');
    try {
      execFileSync('git', ['init'], { cwd: workDir, stdio: 'ignore' });
      execFileSync('git', ['add', '.'], { cwd: workDir, stdio: 'ignore' });
      execFileSync('git', ['commit', '-m', 'initial seed', '--allow-empty'], {
        cwd: workDir,
        stdio: 'ignore',
        env: {
          ...process.env as Record<string, string>,
          GIT_AUTHOR_NAME: 'eval',
          GIT_AUTHOR_EMAIL: 'eval@honeyb.dev',
          GIT_COMMITTER_NAME: 'eval',
          GIT_COMMITTER_EMAIL: 'eval@honeyb.dev',
        },
      });
      log('Git initialized');
    } catch {
      log('Git init failed (non-fatal)');
    }
  }

  // ── Run agents (unless dry run) ─────────────────────────
  let wallClockMs = 0;
  const telemetryDir = join(tmpdir(), `wgl-eval-telemetry-${evalId}`);
  mkdirSync(telemetryDir, { recursive: true });

  if (!opts.dryRunDir) {
    const startTime = Date.now();
    const b = brood!; // guaranteed defined when not dry-run

    // Create in-process infrastructure
    const registry = new NamespaceRegistry({ type: 'memory' });
    const bus = new LocalBus();
    registry.setBus(bus);
    const stores = registry.get('default');
    const sessionStore = new SessionStore();

    // Load protocol
    if (b.specPath && existsSync(b.specPath)) {
      const specData = await loadSpecFile(b.specPath);
      registry.setProtocol('default', specData);
      log(`Protocol loaded: ${specData.name}`);
    }

    // Load dance module
    let danceModule;
    if (b.dancesPath && existsSync(b.dancesPath)) {
      danceModule = await loadDances(b.dancesPath);
      log(`Dance loaded: ${b.dancesPath}`);
    }

    // Initialize plugins
    const pluginManager = new PluginManager({
      verbose,
      namespace: 'default',
      bus,
      eventStore: stores.events,
    });
    await pluginManager.init();
    pluginManager.buildToolEntries(workDir, null, verbose);

    if (!pluginManager.hasToolEntries()) {
      log('WARNING: No tool entries available — agents may not function correctly');
    } else {
      log(`Plugins loaded: ${pluginManager.getToolCount()} tools`);
    }

    // Create telemetry reporter
    const telemetry = new TelemetryReporter({
      projectRoot: telemetryDir,
      auditCapture: true,
    });

    // Set initial state: task description
    await stores.state.set('task', task.task, '_eval');
    log('Task state set');

    // ── Completion detection ──────────────────────────────
    const completionPromise = new Promise<void>((resolveCompletion) => {
      let resolved = false;
      const done = () => {
        if (!resolved) {
          resolved = true;
          resolveCompletion();
        }
      };

      bus.subscribe('default', (event) => {
        if (event.type === 'phase.changed' && (event.data as Record<string, unknown>)?.to === 'complete') {
          log('Phase changed to complete');
          done();
        }
        if (event.type === 'validation.complete') {
          log('Validation complete event received');
          done();
        }
      });

      // Timeout fallback
      setTimeout(done, timeoutS * 1000);
    });

    // ── Build orchestrator and start ──────────────────────
    const hiveEntryPath = join(__dirname, '..', 'agent', 'cli.js');
    const config: AgentsConfig = {
      provider,
      stagger: b.stagger,
      noAcp: false,
      propolisPort: 0,
      worktree: workDir,
      hiveEntry: hiveEntryPath,
      env: {
        ...b.env,
        // Load provider secrets from ~/.secrets/*.env
        ...loadSecretEnv(),
      },
      agents: b.agents.map(a => ({
        role: a.role,
        type: a.type,
        tools: a.tools,
        workspace: a.workspace,
        prompt: a.prompt,
        wakeOn: a.wakeOn ?? undefined,
      })),
      models: b.models,
    };

    const orch = new BroodOrchestrator(
      config,
      0, // port 0 — no HTTP
      bus,
      stores.runs,
      verbose,
      stores,
      registry,
      danceModule,
      telemetry,
      pluginManager,
      sessionStore,
    );

    log('Starting orchestrator...');

    // Publish start event to trigger agent spawning
    await stores.events.publish('start', { source: 'eval' }, '_eval');

    await orch.start();
    log('Orchestrator started, waiting for completion...');

    await completionPromise;
    log('Completion detected, shutting down...');

    await orch.shutdown();
    await telemetry.stop();
    await bus.close();

    wallClockMs = Date.now() - startTime;
    log(`Pipeline finished in ${(wallClockMs / 1000).toFixed(1)}s`);
  }

  // ── Collect process metrics ─────────────────────────────
  const processMetrics = collectProcessMetrics(telemetryDir, wallClockMs);

  // ── Run checks ──────────────────────────────────────────
  log('Running checks...');

  const allChecks = [
    { check: typecheckCheck, key: 'typecheck' },
    { check: structureCheck, key: 'structure' },
    { check: securityCheck, key: 'security' },
    { check: testCheck, key: 'test' },
  ];

  const checkResults: EvalCheckResult[] = [];

  for (const { check, key } of allChecks) {
    // Skip disabled checks
    const cfg = task.checks?.[key];
    if (cfg && cfg.enabled === false) {
      log(`Check "${key}" disabled — skipping`);
      continue;
    }

    // Only run test check if explicitly configured
    if (key === 'test' && !task.checks?.test) {
      continue;
    }

    try {
      log(`Running check: ${key}`);
      const result = await check.run(workDir, task);
      checkResults.push(result);
      log(`  ${key}: ${result.passed ? 'PASS' : 'FAIL'} (${result.score.toFixed(2)})`);
    } catch (err) {
      checkResults.push({
        name: key,
        passed: false,
        score: 0,
        weight: task.checks?.[key]?.weight ?? 1,
        details: `Check error: ${(err as Error).message}`,
        errors: [(err as Error).message],
        duration_ms: 0,
      });
    }
  }

  // ── Score ───────────────────────────────────────────────
  const { total, grade } = computeScore(checkResults);
  log(`Score: ${total}/100 (${grade})`);

  // ── Build result ────────────────────────────────────────
  const result: EvalResult = {
    id: evalId,
    task_name: task.name,
    timestamp,
    provider,
    brood_file: broodPath,
    checks: checkResults,
    process: processMetrics,
    total_score: total,
    grade,
  };

  if (opts.keepWorktree) {
    result.worktree_path = workDir;
  }

  // ── Save result ─────────────────────────────────────────
  const evalDir = join(homedir(), '.honeyb', 'evals', task.name);
  mkdirSync(evalDir, { recursive: true });
  const resultPath = join(evalDir, `${timestamp.replace(/[:.]/g, '-')}.json`);
  writeFileSync(resultPath, JSON.stringify(result, null, 2));
  log(`Result saved: ${resultPath}`);

  // ── Cleanup ─────────────────────────────────────────────
  if (!opts.keepWorktree && ownsWorktree) {
    try {
      rmSync(workDir, { recursive: true, force: true });
    } catch {
      log('Worktree cleanup failed (non-fatal)');
    }
  }

  // Clean up telemetry temp dir
  try {
    rmSync(telemetryDir, { recursive: true, force: true });
  } catch { /* non-fatal */ }

  return result;
}

/**
 * Load provider secrets from ~/.secrets/*.env files.
 * Returns a flat key=value map.
 */
function loadSecretEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  try {
    const secretsDir = join(homedir(), '.secrets');
    const files = readdirSync(secretsDir).filter(f => f.endsWith('.env'));
    for (const file of files) {
      const content = readFileSync(join(secretsDir, file), 'utf8');
      for (const line of content.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eqIdx = trimmed.indexOf('=');
        if (eqIdx === -1) continue;
        const key = trimmed.slice(0, eqIdx).trim();
        const val = trimmed.slice(eqIdx + 1).trim();
        if (key && val) env[key] = val;
      }
    }
  } catch { /* ~/.secrets/ not available */ }
  return env;
}
