// Диагностика мастер-ключа. НЕ печатает сам ключ целиком — только длину и края,
// чтобы поймать ошибку копирования. Правильный ключ: длина 33, начинается "7G", кончается "BP".
import { requireMasterKey } from '../src/env.js';

const k = requireMasterKey();
const first2 = k.slice(0, 2);
const last2 = k.slice(-2);
console.log('length     :', k.length, '(expected 33)');
console.log('starts with:', JSON.stringify(first2), '(expected "7G")');
console.log('ends with  :', JSON.stringify(last2), '(expected "BP")');
const ok = k.length === 33 && first2 === '7G' && last2 === 'BP';
console.log(ok ? '\n=> looks correct. If decrypt still fails, tell me.' :
                 '\n=> MISMATCH — the value is wrong (placeholder/quotes/typo). Re-set it exactly.');
