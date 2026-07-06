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

export const REBALANCE_THRESHOLD = 10_000; // the marketplace gate: below this an account can't list/sell
export const REBALANCE_TARGET = 12_000;    // fund a seller to this — above the 10k gate with a buffer for stamina drain
export const REBALANCE_OP_RESERVE = 1_000; // every account keeps at least this (≥1 $ZOLANA play gate + a little stamina)

export const REBALANCE_MIN_SELLABLE_PETS = 1;      // "makes sense to sell" gate: at least this many sellable pets…
export const REBALANCE_MIN_SELLABLE_GOLD = 100_000; // …OR at least this much Gold (one cashout lot) worth trading

// CONSOLIDATION planner (2026-07-06, owner: "concentrate $ZOLANA onto accounts that have pets to sell so
// their market opens — must be >10k, fund to >12k; the old spread-evenly design never moved anything").
// The fleet is $ZOLANA-short: ~147k across 18 accounts ≈ 8k each, so spread evenly NOBODY clears the 10k
// gate (0 markets). Concentrated at 12k, ~12 accounts CAN sell. So instead of "only move surplus above a
// donor floor" (which needs a donor that never exists here), we REALLOCATE the fleet's whole $ZOLANA:
// keep a small opReserve on every account, then fund as many SELLABLE-pet accounts to `target` as the
// fleet can afford — starting with the ones CLOSEST to target (cheapest to cross → maximizes how many
// markets open) — draining everyone else (non-sellers + the un-funded) down to opReserve. Accounts with
// nothing to sell are never funded (their idle $ZOLANA is exactly what we redistribute). As funded sellers
// sell pets and earn $ZOLANA, the pool grows and the next cycle funds more (a bootstrap cascade).
//
// accounts: [{ name, address, zolana }]. sellableByName: name -> { pets, gold } (or a Map) from live
// snapshots; null → treat every account as sellable (gate off, back-compat). Amounts are whole $ZOLANA;
// funded accounts land jittered just above target (non-round). $ZOLANA is conserved (transfers net to
// zero). Returns { transfers, unmet, skipped, donors, recipients, funded }.
export function planZolanaRebalance(accounts = [], {
  target = REBALANCE_TARGET,
  opReserve = REBALANCE_OP_RESERVE,
  rng = Math.random,
  sellableByName = null,
  minSellablePets = REBALANCE_MIN_SELLABLE_PETS,
  minSellableGold = REBALANCE_MIN_SELLABLE_GOLD,
} = {}) {
  const valid = (accounts || []).filter(a => a && a.name && a.address && Number.isFinite(Number(a.zolana)));
  if (!valid.length) return { transfers: [], unmet: [], skipped: [], donors: [], recipients: [], funded: [] };

  const invOf = (name) => {
    if (!sellableByName) return null;
    return (sellableByName instanceof Map ? sellableByName.get(name) : sellableByName[name]) || { pets: 0, gold: 0 };
  };
  const canSell = (name) => {
    const inv = invOf(name);
    if (inv == null) return true; // no inventory data → gate off, everyone is fundable
    return (Number(inv.pets) || 0) >= minSellablePets || (Number(inv.gold) || 0) >= minSellableGold;
  };

  // 1) Desired end-balance per account. Everyone keeps opReserve (but never reserve more than exists),
  //    then concentrate the remaining budget onto sellable accounts — closest-to-target first.
  const totalZ = valid.reduce((s, a) => s + Number(a.zolana), 0);
  const reserveFloor = Math.max(0, Math.min(opReserve, Math.floor(totalZ / valid.length)));
  const desired = new Map(valid.map(a => [a.name, reserveFloor]));
  let budget = totalZ - reserveFloor * valid.length;

  const fundOrder = valid.filter(a => canSell(a.name))
    .map(a => ({ a, tgt: Math.round(target * (1 + rng() * 0.04)) + Math.floor(rng() * 40) })) // ~12000..12520, non-round
    .sort((x, y) => Number(y.a.zolana) - Number(x.a.zolana)); // highest balance first = closest to target = cheapest to cross
  const funded = [];
  for (const { a, tgt } of fundOrder) {
    if (budget <= 0) break;
    const give = Math.min(budget, Math.max(0, tgt - reserveFloor));
    if (give <= 0) continue;
    desired.set(a.name, reserveFloor + give);
    budget -= give;
    if (reserveFloor + give >= tgt) funded.push(a.name);
  }
  // Leftover budget (fleet has MORE than enough to fund every seller to target) is intentionally left
  // unallocated: below, donors only transfer what recipients actually need, so the surplus simply stays
  // with the accounts that hold it — no account is drained further than necessary, no seller is over-funded.

  // 2) Transfers from over-desired (donors) to under-desired (recipients). Greedy: biggest surplus → biggest need.
  const donors = valid.filter(a => Number(a.zolana) - desired.get(a.name) >= 1)
    .map(a => ({ ...a, avail: Number(a.zolana) - desired.get(a.name) }))
    .sort((x, y) => y.avail - x.avail);
  const needs = valid.filter(a => desired.get(a.name) - Number(a.zolana) >= 1)
    .map(a => ({ ...a, need: desired.get(a.name) - Number(a.zolana) }))
    .sort((x, y) => y.need - x.need);

  const transfers = [];
  const unmet = [];
  for (const r of needs) {
    let remaining = r.need;
    for (const d of donors) {
      if (remaining < 1) break;
      if (d.avail < 1 || d.name === r.name) continue;
      const amount = Math.floor(Math.min(remaining, d.avail));
      if (amount < 1) continue;
      transfers.push({ from: d.name, fromAddress: d.address, to: r.name, toAddress: r.address, amount });
      d.avail -= amount;
      remaining -= amount;
    }
    if (remaining >= 1) unmet.push({ name: r.name, short: Math.round(remaining) });
  }
  // sellable accounts left under target because the fleet couldn't afford to fund them this cycle
  const skipped = fundOrder.filter(({ a }) => !funded.includes(a.name) && Number(a.zolana) < target)
    .map(({ a }) => ({ name: a.name, reason: 'not enough fleet $ZOLANA to fund to target this cycle' }));

  return { transfers, unmet, skipped, donors: donors.map(d => d.name), recipients: needs.map(n => n.name), funded };
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
