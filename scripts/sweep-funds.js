// Consolidate funds from accounts.json into one external wallet.
// v2: token-only sweep across ALL accounts. SOL is left untouched
// everywhere (accounts keep their SOL to keep paying tx fees for the bot) — a sponsor
// wallet (SPONSOR_NAME) pays every network fee + one-time destination-ATA rent instead.
//
// Dry-run by default — prints the plan, sends nothing. Pass --live to actually broadcast.
import { Connection, Keypair, PublicKey, Transaction, sendAndConfirmTransaction } from '@solana/web3.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadEnv, requireMasterKey } from '../src/env.js';
import { loadWallet } from '../src/wallet.js';
import {
  DEFAULT_SOLANA_RPC,
  ZOLANA_MINT,
  mintInfo,
  associatedTokenAddress,
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferCheckedInstruction,
} from '../src/stamina.js';
import { calculateZolanaSweep, parseSweepPolicyArgs } from '../src/sweep-policy.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DESTINATION = 'Hms9MVSMc14go22KMSVpyb3ZQL1WRCLomXeZRWwfTkoe';
const SPONSOR_NAME = 'Ember'; // pays tx fees + destination-ATA rent so source wallets' SOL stays untouched

loadEnv();
const sweepOpts = parseSweepPolicyArgs(process.argv.slice(2), process.env);
const LIVE = sweepOpts.live;
const masterKey = requireMasterKey();

const { accounts } = JSON.parse(readFileSync(join(__dirname, '..', 'accounts.json'), 'utf8'));
const rpcUrl = process.env.SOLANA_RPC_URL || DEFAULT_SOLANA_RPC;
const connection = new Connection(rpcUrl, 'confirmed');
const destinationPk = new PublicKey(DESTINATION);
const mintPk = new PublicKey(ZOLANA_MINT);
const sponsorWallet = loadWallet(SPONSOR_NAME, masterKey);
const sponsorKeypair = Keypair.fromSecretKey(sponsorWallet.secretKey);

function fmt(raw, decimals) {
  return (Number(raw) / 10 ** decimals).toLocaleString('en-US', { maximumFractionDigits: decimals });
}

async function planAccount(entry, index) {
  const wallet = loadWallet(entry.name, masterKey);
  const owner = new PublicKey(wallet.address);

  const solBalance = BigInt(await connection.getBalance(owner, 'confirmed'));

  const { programId, decimals } = await mintInfo(connection, mintPk, 'confirmed');
  const source = associatedTokenAddress(mintPk, owner, programId);
  const bal = await connection.getTokenAccountBalance(source, 'confirmed').catch(() => null);
  const have = bal ? BigInt(bal.value.amount) : 0n;
  const policy = calculateZolanaSweep({
    balanceRaw: have,
    decimals,
    tokenFloorZolana: sweepOpts.tokenFloorZolana,
    minSweepZolana: sweepOpts.minSweepZolana,
  });
  const tokenPlan = { programId, decimals, source, ...policy };

  return { name: entry.name, index, wallet, owner, solBalance, tokenPlan };
}

async function executeAccount(plan) {
  const { wallet, owner, tokenPlan } = plan;
  const ixs = [];

  if (tokenPlan.sweepAmount > 0n) {
    const destAta = associatedTokenAddress(mintPk, destinationPk, tokenPlan.programId);
    // sponsor pays ATA rent (payer = sponsor pubkey), owner only authorizes the token transfer
    ixs.push(createAssociatedTokenAccountIdempotentInstruction(sponsorKeypair.publicKey, destAta, destinationPk, mintPk, tokenPlan.programId));
    ixs.push(createTransferCheckedInstruction(
      tokenPlan.source, mintPk, destAta, owner, tokenPlan.sweepAmount, tokenPlan.decimals, tokenPlan.programId,
    ));
  }
  if (!ixs.length) return null;

  const ownerPayer = Keypair.fromSecretKey(wallet.secretKey);
  const tx = new Transaction().add(...ixs);
  tx.feePayer = sponsorKeypair.publicKey;
  const signers = ownerPayer.publicKey.equals(sponsorKeypair.publicKey) ? [sponsorKeypair] : [sponsorKeypair, ownerPayer];
  return sendAndConfirmTransaction(connection, tx, signers, { commitment: 'confirmed', preflightCommitment: 'confirmed' });
}

const plans = [];
for (let i = 0; i < accounts.length; i++) {
  plans.push(await planAccount(accounts[i], i + 1));
}

let totalToken = 0n;
let tokenDecimals = null;

console.log(`\nDestination: ${DESTINATION}`);
console.log(`RPC: ${rpcUrl}`);
console.log(`ZOLANA token floor: ${sweepOpts.tokenFloorZolana}`);
console.log(`ZOLANA min sweep: ${sweepOpts.minSweepZolana}`);
console.log(`Mode: ${LIVE ? 'LIVE — will broadcast' : 'DRY RUN — nothing will be sent'}\n`);
console.log('idx name         SOL bal (untouched)   ZOLANA bal      ZOLANA sweep   floor          min sweep');
console.log('--------------------------------------------------------------------------------------------');

for (const p of plans) {
  const solBalStr = (Number(p.solBalance) / 1e9).toFixed(6);
  tokenDecimals = p.tokenPlan.decimals;
  totalToken += p.tokenPlan.sweepAmount;
  const tokLine = `${fmt(p.tokenPlan.have, p.tokenPlan.decimals).padEnd(14)} ${fmt(p.tokenPlan.sweepAmount, p.tokenPlan.decimals).padEnd(14)} ${fmt(p.tokenPlan.floor, p.tokenPlan.decimals).padEnd(14)} ${fmt(p.tokenPlan.minSweep, p.tokenPlan.decimals)}`;
  console.log(`${String(p.index).padStart(2)}  ${p.name.padEnd(12)} ${solBalStr.padEnd(21)} ${tokLine}`);
}

console.log('--------------------------------------------------------------------------------------------');
if (tokenDecimals !== null) console.log(`TOTAL ZOLANA to sweep: ${fmt(totalToken, tokenDecimals)} ZOLANA`);

if (!LIVE) {
  console.log('\nDry run only. Re-run with --live to actually broadcast these transfers.');
  process.exit(0);
}

console.log('\nBroadcasting...\n');
for (const plan of plans) {
  const needsToken = plan.tokenPlan.sweepAmount > 0n;
  if (!needsToken) {
    console.log(`${plan.name}: nothing to sweep, skipped`);
    continue;
  }
  try {
    const sig = await executeAccount(plan);
    console.log(`${plan.name}: OK ${sig}`);
  } catch (err) {
    console.error(`${plan.name}: FAILED ${err.message}`);
  }
}
