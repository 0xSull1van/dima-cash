import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyBootFailure, selectAutopilotAccountNames } from '../src/autopilot.js';
import { parseStaminaFundingArgs } from '../src/stamina-funding.js';

test('autopilot routes ZOLANA gate failures into funding queue', () => {
  const error = new Error('POST /api/player/create -> 403 {"error":"Hold at least 1 $ZOLANA to play"}');
  error.status = 403;
  error.bodyText = '{"error":"Hold at least 1 $ZOLANA to play — you currently hold 0."}';

  assert.equal(classifyBootFailure(error, { executeFunding: true }), 'fund');
  assert.equal(classifyBootFailure(error, { executeFunding: false }), 'dry-run');
  assert.equal(classifyBootFailure(Object.assign(new Error('boom'), { status: 500 }), { executeFunding: true }), 'failed');
});

test('autopilot working mode selects only accounts with live snapshots', () => {
  const fundOpts = parseStaminaFundingArgs(['--working', '--execute'], {});
  const selection = selectAutopilotAccountNames(fundOpts, {
    registryNames: ['main', 'spare', 'cold'],
    hasLiveSnapshot: (name) => name !== 'cold',
  });

  assert.equal(fundOpts.working, true);
  assert.deepEqual(fundOpts.names, []);
  assert.deepEqual(selection.selectedNames, ['main', 'spare']);
  assert.deepEqual(selection.skippedNames, ['cold']);
});
