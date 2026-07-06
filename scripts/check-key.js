// Master-key diagnostic. Does NOT print the key itself — only its length and edges,
// so you can eyeball it against your password manager and catch a copy/paste error
// (stray quotes, a truncated paste, a placeholder left in). No expected value is hardcoded here.
import { requireMasterKey } from '../src/env.js';

const k = requireMasterKey();
console.log('length     :', k.length);
console.log('starts with:', JSON.stringify(k.slice(0, 2)));
console.log('ends with  :', JSON.stringify(k.slice(-2)));
console.log('\n=> Compare these against the value in your password manager.');
console.log('   If they match but decrypt still fails, the wallet file may be for a different key.');
