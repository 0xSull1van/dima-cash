export const DEFAULT_SWEEP_TOKEN_FLOOR_ZOLANA = '6500';
export const DEFAULT_SWEEP_MIN_SWEEP_ZOLANA = '0';
export const SWEEP_TOKEN_FLOOR_ENV = 'ZENKO_SWEEP_TOKEN_FLOOR_ZOLANA';
export const SWEEP_MIN_SWEEP_ENV = 'ZENKO_SWEEP_MIN_SWEEP_ZOLANA';

const TOKEN_AMOUNT_RE = /^\d+(?:\.\d+)?$/;

function assertTokenDecimals(decimals) {
  const parsed = Number(decimals);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`invalid token decimals: ${decimals}`);
  }
  return parsed;
}

function normalizeTokenAmount(value, name) {
  const raw = String(value).trim();
  if (!TOKEN_AMOUNT_RE.test(raw)) throw new Error(`invalid ${name}: ${value}`);
  return raw;
}

export function tokenAmountToRawUnits(amount, decimals, name = 'token amount') {
  const tokenDecimals = assertTokenDecimals(decimals);
  const raw = normalizeTokenAmount(amount, name);
  const [whole, frac = ''] = raw.split('.');
  if (frac.length > tokenDecimals) {
    throw new Error(`${name} has too many decimal places for ${tokenDecimals} decimals`);
  }

  const scale = 10n ** BigInt(tokenDecimals);
  const fractional = frac.padEnd(tokenDecimals, '0');
  return (BigInt(whole) * scale) + (fractional ? BigInt(fractional) : 0n);
}

function rawBalance(value) {
  let parsed;
  try {
    parsed = BigInt(value);
  } catch {
    throw new Error(`invalid token balance: ${value}`);
  }
  if (parsed < 0n) throw new Error(`invalid token balance: ${value}`);
  return parsed;
}

function tokenOption(value, fallback, name) {
  if (value === undefined || value === null || value === '') return fallback;
  return normalizeTokenAmount(value, name);
}

export function parseSweepPolicyArgs(argv = [], env = process.env) {
  const opts = {
    live: false,
    tokenFloorZolana: tokenOption(
      env[SWEEP_TOKEN_FLOOR_ENV],
      DEFAULT_SWEEP_TOKEN_FLOOR_ZOLANA,
      'token floor',
    ),
    minSweepZolana: tokenOption(
      env[SWEEP_MIN_SWEEP_ENV],
      DEFAULT_SWEEP_MIN_SWEEP_ZOLANA,
      'min sweep',
    ),
  };

  for (const arg of argv) {
    if (arg === '--live') opts.live = true;
    else if (arg.startsWith('--token-floor=')) {
      opts.tokenFloorZolana = tokenOption(arg.slice('--token-floor='.length), opts.tokenFloorZolana, 'token floor');
    } else if (arg.startsWith('--min-sweep=')) {
      opts.minSweepZolana = tokenOption(arg.slice('--min-sweep='.length), opts.minSweepZolana, 'min sweep');
    } else if (arg.startsWith('--')) {
      throw new Error(`unknown sweep option: ${arg}`);
    }
  }

  return opts;
}

export function calculateZolanaSweep({
  balanceRaw,
  decimals,
  tokenFloorZolana = DEFAULT_SWEEP_TOKEN_FLOOR_ZOLANA,
  minSweepZolana = DEFAULT_SWEEP_MIN_SWEEP_ZOLANA,
} = {}) {
  const tokenDecimals = assertTokenDecimals(decimals);
  const have = rawBalance(balanceRaw);
  const floor = tokenAmountToRawUnits(tokenFloorZolana, tokenDecimals, 'token floor');
  const minSweep = tokenAmountToRawUnits(minSweepZolana, tokenDecimals, 'min sweep');
  const excess = have > floor ? have - floor : 0n;
  const sweepAmount = excess >= minSweep ? excess : 0n;

  return {
    have,
    floor,
    minSweep,
    excess,
    sweepAmount,
  };
}
