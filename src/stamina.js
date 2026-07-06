import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
} from '@solana/web3.js';

export const DEFAULT_SOLANA_RPC = 'https://api.mainnet-beta.solana.com';
export const ZOLANA_MINT = 'Ez6gPDiNK7VtGe5o9vnhDHJq9QPHvEYmSo8teu8mpump';
export const ZOLANA_TREASURY = 'Auywa2xpfcTaBmfzNCLXSLTM5kzBh9kwjuABHY2usVNC';
export const STAMINA_FULL_PACK = 'full';
// ⚠️ Live in-game price, NOT a constant — the server has already moved it (50→150, found live 2026-07-05:
// a fleet-wide `stamina refill err 400 "Payment was too small for this pack"`). The payment is a REAL
// on-chain SPL transfer (createStaminaRefillPayment), sent BEFORE the game checks the amount — if this
// goes stale again, every rejected payment IRREVERSIBLY burns ZOLANA (the amount goes to the treasury,
// stamina is not credited), and handleStaminaRefill retries every 2 min by default, so the cost of
// burned funds grows continuously until someone notices and corrects this number. There's no way to read
// the current price programmatically (the server doesn't return it) — only manually from the game/wiki.
export const STAMINA_FULL_REFILL_COST_ZOLANA = 150;

export const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
export const TOKEN_2022_PROGRAM_ID = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');
export const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');

export function staminaCostForDungeon(dungeonId) {
  const id = Math.max(1, Math.min(25, Number(dungeonId) || 1));
  if (id <= 5) return 6;
  if (id <= 10) return 8;
  if (id <= 15) return 10;
  if (id <= 20) return 14;
  return 18;
}

export function toTokenUnits(amount, decimals) {
  const raw = String(amount);
  if (!/^\d+(\.\d+)?$/.test(raw)) throw new Error(`invalid token amount: ${raw}`);
  const [whole, frac = ''] = raw.split('.');
  const padded = (frac + '0'.repeat(decimals)).slice(0, decimals);
  return BigInt(whole) * (10n ** BigInt(decimals)) + BigInt(padded || '0');
}

export async function mintInfo(connection, mint, commitment) {
  const account = await connection.getParsedAccountInfo(mint, commitment);
  const value = account.value;
  if (!value) throw new Error(`ZOLANA mint not found: ${mint.toBase58()}`);
  let programId;
  if (value.owner.equals(TOKEN_2022_PROGRAM_ID)) programId = TOKEN_2022_PROGRAM_ID;
  else if (value.owner.equals(TOKEN_PROGRAM_ID)) programId = TOKEN_PROGRAM_ID;
  else throw new Error(`unsupported ZOLANA token program: ${value.owner.toBase58()}`);
  const decimals = value.data?.parsed?.info?.decimals;
  if (!Number.isInteger(decimals)) throw new Error('could not read ZOLANA mint decimals');
  return { programId, decimals };
}

export function associatedTokenAddress(mint, owner, tokenProgramId) {
  return PublicKey.findProgramAddressSync(
    [owner.toBuffer(), tokenProgramId.toBuffer(), mint.toBuffer()],
    ASSOCIATED_TOKEN_PROGRAM_ID,
  )[0];
}

// CreateIdempotent: succeeds whether or not the destination ATA already exists.
export function createAssociatedTokenAccountIdempotentInstruction(payer, ata, owner, mint, tokenProgramId) {
  return new TransactionInstruction({
    programId: ASSOCIATED_TOKEN_PROGRAM_ID,
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: ata, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: false, isWritable: false },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: tokenProgramId, isSigner: false, isWritable: false },
    ],
    data: Buffer.from([1]),
  });
}

export function createTransferCheckedInstruction(source, mint, destination, owner, amount, decimals, programId) {
  const data = Buffer.alloc(10);
  data[0] = 12; // SPL Token TransferChecked
  data.writeBigUInt64LE(amount, 1);
  data[9] = decimals;
  return new TransactionInstruction({
    programId,
    keys: [
      { pubkey: source, isSigner: false, isWritable: true },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: destination, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: true, isWritable: false },
    ],
    data,
  });
}

function keypairFromWallet(wallet) {
  if (!wallet?.secretKey) throw new Error('wallet secret key is required for stamina refill payment');
  return Keypair.fromSecretKey(wallet.secretKey instanceof Uint8Array ? wallet.secretKey : new Uint8Array(wallet.secretKey));
}

export async function createStaminaRefillPayment(wallet, {
  rpcUrl = process.env.SOLANA_RPC_URL || DEFAULT_SOLANA_RPC,
  mint = ZOLANA_MINT,
  treasury = ZOLANA_TREASURY,
  amountZolana = STAMINA_FULL_REFILL_COST_ZOLANA,
  commitment = 'confirmed',
} = {}) {
  const payer = keypairFromWallet(wallet);
  const connection = new Connection(rpcUrl, commitment);
  const mintPk = new PublicKey(mint);
  const treasuryPk = new PublicKey(treasury);
  const { programId, decimals } = await mintInfo(connection, mintPk, commitment);
  const amount = toTokenUnits(amountZolana, decimals);
  const source = associatedTokenAddress(mintPk, payer.publicKey, programId);
  const destination = associatedTokenAddress(mintPk, treasuryPk, programId);

  const sourceBalance = await connection.getTokenAccountBalance(source, commitment).catch(() => null);
  if (!sourceBalance) throw new Error(`missing source ZOLANA token account: ${source.toBase58()}`);
  if (BigInt(sourceBalance.value.amount) < amount) {
    throw new Error(`insufficient ZOLANA balance for stamina refill: have ${sourceBalance.value.uiAmountString}, need ${amountZolana}`);
  }
  const destinationInfo = await connection.getAccountInfo(destination, commitment);
  if (!destinationInfo) throw new Error(`missing treasury ZOLANA token account: ${destination.toBase58()}`);

  const tx = new Transaction().add(
    createTransferCheckedInstruction(
      source,
      mintPk,
      destination,
      payer.publicKey,
      amount,
      decimals,
      programId,
    ),
  );

  return sendAndConfirmTransaction(connection, tx, [payer], {
    commitment,
    preflightCommitment: commitment,
  });
}
