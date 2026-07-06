import test from 'node:test';
import assert from 'node:assert/strict';

import { buildSystemProcesses, parseSystemArgs } from '../scripts/run-system.js';

test('parseSystemArgs defaults bare system startup to working accounts only', () => {
  const opts = parseSystemArgs([]);

  assert.equal(opts.all, false);
  assert.equal(opts.working, true);
  assert.equal(opts.mode, 'autopilot');
  assert.equal(opts.watch, true); // 2026-07-06: auto-restart on code change is on by default
  assert.deepEqual(opts.extraBotArgs, ['--working']);
});

test('parseSystemArgs defaults to full farm startup without live sweep', () => {
  const opts = parseSystemArgs(['--all', '--usd=1.3', '--execute']);

  assert.equal(opts.all, true);
  assert.equal(opts.players, false);
  assert.equal(opts.dashboard, true);
  assert.equal(opts.mode, 'autopilot');
  assert.equal(opts.executeFunding, true);
  assert.equal(opts.sweepLive, false);
  assert.deepEqual(opts.extraBotArgs, ['--all', '--usd=1.3', '--execute']);
});

test('buildSystemProcesses starts dashboard and autopilot under --watch, never sweep by default', () => {
  const processes = buildSystemProcesses(parseSystemArgs(['--all', '--execute']));

  assert.deepEqual(processes.map((p) => p.name), ['dashboard', 'autopilot']);
  assert.equal(processes[0].command, process.execPath);
  // 2026-07-06: dashboard now also runs under --watch — it grew real server logic (Jupiter price
  // poller for market-history.js), not just static-file serving (dashboard.html itself never needed
  // a restart, served fresh per-request already; this is for serve-dashboard.js changes specifically).
  assert.deepEqual(processes[0].args, ['--watch', 'scripts/serve-dashboard.js']);
  assert.deepEqual(processes[1].args, ['--watch', 'scripts/run-autopilot.js', '--all', '--execute']);
  assert.equal(processes.some((p) => p.args.includes('scripts/sweep-funds.js')), false);
  assert.equal(JSON.stringify(processes).includes('--live'), false);
});

test('buildSystemProcesses can run players-only bot without dashboard', () => {
  const processes = buildSystemProcesses(parseSystemArgs(['--bot', '--players', '--no-dashboard']));

  assert.deepEqual(processes.map((p) => p.name), ['bot']);
  assert.deepEqual(processes[0].args, ['--watch', 'scripts/run-bot.js', '--players']);
});

test('--no-watch opts the farm process out of auto-restart', () => {
  const opts = parseSystemArgs(['--bot', '--players', '--no-watch']);
  assert.equal(opts.watch, false);
  assert.equal(opts.extraBotArgs.includes('--no-watch'), false); // must not leak into run-bot.js's own arg parsing

  const processes = buildSystemProcesses(opts);
  assert.deepEqual(processes.find((p) => p.name === 'bot').args, ['scripts/run-bot.js', '--players']);
});

test('parseSystemArgs rejects live sweep because playing wallets retain ZOLANA', () => {
  assert.throws(() => parseSystemArgs(['--sweep-live']), /not supported/i);
});
