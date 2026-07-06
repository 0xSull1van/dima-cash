// One-command local supervisor: dashboard + farm loop.
// ZOLANA stays on the playing wallets. This script intentionally does not
// start sweep-funds.js or accept a live sweep flag.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

export function parseSystemArgs(argv = []) {
  const opts = {
    all: false,
    working: false,
    players: false,
    dashboard: true,
    mode: 'autopilot',
    executeFunding: false,
    sweepLive: false,
    watch: true,
    extraBotArgs: [],
  };
  let hasAccountSelector = false;

  for (const arg of argv) {
    if (arg === '--sweep-live' || arg === '--sweep' || arg === '--withdraw-live') {
      throw new Error('live sweep is not supported by system startup; playing wallets retain ZOLANA');
    }
    if (arg === '--bot') {
      opts.mode = 'bot';
      continue;
    }
    if (arg === '--autopilot') {
      opts.mode = 'autopilot';
      continue;
    }
    if (arg === '--no-dashboard') {
      opts.dashboard = false;
      continue;
    }
    if (arg === '--no-watch') {
      opts.watch = false;
      continue;
    }
    if (arg === '--all') {
      opts.all = true;
      hasAccountSelector = true;
    }
    if (arg === '--working') {
      opts.working = true;
      hasAccountSelector = true;
    }
    if (arg === '--players') {
      opts.players = true;
      hasAccountSelector = true;
      if (opts.mode === 'autopilot') opts.mode = 'bot';
    }
    if (!arg.startsWith('--')) hasAccountSelector = true;
    if (arg === '--execute') opts.executeFunding = true;
    opts.extraBotArgs.push(arg);
  }

  if (!hasAccountSelector) {
    if (opts.mode === 'bot') {
      opts.players = true;
      opts.extraBotArgs.push('--players');
    } else {
      opts.working = true;
      opts.extraBotArgs.push('--working');
    }
  }

  return opts;
}

export function buildSystemProcesses(opts = parseSystemArgs()) {
  const processes = [];
  if (opts.dashboard) {
    // 2026-07-06: dashboard now has real server-side logic too (Jupiter price poller for
    // market-history.js), not just static-file serving — same --watch rationale as the farm
    // process below applies here now. dashboard.html itself never needed this (served fresh
    // per-request already); this is specifically for changes to serve-dashboard.js.
    const dashArgs = opts.watch ? ['--watch', 'scripts/serve-dashboard.js'] : ['scripts/serve-dashboard.js'];
    processes.push({
      name: 'dashboard',
      command: process.execPath,
      args: dashArgs,
    });
  }

  const farmScript = opts.mode === 'bot' ? 'scripts/run-bot.js' : 'scripts/run-autopilot.js';
  // --watch (Node 20 built-in, default ON): auto-restarts the farm process when an IMPORTED source
  // file changes — owner was manually re-running `npm run system` after every code fix this session,
  // losing time. Verified in isolation (2026-07-06) that --watch tracks only the require/import graph,
  // NOT arbitrary writes elsewhere in the project — the fleet's own high-frequency logs/*.jsonl and
  // live-*.json writes do NOT trigger a restart loop. `--no-watch` opts back out if ever needed.
  const nodeArgs = opts.watch ? ['--watch', farmScript] : [farmScript];
  processes.push({
    name: opts.mode === 'bot' ? 'bot' : 'autopilot',
    command: process.execPath,
    args: [...nodeArgs, ...opts.extraBotArgs],
  });
  return processes;
}

export async function main(argv = process.argv.slice(2)) {
  const opts = parseSystemArgs(argv);
  const children = buildSystemProcesses(opts).map((proc) => {
    console.log(`[system] starting ${proc.name}: ${proc.command} ${proc.args.join(' ')}`);
    const child = spawn(proc.command, proc.args, {
      cwd: resolve(fileURLToPath(new URL('..', import.meta.url))),
      env: process.env,
      stdio: 'inherit',
      windowsHide: false,
    });
    child.on('exit', (code, signal) => {
      if (signal) console.log(`[system] ${proc.name} stopped by ${signal}`);
      else console.log(`[system] ${proc.name} exited with ${code}`);
      if (code && code !== 0) process.exitCode = code;
    });
    return child;
  });

  const stop = () => {
    console.log('\n[system] stopping...');
    for (const child of children) {
      if (!child.killed) child.kill('SIGINT');
    }
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((error) => {
    console.error(error.message || error);
    process.exit(1);
  });
}
