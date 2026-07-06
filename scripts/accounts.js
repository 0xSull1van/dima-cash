import { loadEnv, requireMasterKey } from '../src/env.js';
import { loadRegistry } from '../src/account-creator.js';
import { proxyLabel } from '../src/accounts.js';
import { loadWallet, walletSecretKeyBase58 } from '../src/wallet.js';

const args = process.argv.slice(2);
const showPrivateKeys = args.includes('--private-keys');
loadEnv();
const registry = loadRegistry();

if (!registry.accounts.length) {
  console.log('No accounts in accounts.json');
  process.exit(0);
}

const masterKey = showPrivateKeys ? requireMasterKey() : null;

for (const account of registry.accounts) {
  const parts = [
    account.name.padEnd(10),
    account.address || '-',
    `proxy ${proxyLabel(account.proxyUrl || process.env[account.proxyEnv])}`,
    `status ${account.status || 'unknown'}`,
  ];

  if (showPrivateKeys) {
    const wallet = loadWallet(account.name, masterKey);
    parts.push(`privateKeyBase58 ${walletSecretKeyBase58(wallet)}`);
  }

  console.log(parts.join('  '));
}
