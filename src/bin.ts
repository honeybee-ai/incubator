#!/usr/bin/env node
import { main } from './index.js';

main().catch((err) => {
  console.error('[incubator] Fatal error:', (err as Error).message);
  process.exit(1);
});
