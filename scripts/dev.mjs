// argus dev launcher — starts dev:server + dev:web with a SHARED, per-launch
// ARGUS_TOKEN so the secure token path is exercised end-to-end in development.
//
// Why a launcher (boundaries.md §4): the token must drive BOTH the server (its
// per-launch bearer) AND the Vite proxy (which injects `Authorization: Bearer
// $ARGUS_TOKEN` server-side). Generating it once here and passing it via env to
// both children keeps the token out of any client JS and off the command line.
// The token is NEVER disabled; the server still validates the header.

import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';

const token = process.env.ARGUS_TOKEN ?? randomBytes(32).toString('hex');
const port = process.env.ARGUS_PORT ?? '4317';
const env = { ...process.env, ARGUS_TOKEN: token, ARGUS_PORT: port };

// Do not print the token by default (redaction). Set ARGUS_PRINT_TOKEN=1 to debug.
if (process.env.ARGUS_PRINT_TOKEN === '1') {
  process.stdout.write(`[argus dev] ARGUS_TOKEN=${token}\n`);
}
process.stdout.write(`[argus dev] server :${port}  web :5173  (token shared via env)\n`);

const children = [
  spawn('npm', ['run', 'dev:server'], { env, stdio: 'inherit' }),
  spawn('npm', ['run', 'dev:web'], { env, stdio: 'inherit' }),
];

function shutdown() {
  for (const c of children) c.kill('SIGINT');
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
for (const c of children) {
  c.on('exit', (code) => {
    if (code && code !== 0) shutdown();
  });
}
