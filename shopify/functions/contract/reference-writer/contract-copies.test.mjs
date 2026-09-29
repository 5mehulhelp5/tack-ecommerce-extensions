// Each function crate builds from its own directory, so each carries a copy
// of contract/contract.rs. A drifted copy would make the two functions read
// the same metafield differently.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { CANONICAL, FUNCTION_DIRS, copyPath } from '../../scripts/sync-contract.mjs';

test('every function crate carries a byte-identical contract.rs', () => {
  const canonical = readFileSync(CANONICAL);
  for (const dir of FUNCTION_DIRS) {
    assert.ok(readFileSync(copyPath(dir)).equals(canonical), `${dir}/src/contract.rs drifted; run scripts/sync-contract.mjs`);
  }
});
