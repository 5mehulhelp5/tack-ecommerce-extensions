// Copies shared/contract.js into every function extension's src/, because each
// function is bundled from its own directory. shared/contract-copies.test.mjs
// fails when a copy drifts, so run this after editing the canonical file:
//   node shopify/functions/scripts/sync-contract.mjs
import { copyFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const FUNCTION_DIRS = ['tackquote-wholesale-pricing', 'tackquote-order-limits'];

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  for (const dir of FUNCTION_DIRS) {
    copyFileSync(join(root, 'shared', 'contract.js'), join(root, dir, 'src', 'contract.js'));
    console.log(`synced ${dir}/src/contract.js`);
  }
}
