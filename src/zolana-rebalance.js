// Rebalance $ZOLANA across fleet wallets (2026-07-06, owner: "where it's short, let another account
// share; everyone should always hold ~12k so the 10k market gate never closes").
//
// ⚠️ REAL MONEY: direct wallet→wallet SPL transfers. The planner is pure and testable; execution only
// under ZENKO_MASTER_KEY (see scripts/rebalance-zolana.js), dry-run by default. Anti-detection: amounts
// are non-round (jittered), pauses between transfers are human (fundingDelayMs). A direct transfer links
// the wallets on-chain — an owner-accepted trade-off (the wallets were funded from a common source anyway).
import { Connection, PublicKey, Transaction, sendAndConfirmTransaction, Keypair } from '@solana/web3.js';
import {
  DEFAULT_SOLANA_RPC,
  ZOLANA_MINT,
  mintInfo,
  associatedTokenAddress,
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferCheckedInstruction,
  toTokenUnits,
} from './stamina.js';

export const REBALANCE_THRESHOLD = 10_000; // below → market gate closed, account is a recipient
export const REBALANCE_TARGET = 12_000;    // top up to this level ("everyone at ~12000")
export const REBALANCE_DONOR_FLOOR = 13_500; // a donor never drops below this (target + stamina buffer)

// Pure planner: who's short and who shares. accounts: [{name, address, zolana}].
// Greedy: the richest donor covers the largest need; amounts jittered +0..4% with a non-round
// tail (not exactly 12000 for everyone — more human). Returns {transfers, unmet}.
export function planZolanaRebalance(accounts = [], {
  threshold = REBALANCE_THRESHOLD,
  target = REBALANCE_TARGET,
  donorFloor = REBALANCE_DONOR_FLOOR,
  rng = Math.random,
} = {}) {
  const valid = (accounts || []).filter(a => a && a.name && a.address && Number.isFinite(Number(a.zolana)));
  const donors = valid
    .filter(a => Number(a.zolana) > donorFloor)
    .map(a => ({ ...a, avail: Number(a.zolana) - donorFloor }))
    .sort((x, y) => y.avail - x.avail);
  const needs = valid
    .filter(a => Number(a.zolana) < threshold)
    .map(a => {
      const base = target - Number(a.zolana);
      // jitter up + non-round tail: the recipient lands at 12k..12.5k+, not exactly on target
      const amount = Math.round(base * (1 + rng() * 0.04)) + Math.floor(rng() * 18);
      return { ...a, need: amount };
    })
    .sort((x, y) => y.need - x.need);

  const transfers = [];
  const unmet = [];
  for (const r of needs) {
    let remaining = r.need;
    for (const d of donors) {
      if (remaining <= 0) break;
      if (d.avail <= 0 || d.name === r.name) continue;
      const amount = Math.min(remaining, Math.floor(d.avail));
      if (amount < 1) continue;
      transfers.push({ from: d.name, fromAddress: d.address, to: r.name, toAddress: r.address, amount });
      d.avail -= amount;
      remaining -= amount;
    }
    if (remaining > 0) unmet.push({ name: r.name, short: remaining });
  }
  return { transfers, unmet, donors: donors.map(d => d.name), recipients: needs.map(n => n.name) };
}

// Generic SPL ZOLANA transfer (same path as the production createStaminaRefillPayment, but the
// recipient is an arbitrary fleet wallet; the recipient's ATA is created idempotently by the sender).
export async function sendZolana(wallet, {
  toAddress,
  amountZolana,
  rpcUrl = process.env.SOLANA_RPC_URL || DEFAULT_SOLANA_RPC,
  mint = ZOLANA_MINT,
  commitment = 'confirmed',
  connectionFactory = (url) => new Connection(url, commitment),
} = {}) {
  if (!wallet?.secretKey) throw new Error('sender wallet secret key required');
  if (!toAddress) throw new Error('recipient address required');
  if (!(Number(amountZolana) > 0)) throw new Error(`invalid transfer amount: ${amountZolana}`);
  const payer = Keypair.fromSecretKey(wallet.secretKey instanceof Uint8Array ? wallet.secretKey : new Uint8Array(wallet.secretKey));
  const connection = connectionFactory(rpcUrl);
  const mintPk = new PublicKey(mint);
  const toPk = new PublicKey(toAddress);
  const { programId, decimals } = await mintInfo(connection, mintPk, commitment);
  const amount = toTokenUnits(amountZolana, decimals);
  const source = associatedTokenAddress(mintPk, payer.publicKey, programId);
  const destination = associatedTokenAddress(mintPk, toPk, programId);

  const sourceBalance = await connection.getTokenAccountBalance(source, commitment).catch(() => null);
  if (!sourceBalance) throw new Error(`missing source ZOLANA token account: ${source.toBase58()}`);
  if (BigInt(sourceBalance.value.amount) < amount) {
    throw new Error(`insufficient ZOLANA: have ${sourceBalance.value.uiAmountString}, sending ${amountZolana}`);
  }

  const tx = new Transaction().add(
    createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, destination, toPk, mintPk, programId),
    createTransferCheckedInstruction(source, mintPk, destination, payer.publicKey, amount, decimals, programId),
  );
  return sendAndConfirmTransaction(connection, tx, [payer], { commitment, preflightCommitment: commitment });
}
