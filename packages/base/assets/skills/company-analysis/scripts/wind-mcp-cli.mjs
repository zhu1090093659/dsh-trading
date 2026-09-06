#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const skillDir = dirname(dirname(fileURLToPath(import.meta.url)));
const embeddedCli = join(skillDir, 'references', 'wind-mcp-skill', 'scripts', 'cli.mjs');

const child = spawn(process.execPath, [embeddedCli, ...process.argv.slice(2)], {
  stdio: 'inherit',
});

child.on('error', (err) => {
  process.stderr.write(`Failed to start embedded Wind MCP CLI: ${err.message}\n`);
  process.exit(1);
});

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});
