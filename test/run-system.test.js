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

test('buildSystemProcesses starts dashboard + autopilot + rebalance under --watch, never sweep by default', () => {
  const processes = buildSystemProcesses(parseSystemArgs(['--all', '--execute']));

  // 2026-07-06: the rebalancer is on by default now (owner request) — see the rebalance test above.
  // discord-floor is token-gated (ambient .env) and orthogonal to the process-args logic here — filter it out.
  assert.deepEqual(processes.map((p) => p.name).filter((n) => n !== 'discord-floor'), ['dashboard', 'autopilot', 'rebalance']);
  assert.equal(processes[0].command, process.execPath);
  // dashboard also runs under --watch — it grew real server logic (Jupiter price poller for
  // market-history.js), not just static-file serving (dashboard.html is served fresh per-request).
  assert.deepEqual(processes[0].args, ['--watch', 'scripts/serve-dashboard.js']);
  assert.deepEqual(processes[1].args, ['--watch', 'scripts/run-autopilot.js', '--all', '--execute']);
  assert.equal(processes.some((p) => p.args.includes('scripts/sweep-funds.js')), false);
  assert.equal(JSON.stringify(processes).includes('--live'), false);
});

test('buildSystemProcesses can run a players-only bot without dashboard (rebalance still on)', () => {
  const processes = buildSystemProcesses(parseSystemArgs(['--bot', '--players', '--no-dashboard']));

  assert.deepEqual(processes.map((p) => p.name).filter((n) => n !== 'discord-floor'), ['bot', 'rebalance']);
  assert.deepEqual(processes.find((p) => p.name === 'bot').args, ['--watch', 'scripts/run-bot.js', '--players']);
});

test('buildSystemProcesses adds the discord-floor tracker when DISCORD_TOKEN is configured', () => {
  const prev = process.env.DISCORD_TOKEN;
  process.env.DISCORD_TOKEN = 'x';
  try {
    const names = buildSystemProcesses(parseSystemArgs(['--all', '--execute'])).map((p) => p.name);
    assert.ok(names.includes('discord-floor'), 'the tracker runs alongside the fleet when a token is set');
  } finally { if (prev === undefined) delete process.env.DISCORD_TOKEN; else process.env.DISCORD_TOKEN = prev; }
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

test('auto-rebalancer is ON by default; --no-rebalance opts out; --rebalance-min sets the interval', () => {
  // default-on (2026-07-06): a plain startup includes the account-to-account rebalancer
  const onByDefault = buildSystemProcesses(parseSystemArgs(['--all']));
  const reb = onByDefault.find((p) => p.name === 'rebalance');
  assert.ok(reb, 'rebalance process present by default');
  assert.deepEqual(reb.args, ['scripts/rebalance-zolana.js', '--execute', '--watch-min=20']);

  // --no-rebalance disables it
  const off = buildSystemProcesses(parseSystemArgs(['--all', '--no-rebalance']));
  assert.equal(off.some((p) => p.name === 'rebalance'), false);
  assert.equal(JSON.stringify(off).includes('rebalance-zolana.js'), false);

  // interval override, and the flags must not leak into the farm script's own args
  const opts = parseSystemArgs(['--all', '--rebalance-min=15']);
  assert.equal(opts.rebalance, true);
  assert.equal(opts.rebalanceMin, 15);
  assert.equal(opts.extraBotArgs.includes('--no-rebalance'), false);
  assert.equal(opts.extraBotArgs.includes('--rebalance-min=15'), false);
  assert.deepEqual(buildSystemProcesses(opts).find((p) => p.name === 'rebalance').args,
    ['scripts/rebalance-zolana.js', '--execute', '--watch-min=15']);
});
