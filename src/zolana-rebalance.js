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

export const REBALANCE_MIN_SELLABLE_PETS = 1;      // "makes sense to sell" gate: at least this many sellable pets…
export const REBALANCE_MIN_SELLABLE_GOLD = 100_000; // …OR at least this much Gold (one cashout lot) worth trading

// Pure planner: who's short and who shares. accounts: [{name, address, zolana}].
// Greedy: the richest donor covers the largest need; amounts jittered +0..4% with a non-round
// tail (not exactly 12000 for everyone — more human).
//
// "Makes sense to sell" gate (2026-07-06, owner: "transfer to accounts that are short on trading funds
// AND where it makes sense to sell"): only fund a short account that actually has something to list —
// otherwise we'd spend real ZOLANA opening a market for an account with nothing to sell. Pass
// `sellableByName` (a name -> { pets, gold } map, or a Map) built from live snapshots; a recipient
// qualifies if it has ≥ minSellablePets sellable pets OR ≥ minSellableGold Gold. When `sellableByName` is
// null (not provided), the gate is OFF and every short account qualifies (old behavior). Short accounts
// that don't qualify are returned in `skipped` (with the reason) so the caller can log why they weren't funded.
// Returns { transfers, unmet, skipped, donors, recipients }.
export function planZolanaRebalance(accounts = [], {
  threshold = REBALANCE_THRESHOLD,
  target = REBALANCE_TARGET,
  donorFloor = REBALANCE_DONOR_FLOOR,
  rng = Math.random,
  sellableByName = null,
  minSellablePets = REBALANCE_MIN_SELLABLE_PETS,
  minSellableGold = REBALANCE_MIN_SELLABLE_GOLD,
} = {}) {
  const valid = (accounts || []).filter(a => a && a.name && a.address && Number.isFinite(Number(a.zolana)));
  const getInv = (name) => {
    if (!sellableByName) return null; // gate off
    return (sellableByName instanceof Map ? sellableByName.get(name) : sellableByName[name]) || { pets: 0, gold: 0 };
  };
  const qualifies = (name) => {
    const inv = getInv(name);
    if (inv == null) return true; // no inventory data supplied → gate off, fund all short (old behavior)
    return (Number(inv.pets) || 0) >= minSellablePets || (Number(inv.gold) || 0) >= minSellableGold;
  };

  const donors = valid
    .filter(a => Number(a.zolana) > donorFloor)
    .map(a => ({ ...a, avail: Number(a.zolana) - donorFloor }))
    .sort((x, y) => y.avail - x.avail);
  const short = valid.filter(a => Number(a.zolana) < threshold);
  const skipped = short
    .filter(a => !qualifies(a.name))
    .map(a => ({ name: a.name, reason: 'nothing to sell (no sellable pets, no Gold surplus)' }));
  const needs = short
    .filter(a => qualifies(a.name))
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
  return { transfers, unmet, skipped, donors: donors.map(d => d.name), recipients: needs.map(n => n.name) };
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
