// Copies contract/contract.rs into every function crate's src/, because
// Shopify CLI builds each function from its own directory. The copy check in
// contract/reference-writer/contract-copies.test.mjs fails when one drifts, so
// run this after editing the canonical file:
//   node shopify/functions/scripts/sync-contract.mjs
import { copyFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const FUNCTION_DIRS = [
  'tackquote-wholesale-pricing',
  'tackquote-order-limits',
  'tackquote-wholesale-shipping',
  'tackquote-wholesale-shipping-discount',
];
export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const CANONICAL = join(ROOT, 'contract', 'contract.rs');
export const copyPath = (dir) => join(ROOT, dir, 'src', 'contract.rs');

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  for (const dir of FUNCTION_DIRS) {
    copyFileSync(CANONICAL, copyPath(dir));
    console.log(`synced ${dir}/src/contract.rs`);
  }
}
