import { build } from 'esbuild';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8'));

await build({
  entryPoints: ['src/bin.ts'],
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'esm',
  outfile: 'dist/incubator.js',
  sourcemap: true,
  minify: true,
  external: [
    // Native C++ addon — cannot be bundled
    'better-sqlite3',
    // WebSocket native addon (optional dep)
    'ws',
    // Redis client (optional, large)
    'ioredis',
    // Native PTY addon (propolis optional dep)
    'node-pty',
    // Claude Agent SDK (optional, large — loaded dynamically)
    '@anthropic-ai/claude-agent-sdk',
    // Static file serving (optional)
    'sirv',
    // Propolis (optional, private — loaded dynamically via PluginManager)
    '@honeybee-ai/propolis',
  ],
  banner: {
    js: `#!/usr/bin/env node
/**
 * @honeybee-ai/incubator v${pkg.version}
 * Copyright (c) 2026 Honeybee AI. MIT License.
 * https://honeyb.dev
 */
import{createRequire as __cr}from"node:module";import{fileURLToPath as __fu}from"node:url";import{dirname as __dn}from"node:path";var require=__cr(import.meta.url),__filename=__fu(import.meta.url),__dirname=__dn(__filename);`,
  },
});

console.log(`Built dist/incubator.js (v${pkg.version})`);
