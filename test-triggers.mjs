#!/usr/bin/env node
/**
 * 69.4 Integration Smoke Tests — TriggerEngine + BroodOrchestrator wiring
 *
 * Spawns incubator as a child process, connects via WebSocket,
 * validates trigger -> event -> spawn -> complete -> restart chains.
 *
 * Zero LLM tokens consumed. Mock agents only.
 *
 * Usage: cd incubator && pnpm run build && node test-triggers.mjs [--port=9876]
 */
import { spawn } from 'node:child_process';
import { WebSocket } from 'ws';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = parseInt((process.argv.find(a => a.startsWith('--port=')) || '--port=9876').split('=')[1]);
const INCUBATOR = join(__dirname, 'dist', 'incubator.js');
const BROOD = join(__dirname, 'test-trigger-brood.yaml');
const BROOD_SCHEDULE = join(__dirname, 'test-trigger-brood-schedule.yaml');

let passed = 0;
let failed = 0;

function ok(cond, msg) {
  if (cond) { console.log(`  \u2713 ${msg}`); passed++; }
  else { console.error(`  \u2717 FAIL: ${msg}`); failed++; }
}

// ─── Server lifecycle ────────────────────────────────────────

function startServer(extraArgs = [], env = {}) {
  return new Promise((resolve, reject) => {
    const args = [INCUBATOR, `--port=${PORT}`, '--verbose', '--no-guard', ...extraArgs];
    const child = spawn(process.execPath, args, {
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let ready = false;
    const timer = setTimeout(() => {
      if (!ready) reject(new Error('Server failed to start within 10s'));
    }, 10_000);

    child.stderr.on('data', (buf) => {
      const line = buf.toString();
      if (!ready && line.includes('listening on port')) {
        ready = true;
        clearTimeout(timer);
        resolve(child);
      }
      if (process.env.VERBOSE) process.stderr.write(`  [server] ${line}`);
    });

    child.on('error', reject);
    child.on('exit', (code) => {
      if (!ready) {
        clearTimeout(timer);
        reject(new Error(`Server exited with code ${code} before ready`));
      }
    });
  });
}

function stopServer(child) {
  return new Promise((resolve) => {
    if (!child || child.exitCode !== null) return resolve();
    child.on('exit', () => resolve());
    child.kill('SIGTERM');
    setTimeout(() => { try { child.kill('SIGKILL'); } catch {} resolve(); }, 3000);
  });
}

// ─── WebSocket helpers ───────────────────────────────────────

function connect() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${PORT}/ws?namespace=default`);
    const events = [];
    const waitMap = new Map(); // type -> [{resolve, timer}]

    let replayResolve;
    const replay = new Promise(r => { replayResolve = r; });

    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'replay_done') { replayResolve(); return; }
      if (msg.type !== 'event') return;
      const evt = msg.event;
      events.push(evt);

      const q = waitMap.get(evt.type);
      if (q?.length) {
        const { resolve: res, timer } = q.shift();
        clearTimeout(timer);
        evt._consumed = true;
        res(evt);
      }
    });

    const c = {
      events,
      replay,

      /** Wait for the next event of this type. Checks unconsumed buffer first. */
      wait(type, ms = 5000) {
        const found = events.find(e => e.type === type && !e._consumed);
        if (found) { found._consumed = true; return Promise.resolve(found); }
        return new Promise((resolve, reject) => {
          const timer = setTimeout(() => {
            const q = waitMap.get(type);
            if (q) { const i = q.findIndex(w => w.timer === timer); if (i >= 0) q.splice(i, 1); }
            reject(new Error(`Timeout: "${type}" not received in ${ms}ms`));
          }, ms);
          if (!waitMap.has(type)) waitMap.set(type, []);
          waitMap.get(type).push({ resolve, timer });
        });
      },

      /** Wait for event matching type + predicate. Skips non-matching events. */
      waitFor(type, pred, ms = 5000) {
        const found = events.find(e => e.type === type && !e._consumed && pred(e));
        if (found) { found._consumed = true; return Promise.resolve(found); }
        return new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error(`Timeout: "${type}" (filtered) not received in ${ms}ms`)), ms);
          const orig = ws.listeners('message');
          const check = () => {
            const hit = events.find(e => e.type === type && !e._consumed && pred(e));
            if (hit) { hit._consumed = true; clearTimeout(timer); ws.off('message', handler); resolve(hit); }
          };
          const handler = () => check();
          ws.on('message', handler);
          // also check in case it arrived between find and listener registration
          check();
        });
      },

      /** Verify no event of this type arrives within ms. */
      absent(type, ms = 1500) {
        const before = events.filter(e => e.type === type).length;
        return new Promise(r => setTimeout(() => {
          r(events.filter(e => e.type === type).length === before);
        }, ms));
      },

      /** Publish an event via WS. */
      publish(event, data = {}) {
        ws.send(JSON.stringify({ type: 'publish', event, data }));
      },

      close() { ws.close(); },
    };

    ws.on('open', () => resolve(c));
    ws.on('error', reject);
  });
}

// ─── Phase 1: Level 1 — env var triggers, no brood ──────────

async function phase1() {
  console.log('\n\u2550\u2550 Level 1: TriggerEngine wiring (env vars, no brood) \u2550\u2550\n');

  const SCHEDULE = JSON.stringify({
    _tick: { every: '2s', action: 'publish', config: { type: 'honeybee.schedule.tick' } },
  });
  const TRIGGERS = JSON.stringify({
    'test.input': { action: 'publish', config: { type: 'test.output' } },
    'test.spawn': 'spawn',
    start: { action: 'publish', config: { type: 'cascade.detected' } },
  });

  const server = await startServer([], {
    HONEYCOMB_SCHEDULE: SCHEDULE,
    HONEYCOMB_TRIGGERS: TRIGGERS,
  });

  try {
    const c = await connect();
    await c.replay;

    // Register schedule waiter early (fires at t~2s)
    const tickPromise = c.wait('honeybee.schedule.tick', 6000);

    // Test 2: Publish trigger fires
    console.log('\u2500 Test 2: Publish trigger (test.input \u2192 test.output)');
    const outputPromise = c.wait('test.output', 5000);
    c.publish('test.input', { hello: 'world' });
    const output = await outputPromise;
    ok(output.type === 'test.output', 'test.output event received');

    // Test 3: spawn action
    console.log('\u2500 Test 3: spawn (test.spawn \u2192 start)');
    const startPromise = c.wait('start', 5000);
    c.publish('test.spawn');
    const startEvt = await startPromise;
    ok(startEvt.type === 'start', 'start event from spawn');
    ok(startEvt.publishedBy === 'trigger:spawn', `publishedBy = "${startEvt.publishedBy}"`);

    // Test 4: Loop prevention
    console.log('\u2500 Test 4: Loop prevention (trigger-published start \u2192 no cascade)');
    const noCascade = await c.absent('cascade.detected', 2000);
    ok(noCascade, 'no cascade.detected \u2014 loop prevention works');

    // Test 1: Schedule fires (waited in parallel with tests 2-4)
    console.log('\u2500 Test 1: Schedule fires');
    const tick = await tickPromise;
    ok(tick.type === 'honeybee.schedule.tick', 'schedule.tick event received');

    c.close();
  } finally {
    await stopServer(server);
  }
}

// ─── Phase 2: Level 2 — brood + restart loop ────────────────

async function phase2() {
  console.log('\n\u2550\u2550 Level 2: Full restart loop (brood + mock agents) \u2550\u2550\n');

  const TRIGGERS = JSON.stringify({
    'honeybee.agents.complete': 'spawn',
  });

  const server = await startServer(
    [`--brood=${BROOD}`],
    { HONEYCOMB_TRIGGERS: TRIGGERS },
  );

  try {
    const c = await connect();
    await c.replay;

    // Test 5: Publish start -> agents.complete
    console.log('\u2500 Test 5: start \u2192 agents run \u2192 agents.complete');
    const completePromise = c.wait('honeybee.agents.complete', 10_000);
    c.publish('start', {});
    await c.wait('start', 5000); // consume the reflected start event
    const complete1 = await completePromise;
    ok(complete1.type === 'honeybee.agents.complete', 'agents.complete received');

    // Test 6: Verify agent counts
    console.log('\u2500 Test 6: agents.complete has correct counts');
    ok(complete1.data?.total === 2, `total = ${complete1.data?.total} (expected 2)`);
    ok(complete1.data?.exited === 2, `exited = ${complete1.data?.exited} (expected 2)`);

    // Test 7: Restart chain
    console.log('\u2500 Test 7: Restart chain (agents.complete \u2192 spawn \u2192 start)');
    const start2 = await c.waitFor('start', e => e.publishedBy === 'trigger:spawn', 5000);
    ok(start2.publishedBy === 'trigger:spawn', `second start from trigger (publishedBy="${start2.publishedBy}")`);

    // Test 8: Second agents.complete
    console.log('\u2500 Test 8: Second agents.complete (restart loop confirmed)');
    const complete2 = await c.wait('honeybee.agents.complete', 10_000);
    ok(complete2.type === 'honeybee.agents.complete', 'second agents.complete received');
    ok(complete2.data?.total === 2, `total = ${complete2.data?.total} (expected 2)`);

    c.close();
  } finally {
    await stopServer(server);
  }
}

// ─── Phase 3: Level 2 — schedule-triggered spawn ────────────

async function phase3() {
  console.log('\n\u2550\u2550 Level 2: Schedule-triggered agent spawn \u2550\u2550\n');

  const SCHEDULE = JSON.stringify({
    auto: { every: '2s', action: 'spawn' },
  });

  const server = await startServer(
    [`--brood=${BROOD}`],
    { HONEYCOMB_SCHEDULE: SCHEDULE },
  );

  try {
    const c = await connect();
    await c.replay;

    // Test 9: Schedule fires spawn -> agents spawn -> agents.complete
    console.log('\u2500 Test 9: Schedule \u2192 spawn \u2192 agents.complete');
    const complete = await c.wait('honeybee.agents.complete', 10_000);
    ok(complete.type === 'honeybee.agents.complete', 'agents.complete from schedule-triggered spawn');
    ok(complete.data?.total === 2, `total = ${complete.data?.total} (expected 2)`);

    c.close();
  } finally {
    await stopServer(server);
  }
}

// ─── Phase 4: Level 3 — brood.yaml schedule/trigger (no env vars) ──

async function phase4() {
  console.log('\n\u2550\u2550 Level 3: brood.yaml schedule + trigger fields (no env vars) \u2550\u2550\n');

  // Start with ONLY --brood pointing to schedule brood file. No env var overrides.
  const server = await startServer([`--brood=${BROOD_SCHEDULE}`]);

  try {
    const c = await connect();
    await c.replay;

    // Test 10: Top-level schedule fires schedule.tick
    console.log('\u2500 Test 10: brood.yaml top-level schedule \u2192 schedule.tick');
    const tick = await c.wait('honeybee.schedule.tick', 6000);
    ok(tick.type === 'honeybee.schedule.tick', 'schedule.tick from brood schedule');

    // Test 11: Per-namespace schedule fires spawn -> start -> agents.complete
    console.log('\u2500 Test 11: brood.yaml per-namespace schedule \u2192 spawn \u2192 agents.complete');
    const complete1 = await c.wait('honeybee.agents.complete', 10_000);
    ok(complete1.type === 'honeybee.agents.complete', 'agents.complete from brood schedule spawn');
    ok(complete1.data?.total === 2, `total = ${complete1.data?.total} (expected 2)`);

    // Test 12: brood.yaml events.on trigger fires restart loop
    // agents.complete already happened above — the on: trigger should fire spawn -> start
    console.log('\u2500 Test 12: brood.yaml events.on (agents.complete \u2192 spawn \u2192 restart)');
    const start2 = await c.waitFor('start', e => e.publishedBy === 'trigger:spawn', 5000);
    ok(start2.publishedBy === 'trigger:spawn', `restart from brood on: trigger (publishedBy="${start2.publishedBy}")`);

    // Confirm second round completes
    const complete2 = await c.wait('honeybee.agents.complete', 10_000);
    ok(complete2.type === 'honeybee.agents.complete', 'second agents.complete (restart loop via brood config)');

    c.close();
  } finally {
    await stopServer(server);
  }
}

// ─── Main ────────────────────────────────────────────────────

const hardTimeout = setTimeout(() => {
  console.error('\nHARD TIMEOUT: tests exceeded 90s');
  process.exit(1);
}, 90_000);

console.log('\u2554\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2557');
console.log('\u2551  69.4 Trigger Integration Smoke Tests         \u2551');
console.log('\u255a\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u255d');

try {
  await phase1();
  await phase2();
  await phase3();
  await phase4();
} catch (err) {
  console.error(`\n\u2717 FATAL: ${err.message}`);
  failed++;
}

clearTimeout(hardTimeout);
const pad = ' '.repeat(Math.max(0, 24 - `${passed}`.length - `${failed}`.length));
console.log(`\n\u2554\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2557`);
console.log(`\u2551  Results: ${passed} passed, ${failed} failed${pad}\u2551`);
console.log(`\u255a\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u255d`);
process.exit(failed > 0 ? 1 : 0);
